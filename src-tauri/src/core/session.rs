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
use crate::core::log_source::{FileLogSource, LogSource, StreamLogSource, ZipLogSource};
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

    /// Resolve a tag ID back to its string.  Returns `""` if `id` is out of
    /// range (defensive — IDs are only produced by `intern`, so out-of-range
    /// indicates a bug, but we avoid panicking in production).
    pub fn resolve(&self, id: u16) -> &str {
        self.table.get(id as usize).map_or("", std::string::String::as_str)
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum SourceType {
    Logcat,
    Kernel,
    Radio,
    Events,
    Bugreport,
    /// Samsung dumpstate — superset of Bugreport with additional Samsung-specific sections.
    Dumpstate,
    Tombstone,
    ANRTrace,
    Custom { parser_id: String },
}

impl SourceType {
    /// Case-insensitive match against a string (e.g. from YAML `source_type_is` filter rules).
    /// Dumpstate is a superset of Bugreport: `Dumpstate.matches_str("bugreport")` returns true,
    /// but `Bugreport.matches_str("dumpstate")` returns false.
    pub fn matches_str(&self, s: &str) -> bool {
        if self.to_string().eq_ignore_ascii_case(s) {
            return true;
        }
        // Dumpstate is a superset of Bugreport — a processor requesting "bugreport"
        // should also match dumpstate files.
        if matches!(self, SourceType::Dumpstate) && s.eq_ignore_ascii_case("bugreport") {
            return true;
        }
        false
    }
}

impl std::fmt::Display for SourceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SourceType::Logcat => write!(f, "Logcat"),
            SourceType::Kernel => write!(f, "Kernel"),
            SourceType::Radio => write!(f, "Radio"),
            SourceType::Events => write!(f, "Events"),
            SourceType::Bugreport => write!(f, "Bugreport"),
            SourceType::Dumpstate => write!(f, "Dumpstate"),
            SourceType::Tombstone => write!(f, "Tombstone"),
            SourceType::ANRTrace => write!(f, "ANRTrace"),
            SourceType::Custom { parser_id } => write!(f, "Custom({parser_id})"),
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
    /// Index into the sections vec of the parent section (None for top-level sections).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_index: Option<usize>,
}

// ---------------------------------------------------------------------------
// AnalysisSession — owns the source for one "workspace"
// ---------------------------------------------------------------------------

pub struct AnalysisSession {
    pub id: String,
    pub source: Option<Box<dyn LogSource>>,
    pub timeline: Timeline,
    pub index: CrossSourceIndex,
    pub tag_interner: TagInterner,
    /// Absolute path of the loaded file, if this is a file-backed session.
    pub file_path: Option<String>,
    /// Holds the extracted temp file for zip-backed sessions. The temp file is
    /// deleted when the session is dropped. Must outlive the mmap.
    pub temp_file: Option<tempfile::NamedTempFile>,
}

