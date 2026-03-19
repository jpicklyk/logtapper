# commands/ — Tauri IPC Surface

Every public function in this directory is a `#[tauri::command]` registered in `src-tauri/src/lib.rs`. The frontend calls these via `invoke()` in `src-next/bridge/commands.ts`. **Adding a command here without registering it in `lib.rs` silently fails at runtime.** See `lib.rs` for the full registration list.

## AppState locking rules

`AppState` uses `std::sync::Mutex` (not async). Rules:

1. **Never hold a lock across an `.await` point.** Acquire, use, drop before any async call.
2. **Never hold `sessions` while trying to acquire `pipeline_results`** (or vice versa) — that lock ordering is undefined and could deadlock.
3. Lock with `lock_or_err(&state.foo, "foo")?` (defined in `mod.rs`) — propagate poison as a consistent `"foo lock poisoned"` error. Never use raw `.lock().map_err(|_| "...")` inline.

### Source snapshot pattern in `pipeline.rs`

`run_pipeline` snapshots the session source data (mmap + line index via `SourceSnapshot`) once before the processing loop. No locks are held during pipeline execution. Processing happens in 50,000-line chunks with a three-level pre-filter (tag union, Aho-Corasick, RegexSet) to skip irrelevant lines before parsing. Layer 2 processors run in parallel via `rayon::scope` (one task per processor). Pipeline cancellation is supported via `Arc<AtomicBool>` checked between chunks.

## Filter commands — source type universality

`create_filter`, `get_filtered_lines`, `cancel_filter`, and `close_filter` (in `filter.rs`) work for **all source types** — both `FileLogSource` and `StreamLogSource`. They dispatch through the `LogSource` trait; no source-type guards exist in `filter.rs`.

Key points:

- **`raw_line(n)` and `meta_at(n)` are transparent to eviction.** `StreamLogSource` automatically reads from `SpillFile` for evicted lines and from the in-memory vec for retained lines. `total_lines()` includes evicted lines in the count.
- **Never reimplement filter logic in the frontend.** Always call `create_filter` for the initial historical scan regardless of source type. Any frontend JS scan that iterates `CacheManager` or `getLines` directly will silently miss evicted lines in a long-running stream.
- **Snapshot model:** `total_lines` is captured at `create_filter` call time. Lines arriving after that snapshot (new ADB batches) are **not** covered by the filter scan. The frontend must handle them incrementally — see `appendMatches` in `useFilterScan`.
- **Universal vs source-specific commands:**
  - Universal (file + streaming): `get_lines`, `create_filter` / `get_filtered_lines` / `cancel_filter` / `close_filter`, all pipeline commands (`run_pipeline`, `get_pipeline_results`, etc.)
  - Streaming only: `save_live_capture`, `start_adb_stream`, `stop_adb_stream`, `flush_batch`

