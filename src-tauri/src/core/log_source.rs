use memmap2::Mmap;
use std::any::Any;
use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::core::line::LineMeta;
use crate::core::session::{SectionInfo, SourceType};

// ---------------------------------------------------------------------------
// Encoding detection and UTF-16 decode
// ---------------------------------------------------------------------------

/// File encoding detected from BOM.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
pub enum Encoding {
    #[default]
    Utf8,
    Utf16Le,
    Utf16Be,
}

impl Encoding {
    /// Byte length of the BOM for this encoding (0 for UTF-8 without BOM).
    pub fn bom_len(self) -> usize {
        match self {
            Encoding::Utf8 => 0,
            Encoding::Utf16Le | Encoding::Utf16Be => 2,
        }
    }

    /// Human-readable name for display in the status bar.
    pub fn display_name(self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf16Le => "UTF-16 LE",
            Encoding::Utf16Be => "UTF-16 BE",
        }
    }

    pub fn is_utf16(self) -> bool {
        matches!(self, Encoding::Utf16Le | Encoding::Utf16Be)
    }
}

/// Detect encoding from the first bytes of a file (BOM detection).
pub fn detect_encoding(data: &[u8]) -> Encoding {
    if data.len() >= 2 {
        if data[0] == 0xFF && data[1] == 0xFE {
            return Encoding::Utf16Le;
        }
        if data[0] == 0xFE && data[1] == 0xFF {
            return Encoding::Utf16Be;
        }
    }
    Encoding::Utf8
}

/// Decode a UTF-16 byte slice into a UTF-8 String.
/// Returns None if the byte slice has an odd length or is empty.
/// Uses `char::decode_utf16` iterator directly to avoid intermediate `Vec<u16>`.
pub fn decode_utf16_bytes(bytes: &[u8], big_endian: bool) -> Option<String> {
    if bytes.is_empty() || bytes.len() % 2 != 0 {
        return None;
    }
    let iter = bytes.chunks_exact(2).map(|c| {
        if big_endian {
            u16::from_be_bytes([c[0], c[1]])
        } else {
            u16::from_le_bytes([c[0], c[1]])
        }
    });
    Some(
        char::decode_utf16(iter)
            .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect(),
    )
}

/// Check if a pair of bytes represents a UTF-16 LF code unit.
#[inline]
pub fn is_utf16_lf(a: u8, b: u8, big_endian: bool) -> bool {
    if big_endian { a == 0x00 && b == 0x0A } else { a == 0x0A && b == 0x00 }
}

/// Check if a pair of bytes represents a UTF-16 CR code unit.
#[inline]
pub fn is_utf16_cr(a: u8, b: u8, big_endian: bool) -> bool {
    if big_endian { a == 0x00 && b == 0x0D } else { a == 0x0D && b == 0x00 }
}

/// Decode a line's byte range from raw data, handling encoding.
/// For UTF-8 this borrows from the data; for UTF-16 it allocates.
pub fn decode_line_bytes<'a>(data: &'a [u8], start: usize, end: usize, encoding: Encoding) -> Option<Cow<'a, str>> {
    if start >= end || end > data.len() {
        return None;
    }
    match encoding {
        Encoding::Utf8 => {
            let mut slice_end = end;
            if slice_end > start && data[slice_end - 1] == b'\n' {
                slice_end -= 1;
            }
            if slice_end > start && data[slice_end - 1] == b'\r' {
                slice_end -= 1;
            }
            std::str::from_utf8(&data[start..slice_end]).ok().map(Cow::Borrowed)
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let be = encoding == Encoding::Utf16Be;
            let mut slice_end = end;
            // Strip UTF-16 LF (2 bytes) and optional preceding CR (2 bytes)
            if slice_end >= start + 2 && is_utf16_lf(data[slice_end - 2], data[slice_end - 1], be) {
                slice_end -= 2;
                if slice_end >= start + 2 && is_utf16_cr(data[slice_end - 2], data[slice_end - 1], be) {
                    slice_end -= 2;
                }
            }
            decode_utf16_bytes(&data[start..slice_end], be).map(Cow::Owned)
        }
    }
}

