# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Frontend Isolation Principles (MANDATORY)

These rules govern ALL frontend work. Every new component, hook, or context change must follow them. Violating these principles is how "fixing one thing breaks another."

### 1. Split context by change frequency — never use a single monolithic context
Group context values by how often they change. High-frequency state (streaming batches at ~50ms) must not share a context with low-frequency state (session metadata, stable callbacks). A change in one context must not re-render consumers of another.

### 2. Memoize all context values
Every context provider value must be wrapped in `useMemo` with correct dependencies. A bare object literal `{ foo, bar }` in a provider creates a new reference on every render, defeating React's bailout.

### 3. Use `React.memo` on component boundaries
Any component that receives props from a context-consuming parent must be wrapped in `React.memo`. This prevents parent re-renders from cascading into children whose props haven't changed. Especially critical for leaf components like `LogViewer`, `ProcessorDashboard`, `SearchBar`.

### 4. Selector hooks over raw context access
Components must not call a broad context hook and destructure. Instead, provide small focused hooks (`useSelectedLine()`, `useIsStreaming()`) that read from the appropriate narrow context. This makes dependencies explicit and greppable.

### 5. Colocate state with consumers
State that only one component subtree needs must stay local to that subtree — do not hoist to a global context. `useBookmarks`, `useAnalysis`, and `useWatchList` are good examples of this. Only promote to context when multiple unrelated subtrees need the same state.

### 6. No cross-hook orchestration in render components
Hooks must not depend on each other's internal state through effects in `App.tsx`. Use a typed event bus or explicit orchestration layer so hooks react to events independently (e.g., `pipeline:completed` → tracker refreshes itself) rather than App.tsx watching one hook and calling another. The event catalog is `src-next/events/events.ts`.

**Bus events must be targeted, not broadcast.** When a bus event is intended for a specific consumer (e.g., a particular pane or session), the event payload must carry an identifier (`paneId`, `sessionId`) and the consumer must match on it. Never broadcast to all subscribers and rely on each checking a ref or prop to decide whether to act — that pattern is fragile under concurrent rendering and rapid state changes (the ref can be stale by the time the event fires).

### 7. Stable callback references
Action callbacks (`closeSession`, `runPipeline`, `openFileDialog`, …) must be `useCallback` with stable deps and placed in a dedicated context that never changes. Consumers of these callbacks should never re-render due to unrelated state changes. Actions are named for the verb they perform — no `on` prefix; that prefix is reserved for component props.

### 8. State mutations flow through the action surface for their scope
Mutations are organized into layered action surfaces. Components call the appropriate layer — never bypass it to mutate state directly via domain hooks or dispatch.

| Layer | Scope | Action surface | Dirty tracking |
|---|---|---|---|
| **Workspace** | What the workspace contains (sessions, pipeline chain, processors) | `ActionsContext` — `WorkspaceMutationActions` | Automatic via `trackMutations()` |
| **Session** | Artifacts within one session (bookmarks, analyses, watches) | `SessionActionsContext` per pane (`useSessionBookmarkActions`, `useSessionAnalysisActions`, `useSessionWatchActions`) | `bus.emit('workspace:mutated')` centralized in provider |
| **View** | Transient UI state (search, scroll, focus, filter) | `ActionsContext` — `ViewActions` | Not tracked |

`src-next/context/CLAUDE.md` has the wiring: how `MUTATION_ACTION_KEYS` / `trackMutations()` / `HookWiring` enforce workspace dirty tracking, and how to add a mutation at either layer.

### 9. Barrel exports control public API — never import internal modules directly
Every module directory (`cache/`, `viewport/`, `hooks/`) must have an `index.ts` barrel that defines its public API. Components and hooks outside a module must import from the barrel only, never from internal files. The barrel exports narrow interfaces and hooks — not implementation classes. Internal files import from each other directly within the same module. Test files may import internals for white-box testing.

All frontend code lives in `src-next/`. The legacy `src/` directory has been removed.

## Implementation Plans

All feature and performance implementation plans live in `plans/` at the project root. The directory is `.gitignore`d (local working docs only). Name files descriptively: `plans/<feature-name>-<tier-or-phase>.md` (e.g. `plans/perf-tier1-quick-wins.md`). When asked to plan a feature or create an implementation plan, write it there.

## Agent Discipline Rules

These rules address recurring mistakes. Follow them before writing code, not as an afterthought.

### Search before creating
Before writing any new function, helper, or utility, search the codebase for existing implementations that do the same thing. Check adjacent files, shared modules, and utility directories. Duplication is caught in every review — prevent it by searching first. If you find a near-match, extend or reuse it rather than creating a parallel version.

