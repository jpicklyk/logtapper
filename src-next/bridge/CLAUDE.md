# src/bridge/ — Frontend IPC Layer

All Tauri communication goes through this directory. Components and hooks **never** call `invoke()` or `listen()` directly.

## File organization

- `commands.ts` — thin `invoke()` wrappers; one function per Rust `#[tauri::command]`
- `events.ts` — typed `listen()` wrappers for all Tauri events
- `types.ts` — the import surface for IPC types; re-exports from `generated/` plus a
  small set of hand-written types that have no Rust struct or that ts-rs cannot
  narrow (each carries a one-line comment explaining why)
- `generated/` — ts-rs bindings produced by `npm run gen:types`; never hand-edit
  (see its own note in `.gitattributes` and `types.ts`'s header comment)

When adding a new Rust IPC struct: derive `TS` on it (see `src-tauri/tests/export_bindings.rs`'s
`ROOT_TYPES!` list), run `npm run gen:types` to regenerate `generated/`, then re-export it from
`types.ts` before using it in a command wrapper. Only add a hand-written type in `types.ts` when
there is no Rust struct to derive from, or ts-rs cannot express the shape (e.g. a `String` field
that is really a fixed set of literals) — and always with a comment saying why. `npm run
check:types` (part of `lint:all`) fails the build if `generated/` drifts from a fresh `gen:types`
run or if `tsc` doesn't pass.

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

## Command wrapper conventions (`commands.ts`)

All wrappers are thin: `invoke(commandName, args)` → typed Promise. The argument object keys must match the Rust command parameter names exactly (snake_case on the Rust side, but Tauri's auto-rename converts camelCase JS keys to snake_case — **pass camelCase from TypeScript**).

## Event subscription conventions (`events.ts`)

All listeners must be unlistened (call the returned `UnlistenFn`) when the subscribing component unmounts. Hooks handle this via the async listener pattern documented in the root CLAUDE.md.

## `loadProcessorYaml` vs `installFromRegistry`

- `loadProcessorYaml` — installs from a YAML string (user paste or file upload). Validates the YAML structure and any inline Rhai scripts.
- `installFromRegistry` — downloads from a GitHub URL, verifies SHA-256 integrity, then behaves like `loadProcessorYaml`. The `RegistryEntry.sha256` field can be empty to skip verification (dev mode).

Both install to `AppState::processors` and persist to disk (`{app_data_dir}/processors/{id}.yaml`). Persisted processors are loaded on startup.
