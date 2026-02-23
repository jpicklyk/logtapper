# core/ — Parsers, Session, Line Types, LogSource

## Two line representations

| Type | Where used | What it contains |
|---|---|---|
| `LineMeta` | Stored permanently in `LogSource.line_meta` | level, tag, timestamp, byte_offset, byte_len. Lightweight — one per indexed line. |
| `LineContext` | Created on-demand during pipeline runs and `get_lines` | Full parsed content: raw (`Arc<str>`), level, tag (`Arc<str>`), pid, tid, message (`Arc<str>`), source_id (`Arc<str>`), source_line_num, fields. String fields use `Arc<str>` for cheap cloning across processors. |

`parse_meta()` is called once during file load (indexing). `parse_line()` is called at read time (pipeline, viewer). Both methods on `LogParser` must stay consistent — they parse the same bytes, just at different times.

## LogParser trait (`parser.rs`)

```rust
pub trait LogParser: Send + Sync {
    fn parse_line(&self, raw: &str, source_id: &str, line_num: usize) -> Option<LineContext>;
    fn parse_meta(&self, raw: &str, byte_offset: usize) -> Option<LineMeta>;
}
```

Returning `None` from `parse_meta()` **silently drops the line from the index**. The line will never appear in any viewer or search result. Only `LogcatParser` has a fallback that returns `Some` for unrecognized lines; `KernelParser` does not (known bug).

| Parser | Used for | `parse_meta` fallback |
|---|---|---|
| `LogcatParser` | Logcat, Radio, Events, default | Yes — all non-separator lines are indexed |
| `KernelParser` | Kernel (dmesg) | **No** — non-matching lines are dropped |
| `BugreportParser` | Bugreport | Yes — delegates to `LogcatParser`, skips `------` dividers |

`parser_for(&source_type)` in `session.rs` selects the correct parser based on detected source type. Used by `pipeline.rs`, `files.rs`, and `filter.rs`.

## Timestamp convention

All timestamps are **nanoseconds since 2000-01-01 00:00:00 UTC** (not Unix epoch). Year 2000 was chosen because logcat strips the year — using 2000 as base keeps relative ordering correct within a session. Lines without a parseable timestamp get `timestamp: 0` (sorted to the front).

## LogSource trait (`log_source.rs`)

`LogSource` is a trait providing polymorphic access to log data. Two implementations:

- **FileLogSource** — memory-mapped file (`Arc<Mmap>`) + byte-offset line index (`Vec<u64>`). Immutable after construction. Supports progressive indexing via `extend_index()`.
- **StreamLogSource** — append-only `Vec<String>` for ADB logcat. Evicts old lines to a `SpillFile` (temp disk file with byte-offset indexing). `evicted_count` tracks offset so line numbers remain stable. `raw_line()` transparently reads from spill file or memory.

Both implement `raw_line(n)`, `meta_at(n)`, `total_lines()`, `is_live()`, and downcast support via `as_any()`.

## AnalysisSession (`session.rs`)

```rust
pub struct AnalysisSession {
    pub id: String,
    pub source: Option<Box<dyn LogSource>>,  // trait object — FileLogSource or StreamLogSource
    pub timeline: Timeline,
    pub index: CrossSourceIndex,
    pub tag_interner: TagInterner,
}
```

Accessor helpers: `primary_source()`, `file_source()` / `stream_source()` (downcast to concrete types), and mutable variants.

## `detect_source_type()` — known issue

The heuristic `text.starts_with('[')` is too broad: any file whose first 4KB starts with `[` is classified as `Kernel`. The correct fix is to check for the kernel timestamp pattern `^\[\s*\d+\.\d+\]` in the first few non-empty lines.
