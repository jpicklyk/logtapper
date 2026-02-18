/// Logcat "threadtime" format parser.
///
/// Handles the standard Android logcat format:
///   MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message
///
/// Also handles the less-common brief/long formats by falling through
/// to a raw-line representation rather than failing.
use regex::Regex;
use std::sync::OnceLock;

use crate::core::line::{LineContext, LineMeta, LogLevel};
use crate::core::parser::LogParser;

// ---------------------------------------------------------------------------
// Compiled regex — initialised once
// ---------------------------------------------------------------------------

static THREADTIME_RE: OnceLock<Regex> = OnceLock::new();
static BRIEF_RE: OnceLock<Regex> = OnceLock::new();

fn threadtime_re() -> &'static Regex {
    THREADTIME_RE.get_or_init(|| {
        // MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message
        Regex::new(
            r"^(\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFSvdiwefs])\s+(.*?):\s*(.*?)$",
        )
        .expect("threadtime regex is valid")
    })
}

fn brief_re() -> &'static Regex {
    BRIEF_RE.get_or_init(|| {
        // LEVEL/TAG(PID): message
        Regex::new(r"^([VDIWEFSvdiwefs])/(.+?)\(\s*(\d+)\):\s*(.*?)$")
            .expect("brief regex is valid")
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn parse_level(c: &str) -> LogLevel {
    match c.to_uppercase().as_str() {
        "V" => LogLevel::Verbose,
        "D" => LogLevel::Debug,
        "I" => LogLevel::Info,
        "W" => LogLevel::Warn,
        "E" => LogLevel::Error,
        "F" | "A" => LogLevel::Fatal,
        _ => LogLevel::Debug,
    }
}

/// Convert a logcat date+time string to nanoseconds since 2000-01-01 00:00:00 UTC.
/// We use year-2000 as the base epoch because logcat strips the year.
/// Relative ordering within a session is all we need.
fn parse_timestamp_ns(date: &str, time: &str) -> i64 {
    const BASE_NS: i64 = 946_684_800_000_000_000; // 2000-01-01 00:00:00 UTC

    let d: Vec<&str> = date.splitn(2, '-').collect();
    let month: i64 = d.first().and_then(|s| s.parse().ok()).unwrap_or(1);
    let day: i64 = d.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);

    // Days-from-year-start table (non-leap-year approximation is fine for ordering)
    const MONTH_DAYS: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let yday = MONTH_DAYS
        .get((month as usize).saturating_sub(1))
        .copied()
        .unwrap_or(0)
        + (day - 1);

    let t: Vec<&str> = time.splitn(4, |c| c == ':' || c == '.').collect();
    let h: i64 = t.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let m: i64 = t.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let s: i64 = t.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let ms: i64 = t.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);

    BASE_NS
        + yday * 86_400_000_000_000
        + h * 3_600_000_000_000
        + m * 60_000_000_000
        + s * 1_000_000_000
        + ms * 1_000_000
}

// ---------------------------------------------------------------------------
// Parser implementation
// ---------------------------------------------------------------------------

pub struct LogcatParser;

impl LogParser for LogcatParser {
    fn parse_line(&self, raw: &str, source_id: &str, line_num: usize) -> Option<LineContext> {
        let raw = raw.trim_end_matches(['\r', '\n']);

        // Skip section headers
        if raw.starts_with("-----") {
            return None;
        }

        // Try threadtime format first (most common)
        if let Some(ctx) = parse_threadtime(raw, source_id, line_num) {
            return Some(ctx);
        }

        // Try brief format
        if let Some(ctx) = parse_brief(raw, source_id, line_num) {
            return Some(ctx);
        }

        // Unrecognised — emit as raw Info line so nothing is lost
        Some(LineContext {
            raw: raw.to_string(),
            timestamp: 0,
            level: LogLevel::Info,
            tag: String::new(),
            pid: 0,
            tid: 0,
            message: raw.to_string(),
            source_id: source_id.to_string(),
            source_line_num: line_num,
            fields: Default::default(),
        })
    }

