---
name: state-patterns
description: React/TypeScript frontend only (src-next/). Decide whether to use a reducer, raw useState, or the mitt event bus when adding React state, wiring a frontend event, or refactoring a context provider.
user-invocable: false
---

# State Patterns for LogTapper (`src-next/`)

This skill governs every state and coordination decision in `src-next/`. Read it before
touching any file in `context/`, `hooks/`, or `events/`.

---

## Quick decision tree

```
Does the change involve React state stored in a context?
├── YES → Does updating it require changing 2+ fields atomically?
│         ├── YES → Use a REDUCER in that context provider
│         └── NO  → Raw useState + useCallback setter is fine
└── NO → Does a hook need to react to something another hook did,
         without sharing context?
          ├── YES → Use the EVENT BUS
          └── NO  → Local state or a direct prop/callback
```

---

## Rule 1 — Use a reducer when state transitions must be atomic

A reducer is warranted when a single logical action changes multiple fields and
leaving them in an intermediate state would be observable or incorrect.

**Reducer candidates (current contexts):**

| Context | Why |
|---|---|
| `SessionContext` | `unregisterSession` must atomically remove from `sessions`, `paneSessionMap`, `indexingProgressBySession`, `streamingSessionIds`, `errorByPane`. Currently 4 nested `setState` calls — a reducer makes this one dispatch. |
| `PipelineContext` | Run lifecycle must be atomic: `run:started` clears error + sets running; `run:complete` sets results, increments runCount, clears progress + running. Raw setters allow callers to leave inconsistent state (e.g. `running=false` but `progress` non-null). |

**NOT reducer candidates (keep raw useState):**

| Context | Why |
|---|---|
| `ViewerContext` | Fields (`search`, `scrollToLine`, `processorId`, etc.) are independent — no action changes two at once. Named transitions add overhead without benefit. |
| `TrackerContext` | Hot path (~50ms batches during streaming). Reducer function call overhead is measurable. Fields are also independent. |
| `ActionsContext` | Stable callbacks, not state. Not applicable. |

**Reducer action naming convention:**
```ts
// domain:verb — matches the event bus naming pattern
type SessionAction =
  | { type: 'session:registered';   paneId: string; result: LoadResult }
  | { type: 'session:unregistered'; paneId: string }
  | { type: 'indexing:progress';    sessionId: string; progress: IndexingProgress | null }
  | { type: 'streaming:changed';    sessionId: string; streaming: boolean }
  | { type: 'pane:loading';         paneId: string; loading: boolean }
  | { type: 'pane:error';           paneId: string; error: string | null }
  | { type: 'pane:focused';         paneId: string | null };

type PipelineAction =
  | { type: 'run:started' }
  | { type: 'run:progress';    current: number; total: number }
  | { type: 'run:complete';    results: unknown[]; runCount: number }
  | { type: 'run:failed';      error: string }
  | { type: 'run:cleared' }
  | { type: 'processors:loaded'; processors: ProcessorSummary[] }
  | { type: 'chain:changed';     chain: string[] }
  | { type: 'active:changed';    ids: string[] };
```

**What the context provider exposes after a reducer migration:**
- State fields (read-only) — same as before
- A single `dispatch` that is **not** exported publicly
- Named action-creator hooks or explicit setter hooks that call `dispatch` internally
- The public API (selector hooks) is **unchanged** — components never see `dispatch`

---

## Rule 2 — Use the event bus for cross-hook coordination

The event bus (`src-next/events/bus.ts`) exists specifically to replace
App.tsx effects that watch one hook and call another (principle #6 in CLAUDE.md).

**Use the bus when:**
- A hook needs to react to a lifecycle event produced by a different hook that
  it does not share context with
- An action needs to reach multiple independent subscribers
- The coordination is one-directional and fire-and-forget (no return value needed)

**Current bus usage (canonical examples):**

| Event | Producer | Consumer | Why bus, not context |
|---|---|---|---|
| `pipeline:completed` | `usePipeline` | `useStateTracker` | Trackers refresh independently after a run; they don't share pipeline context |
| `session:focused` | `ActionsContext` (setFocusedPane) | `SessionContext` | Decouples layout intent from session state mutation |
| `navigate:jump` | UI components | `useLogViewer` | Components don't hold a ref to the viewer; bus lets them emit without coupling |
| `layout:open-tab` | `ActionsContext` | `useWorkspaceLayout` | Layout hook is independent; no shared context |
| `session:pre-load` | `useLogViewer` | `usePipeline` | Pipeline clears results before a new file loads without being called directly |

**Do NOT use the bus when:**
- The state change belongs to a single context and has a single consumer — use a
  reducer action or setter instead
- You need a return value or acknowledgment — the bus is fire-and-forget
- The consumer and producer already share context — just call the setter/dispatch
- You are tempted to emit a bus event *and* update context state for the same
  logical action — pick one; usually the context setter is right and the bus event
  is redundant

**Adding a new event — checklist:**
1. Add name + payload type to `AppEvents` in `src-next/events/events.ts`
2. Follow the `domain:verb` naming convention (e.g. `pipeline:completed`, not `PIPELINE_DONE`)
3. Emit in the producing hook via `bus.emit('event:name', payload)`
4. Subscribe in the consuming hook with the async-safe useEffect pattern (see CLAUDE.md)
5. Document producer and consumer in the event catalog table in `src-next/events/CLAUDE.md`

---

## Rule 3 — Never expose raw dispatch or React.Dispatch publicly

Context files that use `useReducer` must keep `dispatch` internal. Domain hooks
that need to write state call named action creators, not `dispatch` directly.
Components only ever call selector hooks and `ActionsContext` callbacks.

```
Component
  └─► useMySelector()          ← reads state (selector hook)
  └─► useViewerActions().foo() ← triggers action (ActionsContext)
        └─► domain hook (usePipeline, useLogViewer, ...)
              └─► dispatch({ type: 'run:started' })  ← internal only
              └─► bus.emit('pipeline:completed', ...) ← cross-hook coordination
```

---

## Rule 4 — Setter exposure pattern (for contexts not yet migrated)

Until `SessionContext` and `PipelineContext` are migrated to reducers, the
existing raw-setter pattern is tolerated. But:

- Never call multiple setters in sequence from a component — that belongs in a
  domain hook or an action-creator function inside the context
- If you find yourself calling 2+ setters for one logical action, that is a
  signal the context needs a reducer

---

## File locations

| File | Role |
|---|---|
| `src-next/context/SessionContext.tsx` | Session registry state — reducer candidate |
| `src-next/context/PipelineContext.tsx` | Pipeline run state — reducer candidate |
| `src-next/context/ViewerContext.tsx` | Viewer navigation state — keep raw useState |
| `src-next/context/TrackerContext.tsx` | Hot-path tracker state — keep raw useState |
| `src-next/context/ActionsContext.tsx` | Stable callbacks — not state |
| `src-next/context/selectors.ts` | All public selector hooks — add new ones here |
| `src-next/context/index.tsx` | Barrel + AppProviders + HookWiring |
| `src-next/events/events.ts` | AppEvents type map — add new events here |
| `src-next/events/bus.ts` | Singleton mitt instance |