impl AnalysisSession {
    pub fn new(id: String) -> Self {
        Self {
            id,
            source: None,
            timeline: Timeline::new(),
            index: CrossSourceIndex::build(&[]),
            tag_interner: TagInterner::new(),
            file_path: None,
            temp_file: None,
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

    /// Return the tag interner's string table (for cloning outside a lock).
    pub fn tag_table(&self) -> &[String] {
        &self.tag_interner.table
    }

    /// Access the primary source (read-only).
    pub fn primary_source(&self) -> Option<&dyn LogSource> {
        self.source.as_deref()
    }

    /// Access the primary source (mutable).
    pub fn primary_source_mut(&mut self) -> Option<&mut (dyn LogSource + 'static)> {
        self.source.as_deref_mut()
    }

    /// Downcast the source to a FileLogSource (read-only).
    pub fn file_source(&self) -> Option<&FileLogSource> {
        self.source
            .as_ref()
            .and_then(|s| s.as_any().downcast_ref::<FileLogSource>())
    }

    /// Downcast the source to a FileLogSource (mutable).
    pub fn file_source_mut(&mut self) -> Option<&mut FileLogSource> {
        self.source
            .as_mut()
            .and_then(|s| s.as_any_mut().downcast_mut::<FileLogSource>())
    }

    /// Downcast the source to a StreamLogSource (read-only).
    pub fn stream_source(&self) -> Option<&StreamLogSource> {
        self.source
            .as_ref()
            .and_then(|s| s.as_any().downcast_ref::<StreamLogSource>())
    }

    /// Downcast the source to a StreamLogSource (mutable).
    pub fn stream_source_mut(&mut self) -> Option<&mut StreamLogSource> {
        self.source
            .as_mut()
            .and_then(|s| s.as_any_mut().downcast_mut::<StreamLogSource>())
    }

    /// Load a file, detect its type, build the line index, and set it as the source.
    pub fn add_source_from_file(
        &mut self,
        path: &Path,
        source_id: String,
    ) -> Result<(), String> {
        let file =
            File::open(path).map_err(|e| format!("Cannot open '{}': {e}", path.display()))?;

        let mmap =
            Arc::new(unsafe { Mmap::map(&file) }.map_err(|e| format!("Cannot mmap file: {e}"))?);

        let source_type = detect_source_type(&mmap);

        let (line_index, line_meta) = build_line_index(&mmap, &source_type, &mut self.tag_interner);
        let sections = build_section_index(&line_meta, &source_type, &self.tag_interner, mmap.as_ref(), &line_index);

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        self.source = Some(Box::new(FileLogSource {
            source_id,
            source_name: name,
            source_type,
            mmap,
            line_index,
            line_meta,
            section_info: sections,
            indexing: false,
        }));

        self.rebuild_timeline();
        Ok(())
    }

    /// Add an empty streaming source (for ADB logcat sessions).
    pub fn add_stream_source(
        &mut self,
        source_id: String,
        device_label: String,
        temp_dir: std::path::PathBuf,
    ) {
        self.source = Some(Box::new(StreamLogSource::new(
            source_id,
            device_label,
            self.id.clone(),
            temp_dir,
        )));
    }

    /// Load decompressed bytes as a new source (for zip-extracted log files).
    /// The bytes are kept in memory (no mmap) and fully indexed synchronously.
    pub fn add_zip_source(
        &mut self,
        data: Vec<u8>,
        source_id: String,
        source_name: String,
    ) -> Result<(), String> {
        let data = Arc::new(data);
        let source_type = detect_source_type_from_slice(&data);
        let parser = parser_for(&source_type);
        let (line_index, line_meta, _bytes_consumed) =
            build_partial_line_index(&data, parser.as_ref(), &mut self.tag_interner, data.len());
        let sections = build_section_index(&line_meta, &source_type, &self.tag_interner, &data, &line_index);

        self.source = Some(Box::new(ZipLogSource {
            source_id,
            source_name,
            source_type,
            data,
            line_index,
            line_meta,
            section_info: sections,
        }));
        self.rebuild_timeline();
        Ok(())
    }

    /// Downcast the source to a ZipLogSource (read-only).
    pub fn zip_source(&self) -> Option<&ZipLogSource> {
        self.source
            .as_ref()
            .and_then(|s| s.as_any().downcast_ref::<ZipLogSource>())
    }

    /// Like `add_source_from_file` but only indexes the first `max_bytes` synchronously.
    /// Returns `(Arc<Mmap>, total_file_bytes, bytes_consumed)`.
    /// The caller is responsible for background-indexing the remainder.
    pub fn add_source_partial(
        &mut self,
        path: &Path,
        source_id: String,
        max_bytes: usize,
    ) -> Result<(Arc<Mmap>, usize, usize), String> {
        let file = File::open(path).map_err(|e| format!("Cannot open '{}': {e}", path.display()))?;
        let mmap = Arc::new(
            unsafe { Mmap::map(&file) }.map_err(|e| format!("Cannot mmap file: {e}"))?,
        );
        let total_bytes = mmap.len();
        let source_type = detect_source_type(&mmap);
        let parser = parser_for(&source_type);
        let (line_index, line_meta, bytes_consumed) =
            build_partial_line_index(mmap.as_ref(), parser.as_ref(), &mut self.tag_interner, max_bytes);
        let sections = build_section_index(&line_meta, &source_type, &self.tag_interner, mmap.as_ref(), &line_index);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let is_indexing = bytes_consumed < total_bytes;

        let mmap_clone = Arc::clone(&mmap);
        self.source = Some(Box::new(FileLogSource {
            source_id,
            source_name: name,
            source_type,
            mmap,
            line_index,
            line_meta,
            section_info: sections,
            indexing: is_indexing,
        }));

        if !is_indexing {
            self.rebuild_timeline();
        }
        Ok((mmap_clone, total_bytes, bytes_consumed))
    }

    /// Extend the file source index with new entries from background indexing.
    /// When `done` is true, rebuilds sections and timeline.
    pub fn extend_source_index(
        &mut self,
        new_offsets: Vec<u64>,
        new_line_meta: Vec<LineMeta>,
        sentinel: u64,
        done: bool,
    ) {
        if let Some(file_src) = self.file_source_mut() {
            file_src.extend_index(new_offsets, new_line_meta, sentinel, done);
        }
        if done {
            // Rebuild sections from the completed index. Clone the mmap Arc and
            // needed metadata to avoid overlapping borrows with tag_interner.
            if let Some(file_src) = self.file_source() {
                let source_type = file_src.source_type.clone();
                let line_meta_snapshot: Vec<LineMeta> = file_src.line_meta.clone();
                let mmap_clone = Arc::clone(&file_src.mmap);
                let line_index_snapshot: Vec<u64> = file_src.line_index.clone();
                let sections = build_section_index(
                    &line_meta_snapshot,
                    &source_type,
                    &self.tag_interner,
                    mmap_clone.as_ref(),
                    &line_index_snapshot,
                );
                // Re-borrow mutably to set sections
                if let Some(file_src) = self.file_source_mut() {
                    file_src.set_sections(sections);
                }
            }
            self.rebuild_timeline();
        }
    }

    /// Rebuild the unified timeline and cross-source index.
    pub fn rebuild_timeline(&mut self) {
        let all_entries: Vec<TimelineEntry> = if let Some(ref src) = self.source {
            src.line_meta_slice()
                .iter()
                .enumerate()
                .map(|(i, m)| TimelineEntry {
                    source_id: src.id().to_string(),
                    source_line_num: i,
                    timestamp: m.timestamp,
                    level: m.level,
                    tag: self.tag_interner.resolve(m.tag_id).to_string(),
                })
                .collect()
        } else {
            Vec::new()
        };

        self.timeline = Timeline::build(
            std::iter::once(("", all_entries.into_iter())),
        );
        self.index = CrossSourceIndex::build(&self.timeline.entries);
    }
}

// ---------------------------------------------------------------------------
// Source-type detection
// ---------------------------------------------------------------------------

fn detect_source_type(mmap: &Mmap) -> SourceType {
    detect_source_type_from_slice(mmap.as_ref())
}

pub fn detect_source_type_from_slice(data: &[u8]) -> SourceType {
    let sample = &data[..data.len().min(4096)];
    let text = std::str::from_utf8(sample).unwrap_or("");

    // Samsung dumpstate files start with "== dumpstate:" and are a superset of bugreport.
    // Standard ADB bugreports start with "Bugreport format version:".
    if text.contains("== dumpstate:") {
        return SourceType::Dumpstate;
    }
    if text.contains("Bugreport format version:") {
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

    SourceType::Logcat
}

fn is_logcat_threadtime(sample: &str) -> bool {
    for line in sample.lines().take(10) {
        if line.starts_with("-----") {
            continue;
        }
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

    let estimate = (data.len() / 120).max(1024);
    let mut line_index: Vec<u64> = Vec::with_capacity(estimate + 1);
    let mut line_meta: Vec<LineMeta> = Vec::with_capacity(estimate);

    let mut start = 0usize;
    let len = data.len();

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
        start = nl_pos + 1;
    }

    if start < len {
        index_line(start, len, &mut line_index, &mut line_meta, interner);
    }

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

    if start < data.len() && scan_limit == data.len() {
        index_line(start, data.len(), &mut line_index, &mut line_meta, interner);
        end_byte = data.len();
    }

    line_index.push(end_byte as u64);

    (line_index, line_meta, end_byte)
}

/// Scan `line_meta` to extract named section boundaries for Bugreport files.
/// `raw_data` and `line_index` are used to detect DUMPSYS subsections (DUMP OF SERVICE lines).
/// Pass empty slices when the raw data is not available (e.g. stream sources or tests for non-DUMPSYS content).
pub(crate) fn build_section_index(
    line_meta: &[LineMeta],
    source_type: &SourceType,
    interner: &TagInterner,
    raw_data: &[u8],
    line_index: &[u64],
) -> Vec<SectionInfo> {
    if !matches!(source_type, SourceType::Bugreport | SourceType::Dumpstate) {
        return Vec::new();
    }

    let mut sections = Vec::new();
    let mut pending: Vec<(String, usize)> = Vec::new();

    for (i, meta) in line_meta.iter().enumerate() {
        if !meta.is_section_boundary {
            continue;
        }
        let tag = interner.resolve(meta.tag_id);
        if meta.level == LogLevel::Info && !tag.is_empty() && tag != "dumpstate" {
            pending.push((tag.to_string(), i));
        } else if meta.level == LogLevel::Verbose && !tag.is_empty() {
            if let Some(pos) = pending.iter().rposition(|(name, _)| name == tag) {
                let (name, start) = pending.remove(pos);
                sections.push(SectionInfo {
                    name,
                    start_line: start,
                    end_line: i,
                    parent_index: None,
                });
            }
        }
    }

    // Phase 2: Detect DUMPSYS subsections (DUMP OF SERVICE lines) when raw data is available.
    if raw_data.is_empty() || line_index.is_empty() {
        return sections;
    }

    let mut all_subsections: Vec<(usize, Vec<SectionInfo>)> = Vec::new();

    for (parent_pos, section) in sections.iter().enumerate() {
        if !section.name.starts_with("DUMPSYS") {
            continue;
        }

        let mut children: Vec<SectionInfo> = Vec::new();

        for line_num in (section.start_line + 1)..=section.end_line {
            let raw = extract_raw_line(raw_data, line_index, line_num);
            if let Some(after) = raw.strip_prefix("DUMP OF SERVICE ") {
                let service_name = after.trim_end_matches(':').trim();
                // Strip priority prefix: "CRITICAL activity" -> "activity", "HIGH meminfo" -> "meminfo"
                let clean_name = if let Some(rest) = service_name.strip_prefix("CRITICAL ") {
                    rest
                } else if let Some(rest) = service_name.strip_prefix("HIGH ") {
                    rest
                } else {
                    service_name
                };

                // Close previous child's end_line
                if let Some(prev) = children.last_mut() {
                    prev.end_line = line_num - 1;
                }

                children.push(SectionInfo {
                    name: clean_name.to_string(),
                    start_line: line_num,
                    end_line: section.end_line, // tentative; closed by next child or stays as parent end
                    parent_index: Some(0), // placeholder; corrected in rebuild phase
                });
            }
        }

        if !children.is_empty() {
            all_subsections.push((parent_pos, children));
        }
    }

    // Phase 3: Rebuild flat vec with children interleaved after their parents.
    if all_subsections.is_empty() {
        return sections;
    }

    let mut result: Vec<SectionInfo> = Vec::new();
    let mut subsection_map: HashMap<usize, Vec<SectionInfo>> = all_subsections.into_iter().collect();

    for (orig_pos, mut section) in sections.into_iter().enumerate() {
        section.parent_index = None; // ensure top-level
        let parent_idx = result.len();
        result.push(section);

        if let Some(mut children) = subsection_map.remove(&orig_pos) {
            for child in &mut children {
                child.parent_index = Some(parent_idx);
            }
            result.extend(children);
        }
    }

    result
}

/// Extract a raw line from mmap bytes using the line_index.
fn extract_raw_line<'a>(raw_data: &'a [u8], line_index: &[u64], line_num: usize) -> &'a str {
    if line_num >= line_index.len() {
        return "";
    }
    let start = line_index[line_num] as usize;
    let end = if line_num + 1 < line_index.len() {
        line_index[line_num + 1] as usize
    } else {
        raw_data.len()
    };
    if start > raw_data.len() || end > raw_data.len() || start > end {
        return "";
    }
    let bytes = &raw_data[start..end];
    // Trim trailing newline
    let trimmed = if bytes.ends_with(b"\r\n") {
        &bytes[..bytes.len() - 2]
    } else if bytes.ends_with(b"\n") {
        &bytes[..bytes.len() - 1]
    } else {
        bytes
    };
    std::str::from_utf8(trimmed).unwrap_or("")
}

pub(crate) fn parser_for(source_type: &SourceType) -> Box<dyn LogParser> {
    match source_type {
        SourceType::Kernel => Box::new(KernelParser),
        SourceType::Bugreport | SourceType::Dumpstate => Box::new(BugreportParser::new()),
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
    use crate::core::log_source::{FileLogSource, LogSource, StreamLogSource, ZipLogSource};

    /// Helper: build a StreamLogSource with `n` retained lines and `evicted`
    /// evicted lines (simulated by setting evicted_count and pushing metadata
    /// for all lines, but only raw text for the retained ones).
    fn make_stream_source(n: usize, evicted: usize) -> StreamLogSource {
        let mut src = StreamLogSource::new(
            "test".into(),
            "test".into(),
            "test-session".into(),
            std::env::temp_dir(),
        );
        src.evicted_count = evicted;
        // Push metadata for evicted lines (no raw text — text was drained).
        for i in 0..evicted {
            src.line_meta.push(LineMeta {
                level: LogLevel::Info,
                tag_id: 0,
                timestamp: i as i64,
                byte_offset: 0,
                byte_len: 0,
                is_section_boundary: false,
            });
        }
        // Push retained lines (raw text + metadata).
        for i in 0..n {
            let line = format!("line {}", evicted + i);
            src.byte_count += line.len() as u64 + 1;
            src.raw_lines.push(line);
            src.line_meta.push(LineMeta {
                level: LogLevel::Info,
                tag_id: 0,
                timestamp: (evicted + i) as i64,
                byte_offset: 0,
                byte_len: 0,
                is_section_boundary: false,
            });
        }
        src
    }

    // =========================================================================
    // LogSource trait + AnalysisSession accessor tests
    // =========================================================================

    /// Helper: build a FileLogSource backed by an anonymous mmap from logcat data.
    fn make_file_source(n: usize) -> (FileLogSource, Arc<Mmap>) {
        let data = make_logcat_data(n);
        let mut mmap_mut = memmap2::MmapOptions::new()
            .len(data.len())
            .map_anon()
            .expect("anon mmap");
        mmap_mut.copy_from_slice(&data);
        let mmap: Mmap = mmap_mut.make_read_only().unwrap();
        let mmap = Arc::new(mmap);

        let mut interner = TagInterner::new();
        let (line_index, line_meta) = build_line_index(&mmap, &SourceType::Logcat, &mut interner);
        let sections = build_section_index(&line_meta, &SourceType::Logcat, &interner, &[], &[]);

        let src = FileLogSource {
            source_id: "file-src".into(),
            source_name: "test.log".into(),
            source_type: SourceType::Logcat,
            mmap: Arc::clone(&mmap),
            line_index,
            line_meta,
            section_info: sections,
            indexing: false,
        };
        (src, mmap)
    }

    // --- LogSource trait: FileLogSource ---

    #[test]
    fn file_source_trait_id_name_type() {
        let (src, _mmap) = make_file_source(5);
        let trait_ref: &dyn LogSource = &src;
        assert_eq!(trait_ref.id(), "file-src");
        assert_eq!(trait_ref.name(), "test.log");
        assert!(matches!(trait_ref.source_type(), SourceType::Logcat));
        assert!(!trait_ref.is_live());
        assert!(!trait_ref.is_indexing());
    }

    #[test]
    fn file_source_trait_total_lines_and_access() {
        let (src, _mmap) = make_file_source(10);
        let trait_ref: &dyn LogSource = &src;
        assert_eq!(trait_ref.total_lines(), 10);
        assert!(trait_ref.raw_line(0).as_deref().is_some());
        assert!(trait_ref.raw_line(9).as_deref().is_some());
        assert!(trait_ref.raw_line(10).as_deref().is_none());
        assert!(trait_ref.meta_at(0).is_some());
        assert!(trait_ref.meta_at(9).is_some());
        assert!(trait_ref.meta_at(10).is_none());
        assert_eq!(trait_ref.line_meta_slice().len(), 10);
    }

    #[test]
    fn file_source_trait_timestamps() {
        let (src, _mmap) = make_file_source(5);
        let trait_ref: &dyn LogSource = &src;
        let first = trait_ref.first_timestamp();
        let last = trait_ref.last_timestamp();
        assert!(first.is_some(), "should have a first timestamp");
        assert!(last.is_some(), "should have a last timestamp");
        assert!(last.unwrap() >= first.unwrap(), "last >= first");
    }

    #[test]
    fn file_source_sections_empty_for_logcat() {
        let (src, _mmap) = make_file_source(5);
        assert!(src.sections().is_empty(), "logcat files have no sections");
    }

    // --- LogSource trait: StreamLogSource ---

    #[test]
    fn stream_source_trait_id_name_type() {
        let src = StreamLogSource::new("stream-1".into(), "ADB: device".into(), "test".into(), std::env::temp_dir());
        let trait_ref: &dyn LogSource = &src;
        assert_eq!(trait_ref.id(), "stream-1");
        assert_eq!(trait_ref.name(), "ADB: device");
        assert!(matches!(trait_ref.source_type(), SourceType::Logcat));
        assert!(trait_ref.is_live());
        assert!(!trait_ref.is_indexing());
        assert!(trait_ref.sections().is_empty());
    }

    #[test]
    fn stream_source_trait_with_lines() {
        let src = make_stream_source(5, 0);
        let trait_ref: &dyn LogSource = &src;
        assert_eq!(trait_ref.total_lines(), 5);
        assert_eq!(trait_ref.raw_line(0).as_deref(), Some("line 0"));
        assert_eq!(trait_ref.raw_line(4).as_deref(), Some("line 4"));
        assert!(trait_ref.raw_line(5).as_deref().is_none());
        assert_eq!(trait_ref.line_meta_slice().len(), 5);
    }

    #[test]
    fn stream_source_first_timestamp_cached() {
        let mut src = StreamLogSource::new("s".into(), "s".into(), "test".into(), std::env::temp_dir());
        // No lines → None
        assert!(src.first_timestamp().is_none());
        // Push a line with ts > 0
        src.push_raw_line("line 0".into());
        src.push_meta(LineMeta {
            level: LogLevel::Info, tag_id: 0, timestamp: 42,
            byte_offset: 0, byte_len: 0, is_section_boundary: false,
        });
        src.maybe_set_first_ts(42);
        assert_eq!(src.first_timestamp(), Some(42));
        // Evict it — cached_first_ts survives
        src.evict(1);
        assert_eq!(src.retained_count(), 0);
        assert_eq!(src.first_timestamp(), Some(42));
    }

    // --- Trait object polymorphism (Box<dyn LogSource>) ---

    #[test]
    fn boxed_trait_object_file() {
        let (src, _mmap) = make_file_source(3);
        let boxed: Box<dyn LogSource> = Box::new(src);
        assert_eq!(boxed.total_lines(), 3);
        assert!(!boxed.is_live());
        assert!(boxed.raw_line(0).as_deref().is_some());
    }

    #[test]
    fn boxed_trait_object_stream() {
        let src = make_stream_source(4, 0);
        let boxed: Box<dyn LogSource> = Box::new(src);
        assert_eq!(boxed.total_lines(), 4);
        assert!(boxed.is_live());
        assert_eq!(boxed.raw_line(3).as_deref(), Some("line 3"));
    }

    // --- Downcasting via as_any / as_any_mut ---

    #[test]
    fn downcast_file_source() {
        let (src, _mmap) = make_file_source(2);
        let boxed: Box<dyn LogSource> = Box::new(src);
        assert!(boxed.as_any().downcast_ref::<FileLogSource>().is_some());
        assert!(boxed.as_any().downcast_ref::<StreamLogSource>().is_none());
    }

    #[test]
    fn downcast_stream_source() {
        let src = make_stream_source(2, 0);
        let boxed: Box<dyn LogSource> = Box::new(src);
        assert!(boxed.as_any().downcast_ref::<StreamLogSource>().is_some());
        assert!(boxed.as_any().downcast_ref::<FileLogSource>().is_none());
    }

    #[test]
    fn downcast_mut_stream_source() {
        let src = make_stream_source(2, 0);
        let mut boxed: Box<dyn LogSource> = Box::new(src);
        let stream = boxed.as_any_mut().downcast_mut::<StreamLogSource>().unwrap();
        stream.push_raw_line("new line".into());
        stream.push_meta(LineMeta {
            level: LogLevel::Info, tag_id: 0, timestamp: 99,
            byte_offset: 0, byte_len: 0, is_section_boundary: false,
        });
        assert_eq!(boxed.total_lines(), 3);
    }

    // --- AnalysisSession accessor helpers ---

    #[test]
    fn session_new_has_no_file_path() {
        let session = AnalysisSession::new("s".into());
        assert!(session.file_path.is_none(), "new sessions must start with no file_path");
    }

    #[test]
    fn session_file_path_field_is_settable() {
        let mut session = AnalysisSession::new("s".into());
        session.file_path = Some("/logs/device.log".to_string());
        assert_eq!(session.file_path.as_deref(), Some("/logs/device.log"));
    }

    #[test]
    fn session_primary_source_none_when_empty() {
        let session = AnalysisSession::new("empty".into());
        assert!(session.primary_source().is_none());
        assert!(session.file_source().is_none());
        assert!(session.stream_source().is_none());
    }

    #[test]
    fn session_add_stream_source_and_accessors() {
        let mut session = AnalysisSession::new("s1".into());
        session.add_stream_source("adb-123".into(), "ADB: Pixel".into(), std::env::temp_dir());
        assert!(session.primary_source().is_some());
        assert_eq!(session.primary_source().unwrap().id(), "adb-123");
        assert!(session.primary_source().unwrap().is_live());
        // Downcast accessors
        assert!(session.stream_source().is_some());
        assert!(session.file_source().is_none());
        // Mutable downcast
        let stream = session.stream_source_mut().unwrap();
        stream.push_raw_line("test line".into());
        stream.push_meta(LineMeta {
            level: LogLevel::Info, tag_id: 0, timestamp: 1,
            byte_offset: 0, byte_len: 0, is_section_boundary: false,
        });
        assert_eq!(session.primary_source().unwrap().total_lines(), 1);
    }

    #[test]
    fn session_file_source_accessors() {
        let (src, _mmap) = make_file_source(5);
        let mut session = AnalysisSession::new("f1".into());
        session.source = Some(Box::new(src));
        assert!(session.primary_source().is_some());
        assert!(!session.primary_source().unwrap().is_live());
        assert!(session.file_source().is_some());
        assert!(session.stream_source().is_none());
        assert_eq!(session.file_source().unwrap().mmap().len(), _mmap.len());
    }

    #[test]
    fn session_file_source_mut_set_indexing() {
        let (src, _mmap) = make_file_source(5);
        let mut session = AnalysisSession::new("f2".into());
        session.source = Some(Box::new(src));
        assert!(!session.primary_source().unwrap().is_indexing());
        session.file_source_mut().unwrap().set_indexing(true);
        assert!(session.primary_source().unwrap().is_indexing());
        session.file_source_mut().unwrap().set_indexing(false);
        assert!(!session.primary_source().unwrap().is_indexing());
    }

    // --- meta_at() correctness tests ---

    #[test]
    fn meta_at_no_eviction() {
        let src = make_stream_source(5, 0);
        for i in 0..5usize {
            let meta = src.meta_at(i).expect("meta_at should return Some");
            assert_eq!(meta.timestamp, i as i64);
        }
        assert!(src.meta_at(5).is_none());
    }

    #[test]
    fn meta_at_after_eviction() {
        let src = make_stream_source(3, 7);

        // Metadata is preserved for ALL lines (never drained), including evicted.
        for i in 0..7usize {
            assert!(
                src.meta_at(i).is_some(),
                "evicted line {i} metadata should still be available"
            );
            assert_eq!(src.meta_at(i).unwrap().timestamp, i as i64);
        }

        assert_eq!(src.meta_at(7).unwrap().timestamp, 7);
        assert_eq!(src.meta_at(8).unwrap().timestamp, 8);
        assert_eq!(src.meta_at(9).unwrap().timestamp, 9);
        assert!(src.meta_at(10).is_none());
    }

    #[test]
    fn meta_at_large_eviction() {
        let src = make_stream_source(100, 10_000);

        // Metadata is preserved for ALL lines including evicted.
        assert!(src.meta_at(0).is_some());
        assert!(src.meta_at(9_999).is_some());
        assert_eq!(src.meta_at(10_000).unwrap().timestamp, 10_000);
        assert_eq!(src.meta_at(10_099).unwrap().timestamp, 10_099);
        assert!(src.meta_at(10_100).is_none());
    }

    #[test]
    fn total_lines_counts_evicted() {
        let src = make_stream_source(50, 200);
        assert_eq!(src.total_lines(), 250);
    }

    #[test]
    fn raw_line_after_eviction() {
        let src = make_stream_source(3, 5);
        // No spill file → evicted lines return None
        assert!(src.raw_line(0).as_deref().is_none());
        assert!(src.raw_line(4).as_deref().is_none());
        assert_eq!(src.raw_line(5).as_deref(), Some("line 5"));
        assert_eq!(src.raw_line(7).as_deref(), Some("line 7"));
        assert!(src.raw_line(8).as_deref().is_none());
    }

    // =========================================================================
    // Progressive file loading tests
    // =========================================================================

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

    fn bpli(data: &[u8], parser: &dyn LogParser, max_bytes: usize)
        -> (Vec<u64>, Vec<LineMeta>, usize, TagInterner)
    {
        let mut interner = TagInterner::new();
        let (idx, meta, consumed) = build_partial_line_index(data, parser, &mut interner, max_bytes);
        (idx, meta, consumed, interner)
    }

    fn line_count(idx: &[u64]) -> usize {
        if idx.is_empty() { 0 } else { idx.len() - 1 }
    }

    fn extract_line<'a>(data: &'a [u8], idx: &[u64], i: usize) -> &'a str {
        let start = idx[i] as usize;
        let end = idx[i + 1] as usize;
        let slice = &data[start..end];
        let trimmed = if slice.ends_with(b"\r\n") {
            &slice[..slice.len() - 2]
        } else if slice.ends_with(b"\n") {
            &slice[..slice.len() - 1]
        } else {
            slice
        };
        std::str::from_utf8(trimmed).unwrap()
    }

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

