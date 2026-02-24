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
State that only one component subtree needs must stay local to that subtree — do not hoist to a global context. `useBookmarks`, `useAnalysis`, `useWatches`, `useFilter` are good examples of this. Only promote to context when multiple unrelated subtrees need the same state.

### 6. No cross-hook orchestration in render components
Hooks must not depend on each other's internal state through effects in `App.tsx`. Use a typed event bus or explicit orchestration layer so hooks react to events independently (e.g., `pipeline:run-complete` → tracker refreshes itself) rather than App.tsx watching one hook and calling another.

### 7. Stable callback references
Action callbacks (`onViewProcessor`, `onCloseSession`, `onOpenLibrary`) must be `useCallback` with stable deps and placed in a dedicated context that never changes. Consumers of these callbacks should never re-render due to unrelated state changes.

### 8. Barrel exports control public API — never import internal modules directly
Every module directory (`cache/`, `viewport/`, `hooks/`) must have an `index.ts` barrel that defines its public API. Components and hooks outside a module must import from the barrel only, never from internal files. The barrel exports narrow interfaces and hooks — not implementation classes. Internal files import from each other directly within the same module. Test files may import internals for white-box testing.

### Current violations (migration backlog)
The legacy `src/` codebase has a single `AppContext` bundling all state, no `React.memo` usage, unmemoized context value, and cross-hook effects in `App.tsx`. The `src-next/` rewrite follows all principles: 5 split contexts, selector hooks, event bus coordination, React.memo boundaries, and barrel exports. New code must target `src-next/`.

## Implementation Plans

All feature and performance implementation plans live in `plans/` at the project root. The directory is `.gitignore`d (local working docs only). Name files descriptively: `plans/<feature-name>-<tier-or-phase>.md` (e.g. `plans/perf-tier1-quick-wins.md`). When asked to plan a feature or create an implementation plan, write it there.

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

Tauri 2.x desktop app: React 18/TypeScript frontend + Rust backend. All IPC goes through typed `invoke()` calls and Tauri events — no direct filesystem or network access from the frontend. See `design_docs/log-viewer-architecture.md` for the full design spec.

### Backend layout

```
src-tauri/src/commands/         ← #[tauri::command] handlers; AppState defined in mod.rs
src-tauri/src/core/             ← LogSource trait, parsers, AnalysisSession, LineContext, filter, watch, bookmark, analysis
src-tauri/src/processors/       ← unified AnyProcessor registry; sub-modules per type
src-tauri/src/processors/reporter/     ← ReporterDef, engine (ProcessorRun), vars, Rhai interpreter
src-tauri/src/processors/transformer/  ← TransformerDef, engine, builtin PII transformer
src-tauri/src/processors/state_tracker/ ← StateTrackerDef, engine, types (StateSnapshot, transitions)
src-tauri/src/processors/correlator/   ← CorrelatorDef, engine (CorrelatorRun), CorrelationEvent
src-tauri/src/processors/annotator/    ← AnnotatorDef (schema stub — no engine)
src-tauri/src/processors/builtin/      ← embedded YAML files loaded at startup
src-tauri/src/scripting/        ← Rhai sandbox, scope builder, emit() bridge
src-tauri/src/anonymizer/       ← PII detection + token mapping (AnonymizerConfig, detectors)
src-tauri/src/charts/           ← chart data building from emissions/vars
src-tauri/src/claude/           ← Claude API client (SSE streaming), processor generator
src-tauri/src/mcp_bridge.rs     ← Axum HTTP server (127.0.0.1:40404) exposing sessions to MCP clients
```

### Frontend modules

Each module directory under `src-next/` has its own `CLAUDE.md` with architecture, public API, and gotchas. See those for module-specific details.

```
src-next/bridge/      ← invoke() wrappers, event listeners, shared types
src-next/context/     ← 5 split contexts + selector hooks
src-next/hooks/       ← domain hooks (useLogViewer, usePipeline, useStateTracker) + utility hooks
src-next/cache/       ← CacheManager (priority-based LRU) + ViewCacheHandle + CacheContext
src-next/viewport/    ← ReadOnlyViewer, DataSource, CacheDataSource, FetchScheduler
src-next/events/      ← typed event bus (mitt-based)
src-next/components/  ← application components (consume state via selector hooks)
src-next/layout/      ← structural shell (AppShell, CenterArea, ToolBar, etc.)
src-next/ui/          ← primitive UI components (Button, Modal, Tooltip, etc.)
```

### Core data model