### Static styling goes in CSS modules; dynamic values go through CSS custom properties
Never put a *static* visual property in `style={{ ... }}` — it bypasses theming, isn't greppable, and drifts from the rest of the design. If a suitable class doesn't exist, create one in the component's `.module.css`.

For values only known at runtime (a severity color, a progress width, a timeline tick position), do **not** set the CSS property directly. Set a custom property and let the module consume it:

```tsx
// Preferred — the class owns the styling, the component supplies one value
<div className={styles.packHeader} style={{ '--pack-accent': accentColor } as React.CSSProperties}>
```
```css
.packHeader { border-left: 3px solid var(--pack-accent); }
```

This keeps every visual decision in the stylesheet and narrows the component's contribution to data. Direct dynamic properties (`style={{ width: pct }}`) still exist in older components — prefer the custom-property form in new code and when touching those files.

### Side effects belong in useEffect, never in the render body
Do not call `bus.emit()`, `fetch()`, `invoke()`, or any side-effectful function during render — even if wrapped in `queueMicrotask` or `setTimeout`. React may re-invoke render functions (StrictMode, Suspense, concurrent features). Derive values during render; perform effects in `useEffect`.

### No reading external mutable state in useMemo/render
Module-level caches, Maps, and global singletons are invisible to React's reactivity system. Reading them inside `useMemo` or render produces stale results — the memo won't re-run when the external data changes. Use the event bus, context, or state to bridge external data into React's render cycle.

### Trace flags through all consumers
When adding a boolean flag or mode that controls behavior (e.g., `timeline: false`), search for ALL code paths that consume the underlying data — both backend commands and frontend components. A flag only works if every path checks it. Use `Grep` to find all references to the data the flag controls before considering the work done.

### Metadata the UI needs before pipeline run goes on ProcessorSummary
If the UI needs processor metadata (sections, mode, source types, timeline flag) without requiring a pipeline run first, put it on `ProcessorSummary` — not on result types like `StateSnapshot` or `StateTrackerResult` which are only populated after execution.

### Marketplace processor changes require version bumps
Any change to a processor YAML — including metadata-only changes like `source_types` — requires bumping the `version` in both the YAML file AND the matching entry in `marketplace/marketplace.json`. The update checker compares against the index, not the YAML files.

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

**Platform note (MSYS2/Windows):** `cargo build` exits with code 1 on MSYS2 even on success — check for "Finished" in output.

**IMPORTANT — Do NOT prefix Bash commands with `cd`.** The working directory is already the project root. All commands work as-is without a `cd` prefix. Prepending `cd /d/Projects/LogTapper &&` breaks permission pattern matching and causes unnecessary user prompts. Never use `cd <path> &&` before any command — use absolute paths or flags like `--manifest-path` instead.

## Architecture

Tauri 2.x desktop app. All IPC goes through typed `invoke()` calls and Tauri events — the frontend has no direct filesystem or network access. See `design_docs/log-viewer-architecture.md` for the full design spec.

`src-next/`, `src-tauri/src/`, and every module directory under them have their own `CLAUDE.md` covering architecture, public API, and gotchas. These load on demand when you work under that directory — **read the relevant one before changing code there.** Backend-wide Rust gotchas are in `src-tauri/src/CLAUDE.md`; frontend-wide React StrictMode rules are in `src-next/CLAUDE.md`.

## Security model: data tiers and external exposure

LogTapper maintains two distinct data tiers. Understanding which tier is accessible externally is critical when working on features that touch the MCP bridge, export, or Claude integration.

### Tier 1 — Raw log store (`AppState::sessions`)

`AnalysisSession` holds raw log data via the `LogSource` trait. Accessed via `source.raw_line(i)` / `source.meta_at(i)`.

**What reads Tier 1:** both transports go through the same `services/` functions now (see
`src-tauri/src/services/CLAUDE.md`) — there is no separate bridge-only implementation to
drift out of sync with the desktop path.
- `services::lines` / `services::search` — serve `ViewLine`/line-text results to **both**
  the frontend viewer (`get_lines` Tauri command) and MCP agents (`query`, `lines_around`,
  `search`, `search_with_context` under `/mcp/sessions/{session_id}/`)
- `services::pipeline::run` / ADB `services::stream` — read raw lines as pipeline input
- `services::insights`, `services::sections`, `services::filters`, `services::export`,
  `services::stream` — every other place raw line text can leave the backend

