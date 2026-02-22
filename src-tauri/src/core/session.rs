use memchr::memchr_iter;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use crate::core::bugreport_parser::BugreportParser;
use crate::core::index::CrossSourceIndex;
use crate::core::kernel_parser::KernelParser;
use crate::core::line::{LineMeta, LogLevel, ParsedLineMeta};
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;
use crate::core::timeline::{Timeline, TimelineEntry};

// ---------------------------------------------------------------------------
// TagInterner — maps tag strings to compact u16 IDs
// ---------------------------------------------------------------------------

pub struct TagInterner {
    table: Vec<String>,
    index: HashMap<String, u16>,
}

impl TagInterner {
    pub fn new() -> Self {
        let mut interner = Self {
            table: Vec::new(),
            index: HashMap::new(),
        };
        // Pre-intern the empty tag at ID 0 so default/empty tags are free.
        interner.intern("");
        interner
    }

    /// Return the u16 ID for `tag`, inserting it if not yet seen.
    pub fn intern(&mut self, tag: &str) -> u16 {
        if let Some(&id) = self.index.get(tag) {
            return id;
        }
        let id = self.table.len() as u16;
        self.table.push(tag.to_string());
        self.index.insert(tag.to_string(), id);
        id
    }

    /// Resolve a tag ID back to its string.  Panics if `id` is out of range
    /// (which would indicate a bug — IDs are only produced by `intern`).
    pub fn resolve(&self, id: u16) -> &str {
        &self.table[id as usize]
    }
}

impl Default for TagInterner {
    fn default() -> Self {
        Self::new()
    }
}

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
        /// Byte offsets for every indexed line, with a sentinel at the end
        /// equal to the byte past the last line.  Line i spans
        /// `offsets[i]..offsets[i+1]` (may include trailing \r\n).
        line_index: Vec<u64>,
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
                // line_index has N+1 entries (sentinel at end); valid line nums are 0..N-1
                if line_num + 1 >= line_index.len() {
                    return None;
                }
                let start = line_index[line_num] as usize;
                let end = line_index[line_num + 1] as usize;
                // Strip trailing \n and \r\n
                let mut slice_end = end;
                if slice_end > start && mmap[slice_end - 1] == b'\n' {
                    slice_end -= 1;
                }
                if slice_end > start && mmap[slice_end - 1] == b'\r' {
                    slice_end -= 1;
                }
                std::str::from_utf8(&mmap[start..slice_end]).ok()
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
    pub tag_interner: TagInterner,
}

impl AnalysisSession {
    pub fn new(id: String) -> Self {
        Self {
            id,
            sources: Vec::new(),
            timeline: Timeline::new(),
            index: CrossSourceIndex::build(&[]),
            tag_interner: TagInterner::new(),
        }
    }

    /// Intern a tag string and return its compact u16 ID.
    pub fn intern_tag(&mut self, tag: &str) -> u16 {
        self.tag_interner.intern(tag)
    }

