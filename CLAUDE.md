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

**Platform note (MSYS2/Windows):** `.npmrc` sets `os=win32` and `cpu=x64` so npm installs the correct `@rollup/rollup-win32-x64-msvc` native binary. Without this, MSYS2 bash reports `linux` and npm skips the Windows optional deps.

## Architecture

Tauri 2.x desktop app: React 18/TypeScript frontend + Rust backend. All IPC goes through typed `invoke()` calls and Tauri events — no direct filesystem or network access from the frontend.

```
src/bridge/       ← all invoke() wrappers and event listeners
src/hooks/        ← stateful logic (useLogViewer, usePipeline, useClaude)
src/components/   ← React components, consume hooks only

src-tauri/src/commands/   ← #[tauri::command] handlers, AppState definition
src-tauri/src/core/       ← parsers, AnalysisSession, LineMeta/LineContext
src-tauri/src/processors/ ← YAML schema, interpreter, VarStore, registry
src-tauri/src/scripting/  ← Rhai sandbox, scope builder, emit() bridge
src-tauri/src/anonymizer/ ← PII detection + token mapping
src-tauri/src/charts/     ← chart data building from emissions/vars
src-tauri/src/claude/     ← Claude API client (SSE streaming), generator
```

### AppState (`commands/mod.rs`)

All five fields use `std::sync::Mutex` (not async mutexes) because Tauri's command dispatcher is synchronous at the IPC boundary.

| Field | Type | Contains |
|---|---|---|
| `sessions` | `Mutex<HashMap<String, AnalysisSession>>` | sessionId → mmap'd file + line index |
| `processors` | `Mutex<HashMap<String, ProcessorDef>>` | processorId → YAML-defined processor. **In-memory only — lost on restart.** |
| `pipeline_results` | `Mutex<HashMap<String, HashMap<String, RunResult>>>` | sessionId → processorId → matched lines + emissions + vars |
| `api_key` | `Mutex<Option<String>>` | Claude API key set at runtime |
| `http_client` | `reqwest::Client` | Shared; no mutex needed (client is Clone + Send + Sync) |

To add a new command: implement it in the appropriate `commands/*.rs` file, then register it in `src-tauri/src/lib.rs` in the `.invoke_handler(tauri::generate_handler![...])` list.

### End-to-end pipeline run

1. **Frontend** → `runPipeline(sessionId, processorIds, anonymize)` via `invoke()`
2. **`commands/pipeline.rs`** clones processor defs from `AppState::processors`, snapshots `total_lines` from the session, then loops over every line:
   - Re-acquires `sessions` lock per line to get raw bytes (coarse but correct; see `commands/pipeline.rs`)
   - Parses with `LogcatParser` (hardcoded — not the session's detected parser)
   - Optionally anonymizes `message` and `raw`
   - Runs each `ProcessorRun::process_line()` in sequence (serial, no parallelism)
   - Emits `pipeline-progress` Tauri event every 5,000 lines
3. Results stored in `AppState::pipeline_results[sessionId][processorId]`
4. **Frontend** `usePipeline` hook listens to `pipeline-progress` events for live progress

### Tauri events

| Event name | Emitted by | Payload type |
|---|---|---|
| `pipeline-progress` | `commands/pipeline.rs` | `PipelineProgress` (processorId, linesProcessed, totalLines, percent) |
| `claude-stream` | `claude/client.rs` | `{ kind: "text"\|"done"\|"error", text?, error? }` |

### Known bugs

1. **Processor view cache mismatch** (`useLogViewer.ts` + `commands/files.rs`): In Processor mode, `get_lines` returns `ViewLine` with `lineNum` = actual file line number (e.g., 42, 57). The frontend stores these in `lineCache` keyed by `lineNum`. But the virtualizer uses sequential 0-based indices. Result: processor view shows all `…` loading placeholders, never resolves.

2. **KernelParser drops non-kernel lines** (`core/kernel_parser.rs`): `parse_meta()` returns `None` for lines that don't match the kernel timestamp regex. Those lines are silently excluded from the index. Also, `detect_source_type()` in `session.rs` uses `text.starts_with('[')` as a kernel indicator — too broad; can misdetect logcat files.

3. **`pipeline.rs` always uses `LogcatParser`**: The pipeline parser is hardcoded regardless of the session's detected source type. For Kernel or Bugreport files, lines may not parse and are silently skipped (`continue` on `None` from `parse_line`).

### Tauri-specific gotchas

- `app.emit()` requires `use tauri::{AppHandle, Emitter}` — `Emitter` is a trait, not inherent on `AppHandle`.
- Rust's `regex` crate does **not** support look-ahead (`(?!...)`). Clippy flags this as `clippy::invalid_regex`. `get_or_compile()` in `processors/interpreter.rs` returns `Option<&Regex>` to handle invalid patterns gracefully.
- Timestamps are **nanoseconds since 2000-01-01 UTC** (not Unix epoch). JS `number` (64-bit float) loses precision beyond 2^53 nanos — treat timestamps as opaque ordering values on the frontend; do not perform arithmetic on them.
