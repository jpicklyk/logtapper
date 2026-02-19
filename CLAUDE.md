# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the full app in dev mode (starts Vite + Rust backend together)
npx tauri dev

# Frontend only
npm run build          # TypeScript check + Vite bundle
npx vite               # Vite dev server standalone

# Rust backend (run from project root, not src-tauri/)
cargo test --manifest-path src-tauri/Cargo.toml          # all tests
cargo test --manifest-path src-tauri/Cargo.toml <name>   # single test by name
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

**Platform note (MSYS2/Windows):** `.npmrc` sets `os=win32` and `cpu=x64` so npm installs the correct `@rollup/rollup-win32-x64-msvc` native binary. `cargo build` exits with code 1 on MSYS2 even on success — check for "Finished" in output.

## Architecture

Tauri 2.x desktop app: React 18/TypeScript frontend + Rust backend. All IPC goes through typed `invoke()` calls and Tauri events — no direct filesystem or network access from the frontend.

```
src/bridge/       ← all invoke() wrappers and event listeners
src/hooks/        ← stateful logic (useLogViewer, usePipeline, useClaude, useChartData)
src/components/   ← React components, consume hooks only via AppContext

src-tauri/src/commands/   ← #[tauri::command] handlers, AppState definition
src-tauri/src/core/       ← parsers, AnalysisSession, LineMeta/LineContext
src-tauri/src/processors/ ← YAML schema, interpreter, VarStore, registry
src-tauri/src/scripting/  ← Rhai sandbox, scope builder, emit() bridge
src-tauri/src/anonymizer/ ← PII detection + token mapping
src-tauri/src/charts/     ← chart data building from emissions/vars
src-tauri/src/claude/     ← Claude API client (SSE streaming), generator
```

### AppState (`commands/mod.rs`)

All fields use `std::sync::Mutex` (not async). **Never hold a lock across an `.await` point. Never hold `sessions` while acquiring `pipeline_results` — lock ordering is undefined and risks deadlock.**

| Field | Type | Contains |
|---|---|---|
| `sessions` | `Mutex<HashMap<String, AnalysisSession>>` | sessionId → mmap'd file + line index, or live ADB stream |
| `processors` | `Mutex<HashMap<String, ProcessorDef>>` | processorId → YAML-defined processor (auto-loaded from disk on startup) |
| `pipeline_results` | `Mutex<HashMap<String, HashMap<String, RunResult>>>` | sessionId → processorId → matched lines + emissions + vars |
| `api_key` | `Mutex<Option<String>>` | Claude API key set at runtime |
| `http_client` | `reqwest::Client` | Shared; no mutex needed (Clone + Send + Sync) |
| `stream_tasks` | `Mutex<HashMap<String, oneshot::Sender<()>>>` | sessionId → cancellation sender for active ADB streaming task |
| `stream_processor_state` | `Mutex<HashMap<String, HashMap<String, ContinuousRunState>>>` | sessionId → processorId → incremental processor state between batches |

To add a new command: implement it in the appropriate `commands/*.rs` file, then register it in `src-tauri/src/lib.rs` in the `.invoke_handler(tauri::generate_handler![...])` list.

### Command inventory

| Command | File | Notes |
|---|---|---|
| `load_log_file` | `files.rs` | Creates `AnalysisSession`, mmaps file, builds line index |
| `get_lines` | `files.rs` | Paginated view; 3 modes: Full, Processor, Focus |
| `search_logs` | `files.rs` | Full-text / regex search; returns `match_line_nums` |
| `get_dumpstate_metadata` | `files.rs` | Returns section list for bugreport files |
| `get_sections` | `files.rs` | Returns named sections for bugreport navigation |
| `run_pipeline` | `pipeline.rs` | Runs processors over file, emits `pipeline-progress` events |
| `stop_pipeline` | `pipeline.rs` | No-op placeholder |
| `list_processors` | `processors.rs` | Lists installed processors from `AppState::processors` |
| `load_processor_yaml` | `processors.rs` | Parses YAML, validates Rhai scripts, installs to `AppState::processors` |
| `load_processor_from_file` | `processors.rs` | Load processor YAML from a local file path |
| `uninstall_processor` | `processors.rs` | Removes from `AppState::processors` |
| `get_processor_vars` | `processors.rs` | Returns `AppState::pipeline_results[session][processor].vars` |
| `get_matched_lines` | `processors.rs` | Returns matched line numbers for a processor result |
| `fetch_registry` | `processors.rs` | HTTP GET registry JSON from GitHub |
| `install_from_registry` | `processors.rs` | Download + SHA-256 verify + install processor from registry |
| `get_chart_data` | `charts.rs` | Builds chart series from stored `RunResult.emissions` |
| `set_claude_api_key` | `claude.rs` | Stores key in `AppState::api_key` |
| `claude_analyze` | `claude.rs` | Streams analysis via `claude-stream` events |
| `claude_generate_processor` | `claude.rs` | Generates + validates YAML, returns raw string |
| `list_adb_devices` | `adb.rs` | Runs `adb devices -l`, returns `Vec<AdbDevice>` |
| `start_adb_stream` | `adb.rs` | Spawns background ADB task, returns `LoadResult` immediately |
| `stop_adb_stream` | `adb.rs` | Sends cancellation via `stream_tasks[sessionId]` oneshot channel |
| `get_package_pids` | `adb.rs` | Resolves package name → PIDs via `adb shell pidof` |

### Tauri events

