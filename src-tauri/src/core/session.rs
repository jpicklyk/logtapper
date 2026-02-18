use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;

use crate::core::bugreport_parser::BugreportParser;
use crate::core::index::CrossSourceIndex;
use crate::core::kernel_parser::KernelParser;
use crate::core::line::LineMeta;
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;
use crate::core::timeline::{Timeline, TimelineEntry};

// ---------------------------------------------------------------------------
// Source type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum SourceType {
    Logcat,
    Kernel,
    Radio,
    Events,
    Bugreport,
    Tombstone,
    ANRTrace,
    Custom { parser_id: String },
}

impl std::fmt::Display for SourceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SourceType::Logcat => write!(f, "Logcat"),
            SourceType::Kernel => write!(f, "Kernel"),
            SourceType::Radio => write!(f, "Radio"),
            SourceType::Events => write!(f, "Events"),
            SourceType::Bugreport => write!(f, "Bugreport"),
            SourceType::Tombstone => write!(f, "Tombstone"),
            SourceType::ANRTrace => write!(f, "ANRTrace"),
            SourceType::Custom { parser_id } => write!(f, "Custom({})", parser_id),
        }
    }
}

// ---------------------------------------------------------------------------
// LogSource — one file, memory-mapped
// ---------------------------------------------------------------------------

pub struct LogSource {
    pub id: String,
    pub name: String,
    pub source_type: SourceType,
    pub mmap: Mmap,
    /// (byte_offset, byte_len) for every indexed line.
    pub line_index: Vec<(usize, usize)>,
    /// Lightweight metadata for every indexed line.
    pub line_meta: Vec<LineMeta>,
}

impl LogSource {
    pub fn total_lines(&self) -> usize {
        self.line_index.len()
    }

    pub fn raw_line(&self, line_num: usize) -> Option<&str> {
        let (off, len) = self.line_index.get(line_num)?;
        std::str::from_utf8(&self.mmap[*off..*off + *len]).ok()
    }

    pub fn first_timestamp(&self) -> Option<i64> {
        self.line_meta
            .iter()
            .find(|m| m.timestamp > 0)
            .map(|m| m.timestamp)
    }

    pub fn last_timestamp(&self) -> Option<i64> {
        self.line_meta
            .iter()
            .rev()
            .find(|m| m.timestamp > 0)
            .map(|m| m.timestamp)
    }
}

// ---------------------------------------------------------------------------
// AnalysisSession — owns all sources for one "workspace"
// ---------------------------------------------------------------------------

pub struct AnalysisSession {
    pub id: String,
    pub sources: Vec<LogSource>,
    pub timeline: Timeline,
    pub index: CrossSourceIndex,
}

impl AnalysisSession {
    pub fn new(id: String) -> Self {
        Self {
            id,
            sources: Vec::new(),
            timeline: Timeline::new(),
            index: CrossSourceIndex::build(&[]),
        }
    }

    /// Load a file, detect its type, build the line index, and add it.
    /// Returns the new source's index in `self.sources`.
    pub fn add_source_from_file(
        &mut self,
        path: &Path,
        source_id: String,
    ) -> Result<usize, String> {
        let file =
            File::open(path).map_err(|e| format!("Cannot open '{}': {e}", path.display()))?;

        // Safety: the file is opened read-only; other processes may write to it,
        // but we accept that risk for large-file performance.
        let mmap =
            unsafe { Mmap::map(&file) }.map_err(|e| format!("Cannot mmap file: {e}"))?;

        let source_type = detect_source_type(&mmap);

        let (line_index, line_meta) = build_line_index(&mmap, &source_type);

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let idx = self.sources.len();
        self.sources.push(LogSource {
            id: source_id,
            name,
            source_type,
            mmap,
            line_index,
            line_meta,
        });

        // Rebuild the timeline and index after adding a new source.
        self.rebuild_timeline();

        Ok(idx)
    }

