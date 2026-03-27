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

/// Days from Unix epoch (1970-01-01) to a given civil date.
/// Uses the era-based algorithm from https://howardhinnant.github.io/date_algorithms.html
/// Shared with logcat_parser::parse_timestamp_ns.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Nanosecond offset between Jan 1 of `from_year` and Jan 1 of `to_year`.
fn year_offset_ns(from_year: i64, to_year: i64) -> i64 {
    let from_days = days_from_civil(from_year, 1, 1);
    let to_days = days_from_civil(to_year, 1, 1);
    (to_days - from_days) * 86_400_000_000_000
}

/// Convert a full dumpstate datetime to nanoseconds since Unix epoch (UTC).
fn parse_dumpstate_timestamp(year: i64, month: i64, day: i64, hour: i64, min: i64, sec: i64) -> i64 {
    const NS_PER_DAY: i64 = 86_400_000_000_000;
    const NS_PER_HOUR: i64 = 3_600_000_000_000;
    const NS_PER_MIN: i64 = 60_000_000_000;
    const NS_PER_SEC: i64 = 1_000_000_000;

    days_from_civil(year, month, day) * NS_PER_DAY
        + hour * NS_PER_HOUR
        + min * NS_PER_MIN
        + sec * NS_PER_SEC
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

    /// Shift a logcat timestamp from the inferred current year to the dumpstate
    /// capture year, applying year-rollover correction.
    ///
    /// `parse_timestamp_ns` (logcat_parser) infers the current system year since
    /// logcat omits the year. For bugreports, the correct year comes from the
    /// `== dumpstate:` header. This function shifts the timestamp accordingly.
    ///
    /// If the year-shifted timestamp would be *after* the dumpstate capture
    /// time by more than a grace period, the log line is from the previous year
    /// (e.g. a Dec 30 entry in a Jan 5 bugreport).
    ///
    /// Returns the original timestamp unchanged if the dumpstate year has not
    /// yet been recorded.
    fn correct_logcat_year(&self, ts_current_year: i64) -> i64 {
        let ds_year = self.dumpstate_year.load(Ordering::Relaxed) as i64;
        if ds_year == 0 {
            return ts_current_year; // Dumpstate header not yet encountered
        }

        // Determine the inferred current year (same logic as logcat_parser).
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let inferred_year = 1970 + now_secs / 31_557_600; // 365.25 days

        // If the dumpstate year matches the inferred year, no shift needed.
        if ds_year == inferred_year {
            // Still check for year rollover (Dec date in Jan bugreport).
            let dumpstate_ts = self.dumpstate_ts_ns.load(Ordering::Relaxed);
            const GRACE_NS: i64 = 5 * 60 * 1_000_000_000;
            if ts_current_year > dumpstate_ts + GRACE_NS {
                return ts_current_year + year_offset_ns(inferred_year, ds_year - 1);
            }
            return ts_current_year;
        }

        // Shift from inferred year to dumpstate year.
        let ts_shifted = ts_current_year + year_offset_ns(inferred_year, ds_year);

        let dumpstate_ts = self.dumpstate_ts_ns.load(Ordering::Relaxed);
        const GRACE_NS: i64 = 5 * 60 * 1_000_000_000;
        if ts_shifted > dumpstate_ts + GRACE_NS {
            // Date is past the dumpstate capture — belongs to the previous year.
            ts_current_year + year_offset_ns(inferred_year, ds_year - 1)
        } else {
            ts_shifted
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

    /// Helper: expected Unix nanos for a given civil datetime (UTC).
    fn expected_ns(year: i64, month: i64, day: i64, h: i64, m: i64, s: i64, ms: i64) -> i64 {
        days_from_civil(year, month, day) * 86_400_000_000_000
            + h * 3_600_000_000_000
            + m * 60_000_000_000
            + s * 1_000_000_000
            + ms * 1_000_000
    }

    /// Logcat lines parsed after the dumpstate header should have the capture
    /// year applied.
    #[test]
    fn logcat_year_corrected_after_dumpstate_header() {
        let p = BugreportParser::new();
        p.parse_meta("== dumpstate: 2026-02-16 17:27:35", 0).unwrap();

        let m = p
            .parse_meta("02-16 17:24:00.058  1587  1587 E Watchdog: !@Sync timeout", 0)
            .unwrap();
        assert_eq!(m.timestamp, expected_ns(2026, 2, 16, 17, 24, 0, 58));
    }

    /// Log lines within the 5-minute grace window after the capture timestamp
    /// must not be rolled back to the previous year.
    #[test]
    fn logcat_line_within_grace_period_keeps_current_year() {
        let p = BugreportParser::new();
        p.parse_meta("== dumpstate: 2026-02-14 21:23:17", 0).unwrap();

        let m = p
            .parse_meta("02-14 21:24:40.000  1000  1234  5678 I Tag: grace test", 0)
            .unwrap();

        let start_2026 = expected_ns(2026, 1, 1, 0, 0, 0, 0);
        let start_2027 = expected_ns(2027, 1, 1, 0, 0, 0, 0);
        assert!(
            m.timestamp >= start_2026 && m.timestamp < start_2027,
            "timestamp should be in year 2026 (not rolled back to 2025), got {}",
            m.timestamp
        );
    }

    /// Dec 31 log lines in a Jan 1 bugreport must be attributed to year N-1,
    /// while Jan 1 lines from before the capture time stay in year N.
    #[test]
    fn dec_jan_boundary_year_attribution() {
        let p = BugreportParser::new();
        p.parse_meta("== dumpstate: 2026-01-01 00:01:00", 0).unwrap();

        let dec31 = p
            .parse_meta("12-31 23:55:00.000  1000  1000 I Tag: december log", 0)
            .unwrap();
        let jan1 = p
            .parse_meta("01-01 00:00:30.000  1000  1000 I Tag: january log", 0)
            .unwrap();

        let start_2025 = expected_ns(2025, 1, 1, 0, 0, 0, 0);
        let start_2026 = expected_ns(2026, 1, 1, 0, 0, 0, 0);
        let start_2027 = expected_ns(2027, 1, 1, 0, 0, 0, 0);

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

    /// A seeded BugreportParser produces the same timestamps as a full-parse one.
    #[test]
    fn seeded_parser_year_corrects_identically_to_full_parse() {
        let full = BugreportParser::new();
        full.parse_meta("== dumpstate: 2026-02-14 21:23:17", 0).unwrap();
        let expected = full
            .parse_meta("02-14 09:16:57.849  1000  1234  5678 I ActivityManager: msg", 0)
            .unwrap()
            .timestamp;
        assert!(expected > 0);

        let seeded = BugreportParser::new();
        seeded.parse_meta("== dumpstate: 2026-02-14 21:23:17", 0).unwrap();
        let actual = seeded
            .parse_meta("02-14 09:16:57.849  1000  1234  5678 I ActivityManager: msg", 0)
            .unwrap()
            .timestamp;

        assert_eq!(actual, expected);
        assert!(
            actual >= expected_ns(2026, 1, 1, 0, 0, 0, 0),
            "timestamp should be in year 2026, got {}",
            actual
        );
    }

    /// Without seeding, a fresh BugreportParser uses the current system year
    /// (from parse_timestamp_ns). Timestamps should still be reasonable.
    #[test]
    fn unseeded_parser_produces_current_year_timestamps() {
        let unseeded = BugreportParser::new();
        let m = unseeded
            .parse_meta("02-14 09:16:57.849  1000  1234  5678 I ActivityManager: msg", 0)
            .unwrap();

        // Should be in the current year (not year 2000).
        let current_year_start = expected_ns(2025, 1, 1, 0, 0, 0, 0);
        assert!(
            m.timestamp >= current_year_start,
            "unseeded parser should produce a current-year timestamp, got {}",
            m.timestamp
        );
    }

    /// A Dec 30 log line in a Jan 5 bugreport should be attributed to year - 1.
    #[test]
    fn logcat_year_rollover_dec_in_jan_bugreport() {
        let p = BugreportParser::new();
        p.parse_meta("== dumpstate: 2026-01-05 10:00:00", 0).unwrap();

        let m = p
            .parse_meta("12-30 23:55:00.000  1000  1000 I Tag: rollover test", 0)
            .unwrap();

        assert_eq!(m.timestamp, expected_ns(2025, 12, 30, 23, 55, 0, 0));
    }
}
