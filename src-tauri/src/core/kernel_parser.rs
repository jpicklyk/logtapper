use std::sync::OnceLock;
use regex::Regex;

use crate::core::line::{LineContext, LineMeta, LogLevel};
use crate::core::parser::LogParser;

// ---------------------------------------------------------------------------
// KernelParser — parses dmesg / kmsg format
//
// Typical formats:
//   [12345.678901] wlan: firmware crash detected
//   [    0.000000] Linux version 5.10.43 ...
//   <3>[12345.678] (name)      message
// ---------------------------------------------------------------------------

static KERNEL_RE: OnceLock<Regex> = OnceLock::new();

fn kernel_re() -> &'static Regex {
    KERNEL_RE.get_or_init(|| {
        // Matches: optional <level> [ timestamp ] optional:(func) message
        Regex::new(r"^(?:<(\d+)>)?\[\s*(\d+\.\d+)\]\s+(?:\((\S+)\)\s+)?(.*)$").unwrap()
    })
}

/// Convert kmsg level integer to LogLevel.
fn kmsg_level(n: u64) -> LogLevel {
    match n & 7 {
        0 => LogLevel::Fatal,   // KERN_EMERG
        1 => LogLevel::Fatal,   // KERN_ALERT
        2 => LogLevel::Error,   // KERN_CRIT
        3 => LogLevel::Error,   // KERN_ERR
        4 => LogLevel::Warn,    // KERN_WARNING
        5 => LogLevel::Info,    // KERN_NOTICE
        6 => LogLevel::Info,    // KERN_INFO
        _ => LogLevel::Debug,   // KERN_DEBUG
    }
}

pub struct KernelParser;

impl LogParser for KernelParser {
    fn parse_line(&self, raw: &str, source_id: &str, line_num: usize) -> Option<LineContext> {
        let re = kernel_re();
        let caps = re.captures(raw)?;

        let level = caps
            .get(1)
            .and_then(|m| m.as_str().parse::<u64>().ok())
            .map(kmsg_level)
            .unwrap_or(LogLevel::Info);

        let timestamp_sec: f64 = caps.get(2)?.as_str().parse().ok()?;
        // Convert to nanos since 2000-01-01 UTC
        // Kernel timestamps are seconds since boot — we use them as-is offset from epoch
        const BASE_NS: i64 = 946_684_800_000_000_000;
        let timestamp = BASE_NS + (timestamp_sec * 1_000_000_000.0) as i64;

        let tag = caps
            .get(3)
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| "kernel".to_string());

        let message = caps.get(4).map(|m| m.as_str().to_string()).unwrap_or_default();

        Some(LineContext {
            raw: raw.to_string(),
            timestamp,
            level,
            tag,
            pid: 0,
            tid: 0,
            message,
            source_id: source_id.to_string(),
            source_line_num: line_num,
            fields: Default::default(),
            annotations: Vec::new(),
        })
    }

    fn parse_meta(&self, raw: &str, byte_offset: usize) -> Option<LineMeta> {
        let ctx = self.parse_line(raw, "", 0)?;
        Some(LineMeta {
            level: ctx.level,
            tag: ctx.tag,
            timestamp: ctx.timestamp,
            byte_offset,
            byte_len: raw.len(),
            is_section_boundary: false,
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_dmesg() {
        let line = "[12345.678901] wlan: firmware crash detected";
        let p = KernelParser;
        let ctx = p.parse_line(line, "kernel", 0).unwrap();
        assert_eq!(ctx.tag, "kernel");
        assert!(ctx.message.contains("firmware crash"));
        assert!(ctx.timestamp > 0);
    }

    #[test]
    fn parses_kmsg_with_level() {
        let line = "<3>[  0.000001] (swapper) Linux version 5.10";
        let p = KernelParser;
        let ctx = p.parse_line(line, "kernel", 0).unwrap();
        assert_eq!(ctx.level, LogLevel::Error);
        assert_eq!(ctx.tag, "swapper");
    }

    // --- parse_meta() tests (exercising the indexing path) ---

    #[test]
    fn parse_meta_extracts_fields() {
        let line = "[12345.678901] wlan: firmware crash detected";
        let p = KernelParser;
        let meta = p.parse_meta(line, 500).unwrap();

        assert_eq!(meta.level, LogLevel::Info);
        assert_eq!(meta.tag, "kernel");
        assert!(meta.timestamp > 0);
        assert_eq!(meta.byte_offset, 500);
        assert_eq!(meta.byte_len, line.len());
    }

    #[test]
    fn parse_meta_timestamp_matches_parse_line() {
        let line = "[12345.678901] wlan: firmware crash detected";
        let p = KernelParser;
        let meta = p.parse_meta(line, 0).unwrap();
        let ctx = p.parse_line(line, "kernel", 0).unwrap();

        assert_eq!(
            meta.timestamp, ctx.timestamp,
            "parse_meta and parse_line must produce identical timestamps"
        );
        assert_eq!(meta.level, ctx.level);
        assert_eq!(meta.tag, ctx.tag);
    }

    #[test]
    fn parse_meta_returns_none_for_non_kernel() {
        let line = "this is not a kernel line";
        let p = KernelParser;
        assert!(
            p.parse_meta(line, 0).is_none(),
            "non-kernel lines should return None from parse_meta"
        );
    }
}
