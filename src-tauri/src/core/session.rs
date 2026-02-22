use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

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
        mmap: Arc<Mmap>,
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
    /// True while a background indexing task is still scanning the remainder of the file.
    pub is_indexing: bool,
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
            is_indexing: false,
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

    /// Return the `LineMeta` for absolute line number `n`, correctly adjusted
    /// for stream eviction.  Returns `None` when the line has been evicted from
    /// the in-memory buffer or `n` is out of range.
    pub fn meta_at(&self, n: usize) -> Option<&LineMeta> {
        let local = match &self.data {
            LogSourceData::Stream { evicted_count, .. } => n.checked_sub(*evicted_count)?,
            LogSourceData::File { .. } => n,
        };
        self.line_meta.get(local)
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
            Arc::new(unsafe { Mmap::map(&file) }.map_err(|e| format!("Cannot mmap file: {e}"))?);

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
            is_indexing: false,
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

    /// Like `add_source_from_file` but only indexes the first `max_bytes` synchronously.
    /// Returns `(source_idx, Arc<Mmap>, total_file_bytes, bytes_consumed)`.
    /// The caller is responsible for background-indexing the remainder.
    pub fn add_source_partial(
        &mut self,
        path: &Path,
        source_id: String,
        max_bytes: usize,
    ) -> Result<(usize, Arc<Mmap>, usize, usize), String> {
        let file = File::open(path).map_err(|e| format!("Cannot open '{}': {e}", path.display()))?;
        let mmap = Arc::new(
            unsafe { Mmap::map(&file) }.map_err(|e| format!("Cannot mmap file: {e}"))?,
        );
        let total_bytes = mmap.len();
        let source_type = detect_source_type(&mmap);
        let parser = parser_for(&source_type);
        let (line_index, line_meta, bytes_consumed) =
            build_partial_line_index(mmap.as_ref(), parser.as_ref(), max_bytes);
        let sections = build_section_index(&line_meta, &source_type);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let is_indexing = bytes_consumed < total_bytes;
        let idx = self.sources.len();
        self.sources.push(LogSource {
            id: source_id,
            name,
            source_type,
            data: LogSourceData::File { mmap: Arc::clone(&mmap), line_index },
            line_meta,
            sections,
            is_indexing,
        });
        if !is_indexing {
            self.rebuild_timeline();
        }
        Ok((idx, mmap, total_bytes, bytes_consumed))
    }

    /// Append new index entries to the source at `source_idx`.
    /// When `done` is true, rebuilds sections and timeline.
    pub fn extend_source_index(
        &mut self,
        source_idx: usize,
        new_line_index: Vec<(usize, usize)>,
        new_line_meta: Vec<LineMeta>,
        done: bool,
    ) {
        {
            let source = &mut self.sources[source_idx];
            if let LogSourceData::File { ref mut line_index, .. } = source.data {
                line_index.extend(new_line_index);
            }
            source.line_meta.extend(new_line_meta);
            source.is_indexing = !done;
        }
        if done {
            let source_type = self.sources[source_idx].source_type.clone();
            let sections = build_section_index(&self.sources[source_idx].line_meta, &source_type);
            self.sources[source_idx].sections = sections;
            self.rebuild_timeline();
        }
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
    if text.contains("[    0.") || text.contains("Linux version") || looks_like_kernel(text) {
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

/// Check if the first non-empty line looks like a kernel log timestamp: `[ NNNNN.NNNNNN]`.
/// Guards against false positives from lines that merely start with `[`.
fn looks_like_kernel(sample: &str) -> bool {
    for line in sample.lines().take(10) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !trimmed.starts_with('[') {
            continue;
        }
        if let Some(close) = trimmed.find(']') {
            if close > 1 {
                let inner = &trimmed[1..close];
                // Must look like a numeric timestamp: digits, dots, and spaces only,
                // with at least one dot.
                if inner.contains('.')
                    && inner
                        .chars()
                        .all(|c| c.is_ascii_digit() || c == '.' || c == ' ')
                {
                    return true;
                }
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Line indexer — scans the mmap once, builds per-line metadata
// ---------------------------------------------------------------------------

fn build_line_index(
    mmap: &Mmap,
    source_type: &SourceType,
) -> (Vec<(usize, usize)>, Vec<LineMeta>) {
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

            // Strip trailing \r if present.
            let content_end = if end > start && data[end - 1] == b'\r' {
                end - 1
            } else {
                end
            };

            let byte_len = content_end - start;
            // Build meta: try to parse non-empty lines; blank/unparseable lines get a minimal default.
            let meta = if byte_len > 0 {
                match std::str::from_utf8(&data[start..content_end]) {
                    Ok(s) if !s.trim().is_empty() => {
                        parser.parse_meta(s.trim(), start).unwrap_or(LineMeta {
                            level: LogLevel::Info,
                            tag: String::new(),
                            timestamp: 0,
                            byte_offset: start,
                            byte_len,
                            is_section_boundary: false,
                        })
                    }
                    _ => LineMeta {
                        level: LogLevel::Verbose,
                        tag: String::new(),
                        timestamp: 0,
                        byte_offset: start,
                        byte_len,
                        is_section_boundary: false,
                    },
                }
            } else {
                LineMeta {
                    level: LogLevel::Verbose,
                    tag: String::new(),
                    timestamp: 0,
                    byte_offset: start,
                    byte_len: 0,
                    is_section_boundary: false,
                }
            };

            line_index.push((start, byte_len));
            line_meta.push(meta);
            start = i + 1;
        }
    }

    (line_index, line_meta)
}

/// Like `build_line_index` but stops after scanning `max_bytes`.
/// Returns `(line_index, line_meta, bytes_consumed)`.
/// `bytes_consumed` is the byte offset just past the last complete line scanned.
pub(crate) fn build_partial_line_index(
    data: &[u8],
    parser: &dyn LogParser,
    max_bytes: usize,
) -> (Vec<(usize, usize)>, Vec<LineMeta>, usize) {
    let scan_limit = max_bytes.min(data.len());
    let estimate = (scan_limit / 120).max(1024);
    let mut line_index: Vec<(usize, usize)> = Vec::with_capacity(estimate);
    let mut line_meta: Vec<LineMeta> = Vec::with_capacity(estimate);
    let mut start = 0usize;
    let mut end_byte = 0usize;

    for i in 0..data.len() {
        if data[i] == b'\n' || i == data.len() - 1 {
            let end = if data[i] == b'\n' { i } else { i + 1 };
            let content_end = if end > start && data[end - 1] == b'\r' {
                end - 1
            } else {
                end
            };

            let byte_len = content_end - start;
            let meta = if byte_len > 0 {
                match std::str::from_utf8(&data[start..content_end]) {
                    Ok(s) if !s.trim().is_empty() => {
                        parser.parse_meta(s.trim(), start).unwrap_or(LineMeta {
                            level: LogLevel::Info,
                            tag: String::new(),
                            timestamp: 0,
                            byte_offset: start,
                            byte_len,
                            is_section_boundary: false,
                        })
                    }
                    _ => LineMeta {
                        level: LogLevel::Verbose,
                        tag: String::new(),
                        timestamp: 0,
                        byte_offset: start,
                        byte_len,
                        is_section_boundary: false,
                    },
                }
            } else {
                LineMeta {
                    level: LogLevel::Verbose,
                    tag: String::new(),
                    timestamp: 0,
                    byte_offset: start,
                    byte_len: 0,
                    is_section_boundary: false,
                }
            };

            line_index.push((start, byte_len));
            line_meta.push(meta);
            end_byte = i + 1;
            start = i + 1;
            if end_byte >= scan_limit && scan_limit < data.len() {
                break;
            }
        }
    }

    (line_index, line_meta, end_byte)
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
        if !meta.is_section_boundary {
            continue;
        }
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

pub(crate) fn parser_for(source_type: &SourceType) -> Box<dyn LogParser> {
    match source_type {
        SourceType::Logcat | SourceType::Radio | SourceType::Events => Box::new(LogcatParser),
        SourceType::Kernel => Box::new(KernelParser),
        SourceType::Bugreport => Box::new(BugreportParser),
        _ => Box::new(LogcatParser),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::line::LogLevel;

    /// Helper: build a LogSource in Stream mode with `n` lines already in
    /// raw_lines / line_meta, and `evicted` lines already evicted from the front.
    fn make_stream_source(n: usize, evicted: usize) -> LogSource {
        let mut src = LogSource::new_stream("test".into(), "test".into());
        if let LogSourceData::Stream {
            ref mut raw_lines,
            ref mut evicted_count,
            ref mut byte_count,
            ..
        } = src.data
        {
            *evicted_count = evicted;
            for i in 0..n {
                let line = format!("line {}", evicted + i);
                *byte_count += line.len() as u64 + 1;
                raw_lines.push(line);
                src.line_meta.push(LineMeta {
                    level: LogLevel::Info,
                    tag: format!("tag{}", evicted + i),
                    timestamp: (evicted + i) as i64,
                    byte_offset: 0,
                    byte_len: 0,
                    is_section_boundary: false,
                });
            }
        }
        src
    }

    // --- meta_at() correctness tests ---

    #[test]
    fn meta_at_no_eviction() {
        let src = make_stream_source(5, 0);
        // Line 0..4 should all be accessible
        for i in 0..5usize {
            let meta = src.meta_at(i).expect("meta_at should return Some");
            assert_eq!(meta.timestamp, i as i64);
        }
        // Line 5 is out of range
        assert!(src.meta_at(5).is_none());
    }

    #[test]
    fn meta_at_after_eviction() {
        // 3 lines retained; first 7 evicted → absolute line nums 7, 8, 9
        let src = make_stream_source(3, 7);

        // Lines 0..6 are evicted — must return None, NOT panic
        for i in 0..7usize {
            assert!(
                src.meta_at(i).is_none(),
                "evicted line {i} should return None"
            );
        }

        // Lines 7, 8, 9 are live
        assert_eq!(src.meta_at(7).unwrap().timestamp, 7);
        assert_eq!(src.meta_at(8).unwrap().timestamp, 8);
        assert_eq!(src.meta_at(9).unwrap().timestamp, 9);

        // Line 10 is beyond the buffer
        assert!(src.meta_at(10).is_none());
    }

    #[test]
    fn meta_at_large_eviction() {
        // Simulate heavy eviction: 10_000 evicted, only 100 retained
        let src = make_stream_source(100, 10_000);

        // Should not panic for any evicted line
        assert!(src.meta_at(0).is_none());
        assert!(src.meta_at(9_999).is_none());

        // First retained line
        assert_eq!(src.meta_at(10_000).unwrap().timestamp, 10_000);
        // Last retained line
        assert_eq!(src.meta_at(10_099).unwrap().timestamp, 10_099);

        // Past the end
        assert!(src.meta_at(10_100).is_none());
    }

    // --- total_lines() reflects cumulative count through eviction ---

    #[test]
    fn total_lines_counts_evicted() {
        let src = make_stream_source(50, 200);
        // 200 evicted + 50 retained = 250 total
        assert_eq!(src.total_lines(), 250);
    }

    // --- raw_line() mirrors meta_at() semantics ---

    #[test]
    fn raw_line_after_eviction() {
        let src = make_stream_source(3, 5);
        // Evicted lines return None
        assert!(src.raw_line(0).is_none());
        assert!(src.raw_line(4).is_none());
        // Live lines return the correct string
        assert_eq!(src.raw_line(5), Some("line 5"));
        assert_eq!(src.raw_line(7), Some("line 7"));
        assert!(src.raw_line(8).is_none()); // past end
    }

    // =========================================================================
    // Progressive file loading tests
    // =========================================================================

    /// Generate `n` well-formed logcat threadtime lines as bytes.
    /// Each line has a unique timestamp and message for verification.
    fn make_logcat_data(n: usize) -> Vec<u8> {
        let mut out = String::new();
        for i in 0..n {
            let mm = 1 + (i % 12);
            let dd = 1 + (i % 28);
            let hh = i % 24;
            let mi = i % 60;
            let ss = i % 60;
            let ms = (i * 7) % 1000;
            let tid = 1000 + (i % 10);
            out.push_str(&format!(
                "{:02}-{:02} {:02}:{:02}:{:02}.{:03}  1000  {} I TestTag: message {}\n",
                mm, dd, hh, mi, ss, ms, tid, i
            ));
        }
        out.into_bytes()
    }

    /// Simulate the background indexer (`run_background_indexer` in files.rs):
    /// scan remaining bytes in chunks using the same `build_partial_line_index`
    /// + offset adjustment pattern that the real code uses.
    /// Returns combined (line_index, line_meta) for the extension portion only.
    fn simulate_background_chunks(
        data: &[u8],
        parser: &dyn LogParser,
        initial_bytes_consumed: usize,
        chunk_bytes: usize,
    ) -> (Vec<(usize, usize)>, Vec<LineMeta>) {
        let mut all_index = Vec::new();
        let mut all_meta = Vec::new();
        let mut cursor = initial_bytes_consumed;

        while cursor < data.len() {
            let remaining = &data[cursor..];
            let (mut chunk_idx, mut chunk_meta, bytes_in_chunk) =
                build_partial_line_index(remaining, parser, chunk_bytes);

            if bytes_in_chunk == 0 {
                break;
            }

            // Same offset adjustment as run_background_indexer:
            // build_partial_line_index operates on a sub-slice starting at 0,
            // but real byte_offsets are cursor + local_offset.
            for entry in chunk_idx.iter_mut() {
                entry.0 += cursor;
            }
            for m in chunk_meta.iter_mut() {
                m.byte_offset += cursor;
            }

            all_index.extend(chunk_idx);
            all_meta.extend(chunk_meta);
            cursor += bytes_in_chunk;
        }
        (all_index, all_meta)
    }

    // --- A. build_partial_line_index unit tests ---

    #[test]
    fn partial_index_small_file_fits_in_one_chunk() {
        let data = make_logcat_data(5);
        let parser = LogcatParser;
        let (idx, meta, consumed) =
            build_partial_line_index(&data, &parser, data.len() + 1000);

        assert_eq!(idx.len(), 5);
        assert_eq!(meta.len(), 5);
        assert_eq!(consumed, data.len());

        // Verify byte offsets are sequential and non-overlapping
        for i in 1..idx.len() {
            assert!(
                idx[i].0 >= idx[i - 1].0 + idx[i - 1].1,
                "line {} offset should be >= end of line {}",
                i,
                i - 1
            );
        }
    }

    #[test]
    fn partial_index_stops_at_boundary() {
        let data = make_logcat_data(10);
        let parser = LogcatParser;

        // Find where line 3 ends (after its \n)
        let mut newline_count = 0;
        let mut cutoff = 0;
        for (i, &b) in data.iter().enumerate() {
            if b == b'\n' {
                newline_count += 1;
                if newline_count == 3 {
                    cutoff = i + 1; // byte after 3rd \n
                    break;
                }
            }
        }

        let (idx, meta, consumed) = build_partial_line_index(&data, &parser, cutoff);

        assert_eq!(idx.len(), 3, "should index exactly 3 lines");
        assert_eq!(meta.len(), 3);
        assert_eq!(consumed, cutoff, "bytes_consumed should be right after 3rd newline");
    }

    #[test]
    fn partial_index_line_content_matches() {
        let data = make_logcat_data(5);
        let parser = LogcatParser;
        let (idx, _meta, _consumed) =
            build_partial_line_index(&data, &parser, data.len() + 100);

        for (i, &(off, len)) in idx.iter().enumerate() {
            let extracted = std::str::from_utf8(&data[off..off + len]).unwrap();
            let expected_suffix = format!("message {}", i);
            assert!(
                extracted.contains(&expected_suffix),
                "line {} content '{}' should contain '{}'",
                i,
                extracted,
                expected_suffix
            );
        }
    }

    #[test]
    fn partial_index_handles_crlf() {
        let mut data = String::new();
        for i in 0..3 {
            data.push_str(&format!(
                "01-01 12:00:0{}.000  1000  1001 I TestTag: msg {}\r\n",
                i, i
            ));
        }
        let bytes = data.into_bytes();
        let parser = LogcatParser;
        let (idx, meta, consumed) =
            build_partial_line_index(&bytes, &parser, bytes.len() + 100);

        assert_eq!(idx.len(), 3);
        assert_eq!(meta.len(), 3);
        assert_eq!(consumed, bytes.len());

        // byte_len should exclude \r
        for &(off, len) in &idx {
            let content = &bytes[off..off + len];
            assert!(
                !content.contains(&b'\r'),
                "byte_len should exclude \\r"
            );
            assert!(
                !content.contains(&b'\n'),
                "byte_len should exclude \\n"
            );
        }
    }

    #[test]
    fn partial_index_empty_data() {
        let data: &[u8] = &[];
        let parser = LogcatParser;
        let (idx, meta, consumed) = build_partial_line_index(data, &parser, 1000);

        assert_eq!(idx.len(), 0);
        assert_eq!(meta.len(), 0);
        assert_eq!(consumed, 0);
    }

    #[test]
    fn partial_index_single_line_no_newline() {
        let data = b"01-01 12:00:00.000  1000  1001 I TestTag: only line";
        let parser = LogcatParser;
        let (idx, meta, consumed) = build_partial_line_index(data, &parser, data.len() + 100);

        assert_eq!(idx.len(), 1, "should index the single line without trailing newline");
        assert_eq!(meta.len(), 1);
        assert_eq!(consumed, data.len());
        assert_eq!(idx[0].0, 0);
        assert_eq!(idx[0].1, data.len());
    }

    #[test]
    fn partial_index_preserves_timestamps() {
        // Lines with distinct timestamps
        let data = b"01-15 08:30:00.000  1000  1001 I TestTag: first\n\
                     03-22 14:45:30.500  2000  2001 W OtherTag: second\n";
        let parser = LogcatParser;
        let (_idx, meta, _consumed) =
            build_partial_line_index(data, &parser, data.len() + 100);

        assert_eq!(meta.len(), 2);
        // Both should have non-zero timestamps
        assert_ne!(meta[0].timestamp, 0, "first line should have parsed timestamp");
        assert_ne!(meta[1].timestamp, 0, "second line should have parsed timestamp");
        // Second timestamp (March) should be later than first (January)
        assert!(
            meta[1].timestamp > meta[0].timestamp,
            "March timestamp {} should be > January timestamp {}",
            meta[1].timestamp,
            meta[0].timestamp
        );
    }

    // --- B. Partial + extend = full equivalence tests ---

    #[test]
    fn partial_then_extend_equals_full_index() {
        let data = make_logcat_data(20);
        let parser = LogcatParser;

        // Full reference: build_partial_line_index with huge max_bytes
        let (ref_idx, ref_meta, _) =
            build_partial_line_index(&data, &parser, data.len() + 1000);
        assert_eq!(ref_idx.len(), 20);

        // Now do partial (~half) + extend
        let half = data.len() / 2;
        let (part_idx, part_meta, consumed) =
            build_partial_line_index(&data, &parser, half);
        assert!(part_idx.len() < 20, "partial should index fewer than all 20 lines");
        assert!(consumed <= data.len());

        // Simulate extension for remaining bytes
        let (ext_idx, ext_meta) =
            simulate_background_chunks(&data, &parser, consumed, data.len());

        // Combine
        let mut combined_idx = part_idx;
        combined_idx.extend(ext_idx);
        let mut combined_meta = part_meta;
        combined_meta.extend(ext_meta);

        assert_eq!(
            combined_idx.len(),
            ref_idx.len(),
            "combined line count should match full index"
        );
        // Verify every offset+length matches
        for i in 0..ref_idx.len() {
            assert_eq!(
                combined_idx[i], ref_idx[i],
                "line {} index mismatch: combined {:?} vs ref {:?}",
                i, combined_idx[i], ref_idx[i]
            );
        }
        // Verify timestamps match
        for i in 0..ref_meta.len() {
            assert_eq!(
                combined_meta[i].timestamp, ref_meta[i].timestamp,
                "line {} timestamp mismatch",
                i
            );
        }
    }

    #[test]
    fn multi_chunk_extend_equals_full() {
        let data = make_logcat_data(30);
        let parser = LogcatParser;

        // Full reference
        let (ref_idx, _ref_meta, _) =
            build_partial_line_index(&data, &parser, data.len() + 1000);
        assert_eq!(ref_idx.len(), 30);

        // Small chunk size: ~2 lines worth of bytes at a time
        let chunk_size = 120; // roughly one logcat line
        let (first_idx, first_meta, consumed) =
            build_partial_line_index(&data, &parser, chunk_size);
        assert!(first_idx.len() < 30);

        let (ext_idx, ext_meta) =
            simulate_background_chunks(&data, &parser, consumed, chunk_size);

        let mut combined_idx = first_idx;
        combined_idx.extend(ext_idx);
        let mut combined_meta = first_meta;
        combined_meta.extend(ext_meta);

        assert_eq!(
            combined_idx.len(),
            ref_idx.len(),
            "multi-chunk combined should match full: got {} vs {}",
            combined_idx.len(),
            ref_idx.len()
        );
        for i in 0..ref_idx.len() {
            assert_eq!(combined_idx[i], ref_idx[i], "line {} index mismatch", i);
        }
    }

    #[test]
    fn extend_source_index_appends_correctly() {
        let data = make_logcat_data(10);
        let parser = LogcatParser;

        // Build partial covering ~half
        let half = data.len() / 2;
        let (part_idx, part_meta, consumed) =
            build_partial_line_index(&data, &parser, half);
        let part_count = part_idx.len();
        assert!(part_count > 0 && part_count < 10);

        // Build extension for the rest
        let remaining = &data[consumed..];
        let (mut ext_idx, mut ext_meta, _) =
            build_partial_line_index(remaining, &parser, remaining.len() + 100);
        // Adjust offsets for extension
        for entry in ext_idx.iter_mut() {
            entry.0 += consumed;
        }
        for m in ext_meta.iter_mut() {
            m.byte_offset += consumed;
        }
        let ext_count = ext_idx.len();

        // Create session with a File-mode source manually (anon mmap with data copied in)
        let mut mmap_mut = memmap2::MmapOptions::new()
            .len(data.len())
            .map_anon()
            .expect("anon mmap");
        mmap_mut.copy_from_slice(&data);
        let mmap: Mmap = mmap_mut.make_read_only().unwrap();
        let mmap = Arc::new(mmap);

        let mut session = AnalysisSession::new("test-session".into());
        session.sources.push(LogSource {
            id: "src1".into(),
            name: "test.log".into(),
            source_type: SourceType::Logcat,
            data: LogSourceData::File {
                mmap: Arc::clone(&mmap),
                line_index: part_idx,
            },
            line_meta: part_meta,
            sections: Vec::new(),
            is_indexing: true,
        });

        // Verify is_indexing is true
        assert!(session.sources[0].is_indexing);
        assert_eq!(session.sources[0].total_lines(), part_count);

        // Extend with remaining lines
        session.extend_source_index(0, ext_idx, ext_meta, true);

        // Verify final state
        assert!(!session.sources[0].is_indexing, "should be done indexing");
        assert_eq!(
            session.sources[0].total_lines(),
            part_count + ext_count,
            "total lines should be sum of partial + extension"
        );

        // Verify raw_line works for ALL lines
        let source = &session.sources[0];
        for i in 0..source.total_lines() {
            let line = source.raw_line(i);
            assert!(
                line.is_some(),
                "raw_line({}) should return Some after extend",
                i
            );
            let text = line.unwrap();
            let expected = format!("message {}", i);
            assert!(
                text.contains(&expected),
                "raw_line({}) = '{}' should contain '{}'",
                i,
                text,
                expected
            );
        }

        // Verify meta_at works for ALL lines
        for i in 0..source.total_lines() {
            assert!(
                source.meta_at(i).is_some(),
                "meta_at({}) should return Some after extend",
                i
            );
        }
    }

    // --- C. Line number accuracy through progressive loads ---

    #[test]
    fn line_numbers_are_sequential_across_chunks() {
        let data = make_logcat_data(15);
        let parser = LogcatParser;

        let chunk_size = 200;
        let (first_idx, first_meta, consumed) =
            build_partial_line_index(&data, &parser, chunk_size);
        let (ext_idx, ext_meta) =
            simulate_background_chunks(&data, &parser, consumed, chunk_size);

        let mut combined_idx = first_idx;
        combined_idx.extend(ext_idx);
        let mut combined_meta = first_meta;
        combined_meta.extend(ext_meta);

        // Verify every line extracts the right content
        for (i, &(off, len)) in combined_idx.iter().enumerate() {
            let content = std::str::from_utf8(&data[off..off + len]).unwrap();
            let expected = format!("message {}", i);
            assert!(
                content.contains(&expected),
                "line {} content '{}' should contain '{}'",
                i,
                content,
                expected
            );
        }
    }

    #[test]
    fn meta_at_works_across_chunk_boundary() {
        let data = make_logcat_data(10);
        let parser = LogcatParser;

        // Partial: cover first ~4 lines
        let (part_idx, part_meta, consumed) =
            build_partial_line_index(&data, &parser, 300);
        let boundary = part_idx.len();
        assert!(boundary > 0 && boundary < 10);

        // Extension
        let remaining = &data[consumed..];
        let (mut ext_idx, mut ext_meta, _) =
            build_partial_line_index(remaining, &parser, remaining.len() + 100);
        for entry in ext_idx.iter_mut() {
            entry.0 += consumed;
        }
        for m in ext_meta.iter_mut() {
            m.byte_offset += consumed;
        }

        let mut combined_meta = part_meta;
        combined_meta.extend(ext_meta);

        // Check around the boundary
        let last_of_first = &combined_meta[boundary - 1];
        let first_of_second = &combined_meta[boundary];

        assert_ne!(last_of_first.timestamp, 0, "last line of first chunk should have timestamp");
        assert_ne!(first_of_second.timestamp, 0, "first line of second chunk should have timestamp");
        assert!(
            first_of_second.timestamp >= last_of_first.timestamp,
            "timestamps should be non-decreasing across chunk boundary"
        );
    }

    // --- D. Edge cases ---

    #[test]
    fn partial_index_max_bytes_mid_line() {
        let data = make_logcat_data(5);
        let parser = LogcatParser;

        // Find the start of line 2 (after 2nd \n), then set max_bytes to mid-line-2
        let mut newlines = 0;
        let mut line2_start = 0;
        for (i, &b) in data.iter().enumerate() {
            if b == b'\n' {
                newlines += 1;
                if newlines == 2 {
                    line2_start = i + 1;
                    break;
                }
            }
        }
        let mid_line2 = line2_start + 10; // somewhere in the middle of line 2

        let (idx, _meta, consumed) = build_partial_line_index(&data, &parser, mid_line2);

        // Should still fully index line 2 (scan continues to its \n),
        // but NOT index line 3+
        assert_eq!(idx.len(), 3, "should index lines 0, 1, 2 (scan past mid-line)");
        // consumed should be past line 2's newline
        assert!(
            consumed > mid_line2,
            "bytes_consumed {} should be past mid_line2 {}",
            consumed,
            mid_line2
        );
    }

    #[test]
    fn partial_index_max_bytes_exactly_on_newline() {
        let data = make_logcat_data(5);
        let parser = LogcatParser;

        // Find the exact position of the 3rd \n
        let mut newlines = 0;
        let mut third_nl = 0;
        for (i, &b) in data.iter().enumerate() {
            if b == b'\n' {
                newlines += 1;
                if newlines == 3 {
                    third_nl = i;
                    break;
                }
            }
        }

        // max_bytes = position of the 3rd newline (0-indexed byte)
        let (idx, _meta, consumed) = build_partial_line_index(&data, &parser, third_nl);

        // The 3rd newline terminates line index 2 (0-based). After processing it,
        // consumed = third_nl + 1, which equals scan_limit or exceeds it, so we break.
        assert_eq!(idx.len(), 3, "should index exactly 3 lines");
        assert_eq!(consumed, third_nl + 1);
    }

    #[test]
    fn extend_with_empty_batch() {
        let data = make_logcat_data(5);
        let parser = LogcatParser;

        let (part_idx, part_meta, _consumed) =
            build_partial_line_index(&data, &parser, data.len() + 100);

        // Create a File source manually with is_indexing = true
        let mut mmap_mut = memmap2::MmapOptions::new()
            .len(data.len())
            .map_anon()
            .expect("anon mmap");
        mmap_mut.copy_from_slice(&data);
        let mmap: Mmap = mmap_mut.make_read_only().unwrap();

        let mut session = AnalysisSession::new("test".into());
        session.sources.push(LogSource {
            id: "src1".into(),
            name: "test.log".into(),
            source_type: SourceType::Logcat,
            data: LogSourceData::File {
                mmap: Arc::new(mmap),
                line_index: part_idx.clone(),
            },
            line_meta: part_meta.clone(),
            sections: Vec::new(),
            is_indexing: true,
        });

        let original_count = session.sources[0].total_lines();

        // Extend with empty batch, done=true
        session.extend_source_index(0, Vec::new(), Vec::new(), true);

        assert!(!session.sources[0].is_indexing, "should be done indexing");
        assert_eq!(
            session.sources[0].total_lines(),
            original_count,
            "line count should not change with empty batch"
        );
    }

    #[test]
    fn blank_lines_are_indexed() {
        // Logcat lines with a blank line in between
        let data = b"01-01 12:00:00.000  1000  1001 I TestTag: line one\n\
                     \n\
                     01-01 12:00:02.000  1000  1001 I TestTag: line three\n";
        let parser = LogcatParser;
        let (idx, meta, consumed) =
            build_partial_line_index(data, &parser, data.len() + 100);

        assert_eq!(idx.len(), 3, "blank line should be indexed too");
        assert_eq!(meta.len(), 3);
        assert_eq!(consumed, data.len());

        // The blank line should have byte_len 0
        assert_eq!(idx[1].1, 0, "blank line should have byte_len 0");

        // Lines after the blank should still have correct content
        let (off, len) = idx[2];
        let content = std::str::from_utf8(&data[off..off + len]).unwrap();
        assert!(content.contains("line three"), "third line content should be correct");
    }

    // --- Helper: build_partial_line_index signature adapter for equivalence tests ---
    // (build_line_index takes &Mmap, but we use build_partial_line_index with huge
    //  max_bytes as the "full" reference since the logic is identical)
}