| Event name | Emitted by | Payload |
|---|---|---|
| `pipeline-progress` | `commands/pipeline.rs` | `{ processorId, linesProcessed, totalLines, percent }` — every 5,000 lines |
| `claude-stream` | `claude/client.rs` | `{ kind: "text"\|"done"\|"error", text?, error? }` — per SSE token |
| `adb-batch` | `commands/adb.rs` | `{ sessionId, lines: ViewLine[], totalLines, byteCount, firstTimestamp, lastTimestamp }` — every 50 ms |
| `adb-processor-update` | `commands/adb.rs` | `{ sessionId, processorId, matchedLines, emissionCount }` — per-batch processor result |
| `adb-stream-stopped` | `commands/adb.rs` | `{ sessionId, reason: "user"\|"error"\|"eof" }` — device disconnect or stop |

### ADB streaming architecture

`start_adb_stream` spawns a `tokio::task` that:
1. Runs `adb -s DEVICE logcat -v threadtime` as a child process
2. Buffers lines for 50 ms or 100 lines, then flushes a batch
3. Parses each line with `LogcatParser` → appends to `LogSourceData::Stream { raw_lines, line_meta }`
4. Runs any `active_processor_ids` via `ContinuousRunState` (seeded between batches via `ProcessorRun::new_seeded`)
5. Emits `adb-batch` and `adb-processor-update` events
6. Exits on cancellation signal, EOF, or I/O error → emits `adb-stream-stopped`

`LogSourceData` is an enum distinguishing file (`mmap + line_index`) from stream (`raw_lines: Vec<String>`). Stream sources track `evicted_count` for the backend cap. Always use `source.meta_at(n)` and `source.raw_line(n)` instead of indexing `line_meta` directly — these adjust for eviction offset.

### End-to-end pipeline run (file mode)

1. **Frontend** → `runPipeline(sessionId, processorIds, anonymize)` via `invoke()`
2. **`commands/pipeline.rs`** clones processor defs, snapshots `total_lines`, loops over every line:
   - Re-acquires `sessions` lock per line (coarse but correct — mmap stays valid for session lifetime)
   - Parses with `LogcatParser` (**hardcoded** — not the session's detected parser; known limitation)
   - Optionally anonymizes `message` and `raw`
   - Runs each `ProcessorRun::process_line()` serially
3. Results stored in `AppState::pipeline_results[sessionId][processorId]`
4. Frontend `usePipeline` listens to `pipeline-progress` events for live progress

### Frontend hook ownership

Hooks live in `App.tsx` and are shared via `AppContext`. Components access them through `useAppContext()`.

| Hook | Owns |
|---|---|
| `useLogViewer` | File loading, ADB streaming, virtual scroll cache, search, stream filter, processor view mode |
| `usePipeline` | Processor CRUD, pipeline runs, progress, results, `adb-processor-update` subscription |
| `useClaude` | Chat history, streaming, API key sync |
| `useChartData` | On-demand chart fetching (keyed by `sessionId:processorId`; not auto-invalidated on re-run) |
| `usePaneLayout` | Multi-pane layout, tab management, sidebar/panel sizing |

**`useLogViewer` cache semantics:** `lineCache: Map<number, ViewLine>` keys must equal the virtualizer's `virtualItem.index` (0-based sequential). In Full mode this holds — `get_lines` returns sequential `lineNum`. In Processor mode `lineNum` is the actual file line number, causing a virtualizer mismatch (known bug — processor view shows all placeholders).

**`usePipeline` runCount:** `runCount` state is incremented after every pipeline run or `adb-processor-update` event. `VarInspector` uses this as a `refreshKey` to force re-fetch of vars; without it, vars show stale values after re-runs.

### Auto-scroll (streaming)

`LogViewer.tsx` uses `lastProgrammaticScrollMs` (timestamp ref) to guard against async scroll events. Before each `virtualizer.scrollToIndex` call, `lastProgrammaticScrollMs.current = Date.now()`. The `onScroll` handler ignores re-enable events within 150 ms of a programmatic scroll. Disabling auto-scroll uses `wheel`/`keydown` events (fire before position changes, guaranteed to beat React effects).

### Known bugs

1. **Processor view cache mismatch** (`useLogViewer.ts` + `commands/files.rs`): In Processor mode, `get_lines` returns `ViewLine.lineNum` = actual file line number (e.g., 42, 57). The virtualizer expects sequential 0-based indices. Result: processor view shows all `…` loading placeholders, never resolves.

2. **KernelParser drops non-kernel lines** (`core/kernel_parser.rs`): `parse_meta()` returns `None` for lines that don't match the kernel timestamp regex — silently excluded from the index. `detect_source_type()` uses `text.starts_with('[')` which is too broad.

3. **`pipeline.rs` always uses `LogcatParser`**: Hardcoded regardless of the session's detected source type. Kernel/Bugreport lines may be silently skipped.

### Tauri-specific gotchas

- `app.emit()` requires `use tauri::Emitter` — it is a trait method, not inherent on `AppHandle`.
- Rust's `regex` crate does **not** support look-ahead (`(?!...)`). Clippy flags this as `clippy::invalid_regex`. `get_or_compile()` in `processors/interpreter.rs` returns `Option<&Regex>` to handle invalid patterns gracefully.
- Timestamps are **nanoseconds since 2000-01-01 UTC** (not Unix epoch). JS `number` loses precision beyond 2^53 nanos — treat as opaque ordering values on the frontend.
- Rhai map key existence: use `key in map`, not `map.contains_key(key)` — `contains_key` is not registered and causes silent runtime failure.
