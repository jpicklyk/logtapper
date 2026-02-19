use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;

use crate::core::bugreport_parser::BugreportParser;
use crate::core::index::CrossSourceIndex;
use crate::core::kernel_parser::KernelParser;
use crate::core::line::{LineMeta, LogLevel};
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
// SectionInfo — one named section in a dumpstate/bugreport file
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionInfo {
    pub name: String,
    /// 0-based index of the `------` section-start header line.
    pub start_line: usize,
    /// 0-based index of the duration footer, or the last indexed line if no footer found.
    pub end_line: usize,
}

// ---------------------------------------------------------------------------
// LogSourceData — backing store (file mmap or live stream)
// ---------------------------------------------------------------------------

pub enum LogSourceData {
    File {
        mmap: Mmap,
        /// (byte_offset, byte_len) for every indexed line.
        line_index: Vec<(usize, usize)>,
    },
    Stream {
        /// Raw line strings growing as new ADB lines arrive.
        raw_lines: Vec<String>,
        /// Cumulative bytes received (including bytes of evicted lines).
        byte_count: u64,
        /// Lines drained from the front to enforce the size cap.
        evicted_count: usize,
        /// First non-zero timestamp ever seen; set once, never cleared after eviction.
        cached_first_ts: Option<i64>,
    },
}

// ---------------------------------------------------------------------------
// LogSource — one source (file or ADB stream)
// ---------------------------------------------------------------------------

pub struct LogSource {
    pub id: String,
    pub name: String,
    pub source_type: SourceType,
    pub data: LogSourceData,
    /// Lightweight metadata for every indexed line (shared by both variants).
    pub line_meta: Vec<LineMeta>,
    /// Named sections (Bugreport only; empty for all other source types).
    pub sections: Vec<SectionInfo>,
}

impl LogSource {
    /// Create an empty streaming source.
    pub fn new_stream(id: String, name: String) -> Self {
        Self {
            id,
            name,
            source_type: SourceType::Logcat,
            data: LogSourceData::Stream {
                raw_lines: Vec::new(),
                byte_count: 0,
                evicted_count: 0,
                cached_first_ts: None,
            },
            line_meta: Vec::new(),
            sections: Vec::new(),
        }
    }

    pub fn total_lines(&self) -> usize {
        match &self.data {
            LogSourceData::File { .. } => self.line_meta.len(),
            // Cumulative total: evicted + currently retained
            LogSourceData::Stream { evicted_count, .. } => evicted_count + self.line_meta.len(),
        }
    }

    pub fn raw_line(&self, line_num: usize) -> Option<&str> {
        match &self.data {
            LogSourceData::File { mmap, line_index } => {
                let (off, len) = line_index.get(line_num)?;
                std::str::from_utf8(&mmap[*off..*off + *len]).ok()
            }
            LogSourceData::Stream { raw_lines, evicted_count, .. } => {
                let local_idx = line_num.checked_sub(*evicted_count)?;
                raw_lines.get(local_idx).map(|s| s.as_str())
            }
        }
    }

    /// Cumulative byte count for streaming sources; 0 for file sources.
    pub fn stream_byte_count(&self) -> u64 {
        if let LogSourceData::Stream { byte_count, .. } = &self.data {
            *byte_count
        } else {
            0
        }
    }

    pub fn first_timestamp(&self) -> Option<i64> {
        match &self.data {
            // Return cached value so eviction doesn't lose the original first timestamp.
            LogSourceData::Stream { cached_first_ts, .. } => *cached_first_ts,
            _ => self.line_meta.iter().find(|m| m.timestamp > 0).map(|m| m.timestamp),
        }
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
        let sections = build_section_index(&line_meta, &source_type);

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
            data: LogSourceData::File { mmap, line_index },
            line_meta,
            sections,
        });

        // Rebuild the timeline and index after adding a new source.
        self.rebuild_timeline();

        Ok(idx)
    }

    /// Add an empty streaming source (for ADB logcat sessions).
    /// Returns the new source's index in `self.sources`.
    pub fn add_stream_source(&mut self, source_id: String, device_label: String) -> usize {
        let idx = self.sources.len();
        self.sources.push(LogSource::new_stream(source_id, device_label));
        idx
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

    // Dumpstate must be checked first: dumpstate files embed logcat sections
    // that contain "--------- beginning of", which would otherwise trigger the
    // Logcat branch below.
    if text.contains("== dumpstate:") || text.contains("Bugreport format version:") {
        return SourceType::Bugreport;
    }
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

                let meta = parser.parse_meta(raw, start).unwrap_or(LineMeta {
                    level: LogLevel::Info,
                    tag: String::new(),
                    timestamp: 0,
                    byte_offset: start,
                    byte_len: content_end - start,
                });
                line_index.push((start, content_end - start));
                line_meta.push(meta);
            }

            start = i + 1;
        }
    }

    (line_index, line_meta)
}

/// Scan `line_meta` to extract named section boundaries for Bugreport files.
///
/// BugreportParser sets `LineMeta.tag` to the section name on `------` lines:
/// - Start header: `level = Info`, non-empty tag (not "dumpstate")
/// - Duration footer: `level = Verbose`, non-empty tag
///
/// Uses a stack so that nested sub-section headers (e.g. the many
/// `BLOCK STAT (/sys/block/…)` lines inside `DUMP BLOCK STAT`) are NOT
/// emitted as separate sections.  A `SectionInfo` is only created when a
/// matching duration footer is found.  Sub-section headers that never receive
/// their own footer are silently discarded.
///
/// Returns an empty Vec for all non-Bugreport source types.
fn build_section_index(line_meta: &[LineMeta], source_type: &SourceType) -> Vec<SectionInfo> {
    if !matches!(source_type, SourceType::Bugreport) {
        return Vec::new();
    }

    let mut sections = Vec::new();
    // Stack of (section_name, start_line_idx) — top is the most recently opened.
    let mut pending: Vec<(String, usize)> = Vec::new();

    for (i, meta) in line_meta.iter().enumerate() {
        if meta.level == LogLevel::Info && !meta.tag.is_empty() && meta.tag != "dumpstate" {
            // Section start header — push onto the stack.
            pending.push((meta.tag.clone(), i));
        } else if meta.level == LogLevel::Verbose && !meta.tag.is_empty() {
            // Duration footer — find the most recently opened section with this name.
            if let Some(pos) = pending.iter().rposition(|(name, _)| name == &meta.tag) {
                let (name, start) = pending.remove(pos);
                sections.push(SectionInfo {
                    name,
                    start_line: start,
                    end_line: i,
                });
            }
            // Sub-section headers without a matching footer remain on the stack
            // and are discarded at the end — they are NOT emitted as sections.
        }
    }

    // Any unmatched stack entries are orphan sub-section headers; drop them.
    sections
}

fn parser_for(source_type: &SourceType) -> Box<dyn LogParser> {
    match source_type {
        SourceType::Logcat | SourceType::Radio | SourceType::Events => Box::new(LogcatParser),
        SourceType::Kernel => Box::new(KernelParser),
        SourceType::Bugreport => Box::new(BugreportParser),
        _ => Box::new(LogcatParser),
    }
}