            for offset in chunk_idx.iter_mut() {
                *offset += cursor as u64;
            }
            for m in chunk_meta.iter_mut() {
                m.byte_offset += cursor;
            }

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

        let mut interner = TagInterner::new();

        let half = data.len() / 2;
        let (part_idx, part_meta, consumed) =
            build_partial_line_index(&data, &parser, &mut interner, half);
        let part_count = line_count(&part_idx);
        assert!(part_count > 0 && part_count < 10);

        let remaining = &data[consumed..];
        let (mut ext_idx, mut ext_meta, _) =
            build_partial_line_index(remaining, &parser, &mut interner, remaining.len() + 100);
        for offset in ext_idx.iter_mut() {
            *offset += consumed as u64;
        }
        for m in ext_meta.iter_mut() {
            m.byte_offset += consumed;
        }
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
        session.tag_interner = interner;
        session.source = Some(Box::new(FileLogSource {
            source_id: "src1".into(),
            source_name: "test.log".into(),
            source_type: SourceType::Logcat,
            mmap: Arc::clone(&mmap),
            line_index: part_idx,
            line_meta: part_meta,
            section_info: Vec::new(),
            indexing: true,
        }));

        let source = session.primary_source().unwrap();
        assert!(source.is_indexing());
        assert_eq!(source.total_lines(), part_count);

