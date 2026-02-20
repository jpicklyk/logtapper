# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Full app in dev mode (starts Vite + Rust backend together)
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
src/bridge/       ← invoke() wrappers (commands.ts) + event listeners (events.ts) + shared types (types.ts)
src/hooks/        ← stateful logic: useLogViewer, usePipeline, useClaude, useStateTracker, useChartData, usePaneLayout
src/components/   ← React components, consume hooks only via useAppContext()

src-tauri/src/commands/         ← #[tauri::command] handlers; AppState defined in mod.rs
src-tauri/src/core/             ← parsers (logcat, kernel, bugreport), AnalysisSession, LineContext
src-tauri/src/processors/       ← unified AnyProcessor registry; sub-modules per type
src-tauri/src/processors/reporter/     ← ReporterDef, engine (ProcessorRun), vars, Rhai interpreter
src-tauri/src/processors/transformer/  ← TransformerDef, engine, builtin PII transformer
src-tauri/src/processors/state_tracker/ ← StateTrackerDef, engine, types (StateSnapshot, transitions)
src-tauri/src/processors/correlator/   ← CorrelatorDef (schema stub — no engine)
src-tauri/src/processors/annotator/    ← AnnotatorDef (schema stub — no engine)
src-tauri/src/processors/builtin/      ← embedded YAML files loaded at startup
src-tauri/src/scripting/        ← Rhai sandbox, scope builder, emit() bridge
src-tauri/src/anonymizer/       ← PII detection + token mapping (AnonymizerConfig, detectors)
src-tauri/src/charts/           ← chart data building from emissions/vars
src-tauri/src/claude/           ← Claude API client (SSE streaming), processor generator
```

### Processor type system

`AnyProcessor { meta: ProcessorMeta, kind: ProcessorKind }` is the unified registry type stored in `AppState::processors`. The `type:` YAML field dispatches to the correct schema; omitting it defaults to `reporter` for backward compatibility.

```rust
pub enum ProcessorKind {
    Reporter(ReporterDef),
    Transformer(TransformerDef),
    StateTracker(StateTrackerDef),
    Correlator(CorrelatorDef),   // schema stub, no engine
    Annotator(AnnotatorDef),     // schema stub, no engine
}
```

**ReporterDef pipeline stages** (AND-ed filter → extract → script → aggregate → output):
`Filter` (TagMatch, MessageContains, MessageContainsAny, MessageRegex, LevelMin, TimeRange) → `Extract` (regex captures → fields) → `Script` (Rhai) → `Aggregate` (Count, CountBy, Max, Min, Mean, TimeSeries, Histogram) → `Output` (declarative chart/table)

**TransformerDef** — optional filter + `transforms[]` (`ReplaceField`, `AddField`, `SetField`, `DropField`) or `builtin: pii_anonymizer`

**StateTrackerDef** — `group`, `state` (field decls with typed defaults), `transitions` (filter → set/clear), `output` (timeline, annotate flags)

Built-in processors have IDs starting with `__` (e.g. `__pii_anonymizer`), are loaded via `include_str!` in `lib.rs`, and cannot be uninstalled.

### AppState (`commands/mod.rs`)

All fields use `std::sync::Mutex` (not async). **Never hold a lock across an `.await` point. Never hold `sessions` while acquiring `pipeline_results` — lock ordering is undefined and risks deadlock.**

| Field | Type | Contains |
|---|---|---|
| `sessions` | `Mutex<HashMap<String, AnalysisSession>>` | sessionId → mmapped file + line index, or live ADB stream |
| `processors` | `Mutex<HashMap<String, AnyProcessor>>` | processorId → installed YAML-defined processor |
| `pipeline_results` | `Mutex<HashMap<String, HashMap<String, RunResult>>>` | sessionId → processorId → matched lines, emissions, vars |
| `api_key` | `Mutex<Option<String>>` | Claude API key (in-memory, set at runtime) |
| `http_client` | `reqwest::Client` | Shared; Clone + Send + Sync — no Mutex needed |
| `stream_tasks` | `Mutex<HashMap<String, oneshot::Sender<()>>>` | sessionId → cancellation sender for active ADB task |
| `stream_processor_state` | `Mutex<HashMap<String, HashMap<String, ContinuousRunState>>>` | sessionId → processorId → reporter state between batches |
| `stream_transformer_state` | `Mutex<HashMap<String, HashMap<String, ContinuousTransformerState>>>` | sessionId → transformerId → transformer state between batches |
| `stream_tracker_state` | `Mutex<HashMap<String, HashMap<String, ContinuousTrackerState>>>` | sessionId → trackerId → tracker state between batches |
| `state_tracker_results` | `Mutex<HashMap<String, HashMap<String, StateTrackerResult>>>` | sessionId → trackerId → transitions + final state |
| `anonymizer_config` | `Mutex<AnonymizerConfig>` | Current PII detector/pattern config (persisted to disk) |
| `pii_mappings` | `Mutex<HashMap<String, HashMap<String, String>>>` | sessionId → token → original (from last pipeline run) |
| `stream_anonymizers` | `Mutex<HashMap<String, LogAnonymizer>>` | sessionId → per-stream anonymizer (consistent token numbering across batches) |

### Command inventory

To add a command: implement in `commands/*.rs`, register in `src-tauri/src/lib.rs` `.invoke_handler(tauri::generate_handler![...])`.

| Command | File | Notes |
|---|---|---|
| `load_log_file` | `files.rs` | Creates `AnalysisSession`, mmaps file, detects parser type |
| `get_lines` | `files.rs` | Paginated view; 3 modes: Full, Processor, Focus |
| `search_logs` | `files.rs` | Full-text / regex search; returns `match_line_nums` |
| `get_dumpstate_metadata` | `files.rs` | Build/device info from bugreport |
| `get_sections` | `files.rs` | Named section boundaries for bugreport navigation |
| `run_pipeline` | `pipeline.rs` | Partitions by kind, layered execution, emits `pipeline-progress` |
| `stop_pipeline` | `pipeline.rs` | No-op placeholder (cancellation not yet implemented) |
| `list_processors` | `processors.rs` | Lists `AppState::processors`; sorted builtin-first then by name |
| `load_processor_yaml` | `processors.rs` | Parse YAML → validate Rhai → persist to disk → install |
| `load_processor_from_file` | `processors.rs` | Same as above, reads YAML from local path |
| `uninstall_processor` | `processors.rs` | Removes from AppState + disk; guards `__` IDs |
| `get_processor_vars` | `processors.rs` | Returns `pipeline_results[session][processor].vars` |
| `get_matched_lines` | `processors.rs` | Matched line numbers + raw text |
| `fetch_registry` | `processors.rs` | HTTP GET registry JSON (defaults to GitHub) |
| `install_from_registry` | `processors.rs` | Download + SHA-256 verify + install |
| `get_chart_data` | `charts.rs` | Builds chart series from emissions + vars (reporters only) |
| `set_claude_api_key` | `claude.rs` | Stores key in `AppState::api_key` |
| `claude_analyze` | `claude.rs` | Streams response via `claude-stream` events |
| `claude_generate_processor` | `claude.rs` | Returns validated YAML string synchronously |
| `get_anonymizer_config` | `anonymizer.rs` | Returns `AnonymizerConfig` from AppState |
| `set_anonymizer_config` | `anonymizer.rs` | Updates AppState + persists to `{app_data_dir}/anonymizer_config.json` |
| `test_anonymizer` | `anonymizer.rs` | Runs PII detection on sample text, returns replacements |
| `get_pii_mappings` | `anonymizer.rs` | Returns token→original map from last pipeline run |
| `list_adb_devices` | `adb.rs` | Runs `adb devices -l`, returns `Vec<AdbDevice>` |
| `start_adb_stream` | `adb.rs` | Spawns background ADB logcat task, returns `LoadResult` immediately |
| `stop_adb_stream` | `adb.rs` | Sends cancellation via `stream_tasks[sessionId]` oneshot channel |
| `update_stream_processors` | `adb.rs` | Diffs active reporter IDs mid-stream |
| `update_stream_trackers` | `adb.rs` | Diffs active tracker IDs mid-stream |
| `update_stream_transformers` | `adb.rs` | Diffs active transformer IDs mid-stream |
| `set_stream_anonymize` | `adb.rs` | Enables/disables PII anonymization for active stream |
| `get_package_pids` | `adb.rs` | Resolves package name → PIDs via `adb shell pidof` |
| `get_state_at_line` | `state_tracker.rs` | Binary-search transitions + replay state up to line |
| `get_state_transitions` | `state_tracker.rs` | All transitions for a tracker in a session |
| `get_all_transition_lines` | `state_tracker.rs` | All transition line numbers grouped by tracker ID |

### Tauri events

| Event | Emitted by | Payload | Timing |
|---|---|---|---|
| `pipeline-progress` | `pipeline.rs` | `{ processorId, linesProcessed, totalLines, percent }` | Every 5,000 lines + final |
| `claude-stream` | `claude/client.rs` | `{ kind: "text"\|"done"\|"error", text?, error? }` | Per SSE token |
| `adb-batch` | `adb.rs` flush_batch | `{ sessionId, lines: ViewLine[], totalLines, byteCount, firstTimestamp, lastTimestamp }` | Every 50ms or 100 lines |
| `adb-processor-update` | `adb.rs` flush_batch | `{ sessionId, processorId, matchedLines, emissionCount }` | Per-batch, per reporter |
| `adb-tracker-update` | `adb.rs` flush_batch | `{ sessionId, trackerId, transitionCount }` | Per-batch, per tracker |
| `adb-stream-stopped` | `adb.rs` | `{ sessionId, reason: "user"\|"error"\|"eof" }` | On stop or device disconnect |

### ADB streaming architecture

`start_adb_stream` spawns a `tokio::task` that:
1. Runs `adb -s DEVICE logcat -v threadtime` as a child process
2. Buffers lines for 50ms or 100 lines, then calls `flush_batch()`
3. `flush_batch` applies the layered execution model (same as `run_pipeline`): Transformers → StateTrackers → Reporters
4. Continuous state persists between batches via `new_seeded()` / `into_continuous_state()` pattern for all three processor kinds
5. Emits `adb-batch`, `adb-processor-update`, `adb-tracker-update` events
6. Exits on cancellation signal, EOF, or I/O error → emits `adb-stream-stopped`

`LogSourceData` is an enum: `File { mmap, line_index }` vs `Stream { raw_lines: Vec<String> }`. Stream sources track `evicted_count` for the backend line cap. **Always use `source.meta_at(n)` and `source.raw_line(n)` instead of direct indexing** — these adjust for eviction offset transparently.

### Layered pipeline execution

Both `run_pipeline` (file mode) and `flush_batch` (streaming) follow the same layered model:

```
Raw lines → parse → LineContext
    │
    ▼ Layer 1: Transformers (sequential per line)
    │   Modifies message/fields; may drop line (returns None)
    │   Built-in: PII Anonymizer
    ▼ Layer 2a: StateTrackers (parallel across trackers)
    │   Records StateTransitions; queryable by line_num
    ▼ Layer 2b: Reporters (parallel across reporters)
        Filter / Extract / Script / Aggregate
```

### Frontend hook ownership

Hooks live in `App.tsx` and are shared via `AppContext`. Access via `useAppContext()`.

| Hook | Owns |
|---|---|
| `useLogViewer` | File loading, ADB streaming, virtual scroll cache, search, stream filter, processor view mode, `selectedLineNum` |
| `usePipeline` | Processor CRUD, pipeline runs, progress tracking, results, `adb-processor-update` subscription |
| `useClaude` | Chat history, streaming, API key sync (localStorage + backend) |
| `useStateTracker` | Transition line sets, `getSnapshot`, `getTransitions`, `adb-tracker-update` subscription |
| `useChartData` | On-demand chart fetching (keyed by `sessionId:processorId`; not auto-invalidated on re-run) |
| `usePaneLayout` | Multi-pane layout (tabs: `logviewer`, `dashboard`, `scratch`, `statetimeline`), sidebar/panel sizing |

**`useLogViewer` cache semantics:** `lineCache: Map<number, ViewLine>` keys must equal the virtualizer's `virtualItem.index` (0-based sequential). In Full mode this holds. In Processor mode, `lineNum` is the actual file line number — this causes a virtualizer mismatch (known bug — all placeholders).

**`usePipeline` runCount:** incremented after every pipeline run **and** every `adb-processor-update` event. `VarInspector` and `StatePanel` use this as a refresh trigger — the bail-out pattern in `StatePanel` is critical to prevent flickering (see below).

### High-frequency streaming UI design decisions

Components that update on every ADB batch (~50ms) require explicit stabilization:

**`useRef` for imperative guards** — values affecting behavior that must not trigger re-renders (timestamps, scroll positions, "has-fetched" flags) belong in refs, not state.

**Functional setState with referential bail-out** — canonical pattern for skipping re-renders when new data equals old:
```tsx
setTrackerStates((prev) => {
  const unchanged = prev.length === next.length &&
    prev.every((p, i) => JSON.stringify(p.snapshot) === JSON.stringify(next[i].snapshot));
  return unchanged ? prev : next; // same reference → React skips the re-render
});
```
`JSON.stringify` comparison is pragmatic and acceptable for small snapshots. For larger data, prefer memoized selectors or structural diffing.

**`hasDataRef` for first-fetch skeleton suppression** — show skeleton loading rows only on the very first fetch. Subsequent fetches happen silently. Implemented as `useRef<boolean>` (not state) to avoid the additional render cycle. Reset to `false` when the session or active tracker set changes.

**`pipeline.runCount` fires for both streaming batches and full pipeline runs** — `adb-processor-update` increments `runCount` every ~50ms during streaming, but `state_tracker_results` only updates on full runs. Components depending on `runCount` must handle identical data between fetches (use the bail-out pattern above).

**Auto-scroll timing guards** — `lastProgrammaticScrollMs` ref guards `onScroll` re-enables for 150ms after a programmatic `scrollToIndex`. A second ref `lastManualScrollUpMs` guards for 600ms after any wheel-up or keyboard-up event, preventing the near-bottom race where the scroll event fires asynchronously and re-enables auto-scroll before the user has moved far from the bottom.

### Known bugs

1. **Processor view cache mismatch** (`useLogViewer.ts` + `commands/files.rs`): In Processor mode, `get_lines` returns `ViewLine.lineNum` = actual file line number (e.g., 42, 57). The virtualizer expects sequential 0-based indices. Result: processor view shows all `…` loading placeholders.

2. **`pipeline.rs` always uses `LogcatParser`**: Hardcoded regardless of the session's detected source type. Kernel/bugreport lines may be silently skipped.

3. **KernelParser drops non-kernel lines** (`core/kernel_parser.rs`): `parse_meta()` returns `None` for lines without a kernel timestamp — silently excluded from the index.

### Tauri / Rust gotchas

- `app.emit()` requires `use tauri::Emitter` — it is a trait method, not inherent on `AppHandle`.
- Rust's `regex` crate does **not** support look-ahead (`(?!...)`). Clippy flags this. `get_or_compile()` returns `Option<&Regex>` (None on invalid pattern) — callers skip on None, resulting in 0 matches rather than a panic.
- Timestamps are **nanoseconds since 2000-01-01 UTC** (not Unix epoch). JS `number` loses precision beyond 2^53 nanos — treat as opaque ordering values on the frontend.
- Rhai map key existence: use `key in map`, not `map.contains_key(key)` — `contains_key` is not registered and causes silent runtime failure.
- Rhai nested map mutation: copy → modify → write back (`let m = vars.mymap; m[k] = v; vars.mymap = m`).
- Multiple filter rules are AND-ed. For OR logic, use `message_regex: "foo|bar"` or `message_contains_any: [...]`.
- `validate_for_install()` only validates Rhai syntax — invalid filter regexes pass install but silently produce 0 matches at runtime.
- Clippy: `impl Default for Foo` where the body only calls field defaults → replace with `#[derive(Default)]`.
