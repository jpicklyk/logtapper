// TODO Phase 1: Logcat format parser
// Format: MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message
use crate::core::line::{LineContext, LineMeta};
use crate::core::parser::LogParser;

pub struct LogcatParser;

impl LogParser for LogcatParser {
    fn parse_line(&self, _raw: &str, _source_id: &str, _line_num: usize) -> Option<LineContext> {
        todo!("Phase 1")
    }

    fn parse_meta(&self, _raw: &str, _byte_offset: usize) -> Option<LineMeta> {
        todo!("Phase 1")
    }
}
