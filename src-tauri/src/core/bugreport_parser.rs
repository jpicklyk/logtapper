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

use regex::Regex;
use std::sync::OnceLock;

use crate::core::line::{LineContext, LineMeta, LogLevel};
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

/// Convert a full dumpstate datetime to nanoseconds since 2000-01-01 00:00:00 UTC.
///
/// This uses the same epoch base as the logcat parser so timestamps are
/// comparable across sources within a single session.
fn parse_dumpstate_timestamp(year: i64, month: i64, day: i64, hour: i64, min: i64, sec: i64) -> i64 {
    const BASE_NS: i64 = 946_684_800_000_000_000; // 2000-01-01 00:00:00 UTC

    let years_since_2000 = year - 2000;
    // Approximate leap-day count from year 2000 up to (but not including) `year`.
    let leap_days = years_since_2000 / 4 - years_since_2000 / 100 + years_since_2000 / 400;
    let year_days = years_since_2000 * 365 + leap_days;

    const MONTH_DAYS: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let is_leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days = MONTH_DAYS[(month as usize).saturating_sub(1)];
    let leap_add: i64 = if is_leap && month > 2 { 1 } else { 0 };

    let total_days = year_days + month_days + leap_add + (day - 1);

    BASE_NS
        + total_days * 86_400_000_000_000
        + hour * 3_600_000_000_000
        + min * 60_000_000_000
        + sec * 1_000_000_000
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

pub struct BugreportParser;

impl BugreportParser {
    /// Shared logic: classify one raw line and return its metadata fields.
    /// Called by both `parse_meta` and `parse_line` to avoid duplication.
    fn classify(&self, raw: &str, byte_offset: usize) -> LineMeta {
        // Decorative `====` separators at the top of the dumpstate header.
        if raw.starts_with("====") {
            return LineMeta {
                level: LogLevel::Verbose,
                tag: String::new(),
                timestamp: 0,
                byte_offset,
                byte_len: raw.len(),
            };
        }

        // `== dumpstate: YYYY-MM-DD HH:MM:SS` — file-level timestamp.
        if let Some(caps) = dumpstate_ts_re().captures(raw) {
            let y: i64 = caps.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(2000);
            let mo: i64 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(1);
            let d: i64 = caps.get(3).and_then(|m| m.as_str().parse().ok()).unwrap_or(1);
            let h: i64 = caps.get(4).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let mi: i64 = caps.get(5).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let s: i64 = caps.get(6).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            return LineMeta {
                level: LogLevel::Info,
                tag: "dumpstate".to_string(),
                timestamp: parse_dumpstate_timestamp(y, mo, d, h, mi, s),
                byte_offset,
                byte_len: raw.len(),
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
            return LineMeta {
                level,
                tag,
                timestamp: 0,
                byte_offset,
                byte_len: raw.len(),
            };
        }

        // Plain content line — key:value pairs, prose, numbers, etc.
        LineMeta {
            level: LogLevel::Info,
            tag: String::new(),
            timestamp: 0,
            byte_offset,
            byte_len: raw.len(),
        }
    }
}

impl LogParser for BugreportParser {
    fn parse_meta(&self, raw: &str, byte_offset: usize) -> Option<LineMeta> {
        let raw = raw.trim_end_matches(['\r', '\n']);
        Some(self.classify(raw, byte_offset))
    }

    fn parse_line(&self, raw: &str, source_id: &str, line_num: usize) -> Option<LineContext> {
        let raw = raw.trim_end_matches(['\r', '\n']);
        let meta = self.classify(raw, 0);
        Some(LineContext {
            raw: raw.to_string(),
            timestamp: meta.timestamp,
            level: meta.level,
            tag: meta.tag,
            pid: 0,
            tid: 0,
            message: raw.to_string(),
            source_id: source_id.to_string(),
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
        let p = BugreportParser;
        let m = p.parse_meta("------ MEMORY INFO (/proc/meminfo) ------", 0).unwrap();
        assert_eq!(m.tag, "MEMORY INFO");
        assert_eq!(m.level, LogLevel::Info);
    }

    #[test]
    fn parses_section_header_no_source() {
        let p = BugreportParser;
        let m = p.parse_meta("------ CPU INFO ------", 0).unwrap();
        assert_eq!(m.tag, "CPU INFO");
    }

    #[test]
    fn parses_duration_footer() {
        let p = BugreportParser;
        let m = p
            .parse_meta("------ 0.011s was the duration of 'MEMORY INFO' ------", 0)
            .unwrap();
        assert_eq!(m.tag, "MEMORY INFO");
        assert_eq!(m.level, LogLevel::Verbose);
    }

    #[test]
    fn parses_dumpstate_timestamp() {
        let p = BugreportParser;
        let m = p
            .parse_meta("== dumpstate: 2026-02-16 17:27:35", 0)
            .unwrap();
        assert_eq!(m.tag, "dumpstate");
        assert!(m.timestamp > 0, "timestamp should be positive");
    }

    #[test]
    fn indexes_plain_content_lines() {
        let p = BugreportParser;
        let m = p.parse_meta("MemTotal:        5843088 kB", 0).unwrap();
        assert_eq!(m.level, LogLevel::Info);
        assert_eq!(m.tag, "");
    }

    #[test]
    fn skips_decorative_separator() {
        let p = BugreportParser;
        let m = p
            .parse_meta("========================================================", 0)
            .unwrap();
        assert_eq!(m.level, LogLevel::Verbose);
        assert_eq!(m.tag, "");
    }
}