    fn parse_meta(&self, raw: &str, byte_offset: usize) -> Option<LineMeta> {
        let raw = raw.trim_end_matches(['\r', '\n']);

        if raw.starts_with("-----") {
            return None;
        }

        if let Some(caps) = threadtime_re().captures(raw) {
            let date = caps.get(1).map(|m| m.as_str()).unwrap_or("01-01");
            let time = caps.get(2).map(|m| m.as_str()).unwrap_or("00:00:00.000");
            let level_char = caps.get(5).map(|m| m.as_str()).unwrap_or("I");
            let tag = caps
                .get(6)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();

            return Some(LineMeta {
                level: parse_level(level_char),
                tag,
                timestamp: parse_timestamp_ns(date, time),
                byte_offset,
                byte_len: raw.len(),
            });
        }

        // Brief format — no timestamp, so use 0
        if let Some(caps) = brief_re().captures(raw) {
            let level_char = caps.get(1).map(|m| m.as_str()).unwrap_or("I");
            let tag = caps
                .get(2)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            return Some(LineMeta {
                level: parse_level(level_char),
                tag,
                timestamp: 0,
                byte_offset,
                byte_len: raw.len(),
            });
        }

        // Unknown format — still index the line
        Some(LineMeta {
            level: LogLevel::Info,
            tag: String::new(),
            timestamp: 0,
            byte_offset,
            byte_len: raw.len(),
        })
    }
}

fn parse_threadtime(raw: &str, source_id: &str, line_num: usize) -> Option<LineContext> {
    let caps = threadtime_re().captures(raw)?;

    let date = caps.get(1)?.as_str();
    let time_str = caps.get(2)?.as_str();
    let pid: i32 = caps.get(3)?.as_str().parse().unwrap_or(0);
    let tid: i32 = caps.get(4)?.as_str().parse().unwrap_or(0);
    let level_char = caps.get(5)?.as_str();
    let tag = caps.get(6)?.as_str().trim().to_string();
    let message = caps.get(7)?.as_str().to_string();

    Some(LineContext {
        raw: raw.to_string(),
        timestamp: parse_timestamp_ns(date, time_str),
        level: parse_level(level_char),
        tag,
        pid,
        tid,
        message,
        source_id: source_id.to_string(),
        source_line_num: line_num,
        fields: Default::default(),
    })
}

fn parse_brief(raw: &str, source_id: &str, line_num: usize) -> Option<LineContext> {
    let caps = brief_re().captures(raw)?;

    let level_char = caps.get(1)?.as_str();
    let tag = caps.get(2)?.as_str().trim().to_string();
    let pid: i32 = caps.get(3)?.as_str().parse().unwrap_or(0);
    let message = caps.get(4)?.as_str().to_string();

    Some(LineContext {
        raw: raw.to_string(),
        timestamp: 0,
        level: parse_level(level_char),
        tag,
        pid,
        tid: 0,
        message,
        source_id: source_id.to_string(),
        source_line_num: line_num,
        fields: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::parser::LogParser;

    #[test]
    fn parses_threadtime_line() {
        let line = "01-17 10:23:45.123  1234  5678 E ActivityManager: Something went wrong";
        let parser = LogcatParser;
        let ctx = parser.parse_line(line, "test", 0).unwrap();
        assert_eq!(ctx.level, LogLevel::Error);
        assert_eq!(ctx.tag, "ActivityManager");
        assert_eq!(ctx.message, "Something went wrong");
        assert_eq!(ctx.pid, 1234);
        assert_eq!(ctx.tid, 5678);
    }

    #[test]
    fn parses_brief_line() {
        let line = "D/MyTag( 999): debug message";
        let parser = LogcatParser;
        let ctx = parser.parse_line(line, "test", 0).unwrap();
        assert_eq!(ctx.level, LogLevel::Debug);
        assert_eq!(ctx.tag, "MyTag");
        assert_eq!(ctx.pid, 999);
    }

    #[test]
    fn timestamp_ordering_is_monotonic() {
        let t1 = parse_timestamp_ns("01-01", "00:00:00.000");
        let t2 = parse_timestamp_ns("01-01", "00:00:00.001");
        let t3 = parse_timestamp_ns("01-02", "00:00:00.000");
        assert!(t1 < t2);
        assert!(t2 < t3);
    }

    #[test]
    fn skips_section_headers() {
        let line = "--------- beginning of main";
        let parser = LogcatParser;
        assert!(parser.parse_line(line, "test", 0).is_none());
    }
}
