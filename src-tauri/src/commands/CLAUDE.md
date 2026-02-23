# commands/ — Tauri IPC Surface

Every public function in this directory is a `#[tauri::command]` registered in `src-tauri/src/lib.rs`. The frontend calls these via `invoke()` in `src/bridge/commands.ts`. **Adding a command here without registering it in `lib.rs` silently fails at runtime.**

## AppState locking rules

`AppState` uses `std::sync::Mutex` (not async). Rules:

1. **Never hold a lock across an `.await` point.** Acquire, use, drop before any async call.
2. **Never hold `sessions` while trying to acquire `pipeline_results`** (or vice versa) — that lock ordering is undefined and could deadlock.
3. Lock with `state.foo.lock().map_err(|_| "lock poisoned")?` — propagate poison as a command error.

### Source snapshot pattern in `pipeline.rs`

`run_pipeline` snapshots the session source data (mmap + line index via `SourceSnapshot`) once before the processing loop. No locks are held during pipeline execution. Processing happens in 50,000-line chunks with a three-level pre-filter (tag union, Aho-Corasick, RegexSet) to skip irrelevant lines before parsing. Layer 2 processors run in parallel via `rayon::scope` (one task per processor).

## Command inventory

| Command | File | Notes |
|---|---|---|
| `load_log_file` | `files.rs` | Creates `AnalysisSession`, mmaps file, builds line index |
| `get_lines` | `files.rs` | Paginated view; 3 modes: Full, Processor, Focus |
| `search_logs` | `files.rs` | Full-text / regex search; returns `match_line_nums` |
| `run_pipeline` | `pipeline.rs` | Runs processors, emits `pipeline-progress` events |
| `stop_pipeline` | `pipeline.rs` | No-op placeholder (real cancellation not yet implemented) |
| `list_processors` | `processors.rs` | Lists installed processors from `AppState::processors` |
| `load_processor_yaml` | `processors.rs` | Parses YAML, validates Rhai scripts, installs to `AppState::processors` |
| `uninstall_processor` | `processors.rs` | Removes from `AppState::processors` |
| `get_processor_vars` | `processors.rs` | Returns `AppState::pipeline_results[session][processor].vars` |
| `fetch_registry` | `processors.rs` | HTTP GET registry JSON from GitHub |
| `install_from_registry` | `processors.rs` | Download + SHA-256 verify + install processor from registry |
| `get_chart_data` | `charts.rs` | Builds chart series from stored `RunResult.emissions` |
| `set_claude_api_key` | `claude.rs` | Stores key in `AppState::api_key` |
| `claude_analyze` | `claude.rs` | Streams analysis via `claude-stream` events |
| `claude_generate_processor` | `claude.rs` | Generates + validates YAML, returns raw string |

## Events emitted by commands

- `pipeline-progress` — emitted by `pipeline.rs` once per 50,000-line chunk.  
  Payload: `{ processorId, linesProcessed, totalLines, percent }` (camelCase).
- `claude-stream` — emitted by `claude/client.rs` for each SSE token.  
  Payload: `{ kind: "text"|"done"|"error", text?, error? }`.

## `files.rs` ViewMode coupling

`get_lines` in Processor mode fetches matched line numbers from `AppState::pipeline_results`, then adds context lines and paginates. The returned `ViewLine.lineNum` is the **actual file line number**, not a sequential index. This mismatches the frontend virtualizer's sequential index — a known bug. See root CLAUDE.md.
