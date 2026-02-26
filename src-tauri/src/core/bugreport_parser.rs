//! Dumpstate / bugreport format parser.
//!
//! Handles Android `dumpstate` output (captured as a plain text file or
//! extracted from a bugreport.zip).  The top-level structure looks like:
//!
//! ```text
//! ========================================================
//! == dumpstate: 2026-02-16 17:27:35
//! ========================================================
//! Build: UP1A.231005.007...
//! Build fingerprint: '...'
//! Bootloader: ...
//! ...
//! androidboot.serialno = "R52X10EJCFA"
//! ...
//! Uptime: up 0 weeks, 0 days, 0 hours, 9 minutes, ...
//! Bugreport format version: 2.0
//! Dumpstate info: id=1 pid=8405 ...
//!
//! ------ SECTION NAME (/source/path) ------
//! <section content>
//! ------ 0.011s was the duration of 'SECTION NAME' ------
//! ```
//!
//! The tag field in `LineMeta` carries the section name for `------` header and
//! footer lines so they are discoverable by search.  Plain content lines get an
//! empty tag and are shown as raw text.
//!
//! ## Year inference for logcat lines
//!
//! Logcat lines embedded in a bugreport have no year (`MM-DD HH:MM:SS.mmm`).
//! The parser is stateful: when it encounters the `== dumpstate: YYYY-MM-DD`
//! header it records the capture year, then corrects all subsequent logcat
//! timestamps to that year.
//!
//! Year-rollover: if a logcat line's date (with the dumpstate year applied)
//! would be *after* the dumpstate capture time, the line is from the previous
//! year (e.g. a Dec 30 log line in a Jan 5 bugreport → year − 1).

use regex::Regex;
use std::sync::atomic::{AtomicI32, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};

use crate::core::line::{LineContext, ParsedLineMeta, LogLevel};
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;

// ---------------------------------------------------------------------------
// Compiled regexes
// ---------------------------------------------------------------------------

static DUMPSTATE_TS_RE: OnceLock<Regex> = OnceLock::new();
static DURATION_NAME_RE: OnceLock<Regex> = OnceLock::new();

/// `== dumpstate: YYYY-MM-DD HH:MM:SS`
fn dumpstate_ts_re() -> &'static Regex {
    DUMPSTATE_TS_RE.get_or_init(|| {
        Regex::new(r"^== dumpstate: (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})")
            .expect("dumpstate_ts_re is valid")
    })
}