**LogSource trait** (`core/log_source.rs`): polymorphic abstraction over log data. Two implementations:
- **FileLogSource** — memory-mapped file + byte-offset line index. Immutable after construction.
- **StreamLogSource** — append-only `Vec<String>` for ADB logcat. Evicts old lines to a `SpillFile` (temp disk file with byte-offset indexing) when over the retention cap (default 500k lines). `evicted_count` tracks offset so line numbers remain stable.

**AnalysisSession** (`core/session.rs`): holds `Option<Box<dyn LogSource>>` plus `Timeline`, `CrossSourceIndex`, `TagInterner`. Accessor helpers `file_source()` / `stream_source()` downcast to concrete types.

### AppState concurrency model (`commands/mod.rs`)

All shared state fields use `std::sync::Mutex` (not async, not DashMap/RwLock). One `Arc<AtomicBool>` for pipeline cancellation. `reqwest::Client` is unwrapped (already Send+Sync+Clone).

**Critical rules:**
- Never hold a lock across an `.await` point.
- Never hold `sessions` while acquiring `pipeline_results` — lock ordering is undefined and risks deadlock.
- Acquire, use, drop before any async call.

Explore `commands/mod.rs` for the full field list — it evolves frequently.

## Security model: data tiers and external exposure

LogTapper maintains two distinct data tiers. Understanding which tier is accessible externally is critical when working on features that touch the MCP bridge, export, or Claude integration.

### Tier 1 — Raw log store (`AppState::sessions`)

`AnalysisSession` holds raw log data via the `LogSource` trait. Accessed via `source.raw_line(i)` / `source.meta_at(i)`.

**What reads Tier 1:**
- `get_lines` Tauri command — serves `ViewLine[]` to the frontend viewer **only** (internal)
- `run_pipeline` / `flush_batch` — reads raw lines as pipeline input
- MCP bridge raw-line endpoints (`/query`, `/search`, `/search_with_context`, `/lines_around`)

### Tier 2 — Pipeline results (`AppState::pipeline_results`, `state_tracker_results`, `correlator_results`)

Produced by `run_pipeline` (file mode) or `flush_batch` (ADB streaming) after layered execution. Contains matched line counts, emissions, accumulated vars, state transitions, and correlation events. Does **not** store raw line text.

### Frontend display cache (never exposed externally)

Unified `CacheManager` (priority-based LRU, `src/cache/CacheManager.ts`). Budget is in **line count** (default 100,000 lines via `fileCacheBudget` setting). Priority tiers: focused 60%, visible 30%, background 10%. MCP bridge reads `AppState` directly — the frontend cache is **not** a pathway for external access.

### MCP bridge

Axum HTTP server bound to `127.0.0.1:40404` (`src-tauri/src/mcp_bridge.rs`). MCP tool definitions live in `mcp-server/`. Raw-line endpoints return unredacted data by default — PII anonymization is opt-in via the `mcp_anonymize` flag.

### Processor type system

`AnyProcessor { meta: ProcessorMeta, kind: ProcessorKind }` is the unified registry type in `AppState::processors`. The `type:` YAML field dispatches to the correct schema; omitting it defaults to `reporter`.

- **ReporterDef**: AND-ed filter → extract → Rhai script → aggregate → output
- **TransformerDef**: optional filter + transforms or `builtin: pii_anonymizer`
- **StateTrackerDef**: group, state fields, transitions (filter → set/clear), output
- **CorrelatorDef**: cross-source event correlation with time/line windows
- **AnnotatorDef**: schema stub — no engine yet

Built-in processors have IDs starting with `__` (e.g. `__pii_anonymizer`), loaded via `include_str!`, cannot be uninstalled.

### Layered pipeline execution

Both `run_pipeline` (file mode) and `flush_batch` (streaming) follow the same model:

```
Raw lines ─► Pre-filter (tag union, Aho-Corasick, RegexSet) ─► skip unneeded lines
    │
    ▼ Parse (only lines that pass pre-filter) → LineContext
    │
    ▼ Layer 1: Transformers (sequential per line)
    │   Modifies message/fields; may drop line (returns None)
    ▼ Layer 2a/2b/2c: rayon::scope — one task per processor, each iterates all lines
    │   2a: StateTrackers — records StateTransitions
    │   2b: Reporters — Filter / Extract / Script / Aggregate
    │   2c: Correlators — cross-source event matching
```

**Pre-filter:** `quick_extract_tag()` + Aho-Corasick/RegexSet check whether any Layer 2 processor could match. **Transformers are excluded from pre-filter** — they run in Layer 1 on all parsed lines but only narrow what reaches Layer 2. Including them would set `has_unfiltered=true` and disable the entire pre-filter.

**Parser dispatch:** `parser_for(&source_type)` selects the correct parser (Logcat, Kernel, Bugreport) based on the session's detected source type.

### ADB streaming architecture

