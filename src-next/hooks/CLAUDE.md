# src-next/hooks/ — Domain and Utility Hooks

## Wiring hooks vs. action hooks (singleton invariant)

A domain hook that owns effects — bus subscriptions, Tauri listeners, timers —
is a **wiring hook**. Wiring hooks are mounted exactly once, in
`context/HookWiring`, and are named `use<Domain>Wiring`. Mounting one in a
component multiplies every listener and every timer it contains by the number of
mounted components; for non-idempotent dispatches (`adb:run-count-bump`) and for
IPC pushes (`setSessionPipelineMeta`) that is a correctness bug, not just noise.

When components need the same domain's callbacks, split the domain instead of
mounting the wiring hook twice:

| Half | Name | Effects | Mount sites |
|---|---|---|---|
| Wiring | `usePipelineWiring` | all of them | `context/HookWiring` only |
| Actions | `usePipelineCommands` | **none** | any component |

The wiring hook composes the action hook and re-exports its surface, so
`HookWiring` still mounts a single hook. Any state the two halves must agree on
(e.g. "has the chain been initialized?") belongs in the reducer, not a hook-local
`useRef` — a ref is per-instance, so the instance that sets it is not necessarily
the instance that reads it.

## Domain hook pattern

Domain hooks read/write to their respective context via raw context hooks (imported directly from context files, not the barrel). They use refs for callback stability:

```typescript
const sessionRef = useRef<LoadResult | null>(null);
sessionRef.current = session; // sync on render
const fetchLines = useCallback(() => {
  const sess = sessionRef.current; // read via ref — no dependency
}, []); // stable callback
```

## High-frequency streaming patterns

Components that update on every ADB batch (~50ms) require explicit stabilization:

- **`useRef` for imperative guards** — timestamps, scroll positions, "has-fetched" flags belong in refs, not state
- **Functional setState with referential bail-out** — return `prev` reference when data is unchanged to skip re-renders
- **`hasDataRef` for skeleton suppression** — show skeletons only on first fetch; subsequent fetches are silent
- **Programmatic scroll flag** — `programmaticScrollRef` is set `true` before `el.scrollTop = el.scrollHeight`. `onScroll` checks and clears it to distinguish programmatic from user scrolls. Do NOT use `requestAnimationFrame` — WebView2 does not guarantee scroll events fire before rAF callbacks

## Event bus integration

Hooks coordinate via the typed event bus (`events/bus`), not via effects watching each other's state. See `events/CLAUDE.md` for the event catalog.
