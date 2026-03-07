use std::collections::HashMap;
use std::sync::Arc;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Core log-line types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum LogLevel {
    Verbose,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl LogLevel {
    /// Zero-allocation conversion to a static string matching `Debug`/serde output.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Verbose => "Verbose",
            Self::Debug => "Debug",
            Self::Info => "Info",
            Self::Warn => "Warn",
            Self::Error => "Error",
            Self::Fatal => "Fatal",
        }
    }

    /// Parse a log-level string (short or long form).
    ///
    /// Recognises single-char Android logcat abbreviations (`V`, `D`, `I`, `W`,
    /// `E`, `F`, `A`), long-form names (`VERBOSE`, `DEBUG`, etc.), and common
    /// aliases (`WARNING`, `ASSERT`).
    pub fn from_str_loose(s: &str) -> Option<LogLevel> {
        match s.to_uppercase().as_str() {
            "V" | "VERBOSE" => Some(Self::Verbose),
            "D" | "DEBUG" => Some(Self::Debug),
            "I" | "INFO" => Some(Self::Info),
            "W" | "WARN" | "WARNING" => Some(Self::Warn),
            "E" | "ERROR" => Some(Self::Error),
            "F" | "A" | "FATAL" | "ASSERT" => Some(Self::Fatal),
            _ => None,
        }
    }
}

impl std::fmt::Display for LogLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}


// ---------------------------------------------------------------------------
// Annotation -- applied by Annotator processors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Annotation {
    pub source_id: String,
    pub label: String,
    pub color: Option<String>,
}

use crate::core::session::{SectionInfo, SourceType};

/// Pipeline-wide context passed alongside LineContext to processors.
/// Contains metadata that the pipeline knows but parsers don't produce.
#[derive(Debug, Clone)]
pub struct PipelineContext {
    /// Source type enum (Logcat, Bugreport, Kernel, etc.)
    pub source_type: SourceType,
    /// Source name (filename or device serial)
    pub source_name: Arc<str>,
    /// True for ADB streaming, false for file analysis
    pub is_streaming: bool,
    /// Sorted section info for binary search (bugreport only; empty for other types)
    pub sections: Arc<[SectionInfo]>,
}

#[cfg(test)]
impl PipelineContext {
    /// Default test context: Logcat, non-streaming, no sections.
    pub fn test_default() -> Self {
        Self {
            source_type: SourceType::Logcat,
            source_name: Arc::from("test"),
            is_streaming: false,
            sections: Arc::from([]),
        }
    }
}

/// Look up which section a given line belongs to via binary search.
/// Returns the section name, or "" if the line is not in any section.
pub fn section_for_line(sections: &[SectionInfo], line_num: usize) -> &str {
    if sections.is_empty() {
        return "";
    }
    // Find the last section whose start_line <= line_num
    let pos = sections.partition_point(|s| s.start_line <= line_num);
    if pos == 0 {
        return ""; // line_num is before the first section
    }
    let section = &sections[pos - 1];
    if line_num <= section.end_line {
        &section.name
    } else {
        "" // line_num is between sections (gap)
    }
}

/// Full parsed representation of a single log line — used by processors/scripts.
#[derive(Debug, Clone, Serialize)]
pub struct LineContext {
    pub raw: Arc<str>,
    pub timestamp: i64, // nanos since 2000-01-01 UTC
    pub level: LogLevel,
    pub tag: Arc<str>,
    pub pid: i32,
    pub tid: i32,
    pub message: Arc<str>,
    pub source_id: Arc<str>,
    pub source_line_num: usize,
    /// Fields extracted by upstream pipeline stages.
    pub fields: HashMap<String, serde_json::Value>,
    /// Annotations applied by Annotator processors.
    #[serde(default)]
    pub annotations: Vec<Annotation>,
}

/// Intermediate per-line metadata returned by parsers (contains tag as String).
/// Converted to `LineMeta` (with interned `tag_id`) during indexing.
#[derive(Debug, Clone)]
pub struct ParsedLineMeta {
    pub level: LogLevel,
    pub tag: String,
    pub timestamp: i64,
    pub byte_offset: usize,
    pub byte_len: usize,
    pub is_section_boundary: bool,
}

/// Lightweight per-line metadata stored alongside the mmap.
/// Tags are interned via `TagInterner` — use `session.resolve_tag(tag_id)` to get the string.
#[derive(Debug, Clone, Serialize)]
pub struct LineMeta {
    pub level: LogLevel,
    pub tag_id: u16,
    pub timestamp: i64,
    pub byte_offset: usize,
    pub byte_len: usize,
    /// True only for `------` section header/footer lines in bugreport files.
    /// Used by `build_section_index` to distinguish section boundaries from
    /// regular logcat lines (which also have non-empty tags and Info level).
    #[serde(default)]
    pub is_section_boundary: bool,
}