    /// Resolve a tag ID back to the original string.
    pub fn resolve_tag(&self, tag_id: u16) -> &str {
        self.tag_interner.resolve(tag_id)
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

        let (line_index, line_meta) = build_line_index(&mmap, &source_type, &mut self.tag_interner);
        let sections = build_section_index(&line_meta, &source_type, &self.tag_interner);

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
            build_partial_line_index(mmap.as_ref(), parser.as_ref(), &mut self.tag_interner, max_bytes);
        let sections = build_section_index(&line_meta, &source_type, &self.tag_interner);
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
    /// `new_offsets` are byte offsets of newly indexed lines (no sentinel).
    /// `sentinel` is the byte offset just past the last line in this batch.
    /// When `done` is true, rebuilds sections and timeline.
    pub fn extend_source_index(
        &mut self,
        source_idx: usize,
        new_offsets: Vec<u64>,
        new_line_meta: Vec<LineMeta>,
        sentinel: u64,
        done: bool,
    ) {
        {
            let source = &mut self.sources[source_idx];
            if let LogSourceData::File { ref mut line_index, .. } = source.data {
                // Remove the old sentinel before appending new offsets.
                if !line_index.is_empty() {
                    line_index.pop();
                }
                line_index.extend(new_offsets);
                // Push the new sentinel.
                line_index.push(sentinel);
            }
            source.line_meta.extend(new_line_meta);
            source.is_indexing = !done;
        }
        if done {
            let source_type = self.sources[source_idx].source_type.clone();
            let sections = build_section_index(&self.sources[source_idx].line_meta, &source_type, &self.tag_interner);
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
                    tag: self.tag_interner.resolve(m.tag_id).to_string(),
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

/// Convert a `ParsedLineMeta` (parser output with tag String) to a `LineMeta`
/// (stored form with interned tag_id).
fn intern_parsed_meta(parsed: ParsedLineMeta, interner: &mut TagInterner) -> LineMeta {
    let tag_id = interner.intern(&parsed.tag);
    LineMeta {
        level: parsed.level,
        tag_id,
        timestamp: parsed.timestamp,
        byte_offset: parsed.byte_offset,
        byte_len: parsed.byte_len,
        is_section_boundary: parsed.is_section_boundary,
    }
}

fn build_line_index(
    mmap: &Mmap,
    source_type: &SourceType,
    interner: &mut TagInterner,
) -> (Vec<u64>, Vec<LineMeta>) {
    let parser: Box<dyn LogParser> = parser_for(source_type);
    let data = mmap.as_ref();

    // Pre-allocate rough estimate (avg 120 bytes/line) + 1 for sentinel
    let estimate = (data.len() / 120).max(1024);
    let mut line_index: Vec<u64> = Vec::with_capacity(estimate + 1);
    let mut line_meta: Vec<LineMeta> = Vec::with_capacity(estimate);

    let mut start = 0usize;
    let len = data.len();

    // Helper closure: index a single line from data[start..end] (end excludes the newline).
    let index_line = |start: usize, end: usize, line_index: &mut Vec<u64>, line_meta: &mut Vec<LineMeta>, interner: &mut TagInterner| {
        // Strip trailing \r if present.
        let content_end = if end > start && data[end - 1] == b'\r' {
            end - 1
        } else {
            end
        };

        let byte_len = content_end - start;
        let parsed = if byte_len > 0 {
            match std::str::from_utf8(&data[start..content_end]) {
                Ok(s) if !s.trim().is_empty() => {
                    parser.parse_meta(s.trim(), start).unwrap_or(ParsedLineMeta {
                        level: LogLevel::Info,
                        tag: String::new(),
                        timestamp: 0,
                        byte_offset: start,
                        byte_len,
                        is_section_boundary: false,
                    })
                }
                _ => ParsedLineMeta {
                    level: LogLevel::Verbose,
                    tag: String::new(),
                    timestamp: 0,
                    byte_offset: start,
                    byte_len,
                    is_section_boundary: false,
                },
            }
        } else {
            ParsedLineMeta {
                level: LogLevel::Verbose,
                tag: String::new(),
                timestamp: 0,
                byte_offset: start,
                byte_len: 0,
                is_section_boundary: false,
            }
        };

        line_index.push(start as u64);
        line_meta.push(intern_parsed_meta(parsed, interner));
    };

    for nl_pos in memchr_iter(b'\n', data) {
        index_line(start, nl_pos, &mut line_index, &mut line_meta, interner);
        start = nl_pos + 1;
    }

    // Handle trailing content after the last newline (no trailing \n).
    if start < len {
        index_line(start, len, &mut line_index, &mut line_meta, interner);
    }

    // Sentinel: byte offset past the last line
    line_index.push(len as u64);

    (line_index, line_meta)
}

/// Like `build_line_index` but stops after scanning `max_bytes`.
/// Returns `(line_index, line_meta, bytes_consumed)`.
/// `line_index` includes a sentinel at the end.
/// `bytes_consumed` is the byte offset just past the last complete line scanned.
pub(crate) fn build_partial_line_index(
    data: &[u8],
    parser: &dyn LogParser,
    interner: &mut TagInterner,
    max_bytes: usize,
) -> (Vec<u64>, Vec<LineMeta>, usize) {
    let scan_limit = max_bytes.min(data.len());
    let estimate = (scan_limit / 120).max(1024);
    let mut line_index: Vec<u64> = Vec::with_capacity(estimate + 1);
    let mut line_meta: Vec<LineMeta> = Vec::with_capacity(estimate);
    let mut start = 0usize;
    let mut end_byte = 0usize;

    // Helper closure: index a single line from data[start..end].
    let index_line = |start: usize, end: usize, line_index: &mut Vec<u64>, line_meta: &mut Vec<LineMeta>, interner: &mut TagInterner| {
        let content_end = if end > start && data[end - 1] == b'\r' {
            end - 1
        } else {
            end
        };

        let byte_len = content_end - start;
        let parsed = if byte_len > 0 {
            match std::str::from_utf8(&data[start..content_end]) {
                Ok(s) if !s.trim().is_empty() => {
                    parser.parse_meta(s.trim(), start).unwrap_or(ParsedLineMeta {
                        level: LogLevel::Info,
                        tag: String::new(),
                        timestamp: 0,
                        byte_offset: start,
                        byte_len,
                        is_section_boundary: false,
                    })
                }
                _ => ParsedLineMeta {
                    level: LogLevel::Verbose,
                    tag: String::new(),
                    timestamp: 0,
                    byte_offset: start,
                    byte_len,
                    is_section_boundary: false,
                },
            }
        } else {
            ParsedLineMeta {
                level: LogLevel::Verbose,
                tag: String::new(),
                timestamp: 0,
                byte_offset: start,
                byte_len: 0,
                is_section_boundary: false,
            }
        };

        line_index.push(start as u64);
        line_meta.push(intern_parsed_meta(parsed, interner));
    };

    for nl_pos in memchr_iter(b'\n', data) {
        index_line(start, nl_pos, &mut line_index, &mut line_meta, interner);
        end_byte = nl_pos + 1;
        start = nl_pos + 1;
        if end_byte >= scan_limit && scan_limit < data.len() {
            break;
        }
    }

    // Handle trailing content after the last newline when scanning the full file
    // (i.e., scan_limit == data.len() and no trailing newline).
    if start < data.len() && (end_byte < scan_limit || scan_limit == data.len()) {
        // Only index the trailing partial line if we haven't broken out early
        if end_byte < scan_limit || scan_limit == data.len() {
            // Check: did we exhaust all newlines without hitting scan_limit?
            // If scan_limit < data.len(), we only want complete lines up to the limit.
            if scan_limit == data.len() {
                index_line(start, data.len(), &mut line_index, &mut line_meta, interner);
                end_byte = data.len();
            }
        }
    }

    // Sentinel: byte offset past the last indexed line
    line_index.push(end_byte as u64);

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
fn build_section_index(line_meta: &[LineMeta], source_type: &SourceType, interner: &TagInterner) -> Vec<SectionInfo> {
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
        let tag = interner.resolve(meta.tag_id);
        if meta.level == LogLevel::Info && !tag.is_empty() && tag != "dumpstate" {
            // Section start header — push onto the stack.
            pending.push((tag.to_string(), i));
        } else if meta.level == LogLevel::Verbose && !tag.is_empty() {
            // Duration footer — find the most recently opened section with this name.
            if let Some(pos) = pending.iter().rposition(|(name, _)| name == tag) {
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
                    tag_id: 0,
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

    /// Helper to call build_partial_line_index with a fresh interner.
    /// Returns (line_index_with_sentinel, line_meta, bytes_consumed, interner).
    fn bpli(data: &[u8], parser: &dyn LogParser, max_bytes: usize)
        -> (Vec<u64>, Vec<LineMeta>, usize, TagInterner)
    {
        let mut interner = TagInterner::new();
        let (idx, meta, consumed) = build_partial_line_index(data, parser, &mut interner, max_bytes);
        (idx, meta, consumed, interner)
    }

    /// Number of actual lines in a sentinel-based index (N+1 entries for N lines).
    fn line_count(idx: &[u64]) -> usize {
        if idx.is_empty() { 0 } else { idx.len() - 1 }
    }

    /// Extract line content from sentinel-based index: line i spans idx[i]..idx[i+1].
    fn extract_line<'a>(data: &'a [u8], idx: &[u64], i: usize) -> &'a str {
        let start = idx[i] as usize;
        let end = idx[i + 1] as usize;
        let slice = &data[start..end];
        // Trim trailing \r\n or \n
        let trimmed = if slice.ends_with(b"\r\n") {
            &slice[..slice.len() - 2]
        } else if slice.ends_with(b"\n") {
            &slice[..slice.len() - 1]
        } else {
            slice
        };
        std::str::from_utf8(trimmed).unwrap()
    }

    /// Simulate the background indexer (`run_background_indexer` in files.rs):
    /// scan remaining bytes in chunks using the same `build_partial_line_index`
    /// + offset adjustment pattern that the real code uses.
    /// Returns combined (line_offsets_no_sentinel, line_meta) for the extension portion only.
    fn simulate_background_chunks(
        data: &[u8],
        parser: &dyn LogParser,
        initial_bytes_consumed: usize,
        chunk_bytes: usize,
    ) -> (Vec<u64>, Vec<LineMeta>) {
        let mut all_offsets = Vec::new();
        let mut all_meta = Vec::new();
        let mut cursor = initial_bytes_consumed;
        let mut interner = TagInterner::new();

        while cursor < data.len() {
            let remaining = &data[cursor..];
            let (mut chunk_idx, mut chunk_meta, bytes_in_chunk) =
                build_partial_line_index(remaining, parser, &mut interner, chunk_bytes);

            if bytes_in_chunk == 0 {
                break;
            }

            // Adjust offsets for the cursor position
            for offset in chunk_idx.iter_mut() {
                *offset += cursor as u64;
            }
            for m in chunk_meta.iter_mut() {
                m.byte_offset += cursor;
            }

            // Remove sentinel before collecting (we only want line start offsets)
            if !chunk_idx.is_empty() {
                chunk_idx.pop();
            }
            all_offsets.extend(chunk_idx);
            all_meta.extend(chunk_meta);
            cursor += bytes_in_chunk;
        }
        (all_offsets, all_meta)
    }

    // --- A. build_partial_line_index unit tests ---

    #[test]
    fn partial_index_small_file_fits_in_one_chunk() {
        let data = make_logcat_data(5);
        let parser = LogcatParser;
        let (idx, meta, consumed, _) = bpli(&data, &parser, data.len() + 1000);

        assert_eq!(line_count(&idx), 5);
        assert_eq!(meta.len(), 5);
        assert_eq!(consumed, data.len());

        // Verify byte offsets are sequential
        for i in 1..line_count(&idx) {
            assert!(
                idx[i] >= idx[i - 1],
                "line {} offset should be >= start of line {}",
                i, i - 1
            );
        }
    }

    #[test]
    fn partial_index_stops_at_boundary() {
        let data = make_logcat_data(10);
        let parser = LogcatParser;

        let mut newline_count = 0;
        let mut cutoff = 0;
        for (i, &b) in data.iter().enumerate() {
            if b == b'\n' {
                newline_count += 1;
                if newline_count == 3 {
                    cutoff = i + 1;
                    break;
                }
            }
        }

        let (idx, meta, consumed, _) = bpli(&data, &parser, cutoff);

        assert_eq!(line_count(&idx), 3, "should index exactly 3 lines");
        assert_eq!(meta.len(), 3);
        assert_eq!(consumed, cutoff, "bytes_consumed should be right after 3rd newline");
    }

    #[test]
    fn partial_index_line_content_matches() {
        let data = make_logcat_data(5);
        let parser = LogcatParser;
        let (idx, _meta, _consumed, _) = bpli(&data, &parser, data.len() + 100);

        for i in 0..line_count(&idx) {
            let content = extract_line(&data, &idx, i);
            let expected_suffix = format!("message {}", i);
            assert!(
                content.contains(&expected_suffix),
                "line {} content '{}' should contain '{}'",
                i, content, expected_suffix
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
        let (idx, meta, consumed, _) = bpli(&bytes, &parser, bytes.len() + 100);

        assert_eq!(line_count(&idx), 3);
        assert_eq!(meta.len(), 3);
        assert_eq!(consumed, bytes.len());

        for i in 0..line_count(&idx) {
            let content = extract_line(&bytes, &idx, i);
            assert!(!content.contains('\r'), "line content should not contain \\r");
            assert!(!content.contains('\n'), "line content should not contain \\n");
        }
    }

    #[test]
    fn partial_index_empty_data() {
        let data: &[u8] = &[];
        let parser = LogcatParser;
        let (idx, meta, consumed, _) = bpli(data, &parser, 1000);

        assert_eq!(line_count(&idx), 0);
        assert_eq!(meta.len(), 0);
        assert_eq!(consumed, 0);
    }

    #[test]
    fn partial_index_single_line_no_newline() {
        let data = b"01-01 12:00:00.000  1000  1001 I TestTag: only line";
        let parser = LogcatParser;
        let (idx, meta, consumed, _) = bpli(data, &parser, data.len() + 100);

        assert_eq!(line_count(&idx), 1, "should index the single line without trailing newline");
        assert_eq!(meta.len(), 1);
        assert_eq!(consumed, data.len());
        assert_eq!(idx[0], 0);
    }

    #[test]
    fn partial_index_preserves_timestamps() {
        let data = b"01-15 08:30:00.000  1000  1001 I TestTag: first\n\
                     03-22 14:45:30.500  2000  2001 W OtherTag: second\n";
        let parser = LogcatParser;
        let (_idx, meta, _consumed, _) = bpli(data, &parser, data.len() + 100);

        assert_eq!(meta.len(), 2);
        assert_ne!(meta[0].timestamp, 0, "first line should have parsed timestamp");
        assert_ne!(meta[1].timestamp, 0, "second line should have parsed timestamp");
        assert!(
            meta[1].timestamp > meta[0].timestamp,
            "March timestamp {} should be > January timestamp {}",
            meta[1].timestamp, meta[0].timestamp
        );
    }

    // --- B. Partial + extend = full equivalence tests ---

    #[test]
    fn partial_then_extend_equals_full_index() {
        let data = make_logcat_data(20);
        let parser = LogcatParser;

        let (ref_idx, ref_meta, _, _) = bpli(&data, &parser, data.len() + 1000);
        assert_eq!(line_count(&ref_idx), 20);

        let half = data.len() / 2;
        let (part_idx, part_meta, consumed, _) = bpli(&data, &parser, half);
        assert!(line_count(&part_idx) < 20, "partial should index fewer than all 20 lines");
        assert!(consumed <= data.len());

        let (ext_offsets, ext_meta) =
            simulate_background_chunks(&data, &parser, consumed, data.len());

        // Combine: strip sentinel from partial, add extension offsets, then add final sentinel
        let mut combined_offsets: Vec<u64> = part_idx[..part_idx.len() - 1].to_vec();
        combined_offsets.extend(&ext_offsets);
        combined_offsets.push(*ref_idx.last().unwrap());
        let mut combined_meta = part_meta;
        combined_meta.extend(ext_meta);

        assert_eq!(
            line_count(&combined_offsets), line_count(&ref_idx),
            "combined line count should match full index"
        );
        for i in 0..line_count(&ref_idx) {
            let ref_content = extract_line(&data, &ref_idx, i);
            let combined_content = extract_line(&data, &combined_offsets, i);
            assert_eq!(combined_content, ref_content, "line {} content mismatch", i);
        }
        for i in 0..ref_meta.len() {
            assert_eq!(
                combined_meta[i].timestamp, ref_meta[i].timestamp,
                "line {} timestamp mismatch", i
            );
        }
    }

    #[test]
    fn multi_chunk_extend_equals_full() {
        let data = make_logcat_data(30);
        let parser = LogcatParser;

        let (ref_idx, _ref_meta, _, _) = bpli(&data, &parser, data.len() + 1000);
        assert_eq!(line_count(&ref_idx), 30);

        let chunk_size = 120;
        let (first_idx, first_meta, consumed, _) = bpli(&data, &parser, chunk_size);
        assert!(line_count(&first_idx) < 30);

        let (ext_offsets, ext_meta) =
            simulate_background_chunks(&data, &parser, consumed, chunk_size);

        let mut combined_offsets: Vec<u64> = first_idx[..first_idx.len() - 1].to_vec();
        combined_offsets.extend(&ext_offsets);
        combined_offsets.push(*ref_idx.last().unwrap());
        let mut combined_meta = first_meta;
        combined_meta.extend(ext_meta);

        assert_eq!(
            line_count(&combined_offsets), line_count(&ref_idx),
            "multi-chunk combined should match full: got {} vs {}",
            line_count(&combined_offsets), line_count(&ref_idx)
        );
        for i in 0..line_count(&ref_idx) {
            let ref_content = extract_line(&data, &ref_idx, i);
            let combined_content = extract_line(&data, &combined_offsets, i);
            assert_eq!(combined_content, ref_content, "line {} content mismatch", i);
        }
    }

    #[test]
    fn extend_source_index_appends_correctly() {
        let data = make_logcat_data(10);
        let parser = LogcatParser;

        // Use a single interner for both partial and extension so tag IDs are consistent.
        let mut interner = TagInterner::new();

        let half = data.len() / 2;
        let (part_idx, part_meta, consumed) =
            build_partial_line_index(&data, &parser, &mut interner, half);
        let part_count = line_count(&part_idx);
        assert!(part_count > 0 && part_count < 10);

        // Build extension using the same interner
        let remaining = &data[consumed..];
        let (mut ext_idx, mut ext_meta, _) =
            build_partial_line_index(remaining, &parser, &mut interner, remaining.len() + 100);
        for offset in ext_idx.iter_mut() {
            *offset += consumed as u64;
        }
        for m in ext_meta.iter_mut() {
            m.byte_offset += consumed;
        }
        // Strip sentinel and pass it separately
        let ext_sentinel = ext_idx.pop().unwrap_or(data.len() as u64);
        let ext_count = ext_meta.len();

        let mut mmap_mut = memmap2::MmapOptions::new()
            .len(data.len())
            .map_anon()
            .expect("anon mmap");
        mmap_mut.copy_from_slice(&data);
        let mmap: Mmap = mmap_mut.make_read_only().unwrap();
        let mmap = Arc::new(mmap);

        let mut session = AnalysisSession::new("test-session".into());
        // Transfer the shared interner to the session so tag IDs resolve correctly.
        session.tag_interner = interner;
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

        assert!(session.sources[0].is_indexing);
        assert_eq!(session.sources[0].total_lines(), part_count);

        session.extend_source_index(0, ext_idx, ext_meta, ext_sentinel, true);

        assert!(!session.sources[0].is_indexing, "should be done indexing");
        assert_eq!(
            session.sources[0].total_lines(),
            part_count + ext_count,
            "total lines should be sum of partial + extension"
        );

        let source = &session.sources[0];
        for i in 0..source.total_lines() {
            let line = source.raw_line(i);
            assert!(line.is_some(), "raw_line({}) should return Some after extend", i);
            let text = line.unwrap();
            let expected = format!("message {}", i);
            assert!(
                text.contains(&expected),
                "raw_line({}) = '{}' should contain '{}'", i, text, expected
            );
        }

        for i in 0..source.total_lines() {
            assert!(source.meta_at(i).is_some(), "meta_at({}) should return Some after extend", i);
        }
    }

    // --- C. Line number accuracy through progressive loads ---

    #[test]
    fn line_numbers_are_sequential_across_chunks() {
        let data = make_logcat_data(15);
        let parser = LogcatParser;

        let chunk_size = 200;
        let (first_idx, first_meta, consumed, _) = bpli(&data, &parser, chunk_size);
        let (ext_offsets, ext_meta) =
            simulate_background_chunks(&data, &parser, consumed, chunk_size);

        let mut combined_offsets: Vec<u64> = first_idx[..first_idx.len() - 1].to_vec();
        combined_offsets.extend(&ext_offsets);
        combined_offsets.push(data.len() as u64);
        let mut combined_meta = first_meta;
        combined_meta.extend(ext_meta);

        for i in 0..line_count(&combined_offsets) {
            let content = extract_line(&data, &combined_offsets, i);
            let expected = format!("message {}", i);
            assert!(
                content.contains(&expected),
                "line {} content '{}' should contain '{}'",
                i, content, expected
            );
        }
    }

    #[test]
    fn meta_at_works_across_chunk_boundary() {
        let data = make_logcat_data(10);
        let parser = LogcatParser;

        let (part_idx, part_meta, consumed, _) = bpli(&data, &parser, 300);
        let boundary = line_count(&part_idx);
        assert!(boundary > 0 && boundary < 10);

        let remaining = &data[consumed..];
        let (mut ext_idx, mut ext_meta, _, _) = bpli(remaining, &parser, remaining.len() + 100);
        for offset in ext_idx.iter_mut() {
            *offset += consumed as u64;
        }
        for m in ext_meta.iter_mut() {
            m.byte_offset += consumed;
        }

        let mut combined_meta = part_meta;
        combined_meta.extend(ext_meta);

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
        let mid_line2 = line2_start + 10;

        let (idx, _meta, consumed, _) = bpli(&data, &parser, mid_line2);

        assert_eq!(line_count(&idx), 3, "should index lines 0, 1, 2 (scan past mid-line)");
        assert!(
            consumed > mid_line2,
            "bytes_consumed {} should be past mid_line2 {}",
            consumed, mid_line2
        );
    }

    #[test]
    fn partial_index_max_bytes_exactly_on_newline() {
        let data = make_logcat_data(5);
        let parser = LogcatParser;

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

        let (idx, _meta, consumed, _) = bpli(&data, &parser, third_nl);

        assert_eq!(line_count(&idx), 3, "should index exactly 3 lines");
        assert_eq!(consumed, third_nl + 1);
    }

    #[test]
    fn extend_with_empty_batch() {
        let data = make_logcat_data(5);
        let parser = LogcatParser;

        let mut interner = TagInterner::new();
        let (part_idx, part_meta, _consumed) =
            build_partial_line_index(&data, &parser, &mut interner, data.len() + 100);

        let mut mmap_mut = memmap2::MmapOptions::new()
            .len(data.len())
            .map_anon()
            .expect("anon mmap");
        mmap_mut.copy_from_slice(&data);
        let mmap: Mmap = mmap_mut.make_read_only().unwrap();

        let mut session = AnalysisSession::new("test".into());
        session.tag_interner = interner;
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

        // Extend with empty batch; sentinel = current end
        let sentinel = *part_idx.last().unwrap_or(&0);
        session.extend_source_index(0, Vec::new(), Vec::new(), sentinel, true);

        assert!(!session.sources[0].is_indexing, "should be done indexing");
        assert_eq!(
            session.sources[0].total_lines(),
            original_count,
            "line count should not change with empty batch"
        );
    }

    #[test]
    fn blank_lines_are_indexed() {
        let data = b"01-01 12:00:00.000  1000  1001 I TestTag: line one\n\
                     \n\
                     01-01 12:00:02.000  1000  1001 I TestTag: line three\n";
        let parser = LogcatParser;
        let (idx, meta, consumed, _) = bpli(data, &parser, data.len() + 100);

        assert_eq!(line_count(&idx), 3, "blank line should be indexed too");
        assert_eq!(meta.len(), 3);
        assert_eq!(consumed, data.len());

        // The blank line should have empty content
        let blank_content = extract_line(data, &idx, 1);
        assert!(blank_content.is_empty(), "blank line should have empty content");

        // Lines after the blank should still have correct content
        let line3_content = extract_line(data, &idx, 2);
        assert!(line3_content.contains("line three"), "third line content should be correct");
    }

    // --- Helper: build_partial_line_index signature adapter for equivalence tests ---
    // (build_line_index takes &Mmap, but we use build_partial_line_index with huge
    //  max_bytes as the "full" reference since the logic is identical)
}
