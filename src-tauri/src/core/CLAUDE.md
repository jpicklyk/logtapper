# core/ — Parsers, Session, Line Types

## Two line representations

| Type | Where used | What it contains |
|---|---|---|
| `LineMeta` | Stored permanently in `LogSource.line_meta` | level, tag, timestamp, byte_offset, byte_len. Lightweight — one per indexed line. |
| `LineContext` | Created on-demand during pipeline runs and `get_lines` | Full parsed content: raw, level, tag, pid, tid, message, source_id, source_line_num, fields. |

`parse_meta()` is called once during file load (indexing). `parse_line()` is called at read time (pipeline, viewer). Both methods on `LogParser` must stay consistent — they parse the same bytes, just at different times.

## LogParser trait (`parser.rs`)

```rust
pub trait LogParser: Send + Sync {
    fn parse_line(&self, raw: &str, source_id: &str, line_num: usize) -> Option<LineContext>;
    fn parse_meta(&self, raw: &str, byte_offset: usize) -> Option<LineMeta>;
}
```

Returning `None` from `parse_meta()` **silently drops the line from the index**. The line will never appear in any viewer or search result. Only `LogcatParser` has a fallback that returns `Some` for unrecognized lines; `KernelParser` does not (known bug).

## Timestamp convention

All timestamps are **nanoseconds since 2000-01-01 00:00:00 UTC** (not Unix epoch). The constant `BASE_NS = 946_684_800_000_000_000` appears in `logcat_parser.rs` and `kernel_parser.rs`. Year 2000 was chosen because logcat strips the year — using 2000 as base keeps relative ordering correct within a session.

Lines without a parseable timestamp get `timestamp: 0`. Timeline queries treat 0 as "unknown" and sort to the front.

## `build_line_index()` (`session.rs`)

Scans the mmap byte-by-byte looking for `\n`. For each line:
1. Skips empty lines (after `trim()`).
2. Calls `parser.parse_meta()`. If `None` → line is excluded from index.
3. If `Some(meta)` → pushes `(byte_offset, byte_len)` to `line_index` and `meta` to `line_meta`.

`LogSource.total_lines()` returns `line_index.len()` — the **indexed** count, which may be smaller than the physical line count if lines were dropped.

## `detect_source_type()` (`session.rs`) — known issue

The heuristic `text.starts_with('[')` is too broad: any file whose first 4KB starts with `[` is classified as `Kernel`. A logcat file with bracketed metadata in a preamble would be misdetected. The correct fix is to check for the kernel timestamp pattern `^\[\s*\d+\.\d+\]` in the first few non-empty lines.

## Parsers summary

| Parser | Used for | `parse_meta` fallback |
|---|---|---|
| `LogcatParser` | Logcat, Radio, Events, default | Yes — all non-separator lines are indexed |
| `KernelParser` | Kernel (dmesg) | **No** — non-matching lines are dropped |
| `BugreportParser` | Bugreport | Yes — delegates to `LogcatParser`, skips `------` dividers |

## Session / Source structure

```
AnalysisSession
  id: String
  sources: Vec<LogSource>   ← typically 1; multi-source is Phase 3+
  timeline: Timeline         ← chronological index across all sources
  index: CrossSourceIndex    ← lookup by tag/level/timestamp

LogSource
  id, name, source_type
  mmap: Mmap                 ← memory-mapped file; stays valid for session lifetime
  line_index: Vec<(usize, usize)>   ← (byte_offset, byte_len) per indexed line
  line_meta: Vec<LineMeta>          ← parallel to line_index
```

`primary_source()` returns `sources.first()` — convenience for the common single-file case used throughout Phase 1/2 commands.

## `pipeline.rs` parser coupling

`commands/pipeline.rs` hardcodes `LogcatParser` regardless of the session's detected source type. Lines that don't match the logcat format (including kernel lines) will return `None` from `parse_line()` and be silently skipped by the pipeline. This is a known limitation.