// ---------------------------------------------------------------------------
// IPC types (cross the Tauri invoke boundary)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub text: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default = "bool_true")]
    pub case_sensitive: bool,
    pub within_processor: Option<String>,
    pub min_level: Option<LogLevel>,
    pub tags: Option<Vec<String>>,
    /// Optional time-of-day lower bound, format "HH:MM" or "HH:MM:SS"
    #[serde(default)]
    pub start_time: Option<String>,
    /// Optional time-of-day upper bound, format "HH:MM" or "HH:MM:SS"
    #[serde(default)]
    pub end_time: Option<String>,
}

fn bool_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", content = "center", rename_all = "PascalCase")]
pub enum ViewMode {
    Full,
    Processor,
    Focus(usize),
}

#[allow(clippy::derivable_impls)]
impl Default for ViewMode {
    fn default() -> Self {
        ViewMode::Full
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRequest {
    pub session_id: String,
    #[serde(default)]
    pub mode: ViewMode,
    #[serde(default)]
    pub offset: usize,
    pub count: usize,
    #[serde(default)]
    pub context: usize,
    pub processor_id: Option<String>,
    pub search: Option<SearchQuery>,
}

// ---------------------------------------------------------------------------
// Highlight system
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "PascalCase")]
pub enum HighlightKind {
    Search,
    SearchActive,
    ProcessorMatch { id: String },
    ExtractedField { name: String },
    PiiReplaced,
}

#[derive(Debug, Clone, Serialize)]
pub struct HighlightSpan {
    pub start: usize,
    pub end: usize,
    pub kind: HighlightKind,
}

// ---------------------------------------------------------------------------
// View types — what the frontend receives
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewLine {
    pub line_num: usize,
    pub virtual_index: usize,
    pub raw: String,
    pub level: LogLevel,
    pub tag: String,
    pub message: String,
    pub timestamp: i64,
    pub pid: i32,
    pub tid: i32,
    pub source_id: String,
    pub highlights: Vec<HighlightSpan>,
    pub matched_by: Vec<String>,
    pub is_context: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineWindow {
    pub total_lines: usize,
    pub lines: Vec<ViewLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    pub total_matches: usize,
    pub match_line_nums: Vec<usize>,
    pub by_level: HashMap<String, usize>,
    pub by_tag: HashMap<String, usize>,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::session::SectionInfo;

    fn make_sections() -> Vec<SectionInfo> {
        vec![
            SectionInfo { name: "SYSTEM LOG".to_string(), start_line: 10, end_line: 50 },
            SectionInfo { name: "DUMP OF SERVICE wifi".to_string(), start_line: 60, end_line: 100 },
            SectionInfo { name: "DUMPSYS".to_string(), start_line: 120, end_line: 200 },
        ]
    }

    #[test]
    fn section_for_line_empty_sections() {
        assert_eq!(section_for_line(&[], 42), "");
    }

    #[test]
    fn section_for_line_before_first_section() {
        let sections = make_sections();
        assert_eq!(section_for_line(&sections, 5), "");
    }

    #[test]
    fn section_for_line_at_start_boundary() {
        let sections = make_sections();
        assert_eq!(section_for_line(&sections, 10), "SYSTEM LOG");
    }

    #[test]
    fn section_for_line_at_end_boundary() {
        let sections = make_sections();
        assert_eq!(section_for_line(&sections, 50), "SYSTEM LOG");
    }

    #[test]
    fn section_for_line_middle_of_section() {
        let sections = make_sections();
        assert_eq!(section_for_line(&sections, 30), "SYSTEM LOG");
        assert_eq!(section_for_line(&sections, 80), "DUMP OF SERVICE wifi");
        assert_eq!(section_for_line(&sections, 150), "DUMPSYS");
    }

    #[test]
    fn section_for_line_between_sections() {
        let sections = make_sections();
        // Gap between SYSTEM LOG (end 50) and wifi (start 60)
        assert_eq!(section_for_line(&sections, 55), "");
        // Gap between wifi (end 100) and DUMPSYS (start 120)
        assert_eq!(section_for_line(&sections, 110), "");
    }

    #[test]
    fn section_for_line_after_last_section() {
        let sections = make_sections();
        assert_eq!(section_for_line(&sections, 250), "");
    }

    #[test]
    fn pipeline_context_clone() {
        let ctx = PipelineContext {
            source_type: crate::core::session::SourceType::Bugreport,
            source_name: Arc::from("test.txt"),
            is_streaming: false,
            sections: Arc::from(make_sections().as_slice()),
        };
        let cloned = ctx.clone();
        assert_eq!(cloned.source_type, crate::core::session::SourceType::Bugreport);
        assert_eq!(cloned.sections.len(), 3);
    }

    #[test]
    fn pipeline_context_test_default() {
        let ctx = PipelineContext::test_default();
        assert_eq!(ctx.source_type, crate::core::session::SourceType::Logcat);
        assert!(!ctx.is_streaming);
        assert!(ctx.sections.is_empty());
    }
}
