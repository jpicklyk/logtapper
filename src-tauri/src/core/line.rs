use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};

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

/// The view of a single log line passed to processors and scripts.
#[derive(Debug, Clone, Serialize)]
pub struct LineContext {
    pub raw: String,
    pub timestamp: i64,       // Nanos since epoch
    pub level: LogLevel,
    pub tag: String,
    pub pid: i32,
    pub tid: i32,
    pub message: String,
    pub source_id: String,
    pub source_line_num: usize,
    /// Fields extracted by upstream pipeline stages.
    pub fields: BTreeMap<String, serde_json::Value>,
}

/// Lightweight metadata stored for every line (used by the viewer / search).
#[derive(Debug, Clone, Serialize)]
pub struct LineMeta {
    pub level: LogLevel,
    pub tag: String,
    pub timestamp: i64,
    pub byte_offset: usize,
    pub byte_len: usize,
}
