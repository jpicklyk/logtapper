# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LogTapper is a Tauri 2 desktop application for parsing, analyzing, and visualizing Android log files (logcat, kernel, radio, bugreport). The full design specification is in `LOG_ANALYZER_SPEC.md`.

**Stack:** Rust (core engine) + React/TypeScript (UI) + Tauri (desktop shell) + Rhai (sandboxed scripting) + Recharts (charts).

## Development Commands

All commands run from the project root (`D:\Projects\LogTapper`).

```bash
# Start full dev environment (Rust + React with hot reload)
npx tauri dev

# Frontend only (no Rust, faster for UI-only work)
npm run dev

# Type-check TypeScript
npx tsc --noEmit

# Rust check only (faster than build)
cd src-tauri && cargo check

# Rust tests
cd src-tauri && cargo test

# Rust lint
cd src-tauri && cargo clippy

# Production build
npx tauri build
```

### Windows / MSYS2 Notes

The MSYS2 `link.exe` in the PATH may shadow the MSVC linker. `.cargo/config.toml` pins the correct linker path — this is intentional. The Windows 11 SDK must also be installed:

> Visual Studio Installer → Modify VS 2022 Community → Individual Components → **Windows 11 SDK (10.0.26100.0)**

The `@tauri-apps/cli-win32-x64-msvc` package must be installed alongside `@tauri-apps/cli`. It is pinned in `devDependencies`. If you clean `node_modules`, do a full `npm install` to ensure it is re-fetched.

## Architecture

### Process Model

Two processes communicate over Tauri IPC:

```
React/TS (webview)  ──invoke/event──►  Rust core (native process)
```

The Rust side owns all data: file memory maps, parsed lines, processor state, analysis sessions. The frontend is a pure display layer — it requests windows of data via `invoke()` and listens to streaming events.

### Rust Crate Layout (`src-tauri/src/`)

| Module | Responsibility |
|--------|---------------|
| `commands/` | Tauri `#[command]` handlers — thin glue between IPC and core. Entry point: `lib.rs`. |
| `core/` | Data models (`LineContext`, `LogLevel`, `LineMeta`), parsers, pipeline engine, session/timeline |
| `anonymizer/` | PII detection and deterministic pseudonymization — runs between parser and processors |
| `processors/` | YAML schema parsing, declarative stage interpreter, variable system, GitHub registry |
| `scripting/` | Rhai engine setup, `LineContext`/`vars`/`emit()` bindings, sandbox limits |
| `claude/` | Anthropic API client (SSE streaming), analysis context builder, processor generator |
| `charts/` | `ChartData` computation from processor state; time bucketing/aggregation |

**`AppState`** (in `commands/mod.rs`):
```rust
sessions: Mutex<HashMap<String, AnalysisSession>>
processors: Mutex<HashMap<String, ProcessorDef>>
pipeline_results: Mutex<HashMap<String, HashMap<String, RunResult>>>
api_key: Mutex<Option<String>>
http_client: reqwest::Client
```

### Frontend Layout (`src/`)

| Directory | Responsibility |
|-----------|---------------|
| `components/` | React UI components (log viewer, processor panel, charts, chat, marketplace) |
| `hooks/` | State and IPC hooks (`usePipeline`, `useLogViewer`, `useClaude`, `useChartData`) |
| `bridge/` | Typed wrappers around `@tauri-apps/api` — `commands.ts`, `types.ts` |

### Data Flow

```
File on disk
  → mmap (LogSource)
  → Parser (logcat / kernel / radio / bugreport)
  → Anonymizer (PII scrubbing — always before processors and Claude)
  → Pipeline engine
      → Declarative YAML stages (filter → extract → correlate → aggregate)
      → Rhai script stage (optional, sandboxed)
      → emit() / emit_chart()
  → Output: vars state, emissions table, ChartData
  → Tauri events → Frontend
```

## Key Subsystems

### Processor System

Processors are YAML files with two optional layers:
1. **Declarative stages** — interpreted directly by Rust (`processors/interpreter.rs`). No code.
2. **`stage: script` with Rhai** — inline script with access to `line`, `fields`, `vars`, `history`, `emit()`.

`vars` declared in the YAML header persist across all lines in a processor run.

### PII Anonymizer

Always positioned **after parsing, before processors**. Mappings are session-scoped in memory only. Deterministic: same raw value → same token within a session (e.g., `192.168.1.1` → `<IPv4-1>`).

### Log Viewer Windowing

Rust backend owns all lines. Frontend requests a `LineWindow` via `get_lines(LineRequest)` with `offset + count`. Virtual scrolling via `@tanstack/react-virtual`. Three view modes: **Full**, **Processor** (collapsed to matches + context gaps), **Focus** (centered on a line).

### Claude Integration

- `claude_analyze`: Streams response as `claude-stream` Tauri events; returns `Promise<void>`.
- `claude_generate_processor`: Non-streaming, returns validated YAML string.
- API key stored in `AppState.api_key` (set via `set_claude_api_key` command); frontend persists to localStorage.
- All data sent to Claude has already been through the anonymizer.

### GitHub Registry

- `fetch_registry` command downloads `registry.json` from GitHub.
- `install_from_registry` downloads YAML, verifies SHA-256, validates, and installs.
- `processors/registry.rs` handles HTTP + integrity checks.

## Key Constraints

- **Rhai sandbox limits** (set in `scripting/engine.rs`): 1M operations, 50K string, 100K array, 10K map. No filesystem or network access.
- **`cargo check/test` in `src-tauri/`**, not the project root.
- **`Cargo.lock` is committed** — this is a binary application, not a library.
- Tauri 2 events require `use tauri::Emitter` to be in scope for `app.emit()`.

## Phase Completion Status

All four phases are complete:
- **Phase 1** ✓ — Logcat parser, mmap file reader, virtualized viewer, search
- **Phase 2** ✓ — Rhai scripting, YAML processors, PII anonymizer, processor UI
- **Phase 3** ✓ — Kernel/bugreport parsers, unified timeline, cross-source index, charts
- **Phase 4** ✓ — Claude AI streaming, processor generation, GitHub registry, marketplace
