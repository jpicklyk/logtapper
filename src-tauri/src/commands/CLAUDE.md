# commands/ — Tauri IPC Surface

Every public function in this directory is a `#[tauri::command]` registered in `src-tauri/src/lib.rs`. The frontend calls these via `invoke()` in `src/bridge/commands.ts`. **Adding a command here without registering it in `lib.rs` silently fails at runtime.**

Commands are organized by file: `files.rs`, `pipeline.rs`, `processors.rs`, `charts.rs`, `claude.rs`, `anonymizer.rs`, `adb.rs`, `state_tracker.rs`, `correlator.rs`, `filter.rs`, `bookmark.rs`, `analysis.rs`, `watch.rs`, `session.rs`. See `lib.rs` for the full registration list.

## AppState locking rules

`AppState` uses `std::sync::Mutex` (not async). Rules:

1. **Never hold a lock across an `.await` point.** Acquire, use, drop before any async call.
2. **Never hold `sessions` while trying to acquire `pipeline_results`** (or vice versa) — that lock ordering is undefined and could deadlock.
3. Lock with `state.foo.lock().map_err(|_| "lock poisoned")?` — propagate poison as a command error.

### Source snapshot pattern in `pipeline.rs`

`run_pipeline` snapshots the session source data (mmap + line index via `SourceSnapshot`) once before the processing loop. No locks are held during pipeline execution. Processing happens in 50,000-line chunks with a three-level pre-filter (tag union, Aho-Corasick, RegexSet) to skip irrelevant lines before parsing. Layer 2 processors run in parallel via `rayon::scope` (one task per processor). Pipeline cancellation is supported via `Arc<AtomicBool>` checked between chunks.

## `files.rs` ViewMode coupling

`get_lines` in Processor mode fetches matched line numbers from `AppState::pipeline_results`, then adds context lines and paginates. The returned `ViewLine.lineNum` is the **actual file line number**, not a sequential index. This mismatches the frontend virtualizer's sequential index — a known bug. See root CLAUDE.md.
