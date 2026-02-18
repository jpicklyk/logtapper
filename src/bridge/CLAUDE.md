# src/bridge/ — Frontend IPC Layer

All Tauri communication goes through this directory. Components and hooks **never** call `invoke()` or `listen()` directly.

## Serialization conventions (Rust → TypeScript)

Rust uses `#[serde(rename_all = "camelCase")]` on all IPC structs. The only exception is `LogLevel` which uses `PascalCase` (`"Verbose"`, `"Debug"`, `"Info"`, `"Warn"`, `"Error"`, `"Fatal"`).

Tagged enums cross the boundary as discriminated unions:

| Rust | TypeScript |
|---|---|
| `ViewMode::Full` | `{ mode: 'Full' }` |
| `ViewMode::Processor` | `{ mode: 'Processor' }` |
| `ViewMode::Focus(n)` | `{ mode: 'Focus', center: n }` |
| `HighlightKind::Search` | `{ type: 'Search' }` |
| `HighlightKind::ProcessorMatch { id }` | `{ type: 'ProcessorMatch', id: string }` |
| `HighlightKind::ExtractedField { name }` | `{ type: 'ExtractedField', name: string }` |
| `HighlightKind::PiiReplaced` | `{ type: 'PiiReplaced' }` |

When adding a new Rust IPC struct, add its TypeScript mirror to `types.ts` before using it in a command wrapper.

## Timestamp precision

`ViewLine.timestamp` and `LoadResult.firstTimestamp` / `lastTimestamp` are `i64` nanoseconds since **2000-01-01 UTC** (not Unix epoch). JavaScript `number` (IEEE 754 double) can only represent integers exactly up to 2^53. Nanosecond timestamps overflow this at ~104 days from the epoch. **Treat timestamps as opaque values for ordering only; do not perform arithmetic on them in TypeScript.**

## Command wrappers (`commands.ts`)

All wrappers are thin: `invoke(commandName, args)` → typed Promise. The argument object keys must match the Rust command parameter names exactly (snake_case on the Rust side, but Tauri's auto-rename converts camelCase JS keys to snake_case — **pass camelCase from TypeScript**).

| Function | Rust command | Notes |
|---|---|---|
| `loadLogFile(path)` | `load_log_file` | |
| `getLines(request)` | `get_lines` | `request` is a `LineRequest` object |
| `searchLogs(sessionId, query)` | `search_logs` | |
| `runPipeline(sessionId, ids, anonymize)` | `run_pipeline` | async; also emits events |
| `stopPipeline()` | `stop_pipeline` | no-op until cancellation is implemented |
| `listProcessors()` | `list_processors` | |
| `loadProcessorYaml(yaml)` | `load_processor_yaml` | validates + installs from pasted/uploaded YAML |
| `uninstallProcessor(id)` | `uninstall_processor` | |
| `getProcessorVars(sessionId, id)` | `get_processor_vars` | returns vars after pipeline run |
| `fetchRegistry(url?)` | `fetch_registry` | url defaults to GitHub on backend |
| `installFromRegistry(entry)` | `install_from_registry` | downloads, verifies SHA-256, installs |
| `getChartData(sessionId, id)` | `get_chart_data` | builds chart series from stored emissions |
| `setClaudeApiKey(key)` | `set_claude_api_key` | stored in AppState::api_key (in-memory) |
| `claudeAnalyze(sessionId, processorId, msg)` | `claude_analyze` | returns void; response via `claude-stream` events |
| `claudeGenerateProcessor(desc, lines)` | `claude_generate_processor` | returns YAML string synchronously after full generation |

## Event subscriptions (`events.ts`)

Two events are emitted by the backend:

**`pipeline-progress`** — while `run_pipeline` is executing, emitted every 5,000 lines per processor.
```typescript
listen<PipelineProgress>('pipeline-progress', handler)
// PipelineProgress: { processorId, linesProcessed, totalLines, percent }
```

**`claude-stream`** — while `claude_analyze` is streaming, emitted per SSE token.
```typescript
listen<ClaudeStreamEvent>('claude-stream', handler)
// ClaudeStreamEvent: { kind: "text"|"done"|"error", text?, error? }
```

Both listeners must be unlistened (call the returned `UnlistenFn`) when the subscribing component unmounts. `usePipeline` and `useClaude` hooks handle this.

## `loadProcessorYaml` vs `installFromRegistry`

- `loadProcessorYaml` — installs from a YAML string (user paste or file upload). Validates the YAML structure and any inline Rhai scripts.
- `installFromRegistry` — downloads from a GitHub URL, verifies SHA-256 integrity, then behaves like `loadProcessorYaml`. The `RegistryEntry.sha256` field can be empty to skip verification (dev mode).

Both install to `AppState::processors` (in-memory, no disk persistence).