`start_adb_stream` spawns a `tokio::task` that:
1. Runs `adb -s DEVICE logcat -v threadtime` as a child process
2. Buffers lines for 50ms or 100 lines, then calls `flush_batch()`
3. `flush_batch` applies the full layered execution model
4. Continuous state persists between batches via `new_seeded()` / `into_continuous_state()`
5. Emits `adb-batch`, `adb-processor-update`, `adb-tracker-update` events
6. Evaluates active watches against new lines
7. Exits on cancellation signal, EOF, or I/O error → emits `adb-stream-stopped`

**Always use `source.meta_at(n)` and `source.raw_line(n)` instead of direct indexing** — these adjust for eviction offset transparently.

### Frontend hook ownership, cache, and streaming patterns

See `src-next/hooks/CLAUDE.md` for the hook ownership table, domain hook patterns, and high-frequency streaming stabilization techniques. See `src-next/cache/CLAUDE.md` for CacheManager architecture, budget allocation, and common mistakes.

### Known bugs

1. **Processor view cache mismatch** (`useLogViewer.ts` + `commands/files.rs`): In Processor mode, `get_lines` returns `ViewLine.lineNum` = actual file line number. The virtualizer expects sequential 0-based indices. Result: processor view shows all `…` loading placeholders.

2. **KernelParser drops non-kernel lines** (`core/kernel_parser.rs`): `parse_meta()` returns `None` for lines without a kernel timestamp — silently excluded from the index.

## Gotchas

### Tauri / Rust

- `app.emit()` requires `use tauri::Emitter` — trait method, not inherent on `AppHandle`.
- Rust `regex` crate does **not** support look-ahead (`(?!...)`). `get_or_compile()` returns `Option<&Regex>` (None on invalid) — callers skip, resulting in 0 matches.
- Timestamps are **nanoseconds since 2000-01-01 UTC** (not Unix epoch). JS `number` loses precision beyond 2^53 — treat as opaque ordering values on the frontend.
- `LineContext` string fields (`raw`, `tag`, `message`, `source_id`) are `Arc<str>`, not `String`. Use `Arc::from(s)` to construct, `&*field` or `.as_ref()` for `&str` access, `.to_string()` for owned `String`.
- **Pre-filter and transformers:** `collect_tag_filters()` must exclude transformers. Including an unfiltered transformer disables the entire pre-filter.
- Clippy: `impl Default for Foo` where the body only calls field defaults → replace with `#[derive(Default)]`.

### Rhai scripting

- **`emit()` is NOT a registered function.** Use `_emits.push(#{ key: val })` instead. Calling `emit(...)` compiles but throws a runtime error → entire script aborted.
- Map key existence: use `key in map`, not `map.contains_key(key)` — `contains_key` is not registered.
- Nested map mutation: copy → modify → write back (`let m = vars.mymap; m[k] = v; vars.mymap = m`).
- Integer/float mixing throws: use `.to_float()` to convert. `() > 0` is a type error — guard with `if "field" in fields`.
- String concatenation with ints: use `some_int.to_string()`.

### Processor YAML

- Multiple filter rules are AND-ed. For OR logic, use `message_regex: "foo|bar"` or `message_contains_any: [...]`.
- `validate_for_install()` only validates Rhai syntax — invalid filter regexes pass install but silently produce 0 matches at runtime.
- State tracker engine fires **first matching transition only** per line (YAML order). Most-specific patterns must come first.

### React StrictMode + async event listeners (CRITICAL)

`main.tsx` wraps `<App>` in `<React.StrictMode>`, which **double-mounts** every `useEffect` in dev mode. This silently leaks Tauri event listeners when setup is async.

**The correct pattern (ALWAYS USE for async listener setup):**
```tsx
useEffect(() => {
  let cancelled = false;
  let unlisten: UnlistenFn | null = null;
  someAsyncListenerSetup((event) => {
    if (cancelled) return;
    handleEvent(event);
  }).then((fn) => {
    if (cancelled) fn();            // cleanup already ran → immediately unregister
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}, [deps]);
```

This applies to ALL Tauri async listener APIs: `listen()`, `once()`, `onDragDropEvent()`, etc.

**StrictMode also breaks `requestAnimationFrame` cleanup.** Double-mount means: effect → cleanup → effect. If the cleanup calls `cancelAnimationFrame`, the first rAF is cancelled before it fires. **Never return `cancelAnimationFrame` from a useEffect cleanup.** Either omit cleanup (let stale rAFs fire harmlessly with a ref guard) or avoid rAF entirely — prefer a `programmaticScrollRef` flag pattern for distinguishing programmatic from user-initiated scrolls (see LogViewer.tsx).