/// Shared line extraction from indexed byte data. Used by FileLogSource and ZipLogSource.
fn raw_line_from_bytes<'a>(data: &'a [u8], line_index: &[u64], line_num: usize, encoding: Encoding) -> Option<Cow<'a, str>> {
    if line_num + 1 >= line_index.len() {
        return None;
    }
    let start = line_index[line_num] as usize;
    let end = line_index[line_num + 1] as usize;
    decode_line_bytes(data, start, end, encoding)
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

    /// Whether the source uses CRLF line endings. Always false for streams.
    fn has_crlf(&self) -> bool { false }

    /// Detected file encoding. Defaults to UTF-8.
    fn encoding(&self) -> Encoding { Encoding::Utf8 }

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
    /// True if the file uses CRLF (`\r\n`) line endings, false for LF (`\n`).
    pub(crate) has_crlf: bool,
    /// Detected file encoding (UTF-8, UTF-16LE, UTF-16BE).
    pub(crate) encoding: Encoding,
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
        raw_line_from_bytes(&self.mmap, &self.line_index, line_num, self.encoding)
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

    fn has_crlf(&self) -> bool {
        self.has_crlf
    }

    fn encoding(&self) -> Encoding {
        self.encoding
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

/// Detect CRLF line endings, accounting for file encoding.
pub fn detect_crlf(data: &[u8], encoding: Encoding) -> bool {
    match encoding {
        Encoding::Utf8 => {
            memchr::memchr(b'\n', data).is_some_and(|pos| pos > 0 && data[pos - 1] == b'\r')
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let be = encoding == Encoding::Utf16Be;
            let d = &data[encoding.bom_len()..];
            for i in (0..d.len().saturating_sub(1)).step_by(2) {
                if is_utf16_lf(d[i], d[i + 1], be) {
                    return i >= 2 && is_utf16_cr(d[i - 2], d[i - 1], be);
                }
            }
            false
        }
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
    /// Detected file encoding.
    pub(crate) encoding: Encoding,
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
        raw_line_from_bytes(&self.data, &self.line_index, line_num, self.encoding)
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

    fn encoding(&self) -> Encoding {
        self.encoding
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
// Tests for raw_line_from_bytes
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{raw_line_from_bytes, Encoding, detect_encoding, decode_utf16_bytes, detect_crlf};

    /// Empty line_index (no sentinel) returns None for any line_num.
    #[test]
    fn raw_line_from_bytes_empty_index() {
        let data = b"hello\n";
        let index: Vec<u64> = vec![];
        assert!(
            raw_line_from_bytes(data, &index, 0, Encoding::Utf8).is_none(),
            "empty index must return None for line 0"
        );
    }

    /// A single-sentinel index (no lines) returns None for line 0.
    #[test]
    fn raw_line_from_bytes_sentinel_only() {
        let data = b"hello\n";
        let index: Vec<u64> = vec![6];
        assert!(
            raw_line_from_bytes(data, &index, 0, Encoding::Utf8).is_none(),
            "sentinel-only index must return None for line 0"
        );
    }

    /// \r\n is stripped correctly from the returned content.
    #[test]
    fn raw_line_from_bytes_strips_crlf() {
        let data = b"hello\r\nworld\r\n";
        let index: Vec<u64> = vec![0, 7, 14];
        let line0 = raw_line_from_bytes(data, &index, 0, Encoding::Utf8).unwrap();
        assert_eq!(line0.as_ref(), "hello", "\\r\\n must be fully stripped from line 0");
        let line1 = raw_line_from_bytes(data, &index, 1, Encoding::Utf8).unwrap();
        assert_eq!(line1.as_ref(), "world", "\\r\\n must be fully stripped from line 1");
    }

    /// Plain \n is stripped correctly.
    #[test]
    fn raw_line_from_bytes_strips_lf() {
        let data = b"alpha\nbeta\n";
        let index: Vec<u64> = vec![0, 6, 11];
        let line0 = raw_line_from_bytes(data, &index, 0, Encoding::Utf8).unwrap();
        assert_eq!(line0.as_ref(), "alpha");
        let line1 = raw_line_from_bytes(data, &index, 1, Encoding::Utf8).unwrap();
        assert_eq!(line1.as_ref(), "beta");
    }

    /// line_num beyond total lines returns None.
    #[test]
    fn raw_line_from_bytes_out_of_bounds() {
        let data = b"line0\nline1\n";
        let index: Vec<u64> = vec![0, 6, 12];
        assert!(raw_line_from_bytes(data, &index, 2, Encoding::Utf8).is_none(), "line 2 must return None");
        assert!(raw_line_from_bytes(data, &index, 100, Encoding::Utf8).is_none(), "line 100 must return None");
    }

    /// Non-UTF-8 bytes return None (not a panic).
    #[test]
    fn raw_line_from_bytes_invalid_utf8() {
        // 0xFF 0xFE is not valid UTF-8 — but IS a UTF-16LE BOM.
        // With Utf8 encoding, this should return None.
        let data: &[u8] = &[0xFF, 0xFE, b'\n'];
        let index: Vec<u64> = vec![0, 3];
        let result = raw_line_from_bytes(data, &index, 0, Encoding::Utf8);
        assert!(result.is_none(), "invalid UTF-8 bytes must return None, not panic");
    }

    // ── Encoding detection tests ────────────────────────────────────────

    #[test]
    fn detect_encoding_utf16le_bom() {
        let data: &[u8] = &[0xFF, 0xFE, b'h', 0x00, b'i', 0x00];
        assert_eq!(detect_encoding(data), Encoding::Utf16Le);
    }

    #[test]
    fn detect_encoding_utf16be_bom() {
        let data: &[u8] = &[0xFE, 0xFF, 0x00, b'h', 0x00, b'i'];
        assert_eq!(detect_encoding(data), Encoding::Utf16Be);
    }

    #[test]
    fn detect_encoding_utf8_default() {
        let data = b"hello world\n";
        assert_eq!(detect_encoding(data), Encoding::Utf8);
    }

    #[test]
    fn detect_encoding_empty() {
        assert_eq!(detect_encoding(&[]), Encoding::Utf8);
    }

    // ── UTF-16 decode tests ─────────────────────────────────────────────

    #[test]
    fn decode_utf16_le_basic() {
        // "Hi" in UTF-16LE: H=0x48,0x00  i=0x69,0x00
        let data: &[u8] = &[0x48, 0x00, 0x69, 0x00];
        assert_eq!(decode_utf16_bytes(data, false).unwrap(), "Hi");
    }

    #[test]
    fn decode_utf16_be_basic() {
        // "Hi" in UTF-16BE: H=0x00,0x48  i=0x00,0x69
        let data: &[u8] = &[0x00, 0x48, 0x00, 0x69];
        assert_eq!(decode_utf16_bytes(data, true).unwrap(), "Hi");
    }

    #[test]
    fn decode_utf16_odd_bytes_returns_none() {
        let data: &[u8] = &[0x48, 0x00, 0x69];
        assert!(decode_utf16_bytes(data, false).is_none());
    }

    #[test]
    fn decode_utf16_empty_returns_none() {
        assert!(decode_utf16_bytes(&[], false).is_none());
    }

    // ── UTF-16 raw_line_from_bytes tests ────────────────────────────────

    #[test]
    fn raw_line_from_bytes_utf16le() {
        // BOM + "Hi\n" in UTF-16LE
        let data: &[u8] = &[
            0xFF, 0xFE,             // BOM
            0x48, 0x00, 0x69, 0x00, // "Hi"
            0x0A, 0x00,             // LF
        ];
        // Line starts after BOM (offset 2), ends at offset 8 (sentinel)
        let index: Vec<u64> = vec![2, 8];
        let line = raw_line_from_bytes(data, &index, 0, Encoding::Utf16Le).unwrap();
        assert_eq!(line.as_ref(), "Hi");
    }

    #[test]
    fn raw_line_from_bytes_utf16le_crlf() {
        // BOM + "Hi\r\n" in UTF-16LE
        let data: &[u8] = &[
            0xFF, 0xFE,             // BOM
            0x48, 0x00, 0x69, 0x00, // "Hi"
            0x0D, 0x00, 0x0A, 0x00, // CRLF
        ];
        let index: Vec<u64> = vec![2, 10];
        let line = raw_line_from_bytes(data, &index, 0, Encoding::Utf16Le).unwrap();
        assert_eq!(line.as_ref(), "Hi");
    }

    // ── detect_crlf with encoding tests ─────────────────────────────────

    #[test]
    fn detect_crlf_utf8() {
        assert!(detect_crlf(b"hello\r\nworld\r\n", Encoding::Utf8));
        assert!(!detect_crlf(b"hello\nworld\n", Encoding::Utf8));
    }

    #[test]
    fn detect_crlf_utf16le() {
        // BOM + "hi\r\n" in UTF-16LE
        let data: &[u8] = &[0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00, 0x0D, 0x00, 0x0A, 0x00];
        assert!(detect_crlf(data, Encoding::Utf16Le));

        // BOM + "hi\n" in UTF-16LE (no CR)
        let data_lf: &[u8] = &[0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00, 0x0A, 0x00];
        assert!(!detect_crlf(data_lf, Encoding::Utf16Le));
    }
}

// ---------------------------------------------------------------------------
// SpillFile — temp file for evicted stream lines
// ---------------------------------------------------------------------------

/// Filename prefix for per-session spill files (in the app-data / temp dir).
pub(crate) const SPILL_FILE_PREFIX: &str = "logtapper-spill-";
/// Filename suffix for spill files.
pub(crate) const SPILL_FILE_SUFFIX: &str = ".tmp";

/// Build the spill file name for a given session id.
fn spill_file_name(session_id: &str) -> String {
    format!("{SPILL_FILE_PREFIX}{session_id}{SPILL_FILE_SUFFIX}")
}

/// Delete orphaned spill files left in `dir` by a previous run.
///
/// ADB stream sessions are purely in-memory: their `LogSource` lives only in
/// `AppState::sessions` and they are never persisted to `.ltw` (see
/// `collect_session_data`, which skips sessions without a `file_path`). So no
/// session — and no `SpillFile`, whose `Drop` deletes the temp file — ever
/// survives a process restart. Any `logtapper-spill-*.tmp` present at startup
/// is therefore an orphan from a crashed or force-killed run and is safe to
/// remove. Returns the number of files deleted. Non-fatal: individual delete
/// failures are logged and skipped.
pub fn sweep_orphaned_spill_files(dir: &std::path::Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0; // dir missing or unreadable — nothing to sweep
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(SPILL_FILE_PREFIX) && name.ends_with(SPILL_FILE_SUFFIX) {
            let path = entry.path();
            if !path.is_file() {
                continue; // never touch directories that happen to match
            }
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(e) => eprintln!(
                    "Warning: failed to remove orphaned spill file {}: {e}",
                    path.display()
                ),
            }
        }
    }
    removed
}

/// Maximum total bytes a single ADB stream's spill file may grow to before
/// the backend stops spilling evicted lines to disk.
///
/// Without a cap, an overnight (or otherwise unattended) capture spills every
/// line evicted past the in-memory retention window (default 500k lines) to
/// disk, unbounded. 2 GiB is generous enough to cover essentially any normal
/// capture session while still guaranteeing a runaway stream cannot fill the
/// disk. Once reached, further evictions stop writing to the spill file and
/// instead count toward `StreamLogSource::lost_line_count` (already surfaced
/// to the UI via `AdbBatch` / the FileInfoPanel warning banner) — the same
/// mechanism used when the spill file fails to create at all.
///
/// This is a constant rather than a user setting: threading a `spillMaxBytes`
/// value from `AppSettings` down to here would require adding a new
/// parameter through `start_adb_stream` (already an 8-parameter Tauri
/// command) → `run_streaming_task` (already `#[allow(clippy::too_many_arguments)]`)
/// → `flush_batch` → `evict()`, plus new frontend plumbing (settings field,
/// `GeneralTab` control, bridge command param). That is substantially more
/// invasive than the cap logic itself for a rarely-hit safety backstop.
/// Centralizing the value here keeps it trivial to promote to a setting later
/// if a real need arises.
pub(crate) const SPILL_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB

/// Holds the spill file handle, byte offsets for each spilled line, and the
/// file path (for cleanup and capture finalization).
pub(crate) struct SpillFile {
    /// Read+write handle.  Protected by Mutex because `raw_line(&self)` needs
    /// to seek+read while the trait method takes `&self`.
    file: Mutex<std::fs::File>,
    /// Byte offset of each spilled line within the file.
    line_offsets: Vec<u64>,
    /// Total bytes written (== offset of next write). Updated from the byte
    /// lengths already in hand at write time — no `fs::metadata`/stat calls.
    total_bytes: u64,
    /// Set once `total_bytes` reaches `cap`. Checked by callers before
    /// attempting a write so a capped stream never repeats failed write
    /// attempts — just a bool read.
    cap_reached: bool,
    /// Byte cap for this spill file. Always `SPILL_MAX_BYTES` in production;
    /// tests use `create_with_cap` to exercise cap behavior without writing
    /// gigabytes of data.
    cap: u64,
    /// Path on disk (for cleanup / finalization).
    pub(crate) path: PathBuf,
}

impl SpillFile {
    /// Create a new spill file. `cap` is `SPILL_MAX_BYTES` in production;
    /// tests pass a tiny cap (see `StreamLogSource::evict_with_cap_for_test`)
    /// to exercise cap behavior without writing gigabytes of data.
    fn create_with_cap(path: PathBuf, cap: u64) -> Result<Self, String> {
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
            cap_reached: false,
            cap,
            path,
        })
    }

    /// Append a line to the spill file.  Records byte offset and updates the
    /// running byte total; flips `cap_reached` once `cap` is hit. Callers are
    /// expected to check `is_cap_reached()` before calling this — it does not
    /// refuse the write itself, so the cap is enforced by the caller skipping
    /// the call entirely once reached.
    fn write_line(&mut self, line: &str) -> Result<(), String> {
        let mut f = self.file.lock().map_err(|_| "spill file lock poisoned")?;
        self.line_offsets.push(self.total_bytes);
        let bytes = line.as_bytes();
        f.write_all(bytes).map_err(|e| format!("spill write: {e}"))?;
        f.write_all(b"\n").map_err(|e| format!("spill write: {e}"))?;
        self.total_bytes += bytes.len() as u64 + 1;
        if self.total_bytes >= self.cap {
            self.cap_reached = true;
        }
        Ok(())
    }

    /// Whether the spill file has reached `SPILL_MAX_BYTES`. A plain bool
    /// read — no stat call — so callers can check it per-line cheaply.
    pub(crate) fn is_cap_reached(&self) -> bool {
        self.cap_reached
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
    /// Count of evicted lines that could NOT be written to the spill file
    /// (spill creation failed, or an individual write errored). These lines are
    /// permanently lost — they leave the in-memory buffer but never reach disk.
    /// Surfaced to the UI so silent, invisible data loss becomes observable.
    pub(crate) lost_line_count: usize,
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
            lost_line_count: 0,
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
        self.evict_inner(count, SPILL_MAX_BYTES);
    }

    /// Test-only entry point identical to `evict()` but with an overridable
    /// spill byte cap, so cap-enforcement behavior can be exercised without
    /// writing gigabytes of data. Only takes effect on the eviction that
    /// creates the spill file (the cap is fixed for the file's lifetime).
    #[cfg(test)]
    pub(crate) fn evict_with_cap_for_test(&mut self, count: usize, cap: u64) {
        self.evict_inner(count, cap);
    }

    fn evict_inner(&mut self, count: usize, spill_cap: u64) {
        if count == 0 {
            return;
        }
        // Create spill file on first eviction.
        if self.spill.is_none() {
            let spill_path = self.temp_dir.join(spill_file_name(&self.session_id));
            match SpillFile::create_with_cap(spill_path, spill_cap) {
                Ok(sf) => self.spill = Some(sf),
                Err(e) => {
                    eprintln!("Warning: failed to create spill file, evicted lines will be lost: {e}");
                    // Fall through — evict without spilling (retention cap must
                    // hold), but the loss is now counted (see below).
                }
            }
        }
        // Write evicted lines to the spill file, counting any that are lost.
        // The retention cap must be enforced regardless (lines still drain), so
        // an unspillable line is dropped — but recorded in `lost_line_count`
        // instead of vanishing behind only an eprintln.
        let mut lost = 0usize;
        match self.spill {
            Some(ref mut spill) => {
                for (i, line) in self.raw_lines.iter().take(count).enumerate() {
                    // Once SPILL_MAX_BYTES is reached (in this call or a prior
                    // one), stop attempting writes: a cheap flag check, no
                    // further disk I/O. The rest of this batch is lost.
                    if spill.is_cap_reached() {
                        lost += count - i;
                        break;
                    }
                    if let Err(e) = spill.write_line(line) {
                        eprintln!("Warning: spill write failed, evicted line lost: {e}");
                        lost += 1;
                    }
                }
            }
            None => {
                // Spill file could not be created — every line evicted in this
                // call is permanently lost.
                lost = count;
            }
        }
        self.raw_lines.drain(0..count);
        // NOTE: line_meta is NOT drained — metadata stays for all lines, so
        // absolute line numbering (via `evicted_count`) is unaffected by loss.
        self.lost_line_count += lost;
        self.evicted_count += count;
    }

    /// Write all lines (spill first, then retained) to `writer`, each followed
    /// by a newline.  Returns the number of lines written.
    ///
    /// When lines were permanently lost (`lost_line_count > 0` — spill cap
    /// reached, or spill creation failed), a single marker line is written at
    /// the boundary between the spilled content and the retained lines, i.e.
    /// exactly where the lost lines would otherwise silently be missing from
    /// the output. The marker is output-only: it is generated fresh on every
    /// save and never touches `line_meta`, line numbering, or any other
    /// stored state. When `lost_line_count == 0`, output is byte-identical to
    /// before this marker existed.
    pub fn write_stream_lines(&self, writer: &mut impl std::io::Write) -> Result<u32, String> {
        let mut count = 0u32;
        if let Some(ref spill) = self.spill {
            for i in 0..spill.total_spilled() {
                if let Some(line) = spill.read_line(i) {
                    writer.write_all(line.as_bytes()).map_err(|e| format!("Write error: {e}"))?;
                    writer.write_all(b"\n").map_err(|e| format!("Write error: {e}"))?;
                    count += 1;
                }
            }
        }
        if self.lost_line_count > 0 {
            let marker = format!(
                "---- [LogTapper] {} lines not captured (spill unavailable) ----",
                self.lost_line_count
            );
            writer.write_all(marker.as_bytes()).map_err(|e| format!("Write error: {e}"))?;
            writer.write_all(b"\n").map_err(|e| format!("Write error: {e}"))?;
            count += 1;
        }
        for raw in &self.raw_lines {
            writer.write_all(raw.as_bytes()).map_err(|e| format!("Write error: {e}"))?;
            writer.write_all(b"\n").map_err(|e| format!("Write error: {e}"))?;
            count += 1;
        }
        Ok(count)
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

    /// Number of evicted lines permanently lost because spilling failed
    /// (spill-file creation failed, or an individual write errored).
    pub fn lost_line_count(&self) -> usize {
        self.lost_line_count
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

// ---------------------------------------------------------------------------
// Tests for spill-file sweep + eviction loss accounting
// ---------------------------------------------------------------------------

#[cfg(test)]
mod spill_tests {
    use super::*;
    use crate::core::line::{LineMeta, LogLevel};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Create a fresh, uniquely-named temp directory for a test.
    fn unique_temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "logtapper-spilltest-{tag}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn dummy_meta() -> LineMeta {
        LineMeta {
            level: LogLevel::Info,
            tag_id: 0,
            timestamp: 0,
            byte_offset: 0,
            byte_len: 0,
            is_section_boundary: false,
        }
    }

    /// The startup sweep deletes `logtapper-spill-*.tmp` orphans and leaves
    /// every non-matching file untouched.
    #[test]
    fn sweep_deletes_orphans_and_spares_others() {
        let dir = unique_temp_dir("sweep");

        // Orphan spill files (must be deleted).
        let orphan1 = dir.join(spill_file_name("sess-A"));
        let orphan2 = dir.join(spill_file_name("adb-192-168-0-2_9c3f"));
        std::fs::write(&orphan1, b"x").unwrap();
        std::fs::write(&orphan2, b"y").unwrap();

        // Non-matching files (must be spared).
        let keep_suffix = dir.join("logtapper-spill-foo.txt"); // wrong suffix
        let keep_prefix = dir.join("something-else.tmp"); // wrong prefix
        let keep_other = dir.join("sources.json"); // unrelated
        std::fs::write(&keep_suffix, b"a").unwrap();
        std::fs::write(&keep_prefix, b"b").unwrap();
        std::fs::write(&keep_other, b"c").unwrap();

        let removed = sweep_orphaned_spill_files(&dir);
        assert_eq!(removed, 2, "both orphan spill files must be removed");
        assert!(!orphan1.exists(), "orphan 1 deleted");
        assert!(!orphan2.exists(), "orphan 2 deleted");
        assert!(keep_suffix.exists(), "wrong-suffix file spared");
        assert!(keep_prefix.exists(), "wrong-prefix file spared");
        assert!(keep_other.exists(), "unrelated file spared");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A directory whose name coincidentally matches the spill pattern is never
    /// removed (only regular files are swept).
    #[test]
    fn sweep_ignores_matching_directories() {
        let dir = unique_temp_dir("sweepdir");
        let matching_subdir = dir.join(spill_file_name("looks-like-a-spill"));
        std::fs::create_dir_all(&matching_subdir).unwrap();

        let removed = sweep_orphaned_spill_files(&dir);
        assert_eq!(removed, 0, "directories matching the pattern must be ignored");
        assert!(matching_subdir.exists(), "matching directory must survive");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Sweeping a missing/unreadable directory is a no-op that returns 0.
    #[test]
    fn sweep_missing_dir_returns_zero() {
        let dir = std::env::temp_dir()
            .join(format!("logtapper-spilltest-absent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(sweep_orphaned_spill_files(&dir), 0);
    }

    /// When the spill file cannot be created, evicted lines are counted as lost
    /// and absolute line numbering stays consistent (meta is never drained, and
    /// `evicted_count` still advances so retained lines read at the right index).
    #[test]
    fn evict_records_loss_when_spill_unavailable() {
        // Force SpillFile::create_with_cap to fail: point temp_dir at a *file*
        // so that joining a filename onto it cannot be opened. Reliable on all OSes.
        let base = unique_temp_dir("evictfail");
        let file_as_dir = base.join("blocker");
        std::fs::write(&file_as_dir, b"x").unwrap();

        let mut src = StreamLogSource::new(
            "src".to_string(),
            "name".to_string(),
            "sess-fail".to_string(),
            file_as_dir,
        );
        for i in 0..5 {
            src.push_raw_line(format!("line {i}"));
            src.push_meta(dummy_meta());
        }
        assert_eq!(src.total_lines(), 5);

        // Evict the first 2 — spill creation fails, so both are lost.
        src.evict(2);

        assert!(!src.has_spill(), "spill file must not have been created");
        assert_eq!(src.lost_line_count(), 2, "both unspillable lines are counted as lost");
        assert_eq!(src.evicted_count(), 2, "evicted_count still advances");
        // Metadata is never drained, so absolute line count is unchanged.
        assert_eq!(src.total_lines(), 5);
        // Evicted lines are unrecoverable (no spill) → None, not a panic or shift.
        assert!(src.raw_line(0).is_none(), "lost line 0 returns None");
        assert!(src.raw_line(1).is_none(), "lost line 1 returns None");
        // Retained lines still read at their ABSOLUTE index (numbering intact).
        assert_eq!(src.raw_line(2).as_deref(), Some("line 2"));
        assert_eq!(src.raw_line(4).as_deref(), Some("line 4"));
        // meta_at works for every absolute line number.
        assert!(src.meta_at(0).is_some());
        assert!(src.meta_at(4).is_some());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The normal path: spilling succeeds, nothing is lost, evicted lines are
    /// recoverable, and line numbering is preserved.
    #[test]
    fn evict_no_loss_and_recovers_lines_when_spill_ok() {
        let dir = unique_temp_dir("evictok");
        let mut src = StreamLogSource::new(
            "src".to_string(),
            "name".to_string(),
            "sess-ok".to_string(),
            dir.clone(),
        );
        for i in 0..5 {
            src.push_raw_line(format!("line {i}"));
            src.push_meta(dummy_meta());
        }

        src.evict(2);

        assert!(src.has_spill(), "spill file created on first eviction");
        assert_eq!(src.lost_line_count(), 0, "no loss when spilling works");
        assert_eq!(src.evicted_count(), 2);
        assert_eq!(src.total_lines(), 5);
        // Evicted lines recoverable from the spill file at absolute index.
        assert_eq!(src.raw_line(0).as_deref(), Some("line 0"));
        assert_eq!(src.raw_line(1).as_deref(), Some("line 1"));
        // Retained lines still read at absolute index.
        assert_eq!(src.raw_line(2).as_deref(), Some("line 2"));
        assert_eq!(src.raw_line(4).as_deref(), Some("line 4"));

        // Drop removes the temp spill file.
        drop(src);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Spill byte-cap tests ────────────────────────────────────────────

    /// Once the (test-tiny) spill byte cap is reached, spilling stops: only
    /// the lines that fit under the cap are written to disk, the rest of the
    /// same eviction call are counted as lost, retained lines are unaffected,
    /// and absolute line numbering (evicted_count / meta_at / total_lines)
    /// stays consistent — mirroring the "spill unavailable" test above but
    /// for the byte-cap path instead of a creation failure.
    #[test]
    fn evict_cap_stops_spilling_mid_batch_and_counts_loss() {
        let dir = unique_temp_dir("evictcap");
        let mut src = StreamLogSource::new(
            "src".to_string(),
            "name".to_string(),
            "sess-cap".to_string(),
            dir.clone(),
        );
        // 15 lines: "line 0".."line 14". Each write is content + '\n':
        // "line 0".."line 9" = 7 bytes each, "line 10".."line 14" = 8 bytes each.
        for i in 0..15 {
            src.push_raw_line(format!("line {i}"));
            src.push_meta(dummy_meta());
        }

        // cap=20 bytes: "line 0" (7) -> 7, "line 1" (7) -> 14, "line 2" (7) -> 21
        // >= 20, so exactly 3 lines get spilled before the cap trips.
        src.evict_with_cap_for_test(10, 20);

        assert!(src.has_spill(), "spill file is still created under the cap");
        assert_eq!(src.evicted_count(), 10, "retention cap (line count) unaffected by the byte cap");
        assert_eq!(src.total_lines(), 15, "line_meta is never drained, numbering stable");
        assert_eq!(src.lost_line_count(), 7, "lines 3..9 (7 of the 10 evicted) are lost once the byte cap trips");

        // Spilled (recoverable) lines: absolute indices 0, 1, 2.
        assert_eq!(src.raw_line(0).as_deref(), Some("line 0"));
        assert_eq!(src.raw_line(1).as_deref(), Some("line 1"));
        assert_eq!(src.raw_line(2).as_deref(), Some("line 2"));
        // Lost lines: absolute indices 3..9 — evicted but never spilled, so
        // unrecoverable (None, not a panic or a shifted read).
        for i in 3..10 {
            assert!(src.raw_line(i).is_none(), "line {i} was lost to the byte cap, must read as None");
        }
        // Retained (in-memory) lines: absolute indices 10..14, unaffected by
        // the cap, still read at their absolute index.
        for i in 10..15 {
            let expected = format!("line {i}");
            assert_eq!(src.raw_line(i).as_deref(), Some(expected.as_str()));
        }
        // meta_at covers every absolute line number regardless of loss.
        for i in 0..15 {
            assert!(src.meta_at(i).is_some(), "meta_at({i}) must stay populated");
        }

        drop(src);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Once the cap is reached, further evictions — even in separate calls —
    /// must not attempt any more spill writes: `total_spilled()` stops
    /// growing and `lost_line_count` accounts for every subsequent evicted
    /// line via a cheap flag check, not repeated failed I/O.
    #[test]
    fn evict_cap_reached_short_circuits_across_calls() {
        let dir = unique_temp_dir("evictcapmulti");
        let mut src = StreamLogSource::new(
            "src".to_string(),
            "name".to_string(),
            "sess-capmulti".to_string(),
            dir.clone(),
        );
        for i in 0..6 {
            src.push_raw_line(format!("line {i}"));
            src.push_meta(dummy_meta());
        }

        // cap=15: "line 0" (7) -> 7, "line 1" (7) -> 14 (< 15, not yet tripped).
        src.evict_with_cap_for_test(2, 15);
        assert_eq!(src.lost_line_count(), 0, "cap not yet reached after 2 lines (14 < 15)");
        assert_eq!(src.evicted_count(), 2);

        // "line 2" (7) -> 21 >= 15: trips the cap on this write; "line 3" is
        // then lost via the cheap flag check within the same call.
        src.evict_with_cap_for_test(2, 15);
        assert_eq!(src.lost_line_count(), 1, "line 3 lost once the cap trips mid-call");
        assert_eq!(src.evicted_count(), 4);
        let spilled_after_trip = src.spill.as_ref().unwrap().total_spilled();
        assert_eq!(spilled_after_trip, 3, "lines 0,1,2 spilled before the cap tripped");

        // A subsequent call evicts 2 more lines; the cap is already reached,
        // so both are lost with no further spill I/O — total_spilled() is
        // unchanged, demonstrating growth has stopped.
        src.evict_with_cap_for_test(2, 15);
        assert_eq!(src.lost_line_count(), 3, "both lines in the third call are lost too");
        assert_eq!(src.evicted_count(), 6);
        assert_eq!(
            src.spill.as_ref().unwrap().total_spilled(),
            spilled_after_trip,
            "spill file growth has stopped — no further lines were written"
        );

        drop(src);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `write_stream_lines` writes exactly one output-only marker line at the
    /// boundary between spilled content and retained lines when lines were
    /// lost, and omits it entirely (byte-identical output) when nothing was
    /// lost. The marker must never affect `total_lines()` / `meta_at()`.
    #[test]
    fn write_stream_lines_marker_present_only_when_lines_lost() {
        let dir = unique_temp_dir("marker");

        // ── lost_line_count > 0: marker appears between spill and retained ──
        let mut lossy = StreamLogSource::new(
            "src".to_string(),
            "name".to_string(),
            "sess-marker-lossy".to_string(),
            dir.clone(),
        );
        for i in 0..15 {
            lossy.push_raw_line(format!("line {i}"));
            lossy.push_meta(dummy_meta());
        }
        lossy.evict_with_cap_for_test(10, 20); // same shape as the cap test above
        assert_eq!(lossy.lost_line_count(), 7);

        let mut buf = Vec::new();
        let written = lossy.write_stream_lines(&mut buf).unwrap();
        let text = String::from_utf8(buf).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines,
            vec![
                "line 0",
                "line 1",
                "line 2",
                "---- [LogTapper] 7 lines not captured (spill unavailable) ----",
                "line 10",
                "line 11",
                "line 12",
                "line 13",
                "line 14",
            ],
            "marker must sit exactly between spilled content and retained lines"
        );
        assert_eq!(written, 9, "3 spilled + 1 marker + 5 retained");
        // Marker is output-only: it never touched stored state.
        assert_eq!(lossy.total_lines(), 15, "line_meta/total_lines unaffected by the marker");

        // ── lost_line_count == 0: output must be identical to before the
        // marker existed — no marker line anywhere. ──
        let mut clean = StreamLogSource::new(
            "src".to_string(),
            "name".to_string(),
            "sess-marker-clean".to_string(),
            dir.clone(),
        );
        for i in 0..5 {
            clean.push_raw_line(format!("line {i}"));
            clean.push_meta(dummy_meta());
        }
        clean.evict(2); // plenty of headroom under the real 2 GiB cap — no loss
        assert_eq!(clean.lost_line_count(), 0);

        let mut buf2 = Vec::new();
        let written2 = clean.write_stream_lines(&mut buf2).unwrap();
        let text2 = String::from_utf8(buf2).unwrap();
        assert!(!text2.contains("LogTapper"), "no marker line when nothing was lost");
        assert_eq!(
            text2.lines().collect::<Vec<_>>(),
            vec!["line 0", "line 1", "line 2", "line 3", "line 4"]
        );
        assert_eq!(written2, 5);

        drop(lossy);
        drop(clean);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
