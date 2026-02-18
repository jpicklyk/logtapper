# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LogTapper is a Tauri 2 desktop application for parsing, analyzing, and visualizing Android log files (logcat, kernel, radio, bugreport). The full design specification is in `LOG_ANALYZER_SPEC.md`.

**Stack:** Rust (core engine) + React/TypeScript (UI) + Tauri (desktop shell) + Rhai (sandboxed scripting).

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

# Production build
npx tauri build
```

### Windows / Warp Terminal Notes

The MSYS2 `link.exe` in Warp's PATH shadows the MSVC linker. `.cargo/config.toml` pins the correct linker path — this is intentional. The Windows 11 SDK must also be installed:

> Visual Studio Installer → Modify VS 2022 Community → Individual Components → **Windows 11 SDK (10.0.26100.0)**

The `@tauri-apps/cli-win32-x64-msvc` package must be installed alongside `@tauri-apps/cli` due to an npm optional-dependency bug. It is pinned in `devDependencies`. If you ever clean `node_modules`, do a full `npm install` (not `--prefer-offline`) to ensure it is re-fetched.

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
| `commands/` | Tauri `#[command]` handlers — thin glue between IPC and core |
| `core/` | Data models (`LineContext`, `LogLevel`, `LineMeta`), parsers, pipeline engine, session/timeline |
| `anonymizer/` | PII detection and deterministic pseudonymization — runs between parser and processors |
| `processors/` | YAML schema parsing, declarative stage interpreter, variable system |
| `scripting/` | Rhai engine setup, `LineContext`/`vars`/`emit()` bindings, sandbox limits |
| `claude/` | Anthropic API client (SSE streaming), analysis context builder, processor generator |
| `charts/` | `ChartData` computation from processor state; time bucketing/aggregation |

**Entry point:** `src-tauri/src/lib.rs` — all Tauri commands are registered in `run()` via `invoke_handler!`.

### IPC Conventions

- Frontend calls use `invoke("command_name", args)` via typed wrappers in `src/bridge/commands.ts` (to be implemented).
- Backend pushes streaming data via named Tauri events (e.g., `pipeline-results`, `chart-update-{pid}-{cid}`).
- All data crossing IPC is JSON-serialized via `serde`. Rust structs that cross the boundary derive `serde::Serialize`/`Deserialize`.

### Frontend Layout (`src/`)

| Directory | Responsibility |
|-----------|---------------|
| `components/` | React UI components (log viewer, processor panel, charts, chat) |
| `hooks/` | State and IPC hooks (`usePipeline`, `useLogViewer`, `useClaude`, etc.) |
| `bridge/` | Typed wrappers around `@tauri-apps/api` — `commands.ts`, `events.ts`, `types.ts` |

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

### Processor System

Processors are YAML files with two optional layers:
1. **Declarative stages** — interpreted directly by Rust (`processors/interpreter.rs`). No code.
2. **`stage: script` with Rhai** — inline script with access to `line`, `fields`, `vars`, `history`, `session`, `emit()`, `emit_chart()`.

`vars` declared in the YAML header persist across all lines in a processor run and are the primary way processors accumulate state (counters, tables, lists).

### PII Anonymizer

Always positioned **after parsing, before processors**. `LineContext` fields seen by scripts and Claude are already anonymized. Mappings are session-scoped in memory only (never written to disk). Deterministic: same raw value → same token within a session (e.g., `192.168.1.1` → `<IPv4-1>` everywhere).

### Log Viewer Windowing

The Rust backend owns all lines in memory. The frontend requests a `LineWindow` via `get_lines(LineRequest)` specifying `offset + count` (viewport capacity). Virtual scrolling (`@tanstack/react-virtual`) renders only visible rows. Three view modes: **Full**, **Processor** (collapsed to matches + context gaps), **Focus** (centered on a timestamp/line).

## Implementation Phases

The codebase is organized around four phases. Every stub file contains a `// TODO PhaseN:` comment indicating when it will be implemented:

- **Phase 1** — Logcat parser, mmap file reader, basic pipeline, virtualized viewer, search
- **Phase 2** — Rhai scripting, variable system, YAML processor schema, PII anonymizer, highlight system
- **Phase 3** — Multi-source (kernel/radio/bugreport), unified timeline, cross-source index, charts
- **Phase 4** — Claude AI integration, GitHub processor registry, auto-updater, CI/CD

## Key Constraints

- **Rhai sandbox limits** (to be set in `scripting/engine.rs`): 1M operations, 50K string, 100K array, 10K map. No filesystem or network access.
- **`cargo check` in `src-tauri/`**, not the project root — the Rust crate lives under `src-tauri/`.
- **`Cargo.lock` is committed** — this is a binary application, not a library.
- Commented-out deps in `Cargo.toml` (`rhai`, `tokio`, `reqwest`) are intentionally left for the phase they belong to.
