# src/bridge/ — Frontend IPC Layer

All Tauri communication goes through this directory. Components and hooks **never** call `invoke()` or `listen()` directly.

## File organization

- `commands.ts` — thin `invoke()` wrappers; one function per Rust `#[tauri::command]`
- `events.ts` — typed `listen()` wrappers for all Tauri events
- `types.ts` — TypeScript mirrors of all Rust IPC structs

When adding a new Rust IPC struct, add its TypeScript mirror to `types.ts` before using it in a command wrapper.

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

## Timestamp precision

`ViewLine.timestamp` and `LoadResult.firstTimestamp` / `lastTimestamp` are `i64` nanoseconds since **2000-01-01 UTC** (not Unix epoch). JavaScript `number` (IEEE 754 double) can only represent integers exactly up to 2^53. **Treat timestamps as opaque values for ordering only; do not perform arithmetic on them in TypeScript.**

## Command wrapper conventions (`commands.ts`)

All wrappers are thin: `invoke(commandName, args)` → typed Promise. The argument object keys must match the Rust command parameter names exactly (snake_case on the Rust side, but Tauri's auto-rename converts camelCase JS keys to snake_case — **pass camelCase from TypeScript**).

## Event subscription conventions (`events.ts`)

All listeners must be unlistened (call the returned `UnlistenFn`) when the subscribing component unmounts. Hooks handle this via the async listener pattern documented in the root CLAUDE.md.

## `loadProcessorYaml` vs `installFromRegistry`

- `loadProcessorYaml` — installs from a YAML string (user paste or file upload). Validates the YAML structure and any inline Rhai scripts.
- `installFromRegistry` — downloads from a GitHub URL, verifies SHA-256 integrity, then behaves like `loadProcessorYaml`. The `RegistryEntry.sha256` field can be empty to skip verification (dev mode).

Both install to `AppState::processors` and persist to disk (`{app_data_dir}/processors/{id}.yaml`). Persisted processors are loaded on startup.
