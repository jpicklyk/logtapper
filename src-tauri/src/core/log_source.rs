use memmap2::Mmap;
use std::any::Any;
use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::core::line::LineMeta;
use crate::core::session::{SectionInfo, SourceType};

/// Shared line extraction from indexed byte data. Used by FileLogSource and ZipLogSource.
fn raw_line_from_bytes<'a>(data: &'a [u8], line_index: &[u64], line_num: usize) -> Option<Cow<'a, str>> {
    if line_num + 1 >= line_index.len() {
        return None;
    }
    let start = line_index[line_num] as usize;
    let end = line_index[line_num + 1] as usize;
    if start >= end || end > data.len() {
        return None;
    }
    let mut slice_end = end;
    if slice_end > start && data[slice_end - 1] == b'\n' {
        slice_end -= 1;
    }
    if slice_end > start && data[slice_end - 1] == b'\r' {
        slice_end -= 1;
    }
    std::str::from_utf8(&data[start..slice_end]).ok().map(Cow::Borrowed)
}

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
    fn raw_line(&self, line_num: usize) -> Option<Cow<'_, str>>;
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
            .filter(|m| m.timestamp > 0)
            .map(|m| m.timestamp)
            .max()
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

    fn raw_line(&self, line_num: usize) -> Option<Cow<'_, str>> {
        raw_line_from_bytes(&self.mmap, &self.line_index, line_num)
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
// ZipLogSource — decompressed in-memory log source
// ---------------------------------------------------------------------------

pub struct ZipLogSource {
    pub(crate) source_id: String,
    pub(crate) source_name: String,
    pub(crate) source_type: SourceType,
    /// Decompressed source bytes held in memory.
    pub(crate) data: Arc<Vec<u8>>,
    /// Byte offsets for every line (sentinel at end, same as FileLogSource).
    pub(crate) line_index: Vec<u64>,
    pub(crate) line_meta: Vec<LineMeta>,
    pub(crate) section_info: Vec<SectionInfo>,
}

impl LogSource for ZipLogSource {
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

    fn raw_line(&self, line_num: usize) -> Option<Cow<'_, str>> {
        raw_line_from_bytes(&self.data, &self.line_index, line_num)
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
        false
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

impl ZipLogSource {
    pub fn data(&self) -> &Arc<Vec<u8>> {
        &self.data
    }

    pub fn line_index(&self) -> &[u64] {
        &self.line_index
    }
}

// ---------------------------------------------------------------------------
// SpillFile — temp file for evicted stream lines
// ---------------------------------------------------------------------------

/// Holds the spill file handle, byte offsets for each spilled line, and the
/// file path (for cleanup and capture finalization).
pub(crate) struct SpillFile {
    /// Read+write handle.  Protected by Mutex because `raw_line(&self)` needs
    /// to seek+read while the trait method takes `&self`.
    file: Mutex<std::fs::File>,
    /// Byte offset of each spilled line within the file.
    line_offsets: Vec<u64>,
    /// Total bytes written (== offset of next write).
    total_bytes: u64,
    /// Path on disk (for cleanup / finalization).
    pub(crate) path: PathBuf,
}

impl SpillFile {
    fn create(path: PathBuf) -> Result<Self, String> {
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|e| format!("Failed to create spill file {}: {e}", path.display()))?;
        Ok(Self {
            file: Mutex::new(file),
            line_offsets: Vec::new(),
            total_bytes: 0,
            path,
        })
    }

    /// Append a line to the spill file.  Records byte offset.
    fn write_line(&mut self, line: &str) -> Result<(), String> {
        let mut f = self.file.lock().map_err(|_| "spill file lock poisoned")?;
        self.line_offsets.push(self.total_bytes);
        let bytes = line.as_bytes();
        f.write_all(bytes).map_err(|e| format!("spill write: {e}"))?;
        f.write_all(b"\n").map_err(|e| format!("spill write: {e}"))?;
        self.total_bytes += bytes.len() as u64 + 1;
        Ok(())
    }