/// Extract section name from inside single-quotes in a duration footer line.
/// `------ 0.011s was the duration of 'MEMORY INFO' ------` → `MEMORY INFO`
fn duration_name_re() -> &'static Regex {
    DURATION_NAME_RE.get_or_init(|| {
        Regex::new(r"'([^']+)'").expect("duration_name_re is valid")
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract the human-readable section name from a `------` start line.
///
/// `------ MEMORY INFO (/proc/meminfo) ------` → `"MEMORY INFO"`
/// `------ CPU INFO ------`                    → `"CPU INFO"`
fn extract_section_name(raw: &str) -> String {
    let inner = raw.trim_start_matches('-').trim_end_matches('-').trim();
    // Strip trailing ` (source/path)` annotation if present.
    if let Some(idx) = inner.rfind(" (") {
        inner[..idx].trim().to_string()
    } else {
        inner.to_string()
    }
}

/// Nanosecond offset from BASE_NS (2000-01-01 00:00:00 UTC) to the start of
/// `year`.  Accounts for leap years between 2000 and `year` (exclusive).
///
/// Returns 0 for year 2000, positive for later years, negative for earlier.
fn year_start_ns_from_2000(year: i64) -> i64 {
    let y = year - 2000;
    let leap_days = y / 4 - y / 100 + y / 400;
    (y * 365 + leap_days) * 86_400_000_000_000
}

/// Convert a full dumpstate datetime to nanoseconds (Unix-compatible: BASE_NS
/// is the Unix nanosecond value of 2000-01-01 00:00:00 UTC).
fn parse_dumpstate_timestamp(year: i64, month: i64, day: i64, hour: i64, min: i64, sec: i64) -> i64 {
    const BASE_NS: i64 = 946_684_800_000_000_000; // 2000-01-01 00:00:00 UTC as Unix nanos

    const MONTH_DAYS: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let is_leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days = MONTH_DAYS[(month as usize).saturating_sub(1)];
    let leap_add: i64 = if is_leap && month > 2 { 1 } else { 0 };
    let yday = month_days + leap_add + (day - 1);

    BASE_NS
        + year_start_ns_from_2000(year)
        + yday * 86_400_000_000_000
        + hour * 3_600_000_000_000
        + min * 60_000_000_000
        + sec * 1_000_000_000
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/// Stateful bugreport parser.  Must be constructed with [`BugreportParser::new()`].
///
/// State is updated as lines are parsed top-to-bottom:
/// - `dumpstate_year` / `dumpstate_ts_ns` are populated on the first
///   `== dumpstate:` header line.
/// - All subsequent logcat timestamps are corrected to that year (with
///   year-rollover handling).
///
/// `AtomicI32`/`AtomicI64` with `Relaxed` ordering are used so that the
/// parser satisfies `Send + Sync` (required by `LogParser`) while remaining
/// allocation-free.  The parse is always single-threaded and sequential so
/// there is no concurrent access to reason about.
pub struct BugreportParser {
    /// Capture year from the `== dumpstate:` header, or 0 if not yet seen.
    dumpstate_year: AtomicI32,
    /// Full capture timestamp (Unix nanos) from the `== dumpstate:` header.
    dumpstate_ts_ns: AtomicI64,
}

impl BugreportParser {
    pub fn new() -> Self {
        Self {
            dumpstate_year: AtomicI32::new(0),
            dumpstate_ts_ns: AtomicI64::new(0),
        }
    }

    /// Shift a logcat timestamp (stored with year-2000 base) to the dumpstate
    /// capture year, applying year-rollover correction.
    ///
    /// If the year-shifted timestamp would be *after* the dumpstate capture
    /// time by more than a grace period, the log line is from the previous year
    /// (e.g. a Dec 30 entry in a Jan 5 bugreport).  A 5-minute grace period
    /// prevents log lines that were written just after the dumpstate header
    /// (but still during the same capture session) from being incorrectly
    /// rolled back to the previous year.
    ///
    /// Returns the original timestamp unchanged if the dumpstate year has not
    /// yet been recorded.
    fn correct_logcat_year(&self, ts_2000: i64) -> i64 {
        let year = self.dumpstate_year.load(Ordering::Relaxed) as i64;
        if year == 0 {
            return ts_2000; // Dumpstate header not yet encountered
        }

        // ts_2000 = BASE_NS + time_offset_within_year
        // Shift to dumpstate year by adding the year-start offset delta.
        let offset = year_start_ns_from_2000(year);
        let ts_with_year = ts_2000 + offset;

        let dumpstate_ts = self.dumpstate_ts_ns.load(Ordering::Relaxed);
        // Allow up to 5 minutes past dumpstate time before treating a timestamp
        // as a year-rollover (Dec→Jan).  Lines written during the dumpstate
        // collection itself may legitimately post-date the header timestamp by
        // a few seconds or minutes.
        const GRACE_NS: i64 = 5 * 60 * 1_000_000_000;
        if ts_with_year > dumpstate_ts + GRACE_NS {
            // This date is substantially later in the year than the capture
            // time — it belongs to the previous year (Dec 30 in a Jan 5
            // bugreport, for example).
            ts_2000 + year_start_ns_from_2000(year - 1)
        } else {
            ts_with_year
        }
    }

    /// Shared logic: classify one raw line and return its metadata fields.
    /// Called by both `parse_meta` and `parse_line` to avoid duplication.
    fn classify(&self, raw: &str, byte_offset: usize) -> ParsedLineMeta {
        // Decorative `====` separators at the top of the dumpstate header.
        if raw.starts_with("====") {
            return ParsedLineMeta {
                level: LogLevel::Verbose,
                tag: String::new(),
                timestamp: 0,
                byte_offset,
                byte_len: raw.len(),
                is_section_boundary: false,
            };
        }

        // `== dumpstate: YYYY-MM-DD HH:MM:SS` — file-level timestamp.
        // Store the capture year and timestamp for use in logcat year correction.
        // The line's own timestamp is set to 0 so it is excluded from the
        // session's first/last timestamp calculations — only actual log-line
        // timestamps (from the SYSTEM LOG section etc.) should drive those.
        if let Some(caps) = dumpstate_ts_re().captures(raw) {
            let y: i64 = caps.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(2000);
            let mo: i64 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(1);
            let d: i64 = caps.get(3).and_then(|m| m.as_str().parse().ok()).unwrap_or(1);
            let h: i64 = caps.get(4).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let mi: i64 = caps.get(5).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let s: i64 = caps.get(6).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let ts = parse_dumpstate_timestamp(y, mo, d, h, mi, s);
            self.dumpstate_year.store(y as i32, Ordering::Relaxed);
            self.dumpstate_ts_ns.store(ts, Ordering::Relaxed);
            return ParsedLineMeta {
                level: LogLevel::Info,
                tag: "dumpstate".to_string(),
                timestamp: 0,
                byte_offset,
                byte_len: raw.len(),
                is_section_boundary: false,
            };
        }

        // `------` lines — section headers and duration footers.
        if raw.starts_with("------") {
            let (tag, level) = if raw.contains("was the duration of") {
                // Duration footer: extract name from single-quotes.
                let name = duration_name_re()
                    .captures(raw)
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();
                (name, LogLevel::Verbose)
            } else {
                // Section start header.
                (extract_section_name(raw), LogLevel::Info)
            };
            return ParsedLineMeta {
                level,
                tag,
                timestamp: 0,
                byte_offset,
                byte_len: raw.len(),
                is_section_boundary: true,
            };
        }

        // Try logcat format (handles both standard ADB and bugreport UID-prefixed formats).
        // LogcatParser already recognises MM-DD HH:MM:SS.mmm [UID] PID TID LEVEL TAG: msg.
        if let Some(mut meta) = LogcatParser.parse_meta(raw, byte_offset) {
            if meta.timestamp > 0 {
                meta.timestamp = self.correct_logcat_year(meta.timestamp);
            }
            meta.byte_len = raw.len();
            return meta;
        }

        // Plain content line — key:value pairs, prose, numbers, etc.
        ParsedLineMeta {
            level: LogLevel::Info,
            tag: String::new(),
            timestamp: 0,
            byte_offset,
            byte_len: raw.len(),
            is_section_boundary: false,
        }
    }
}

impl Default for BugreportParser {
    fn default() -> Self {
        Self::new()
    }
}

impl LogParser for BugreportParser {
    fn parse_meta(&self, raw: &str, byte_offset: usize) -> Option<ParsedLineMeta> {
        let raw = raw.trim_end_matches(['\r', '\n']);
        Some(self.classify(raw, byte_offset))
    }

    fn parse_line(&self, raw: &str, source_id: &str, line_num: usize) -> Option<LineContext> {
        let raw = raw.trim_end_matches(['\r', '\n']);

        // Delegate logcat lines to LogcatParser for full pid/tid/message parsing,
        // then correct the year using the stored dumpstate capture year.
        // Note: non-logcat lines (including the dumpstate header) fall through to
        // classify() below, which updates dumpstate_year as a side-effect.
        if let Some(mut ctx) = LogcatParser.parse_line(raw, source_id, line_num) {
            if ctx.timestamp > 0 {
                ctx.timestamp = self.correct_logcat_year(ctx.timestamp);
            }
            ctx.source_line_num = line_num;
            return Some(ctx);
        }

        let meta = self.classify(raw, 0);
        let raw_arc: Arc<str> = Arc::from(raw);
        Some(LineContext {
            raw: Arc::clone(&raw_arc),
            timestamp: meta.timestamp,
            level: meta.level,
            tag: Arc::from(meta.tag.as_str()),
            pid: 0,
            tid: 0,
            message: raw_arc,
            source_id: Arc::from(source_id),
            source_line_num: line_num,
            fields: Default::default(),
            annotations: Vec::new(),
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::parser::LogParser;

    #[test]
    fn parses_section_header() {
        let p = BugreportParser::new();
        let m = p.parse_meta("------ MEMORY INFO (/proc/meminfo) ------", 0).unwrap();
        assert_eq!(m.tag, "MEMORY INFO");
        assert_eq!(m.level, LogLevel::Info);
    }

    #[test]
    fn parses_section_header_no_source() {
        let p = BugreportParser::new();
        let m = p.parse_meta("------ CPU INFO ------", 0).unwrap();
        assert_eq!(m.tag, "CPU INFO");
    }

    #[test]
    fn parses_duration_footer() {
        let p = BugreportParser::new();
        let m = p
            .parse_meta("------ 0.011s was the duration of 'MEMORY INFO' ------", 0)
            .unwrap();
        assert_eq!(m.tag, "MEMORY INFO");
        assert_eq!(m.level, LogLevel::Verbose);
    }

    #[test]
    fn parses_dumpstate_timestamp() {
        let p = BugreportParser::new();
        let m = p
            .parse_meta("== dumpstate: 2026-02-16 17:27:35", 0)
            .unwrap();
        assert_eq!(m.tag, "dumpstate");
        // Dumpstate header line has timestamp=0 in line_meta so it is
        // excluded from first/last timestamp calculations.  The capture time
        // is stored in dumpstate_ts_ns for year correction only.
        assert_eq!(m.timestamp, 0);
        // Year and capture ts should now be stored for year correction
        assert_eq!(p.dumpstate_year.load(Ordering::Relaxed), 2026);
        assert!(p.dumpstate_ts_ns.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn indexes_plain_content_lines() {
        let p = BugreportParser::new();
        let m = p.parse_meta("MemTotal:        5843088 kB", 0).unwrap();
        assert_eq!(m.level, LogLevel::Info);
        assert_eq!(m.tag, "");
    }

    #[test]
    fn parses_embedded_logcat_line_standard() {
        let p = BugreportParser::new();
        // Standard ADB logcat format: MM-DD HH:MM:SS.mmm PID TID L TAG: msg
        let m = p
            .parse_meta("02-16 17:24:00.058  1587  1587 E Watchdog: !@Sync timeout", 0)
            .unwrap();
        assert_eq!(m.level, LogLevel::Error);
        assert_eq!(m.tag, "Watchdog");
        assert!(m.timestamp > 0);
    }

    #[test]
    fn parses_embedded_logcat_line_with_uid() {
        let p = BugreportParser::new();
        // Bugreport SYSTEM LOG format: MM-DD HH:MM:SS.mmm UID PID TID L TAG: msg
        let m = p
            .parse_meta("02-16 17:28:19.497  1000  1149  3609 D RestrictionPolicy: some message", 0)
            .unwrap();
        assert_eq!(m.level, LogLevel::Debug);
        assert_eq!(m.tag, "RestrictionPolicy");
        assert!(m.timestamp > 0);
    }

    #[test]
    fn skips_decorative_separator() {
        let p = BugreportParser::new();
        let m = p
            .parse_meta("========================================================", 0)
            .unwrap();
        assert_eq!(m.level, LogLevel::Verbose);
        assert_eq!(m.tag, "");
    }

    /// Logcat lines parsed after the dumpstate header should have the capture
    /// year applied rather than the year-2000 base used by LogcatParser alone.
    #[test]
    fn logcat_year_corrected_after_dumpstate_header() {
        let p = BugreportParser::new();
        p.parse_meta("== dumpstate: 2026-02-16 17:27:35", 0).unwrap();

        // A line from the same day, earlier in the day — should be year 2026.
        let m = p
            .parse_meta("02-16 17:24:00.058  1587  1587 E Watchdog: !@Sync timeout", 0)
            .unwrap();
        // The corrected timestamp should be in 2026, not 2000.
        // Year 2026 offset from BASE_NS is year_start_ns_from_2000(2026).
        let year_2026_offset = year_start_ns_from_2000(2026);
        let year_2000_ts = {
            // Compute what LogcatParser alone would produce for 02-16 17:24:00.058
            const BASE_NS: i64 = 946_684_800_000_000_000;
            const MONTH_DAYS: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
            let yday = MONTH_DAYS[1] + 15; // Feb (index 1) + day 16 - 1 = 15
            BASE_NS + yday * 86_400_000_000_000 + 17 * 3_600_000_000_000 + 24 * 60_000_000_000 + 58_000_000
        };
        assert_eq!(m.timestamp, year_2000_ts + year_2026_offset);
    }

    /// Log lines written within the 5-minute grace window after the dumpstate
    /// capture timestamp must not be rolled back to the previous year.  This
    /// covers lines emitted by the device during the dumpstate collection itself
    /// (the original bug: lines 83 seconds after capture were showing year 2025).
    #[test]
    fn logcat_line_within_grace_period_keeps_current_year() {
        let p = BugreportParser::new();
        p.parse_meta("== dumpstate: 2026-02-14 21:23:17", 0).unwrap();

        // 21:24:40 is 83 seconds after the capture time — within the 5-minute grace window.
        let m = p
            .parse_meta("02-14 21:24:40.000  1000  1234  5678 I Tag: grace test", 0)
            .unwrap();

        const BASE_NS: i64 = 946_684_800_000_000_000;
        let start_2026 = BASE_NS + year_start_ns_from_2000(2026);
        let start_2027 = BASE_NS + year_start_ns_from_2000(2027);
        assert!(
            m.timestamp >= start_2026 && m.timestamp < start_2027,
            "timestamp should be in year 2026 (not rolled back to 2025), got {}",
            m.timestamp
        );
    }

    /// Dec 31 log lines in a Jan 1 bugreport must be attributed to year N−1,
    /// while Jan 1 lines from before the capture time stay in year N.
    /// Exercises the Dec/Jan year boundary in both directions.
    #[test]
    fn dec_jan_boundary_year_attribution() {
        let p = BugreportParser::new();
        // Bugreport captured 2026-01-01 00:01:00.
        p.parse_meta("== dumpstate: 2026-01-01 00:01:00", 0).unwrap();

        // Dec 31 23:55:00 — shifted to year 2026 would be 2026-12-31, far past
        // the capture date → must roll back to 2025-12-31.
        let dec31 = p
            .parse_meta("12-31 23:55:00.000  1000  1000 I Tag: december log", 0)
            .unwrap();

        // Jan 1 00:00:30 — 30 seconds before capture, stays in 2026.
        let jan1 = p
            .parse_meta("01-01 00:00:30.000  1000  1000 I Tag: january log", 0)
            .unwrap();

        const BASE_NS: i64 = 946_684_800_000_000_000;
        let start_2025 = BASE_NS + year_start_ns_from_2000(2025);
        let start_2026 = BASE_NS + year_start_ns_from_2000(2026);
        let start_2027 = BASE_NS + year_start_ns_from_2000(2027);

        assert!(
            dec31.timestamp >= start_2025 && dec31.timestamp < start_2026,
            "Dec 31 should be attributed to 2025, timestamp={}",
            dec31.timestamp
        );
        assert!(
            jan1.timestamp >= start_2026 && jan1.timestamp < start_2027,
            "Jan 1 should be attributed to 2026, timestamp={}",
            jan1.timestamp
        );
    }

    /// A fresh BugreportParser seeded with only the dumpstate header line
    /// produces the same year-corrected timestamps as a parser that processed
    /// the full file in sequence.  This is the exact pattern used by
    /// `run_background_indexer` to fix the "year 2000" regression on the second
    /// chunk.
    #[test]
    fn seeded_parser_year_corrects_identically_to_full_parse() {
        let full = BugreportParser::new();
        full.parse_meta("== dumpstate: 2026-02-14 21:23:17", 0).unwrap();
        let expected = full
            .parse_meta("02-14 09:16:57.849  1000  1234  5678 I ActivityManager: msg", 0)
            .unwrap()
            .timestamp;
        assert!(expected > 0);

        // Seeded fresh parser — mirrors what run_background_indexer does before
        // processing its first chunk.
        let seeded = BugreportParser::new();
        seeded
            .parse_meta("== dumpstate: 2026-02-14 21:23:17", 0)
            .unwrap();
        let actual = seeded
            .parse_meta("02-14 09:16:57.849  1000  1234  5678 I ActivityManager: msg", 0)
            .unwrap()
            .timestamp;

        assert_eq!(
            actual, expected,
            "seeded parser must produce the same timestamp as a parser that saw the full file"
        );

        const BASE_NS: i64 = 946_684_800_000_000_000;
        assert!(
            actual >= BASE_NS + year_start_ns_from_2000(2026),
            "timestamp should be in year 2026, got {}",
            actual
        );
    }

    /// Without seeding, a fresh BugreportParser produces year-~2000 timestamps —
    /// confirming that the seeding step in run_background_indexer is not redundant.
    #[test]
    fn unseeded_parser_produces_year_2000_timestamps() {
        let unseeded = BugreportParser::new();
        let m = unseeded
            .parse_meta("02-14 09:16:57.849  1000  1234  5678 I ActivityManager: msg", 0)
            .unwrap();

        const BASE_NS: i64 = 946_684_800_000_000_000;
        let bound_2010 = BASE_NS + year_start_ns_from_2000(2010);
        assert!(
            m.timestamp < bound_2010,
            "unseeded parser should produce a year-~2000 timestamp, got {}",
            m.timestamp
        );
    }

    /// A Dec 30 log line in a Jan 5 bugreport should be attributed to year − 1.
    #[test]
    fn logcat_year_rollover_dec_in_jan_bugreport() {
        let p = BugreportParser::new();
        p.parse_meta("== dumpstate: 2026-01-05 10:00:00", 0).unwrap();

        let m = p
            .parse_meta("12-30 23:55:00.000  1000  1000 I Tag: rollover test", 0)
            .unwrap();

        // Dec 30 with year 2026 would be after Jan 5, 2026 → must roll to 2025.
        let year_2025_offset = year_start_ns_from_2000(2025);
        let year_2000_ts = {
            const BASE_NS: i64 = 946_684_800_000_000_000;
            const MONTH_DAYS: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
            let yday = MONTH_DAYS[11] + 29; // Dec (index 11) + day 30 - 1 = 29
            BASE_NS + yday * 86_400_000_000_000 + 23 * 3_600_000_000_000 + 55 * 60_000_000_000
        };
        assert_eq!(m.timestamp, year_2000_ts + year_2025_offset);
    }
}
