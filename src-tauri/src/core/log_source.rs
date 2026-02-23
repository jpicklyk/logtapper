use memmap2::Mmap;
use std::any::Any;
use std::sync::Arc;

use crate::core::line::LineMeta;
use crate::core::session::{SectionInfo, SourceType};

// ---------------------------------------------------------------------------
// LogSource trait — the foundational abstraction for log data access
// ---------------------------------------------------------------------------

/// Unified interface for accessing log data, whether from a memory-mapped file
/// or a live ADB stream. All line numbers are absolute (0-based, monotonically
/// increasing even through stream eviction).
pub trait LogSource: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn source_type(&self) -> &SourceType;
    fn total_lines(&self) -> usize;
    fn raw_line(&self, line_num: usize) -> Option<&str>;
    fn meta_at(&self, line_num: usize) -> Option<&LineMeta>;
    fn line_meta_slice(&self) -> &[LineMeta];
    fn is_live(&self) -> bool;
    fn sections(&self) -> &[SectionInfo];
    fn is_indexing(&self) -> bool;

    /// Downcast support for type-specific mutable operations.
    fn as_any(&self) -> &dyn Any;
    fn as_any_mut(&mut self) -> &mut dyn Any;

    fn first_timestamp(&self) -> Option<i64> {
        self.line_meta_slice()
            .iter()
            .find(|m| m.timestamp > 0)
            .map(|m| m.timestamp)
    }

    fn last_timestamp(&self) -> Option<i64> {
        self.line_meta_slice()
            .iter()
            .rev()
            .find(|m| m.timestamp > 0)
            .map(|m| m.timestamp)
    }
}

// ---------------------------------------------------------------------------
// FileLogSource — immutable memory-mapped file source
// ---------------------------------------------------------------------------

pub struct FileLogSource {
    pub(crate) source_id: String,
    pub(crate) source_name: String,
    pub(crate) source_type: SourceType,
    pub(crate) mmap: Arc<Mmap>,
    /// Byte offsets for every indexed line, with a sentinel at the end.
    /// Line i spans `line_index[i]..line_index[i+1]`.
    pub(crate) line_index: Vec<u64>,
    pub(crate) line_meta: Vec<LineMeta>,
    pub(crate) section_info: Vec<SectionInfo>,
    /// True while background indexing is still scanning the remainder.
    pub(crate) indexing: bool,
}

impl LogSource for FileLogSource {
    fn id(&self) -> &str {
        &self.source_id
    }

    fn name(&self) -> &str {
        &self.source_name
    }

    fn source_type(&self) -> &SourceType {
        &self.source_type
    }

    fn total_lines(&self) -> usize {
        self.line_meta.len()
    }

    fn raw_line(&self, line_num: usize) -> Option<&str> {
        if line_num + 1 >= self.line_index.len() {
            return None;
        }
        let start = self.line_index[line_num] as usize;
        let end = self.line_index[line_num + 1] as usize;
        if start >= end || end > self.mmap.len() {
            return None;
        }
        // Strip trailing \n and \r\n
        let mut slice_end = end;
        if slice_end > start && self.mmap[slice_end - 1] == b'\n' {
            slice_end -= 1;
        }
        if slice_end > start && self.mmap[slice_end - 1] == b'\r' {
            slice_end -= 1;
        }
        std::str::from_utf8(&self.mmap[start..slice_end]).ok()
    }

    fn meta_at(&self, line_num: usize) -> Option<&LineMeta> {
        self.line_meta.get(line_num)
    }

    fn line_meta_slice(&self) -> &[LineMeta] {
        &self.line_meta
    }

    fn is_live(&self) -> bool {
        false
    }

    fn sections(&self) -> &[SectionInfo] {
        &self.section_info
    }

