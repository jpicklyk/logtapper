/// Bugreport parser stub — Phase 3 foundation.
///
/// A bugreport ZIP/text contains multiple sections:
///   ------ SYSTEM LOG (logcat) ------
///   ------ KERNEL LOG ------
///   etc.
///
/// This stub passes everything through as Logcat lines, with future support
/// for detecting and splitting sections.

use crate::core::line::{LineContext, LineMeta};
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;

pub struct BugreportParser;

impl LogParser for BugreportParser {
    fn parse_line(&self, raw: &str, source_id: &str, line_num: usize) -> Option<LineContext> {
        // Skip section header dividers
        if raw.starts_with("------") {
            return None;
        }
        // Delegate to logcat parser — most bugreport content is logcat formatted
        LogcatParser.parse_line(raw, source_id, line_num)
    }

    fn parse_meta(&self, raw: &str, byte_offset: usize) -> Option<LineMeta> {
        if raw.starts_with("------") {
            return None;
        }
        LogcatParser.parse_meta(raw, byte_offset)
    }
}
