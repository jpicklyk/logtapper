# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Frontend

The shipped frontend is the Solid app in `src-solid/`. Its architecture, module map and
rules (stores composed in `App.tsx`, the shell's surface map, cancel-safe `listen()`,
per-session state keyed by session id, barrel imports across modules, static styling in
CSS modules with runtime values through custom properties) are in `src-solid/CLAUDE.md` —
**read it before changing code there.**

The framework-free modules shared with the backend's generated bindings live in
`src-shared/` (see `src-shared/CLAUDE.md`). Nothing there may import a UI framework, and
`src-solid/` reaches it only through the aliases in `solid.aliases.ts`; `eslint.config.js`
enforces both directions.

## Implementation Plans

All feature and performance implementation plans live in `plans/` at the project root. The directory is `.gitignore`d (local working docs only). Name files descriptively: `plans/<feature-name>-<tier-or-phase>.md` (e.g. `plans/perf-tier1-quick-wins.md`). When asked to plan a feature or create an implementation plan, write it there.

## Agent Discipline Rules

These rules address recurring mistakes. Follow them before writing code, not as an afterthought.

### Search before creating
Before writing any new function, helper, or utility, search the codebase for existing implementations that do the same thing. Check adjacent files, shared modules, and utility directories. Duplication is caught in every review — prevent it by searching first. If you find a near-match, extend or reuse it rather than creating a parallel version.

### Trace flags through all consumers
When adding a boolean flag or mode that controls behavior (e.g., `timeline: false`), search for ALL code paths that consume the underlying data — both backend commands and frontend components. A flag only works if every path checks it. Use `Grep` to find all references to the data the flag controls before considering the work done.

Directory-specific rules live next to the code they govern and load when you work there: frontend styling and reactivity in `src-solid/CLAUDE.md`, the `ProcessorSummary` metadata contract in `src-tauri/src/processors/CLAUDE.md`, processor version bumps in `marketplace/CLAUDE.md`.

## Commands

```bash
# Full app in dev mode (Solid UI: Vite on :1421 + Rust backend together)
npx tauri dev

# Frontend only (Solid)
npm run build          # TypeScript check + Vite bundle -> dist-solid/
npm run dev            # Vite dev server standalone
npm test               # Solid vitest suite

# Rust backend (run from project root, not src-tauri/)
cargo test --manifest-path src-tauri/Cargo.toml          # all tests
cargo test --manifest-path src-tauri/Cargo.toml <name>   # single test by name
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

**Platform note (MSYS2/Windows):** `cargo build` exits with code 1 on MSYS2 even on success — check for "Finished" in output.

**IMPORTANT — Do NOT prefix Bash commands with `cd`.** The working directory is already the project root. All commands work as-is without a `cd` prefix. Prepending `cd /d/Projects/LogTapper &&` breaks permission pattern matching and causes unnecessary user prompts. Never use `cd <path> &&` before any command — use absolute paths or flags like `--manifest-path` instead.

## Architecture

Tauri 2.x desktop app. All IPC goes through typed `invoke()` calls and Tauri events — the frontend has no direct filesystem or network access. See `design_docs/log-viewer-architecture.md` for the full design spec.

`src-solid/`, `src-shared/`, `src-tauri/src/` and its module directories each have a `CLAUDE.md`
(architecture, public API, gotchas) that loads when you work there — **read it before changing
code under that directory.**

## Security invariants

These hold from every directory. The mechanics and the rationale live next to the code:
`src-tauri/src/services/CLAUDE.md` (policy), `src-tauri/src/mcp_bridge/CLAUDE.md` (routes and
the error table), `src-tauri/src/processors/CLAUDE.md` (pre-filter, source types), and
`design_docs/MCP_SECURITY_DESIGN.md` (history, incl. "Issue 1").

- **Raw log text** (`AppState::sessions`, read only via `source.raw_line(n)` / `source.meta_at(n)`,
  never by direct indexing) leaves the backend only through `services/*`. Pipeline results
  never carry raw text. The frontend cache (`src-shared/cache/`) is never an external pathway.
- **Every service call carries a `services::Caller`** (`Ui` from a Tauri command, `Agent` from
  the bridge) and `services::policy` is the single place identity becomes a decision. Never
  branch on transport ("am I in `mcp_bridge/`").
- **Agents read anonymized text** unless the anonymizer mode is `None` or `agent_raw_access`
  is on; both are `Ui`-only persisted settings (`AnonymizerConfig::mode`, `agent_raw_access`)
  and nothing else may write them. No session state and no pipeline chain participates.
  `Ui` redaction is decided per pathway (`services::policy::should_anonymize_for`): in-app
  surfaces only under `All`, everything that leaves the tool (export, stream save, clipboard)
  under `All`/`External` — there are no per-surface checkboxes.
- **Agents cannot mutate their own gates**: the open-file allowlist, the anonymizer config,
  raw access, marketplace sources. Denied and nonexistent paths are indistinguishable so an
  agent cannot probe the filesystem.
- **Every bridge failure is a real HTTP status**, never `200 + {"error"}`; `mcp-server/` treats
  any non-2xx as `isError`.
- **Transformers skip the pre-filter but not `source_types` enforcement**; the built-in
  `__pii_anonymizer` declares no schema and is never skipped (pinned by a test).