    fn is_indexing(&self) -> bool {
        self.indexing
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

impl FileLogSource {
    /// Access the underlying mmap (for pipeline snapshot).
    pub fn mmap(&self) -> &Arc<Mmap> {
        &self.mmap
    }

    /// Access the line index (for pipeline snapshot).
    pub fn line_index(&self) -> &[u64] {
        &self.line_index
    }

    /// Set the indexing flag.
    pub fn set_indexing(&mut self, indexing: bool) {
        self.indexing = indexing;
    }

    /// Extend the line index with new entries from background indexing.
    /// `new_offsets` are byte offsets of newly indexed lines (no sentinel).
    /// `sentinel` is the byte offset just past the last line in this batch.
    /// When `done` is true, indexing is marked complete.
    pub fn extend_index(
        &mut self,
        new_offsets: Vec<u64>,
        new_line_meta: Vec<LineMeta>,
        sentinel: u64,
        done: bool,
    ) {
        // Remove old sentinel before appending new offsets.
        if !self.line_index.is_empty() {
            self.line_index.pop();
        }
        self.line_index.extend(new_offsets);
        self.line_index.push(sentinel);
        self.line_meta.extend(new_line_meta);
        self.indexing = !done;
    }

    /// Update sections (called after indexing completes).
    pub fn set_sections(&mut self, sections: Vec<SectionInfo>) {
        self.section_info = sections;
    }
}

// ---------------------------------------------------------------------------
// StreamLogSource — append-only live stream source (ADB logcat)
// ---------------------------------------------------------------------------

pub struct StreamLogSource {
    pub(crate) source_id: String,
    pub(crate) source_name: String,
    pub(crate) source_type: SourceType,
    /// Raw line strings growing as new ADB lines arrive.
    pub(crate) raw_lines: Vec<String>,
    pub(crate) line_meta: Vec<LineMeta>,
    /// Cumulative bytes received (including bytes of evicted lines).
    pub(crate) byte_count: u64,
    /// Lines drained from the front to enforce the size cap.
    pub(crate) evicted_count: usize,
    /// First non-zero timestamp ever seen; set once, never cleared after eviction.
    pub(crate) cached_first_ts: Option<i64>,
}

impl StreamLogSource {
    pub fn new(source_id: String, source_name: String) -> Self {
        Self {
            source_id,
            source_name,
            source_type: SourceType::Logcat,
            raw_lines: Vec::new(),
            line_meta: Vec::new(),
            byte_count: 0,
            evicted_count: 0,
            cached_first_ts: None,
        }
    }

    /// Cumulative byte count for streaming sources.
    pub fn stream_byte_count(&self) -> u64 {
        self.byte_count
    }

    /// Add bytes to the cumulative count.
    pub fn add_bytes(&mut self, bytes: u64) {
        self.byte_count += bytes;
    }

    /// Push a raw line into the stream buffer.
    pub fn push_raw_line(&mut self, line: String) {
        self.raw_lines.push(line);
    }

    /// Push line metadata.
    pub fn push_meta(&mut self, meta: LineMeta) {
        self.line_meta.push(meta);
    }

    /// Set cached_first_ts if not already set and timestamp > 0.
    pub fn maybe_set_first_ts(&mut self, ts: i64) {
        if self.cached_first_ts.is_none() && ts > 0 {
            self.cached_first_ts = Some(ts);
        }
    }

    /// Evict the oldest `count` lines from the front of the buffer.
    pub fn evict(&mut self, count: usize) {
        if count > 0 {
            self.raw_lines.drain(0..count);
            self.line_meta.drain(0..count);
            self.evicted_count += count;
        }
    }

    /// Number of raw lines currently retained in memory.
    pub fn retained_count(&self) -> usize {
        self.raw_lines.len()
    }

    /// Number of lines evicted from the front.
    pub fn evicted_count(&self) -> usize {
        self.evicted_count
    }

    /// Cached first timestamp (survives eviction).
    pub fn cached_first_ts(&self) -> Option<i64> {
        self.cached_first_ts
    }
}

impl LogSource for StreamLogSource {
    fn id(&self) -> &str {
        &self.source_id
    }

    fn name(&self) -> &str {
        &self.source_name
    }

    fn source_type(&self) -> &SourceType {
        &self.source_type
    }

    fn total_lines(&self) -> usize {
        self.evicted_count + self.line_meta.len()
    }

    fn raw_line(&self, line_num: usize) -> Option<&str> {
        let local_idx = line_num.checked_sub(self.evicted_count)?;
        self.raw_lines.get(local_idx).map(|s| s.as_str())
    }

    fn meta_at(&self, line_num: usize) -> Option<&LineMeta> {
        let local = line_num.checked_sub(self.evicted_count)?;
        self.line_meta.get(local)
    }

    fn line_meta_slice(&self) -> &[LineMeta] {
        &self.line_meta
    }

    fn is_live(&self) -> bool {
        true
    }

    fn sections(&self) -> &[SectionInfo] {
        &[] // streams don't have sections
    }

    fn is_indexing(&self) -> bool {
        false
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn first_timestamp(&self) -> Option<i64> {
        // Return cached value so eviction doesn't lose the original first timestamp.
        self.cached_first_ts
    }
}
