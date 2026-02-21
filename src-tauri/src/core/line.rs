use std::collections::HashMap;
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

impl std::fmt::Display for LogLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
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

/// Full parsed representation of a single log line — used by processors/scripts.
#[derive(Debug, Clone, Serialize)]
pub struct LineContext {
    pub raw: String,
    pub timestamp: i64, // nanos since 2000-01-01 UTC
    pub level: LogLevel,
    pub tag: String,
    pub pid: i32,
    pub tid: i32,
    pub message: String,
    pub source_id: String,
    pub source_line_num: usize,
    /// Fields extracted by upstream pipeline stages.
    pub fields: HashMap<String, serde_json::Value>,
    /// Annotations applied by Annotator processors.
    #[serde(default)]
    pub annotations: Vec<Annotation>,
}

/// Lightweight per-line metadata stored alongside the mmap.
#[derive(Debug, Clone, Serialize)]
pub struct LineMeta {
    pub level: LogLevel,
    pub tag: String,
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