### Tier 2 — Pipeline results (`AppState::pipeline_results`, `state_tracker_results`, `correlator_results`)

Produced by `run_pipeline` (file mode) or `flush_batch` (ADB streaming) after layered execution. Contains matched line counts, emissions, accumulated vars, state transitions, and correlation events. Does **not** store raw line text.

### Frontend display cache (never exposed externally)

The unified `CacheManager` (`src-next/cache/`) is **not** a pathway for external access — the MCP bridge reads `AppState` directly and never sees it.

### MCP bridge — caller-based gates, not transport-based

Axum HTTP server bound to `127.0.0.1:40404` (`src-tauri/src/mcp_bridge/`, see its own
`CLAUDE.md`). MCP tool definitions live in `mcp-server/`. Every service call carries a
`services::Caller` (`Ui` from a Tauri command adapter, `Agent { client }` from the bridge)
and `services::policy` is the single place that identity becomes a decision — never an
individual service, never "am I in `mcp_bridge/`":

- **Open/read a path** (`policy::authorize_open`) — `Ui` passes through (the native file
  dialog is the consent step); `Agent` is checked against the configured allowlist. Denied
  and nonexistent are deliberately indistinguishable, so an agent cannot probe the
  filesystem by comparing error messages.
- **Write a new destination** (`policy::authorize_write_dest`) — the same allowlist gate
  for a path that doesn't exist yet (workspace save, export, ADB stream save-to-file): an
  agent's destination must have its **parent directory** inside the allowlist; the file
  name must be a single plain segment. `Ui` passes through untouched (the native save
  dialog is consent).
- **PII anonymization** (`policy::should_anonymize` / `policy::redact_line`) is keyed on
  `Caller`, not on which transport served the request: `Ui` is never redacted (the human
  is looking at their own machine), an **`Agent` is always redacted** unless the user
  ticked "Allow agents to read raw (un-anonymized) log text" in Settings → General → MCP
  Integration. That one setting (`AppState::agent_raw_access`, persisted to
  `{app_data_dir}/mcp_agent_access.json`, `Ui`-only via `set_agent_raw_access`) is the
  whole decision — **no session state, and above all no pipeline chain, participates in
  it.** It replaced a per-session `mcp_anonymize` map the frontend mirrored from
  `chain.includes('__pii_anonymizer')`, which meant the default chain switched agent
  anonymization *off* as soon as the UI opened a tab. Never add a second writer; see
  "Issue 1" in `design_docs/MCP_SECURITY_DESIGN.md`.
- **Agents cannot mutate their own gates.** `policy::deny_agent_gate_mutation` refuses an
  agent request to change the open-file allowlist, the anonymizer config, agent raw log
  access, or add/remove a marketplace source (a supply-chain surface) — `Forbidden`/`NOT_ALLOWED` for `Agent`,
  passthrough for `Ui`. There is no bridge route at all for the marketplace-source
  mutations; every other gated mutation has a route that always answers 403 for an agent
  caller.
- **Every bridge failure is a real HTTP status**, not `200 + {"error": ...}`: 404
  `NOT_FOUND`, 400 `INVALID_ARGUMENT`/`INVALID_PATH`/…, 403 `NOT_ALLOWED`, 409 `CONFLICT`,
  499 `CANCELLED`, 500 `LOCK_POISONED`/`INTERNAL` — see `mcp_bridge/CLAUDE.md`'s error
  table. A client that doesn't check the status code will misread a gate refusal as
  success, so `mcp-server/` must treat any non-2xx as `isError: true`.

### Transformers and the pre-filter exemption

Transformers are excluded from the pipeline pre-filter — they run in Layer 1 on all parsed lines but only narrow what reaches Layer 2. Including an unfiltered one would set `has_tag_unfiltered` / `has_content_unfiltered` in `collect_prefilter_info()` and disable the corresponding pre-filter stage entirely. (`src-tauri/src/processors/CLAUDE.md` has the full execution model.)

That exemption is narrow and must not be read as a general one. **Transformers ARE subject to declared `source_types` enforcement**, in both `run_pipeline` and `flush_batch` — a transformer rewrites or drops lines before any Layer 2 processor sees them, so running one against a source it does not understand corrupts every downstream processor's input rather than merely wasting work. The built-in `__pii_anonymizer` declares no schema, so it is never excluded; that is deliberate and pinned by a test, because a skipped anonymizer means unredacted PII reaching exports and the MCP bridge.

**Always use `source.meta_at(n)` and `source.raw_line(n)` instead of direct indexing** — these adjust for eviction offset transparently.