    /// Read a spilled line by its absolute line number (0-based within the spill).
    pub(crate) fn read_line(&self, spill_idx: usize) -> Option<String> {
        if spill_idx >= self.line_offsets.len() {
            return None;
        }
        let offset = self.line_offsets[spill_idx];
        let end = if spill_idx + 1 < self.line_offsets.len() {
            self.line_offsets[spill_idx + 1]
        } else {
            self.total_bytes
        };
        // end includes the trailing '\n', so content length = end - offset - 1
        if end <= offset {
            return Some(String::new());
        }
        let content_len = (end - offset - 1) as usize; // strip trailing \n
        let mut buf = vec![0u8; content_len];
        let mut f = self.file.lock().ok()?;
        f.seek(SeekFrom::Start(offset)).ok()?;
        f.read_exact(&mut buf).ok()?;
        Some(String::from_utf8_lossy(&buf).into_owned())
    }

    /// Total number of lines spilled.
    pub(crate) fn total_spilled(&self) -> usize {
        self.line_offsets.len()
    }
}

impl Drop for SpillFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
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
    /// Metadata for ALL lines ever pushed (never drained — ~24 bytes each).
    pub(crate) line_meta: Vec<LineMeta>,
    /// Cumulative bytes received (including bytes of evicted lines).
    pub(crate) byte_count: u64,
    /// Lines drained from the front to enforce the size cap.
    pub(crate) evicted_count: usize,
    /// First non-zero timestamp ever seen; set once, never cleared after eviction.
    pub(crate) cached_first_ts: Option<i64>,
    /// Temp file for evicted lines (created on first eviction).
    pub(crate) spill: Option<SpillFile>,
    /// Directory for temp spill files.
    pub(crate) temp_dir: PathBuf,
    /// Session ID for naming the spill file.
    pub(crate) session_id: String,
}

impl StreamLogSource {
    pub fn new(source_id: String, source_name: String, session_id: String, temp_dir: PathBuf) -> Self {
        Self {
            source_id,
            source_name,
            source_type: SourceType::Logcat,
            raw_lines: Vec::new(),
            line_meta: Vec::new(),
            byte_count: 0,
            evicted_count: 0,
            cached_first_ts: None,
            spill: None,
            temp_dir,
            session_id,
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

    /// Evict the oldest `count` lines from the front of the in-memory buffer.
    /// Evicted lines are written to the spill file so they remain accessible
    /// via `raw_line()`.  Metadata (`line_meta`) is never drained — it stays
    /// in memory for all lines (past and present).
    pub fn evict(&mut self, count: usize) {
        if count == 0 {
            return;
        }
        // Create spill file on first eviction.
        if self.spill.is_none() {
            let spill_path = self.temp_dir.join(format!(
                "logtapper-spill-{}.tmp",
                self.session_id
            ));
            match SpillFile::create(spill_path) {
                Ok(sf) => self.spill = Some(sf),
                Err(e) => {
                    eprintln!("Warning: failed to create spill file, evicted lines will be lost: {e}");
                    // Fall through — evict without spilling (legacy behavior).
                }
            }
        }
        // Write evicted lines to spill file.
        if let Some(ref mut spill) = self.spill {
            for line in self.raw_lines.iter().take(count) {
                if let Err(e) = spill.write_line(line) {
                    eprintln!("Warning: spill write failed: {e}");
                }
            }
        }
        self.raw_lines.drain(0..count);
        // NOTE: line_meta is NOT drained — metadata stays for all lines.
        self.evicted_count += count;
    }

    /// Whether a spill file exists (evicted lines are recoverable).
    pub fn has_spill(&self) -> bool {
        self.spill.is_some()
    }

    /// Get the spill file path, if any.
    pub fn spill_path(&self) -> Option<&PathBuf> {
        self.spill.as_ref().map(|s| &s.path)
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
        // line_meta is never drained, so it reflects ALL lines ever pushed.
        self.line_meta.len()
    }

    fn raw_line(&self, line_num: usize) -> Option<Cow<'_, str>> {
        if line_num < self.evicted_count {
            // Evicted line — try the spill file.
            self.spill
                .as_ref()
                .and_then(|sf| sf.read_line(line_num))
                .map(Cow::Owned)
        } else {
            // In-memory line.
            let local_idx = line_num - self.evicted_count;
            self.raw_lines.get(local_idx).map(|s| Cow::Borrowed(s.as_str()))
        }
    }

    fn meta_at(&self, line_num: usize) -> Option<&LineMeta> {
        // line_meta covers ALL lines (never drained), so direct index works.
        self.line_meta.get(line_num)
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
