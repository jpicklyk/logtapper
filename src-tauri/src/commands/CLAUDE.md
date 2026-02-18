# commands/ — Tauri IPC Surface

Every public function in this directory is a `#[tauri::command]` registered in `src-tauri/src/lib.rs`. The frontend calls these via `invoke()` in `src/bridge/commands.ts`. **Adding a command here without registering it in `lib.rs` silently fails at runtime.**

## AppState locking rules

`AppState` uses `std::sync::Mutex` (not async). Rules:

1. **Never hold a lock across an `.await` point.** Acquire, use, drop before any async call.
2. **Never hold `sessions` while trying to acquire `pipeline_results`** (or vice versa) — that lock ordering is undefined and could deadlock.
3. Lock with `state.foo.lock().map_err(|_| "lock poisoned")?` — propagate poison as a command error.

### Lock-per-line pattern in `pipeline.rs`

`run_pipeline` re-acquires `sessions` for every line in the main loop (line ~96). This is intentional and correct, but coarse. The comment explains: the mmap stays valid for the session lifetime, so a copy of the raw bytes is cheap. A future optimization would clone the whole `LogSource` arc before the loop.

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

- `pipeline-progress` — emitted by `pipeline.rs` every 5,000 lines and on final line.  
  Payload: `{ processorId, linesProcessed, totalLines, percent }` (camelCase).
- `claude-stream` — emitted by `claude/client.rs` for each SSE token.  
  Payload: `{ kind: "text"|"done"|"error", text?, error? }`.

## `files.rs` ViewMode coupling

`get_lines` in Processor mode fetches matched line numbers from `AppState::pipeline_results`, then adds context lines and paginates. The returned `ViewLine.lineNum` is the **actual file line number**, not a sequential index. This mismatches the frontend virtualizer's sequential index — a known bug. See root CLAUDE.md.