    /// Rebuild the unified timeline and cross-source index from all loaded sources.
    pub fn rebuild_timeline(&mut self) {
        let all_entries: Vec<TimelineEntry> = self
            .sources
            .iter()
            .flat_map(|src| {
                src.line_meta.iter().enumerate().map(|(i, m)| TimelineEntry {
                    source_id: src.id.clone(),
                    source_line_num: i,
                    timestamp: m.timestamp,
                    level: m.level,
                    tag: m.tag.clone(),
                })
            })
            .collect();

        self.timeline = Timeline::build(
            // Pass a single "all entries" iterator; Timeline::build just flattens.
            std::iter::once(("", all_entries.into_iter())),
        );
        self.index = CrossSourceIndex::build(&self.timeline.entries);
    }

    pub fn source_by_id(&self, id: &str) -> Option<&LogSource> {
        self.sources.iter().find(|s| s.id == id)
    }

    /// First source — convenience for single-source Phase 1 usage.
    pub fn primary_source(&self) -> Option<&LogSource> {
        self.sources.first()
    }
}

// ---------------------------------------------------------------------------
// Source-type detection
// ---------------------------------------------------------------------------

fn detect_source_type(mmap: &Mmap) -> SourceType {
    // Sample the first 4 KB for heuristics
    let sample = &mmap[..mmap.len().min(4096)];
    let text = std::str::from_utf8(sample).unwrap_or("");

    if text.contains("--------- beginning of") || is_logcat_threadtime(text) {
        return SourceType::Logcat;
    }
    if text.contains("[    0.") || text.contains("Linux version") || text.starts_with('[') {
        return SourceType::Kernel;
    }
    if text.contains("RILJ") || text.contains("RIL") {
        return SourceType::Radio;
    }

    SourceType::Logcat // safe default
}

fn is_logcat_threadtime(sample: &str) -> bool {
    // Check if the first non-empty line matches the threadtime pattern
    for line in sample.lines().take(10) {
        if line.starts_with("-----") {
            continue;
        }
        // Quick byte-level check: "MM-DD HH:MM:SS"
        let b = line.as_bytes();
        if b.len() > 14
            && b[2] == b'-'
            && b[5] == b' '
            && b[8] == b':'
            && b[11] == b':'
            && b[14] == b'.'
        {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Line indexer — scans the mmap once, builds per-line metadata
// ---------------------------------------------------------------------------

fn build_line_index(mmap: &Mmap, source_type: &SourceType) -> (Vec<(usize, usize)>, Vec<LineMeta>) {
    let parser: Box<dyn LogParser> = parser_for(source_type);
    let data = mmap.as_ref();

    // Pre-allocate rough estimate (avg 120 bytes/line)
    let estimate = (data.len() / 120).max(1024);
    let mut line_index: Vec<(usize, usize)> = Vec::with_capacity(estimate);
    let mut line_meta: Vec<LineMeta> = Vec::with_capacity(estimate);

    let mut start = 0usize;
    let len = data.len();

    for i in 0..len {
        if data[i] == b'\n' || i == len - 1 {
            let end = if data[i] == b'\n' { i } else { i + 1 };

            // Strip trailing \r if present
            let content_end = if end > start && data[end - 1] == b'\r' {
                end - 1
            } else {
                end
            };

            if content_end > start {
                let raw = match std::str::from_utf8(&data[start..content_end]) {
                    Ok(s) if !s.trim().is_empty() => s,
                    _ => {
                        start = i + 1;
                        continue;
                    }
                };

                if let Some(meta) = parser.parse_meta(raw, start) {
                    line_index.push((start, content_end - start));
                    line_meta.push(meta);
                }
                // Lines that return None from parse_meta (e.g. section headers) are skipped.
            }

            start = i + 1;
        }
    }

    (line_index, line_meta)
}

fn parser_for(source_type: &SourceType) -> Box<dyn LogParser> {
    match source_type {
        SourceType::Logcat | SourceType::Radio | SourceType::Events => Box::new(LogcatParser),
        SourceType::Kernel => Box::new(KernelParser),
        SourceType::Bugreport => Box::new(BugreportParser),
        _ => Box::new(LogcatParser),
    }
}