        session.extend_source_index(ext_idx, ext_meta, ext_sentinel, true);

        let source = session.primary_source().unwrap();
        assert!(!source.is_indexing(), "should be done indexing");
        assert_eq!(
            source.total_lines(),
            part_count + ext_count,
            "total lines should be sum of partial + extension"
        );

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
        let original_count = line_count(&part_idx);
        session.source = Some(Box::new(FileLogSource {
            source_id: "src1".into(),
            source_name: "test.log".into(),
            source_type: SourceType::Logcat,
            mmap: Arc::new(mmap),
            line_index: part_idx.clone(),
            line_meta: part_meta,
            section_info: Vec::new(),
            indexing: true,
        }));

        let sentinel = *part_idx.last().unwrap_or(&0);
        session.extend_source_index(Vec::new(), Vec::new(), sentinel, true);

        let source = session.primary_source().unwrap();
        assert!(!source.is_indexing(), "should be done indexing");
        assert_eq!(
            source.total_lines(),
            original_count,
            "line count should not change with empty batch"
        );
    }

    // --- Session metadata computation tests ---

    #[test]
    fn session_metadata_level_distribution() {
        let mut src = StreamLogSource::new("s".into(), "test".into(), "test".into(), std::env::temp_dir());
        // Push lines with different levels
        let levels = [LogLevel::Info, LogLevel::Error, LogLevel::Info, LogLevel::Warn, LogLevel::Info];
        for (i, &level) in levels.iter().enumerate() {
            src.push_raw_line(format!("line {}", i));
            src.push_meta(LineMeta {
                level,
                tag_id: 0,
                timestamp: (i + 1) as i64,
                byte_offset: 0,
                byte_len: 0,
                is_section_boundary: false,
            });
        }
        let trait_ref: &dyn LogSource = &src;

        let mut level_dist: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for meta in trait_ref.line_meta_slice() {
            *level_dist.entry(format!("{:?}", meta.level)).or_insert(0) += 1;
        }
        assert_eq!(level_dist.get("Info"), Some(&3));
        assert_eq!(level_dist.get("Error"), Some(&1));
        assert_eq!(level_dist.get("Warn"), Some(&1));
        assert_eq!(level_dist.get("Debug"), None);
    }

    #[test]
    fn session_metadata_tag_counts() {
        let mut session = AnalysisSession::new("s".into());
        let tag_a = session.intern_tag("ActivityManager");
        let tag_b = session.intern_tag("SystemServer");

        let mut src = StreamLogSource::new("s".into(), "test".into(), "test".into(), std::env::temp_dir());
        // 3 lines with ActivityManager, 2 with SystemServer
        for _ in 0..3 {
            src.push_raw_line("am line".into());
            src.push_meta(LineMeta {
                level: LogLevel::Info, tag_id: tag_a, timestamp: 1,
                byte_offset: 0, byte_len: 0, is_section_boundary: false,
            });
        }
        for _ in 0..2 {
            src.push_raw_line("ss line".into());
            src.push_meta(LineMeta {
                level: LogLevel::Info, tag_id: tag_b, timestamp: 1,
                byte_offset: 0, byte_len: 0, is_section_boundary: false,
            });
        }
        session.source = Some(Box::new(src));

        let source = session.primary_source().unwrap();
        let mut tag_counts: std::collections::HashMap<u16, usize> = std::collections::HashMap::new();
        for meta in source.line_meta_slice() {
            *tag_counts.entry(meta.tag_id).or_insert(0) += 1;
        }
        assert_eq!(tag_counts.get(&tag_a), Some(&3));
        assert_eq!(tag_counts.get(&tag_b), Some(&2));
        assert_eq!(session.resolve_tag(tag_a), "ActivityManager");
        assert_eq!(session.resolve_tag(tag_b), "SystemServer");
    }

    #[test]
    fn session_metadata_file_size_from_mmap() {
        let (src, mmap) = make_file_source(10);
        let mmap_len = mmap.len();
        let mut session = AnalysisSession::new("f".into());
        session.source = Some(Box::new(src));

        let file_src = session.file_source().unwrap();
        assert_eq!(file_src.mmap().len(), mmap_len);
        assert!(mmap_len > 0, "mmap should have non-zero length");
    }

    #[test]
    fn session_metadata_stream_byte_count() {
        let mut src = StreamLogSource::new("s".into(), "test".into(), "test".into(), std::env::temp_dir());
        src.add_bytes(1000);
        src.add_bytes(500);
        assert_eq!(src.stream_byte_count(), 1500);
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

        let blank_content = extract_line(data, &idx, 1);
        assert!(blank_content.is_empty(), "blank line should have empty content");

        let line3_content = extract_line(data, &idx, 2);
        assert!(line3_content.contains("line three"), "third line content should be correct");
    }

    // =========================================================================
    // Spill-to-disk tests
    // =========================================================================

    /// Helper: create a StreamLogSource, push `n` lines, evict `evict_count`.
    fn make_stream_with_eviction(n: usize, evict_count: usize) -> StreamLogSource {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut src = StreamLogSource::new(
            "spill-test".into(),
            "test".into(),
            format!("spill-{}-{}", std::process::id(), unique),
            std::env::temp_dir(),
        );
        for i in 0..n {
            let line = format!("line {}", i);
            src.push_raw_line(line);
            src.push_meta(LineMeta {
                level: LogLevel::Info,
                tag_id: 0,
                timestamp: i as i64,
                byte_offset: 0,
                byte_len: 0,
                is_section_boundary: false,
            });
        }
        if evict_count > 0 {
            src.evict(evict_count);
        }
        src
    }

    #[test]
    fn spill_write_and_read() {
        let src = make_stream_with_eviction(10, 5);
        // Evicted 5 lines → should have spill file
        assert!(src.has_spill(), "spill file should exist after eviction");
        assert_eq!(src.evicted_count(), 5);
        assert_eq!(src.retained_count(), 5);
        assert_eq!(src.total_lines(), 10);

        // Spilled lines should be readable
        for i in 0..5 {
            let line = src.raw_line(i);
            assert!(line.is_some(), "spilled line {} should be readable", i);
        }
        // Retained lines should be readable
        for i in 5..10 {
            let line = src.raw_line(i);
            assert!(line.is_some(), "retained line {} should be readable", i);
        }
        // Out of range
        assert!(src.raw_line(10).is_none());
    }

    #[test]
    fn spill_line_content_matches() {
        let src = make_stream_with_eviction(10, 5);

        // Verify every line has correct content
        for i in 0..10 {
            let content = src.raw_line(i).expect(&format!("line {} should exist", i));
            assert_eq!(
                &*content,
                &format!("line {}", i),
                "line {} content mismatch",
                i
            );
        }
    }

    #[test]
    fn evict_with_spill_preserves_metadata() {
        let src = make_stream_with_eviction(20, 10);

        // ALL metadata should be accessible (never drained)
        for i in 0..20 {
            let meta = src.meta_at(i);
            assert!(
                meta.is_some(),
                "meta_at({}) should be available even for evicted lines",
                i
            );
            assert_eq!(meta.unwrap().timestamp, i as i64);
        }
        assert!(src.meta_at(20).is_none());
    }

    #[test]
    fn save_capture_with_spill() {
        let src = make_stream_with_eviction(15, 8);
        let dir = std::env::temp_dir();
        let output = dir.join(format!("logtapper-test-capture-{}.log", std::process::id()));

        // Simulate what save_live_capture does
        {
            use std::io::Write;
            let file = std::fs::File::create(&output).expect("create output");
            let mut writer = std::io::BufWriter::new(file);
            let mut count = 0u32;
            // Write spilled lines
            if let Some(ref spill) = src.spill {
                for i in 0..spill.total_spilled() {
                    if let Some(line) = spill.read_line(i) {
                        writer.write_all(line.as_bytes()).unwrap();
                        writer.write_all(b"\n").unwrap();
                        count += 1;
                    }
                }
            }
            // Write retained lines
            for raw in &src.raw_lines {
                writer.write_all(raw.as_bytes()).unwrap();
                writer.write_all(b"\n").unwrap();
                count += 1;
            }
            writer.flush().unwrap();
            assert_eq!(count, 15, "should write all 15 lines");
        }

        // Verify output file content
        let content = std::fs::read_to_string(&output).expect("read output");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 15);
        for (i, line) in lines.iter().enumerate() {
            assert_eq!(*line, format!("line {}", i), "output line {} mismatch", i);
        }

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn spill_cleanup_on_drop() {
        let spill_path;
        {
            let src = make_stream_with_eviction(10, 5);
            spill_path = src.spill_path().cloned().expect("should have spill path");
            assert!(spill_path.exists(), "spill file should exist while source is alive");
        }
        // After drop, the spill file should be deleted
        assert!(!spill_path.exists(), "spill file should be cleaned up on drop");
    }

    // =========================================================================
    // build_section_index — DUMPSYS subsection tests
    // =========================================================================

    /// Build a fake bugreport-style raw byte buffer and corresponding line_index and
    /// line_meta for use in DUMPSYS subsection tests.
    ///
    /// Layout:
    ///   line 0: ------ SYSTEM LOG (/path) ------      (section start, level=Info, is_boundary)
    ///   line 1: some log line                          (content)
    ///   line 2: ------ 0.001s was the duration of 'SYSTEM LOG' ------  (section end, level=Verbose)
    ///   line 3: ------ DUMPSYS (/path) ------          (section start, level=Info, is_boundary)
    ///   line 4: content line                           (content)
    ///   line 5: DUMP OF SERVICE wifi:                  (subsection header)
    ///   line 6: wifi content                           (content)
    ///   line 7: DUMP OF SERVICE CRITICAL activity:     (subsection header with priority prefix)
    ///   line 8: activity content                       (content)
    ///   line 9: DUMP OF SERVICE HIGH meminfo:          (subsection header with HIGH prefix)
    ///   line 10: meminfo content                       (content)
    ///   line 11: ------ 0.002s was the duration of 'DUMPSYS' ------   (section end, level=Verbose)
    fn make_dumpsys_data() -> (Vec<u8>, Vec<u64>, Vec<LineMeta>, TagInterner) {
        let lines: &[&str] = &[
            "------ SYSTEM LOG (/proc/sys) ------",         // 0
            "some log line",                                  // 1
            "------ 0.001s was the duration of 'SYSTEM LOG' ------", // 2
            "------ DUMPSYS (/path) ------",                  // 3
            "content line",                                   // 4
            "DUMP OF SERVICE wifi:",                          // 5
            "wifi content",                                   // 6
            "DUMP OF SERVICE CRITICAL activity:",             // 7
            "activity content",                               // 8
            "DUMP OF SERVICE HIGH meminfo:",                  // 9
            "meminfo content",                                // 10
            "------ 0.002s was the duration of 'DUMPSYS' ------", // 11
        ];

        let mut data: Vec<u8> = Vec::new();
        let mut line_index: Vec<u64> = Vec::new();

        for line in lines {
            line_index.push(data.len() as u64);
            data.extend_from_slice(line.as_bytes());
            data.push(b'\n');
        }
        // Sentinel
        line_index.push(data.len() as u64);

        let mut interner = TagInterner::new();
        let system_log_id = interner.intern("SYSTEM LOG");
        let dumpsys_id = interner.intern("DUMPSYS");

        // Build LineMeta matching the lines above
        let meta = vec![
            // line 0: section start for SYSTEM LOG
            LineMeta { level: LogLevel::Info, tag_id: system_log_id, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: true },
            // line 1: content
            LineMeta { level: LogLevel::Info, tag_id: 0, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: false },
            // line 2: section end for SYSTEM LOG
            LineMeta { level: LogLevel::Verbose, tag_id: system_log_id, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: true },
            // line 3: section start for DUMPSYS
            LineMeta { level: LogLevel::Info, tag_id: dumpsys_id, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: true },
            // line 4: content
            LineMeta { level: LogLevel::Info, tag_id: 0, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: false },
            // line 5: DUMP OF SERVICE wifi: (content — parser doesn't mark these as boundaries)
            LineMeta { level: LogLevel::Info, tag_id: 0, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: false },
            // line 6: wifi content
            LineMeta { level: LogLevel::Info, tag_id: 0, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: false },
            // line 7: DUMP OF SERVICE CRITICAL activity:
            LineMeta { level: LogLevel::Info, tag_id: 0, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: false },
            // line 8: activity content
            LineMeta { level: LogLevel::Info, tag_id: 0, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: false },
            // line 9: DUMP OF SERVICE HIGH meminfo:
            LineMeta { level: LogLevel::Info, tag_id: 0, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: false },
            // line 10: meminfo content
            LineMeta { level: LogLevel::Info, tag_id: 0, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: false },
            // line 11: section end for DUMPSYS
            LineMeta { level: LogLevel::Verbose, tag_id: dumpsys_id, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: true },
        ];

        (data, line_index, meta, interner)
    }

    #[test]
    fn build_section_index_detects_dumpsys_subsections() {
        let (data, line_index, meta, interner) = make_dumpsys_data();
        let sections = build_section_index(
            &meta,
            &SourceType::Bugreport,
            &interner,
            &data,
            &line_index,
        );

        // Expected flat order:
        //   [0] SYSTEM LOG (top-level, parent_index=None)
        //   [1] DUMPSYS (top-level, parent_index=None)
        //   [2] wifi (child of DUMPSYS at index 1, parent_index=Some(1))
        //   [3] activity (child of DUMPSYS at index 1, parent_index=Some(1))
        //   [4] meminfo (child of DUMPSYS at index 1, parent_index=Some(1))

        assert_eq!(sections.len(), 5, "expected 2 top-level + 3 children");

        // Top-level SYSTEM LOG
        assert_eq!(sections[0].name, "SYSTEM LOG");
        assert_eq!(sections[0].start_line, 0);
        assert_eq!(sections[0].end_line, 2);
        assert!(sections[0].parent_index.is_none(), "SYSTEM LOG should be top-level");

        // Top-level DUMPSYS
        assert_eq!(sections[1].name, "DUMPSYS");
        assert_eq!(sections[1].start_line, 3);
        assert_eq!(sections[1].end_line, 11);
        assert!(sections[1].parent_index.is_none(), "DUMPSYS should be top-level");

        // Child: wifi
        assert_eq!(sections[2].name, "wifi");
        assert_eq!(sections[2].start_line, 5);
        assert_eq!(sections[2].end_line, 6, "wifi end_line should be closed by next child");
        assert_eq!(sections[2].parent_index, Some(1), "wifi parent should be DUMPSYS at index 1");

        // Child: activity (after stripping CRITICAL prefix)
        assert_eq!(sections[3].name, "activity");
        assert_eq!(sections[3].start_line, 7);
        assert_eq!(sections[3].end_line, 8, "activity end_line should be closed by next child");
        assert_eq!(sections[3].parent_index, Some(1), "activity parent should be DUMPSYS at index 1");

        // Child: meminfo (after stripping HIGH prefix)
        assert_eq!(sections[4].name, "meminfo");
        assert_eq!(sections[4].start_line, 9);
        assert_eq!(sections[4].end_line, 11, "last child end_line should match parent end_line");
        assert_eq!(sections[4].parent_index, Some(1), "meminfo parent should be DUMPSYS at index 1");
    }

    #[test]
    fn build_section_index_priority_prefix_stripping() {
        // Minimal test: verify priority prefix variants are stripped correctly.
        // Reuse the data from make_dumpsys_data() and check names directly.
        let (data, line_index, meta, interner) = make_dumpsys_data();
        let sections = build_section_index(
            &meta,
            &SourceType::Bugreport,
            &interner,
            &data,
            &line_index,
        );

        let child_names: Vec<&str> = sections.iter()
            .filter(|s| s.parent_index.is_some())
            .map(|s| s.name.as_str())
            .collect();

        assert!(child_names.contains(&"wifi"), "plain service name should be unchanged");
        assert!(child_names.contains(&"activity"), "CRITICAL prefix should be stripped");
        assert!(child_names.contains(&"meminfo"), "HIGH prefix should be stripped");
        assert!(!child_names.iter().any(|n| n.starts_with("CRITICAL ")), "CRITICAL prefix must be stripped");
        assert!(!child_names.iter().any(|n| n.starts_with("HIGH ")), "HIGH prefix must be stripped");
    }

    #[test]
    fn build_section_index_non_dumpsys_sections_have_no_children() {
        // Build data where a non-DUMPSYS section contains a DUMP OF SERVICE line.
        // That section should NOT get children — only sections named DUMPSYS* get subsection detection.
        let lines: &[&str] = &[
            "------ SYSTEM LOG (/path) ------",         // 0 — section start
            "DUMP OF SERVICE wifi:",                     // 1 — should NOT become a child
            "some content",                              // 2
            "------ 0.001s was the duration of 'SYSTEM LOG' ------", // 3 — section end
        ];

        let mut data: Vec<u8> = Vec::new();
        let mut line_index: Vec<u64> = Vec::new();

        for line in lines {
            line_index.push(data.len() as u64);
            data.extend_from_slice(line.as_bytes());
            data.push(b'\n');
        }
        line_index.push(data.len() as u64);

        let mut interner = TagInterner::new();
        let system_log_id = interner.intern("SYSTEM LOG");

        let meta = vec![
            LineMeta { level: LogLevel::Info, tag_id: system_log_id, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: true },
            LineMeta { level: LogLevel::Info, tag_id: 0, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: false },
            LineMeta { level: LogLevel::Info, tag_id: 0, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: false },
            LineMeta { level: LogLevel::Verbose, tag_id: system_log_id, timestamp: 0, byte_offset: 0, byte_len: 0, is_section_boundary: true },
        ];

        let sections = build_section_index(
            &meta,
            &SourceType::Bugreport,
            &interner,
            &data,
            &line_index,
        );

        // Only one top-level section, no children
        assert_eq!(sections.len(), 1, "non-DUMPSYS section should have no children");
        assert_eq!(sections[0].name, "SYSTEM LOG");
        assert!(sections[0].parent_index.is_none());
        assert!(!sections.iter().any(|s| s.parent_index.is_some()), "no children should exist");
    }

    // =========================================================================
    // ZipLogSource tests
    // =========================================================================

    #[test]
    fn zip_source_basic() {
        let raw = b"01-01 00:00:01.000  1234  5678 D TestTag: Hello world\n\
                    01-01 00:00:02.000  1234  5678 I TestTag: Second line\n";
        let mut session = AnalysisSession::new("test-zip".to_string());
        session
            .add_zip_source(raw.to_vec(), "src-1".to_string(), "test.log".to_string())
            .unwrap();
        let source = session.primary_source().unwrap();
        assert_eq!(source.total_lines(), 2);
        assert!(source.raw_line(0).is_some());
        assert!(source.raw_line(1).is_some());
        assert!(source.raw_line(2).is_none());
        assert!(!source.is_live());
        assert!(!source.is_indexing());
    }

    #[test]
    fn zip_source_id_name_type() {
        let raw = b"01-01 00:00:01.000  1000  1001 I Tag: msg\n";
        let mut session = AnalysisSession::new("s".to_string());
        session
            .add_zip_source(raw.to_vec(), "zip-src-id".to_string(), "myfile.log".to_string())
            .unwrap();
        let source = session.primary_source().unwrap();
        assert_eq!(source.id(), "zip-src-id");
        assert_eq!(source.name(), "myfile.log");
        assert!(matches!(source.source_type(), SourceType::Logcat));
    }

    #[test]
    fn zip_source_downcast_accessor() {
        let raw = b"01-01 00:00:01.000  1000  1001 I Tag: msg\n";
        let mut session = AnalysisSession::new("s".to_string());
        session
            .add_zip_source(raw.to_vec(), "z1".to_string(), "z.log".to_string())
            .unwrap();
        assert!(session.zip_source().is_some());
        assert!(session.file_source().is_none());
        assert!(session.stream_source().is_none());
    }

    #[test]
    fn zip_source_raw_line_content() {
        let raw = b"01-01 00:00:01.000  1234  5678 D TestTag: Hello world\n\
                    01-01 00:00:02.000  1234  5678 I TestTag: Second line\n";
        let mut session = AnalysisSession::new("s".to_string());
        session
            .add_zip_source(raw.to_vec(), "z".to_string(), "z.log".to_string())
            .unwrap();
        let source = session.primary_source().unwrap();
        let line0 = source.raw_line(0).unwrap();
        assert!(line0.contains("Hello world"), "line 0 should contain 'Hello world'");
        let line1 = source.raw_line(1).unwrap();
        assert!(line1.contains("Second line"), "line 1 should contain 'Second line'");
    }

    #[test]
    fn zip_source_meta_at() {
        let raw = b"01-01 00:00:01.000  1000  1001 I Tag: msg\n";
        let mut session = AnalysisSession::new("s".to_string());
        session
            .add_zip_source(raw.to_vec(), "z".to_string(), "z.log".to_string())
            .unwrap();
        let source = session.primary_source().unwrap();
        assert!(source.meta_at(0).is_some());
        assert!(source.meta_at(1).is_none());
    }

    #[test]
    fn zip_source_downcast_via_boxed_trait() {
        let raw = b"01-01 00:00:01.000  1000  1001 I Tag: msg\n";
        let mut session = AnalysisSession::new("s".to_string());
        session
            .add_zip_source(raw.to_vec(), "z".to_string(), "z.log".to_string())
            .unwrap();
        let boxed: &Box<dyn LogSource> = session.source.as_ref().unwrap();
        assert!(boxed.as_any().downcast_ref::<ZipLogSource>().is_some());
        assert!(boxed.as_any().downcast_ref::<FileLogSource>().is_none());
        assert!(boxed.as_any().downcast_ref::<StreamLogSource>().is_none());
    }
}
