use crate::core::line::{LineContext, ParsedLineMeta};

/// Trait implemented by each log format parser.
pub trait LogParser: Send + Sync {
    fn parse_line(&self, raw: &str, source_id: &str, line_num: usize) -> Option<LineContext>;
    fn parse_meta(&self, raw: &str, byte_offset: usize) -> Option<ParsedLineMeta>;
}
