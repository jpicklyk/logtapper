# src/hooks/ — Stateful Frontend Logic

These hooks are the single source of truth for all app state. Components receive state and callbacks as props; they do not call bridge functions directly.

## Hook ownership in `App.tsx`

```
App.tsx
  useLogViewer()   →  file loading, virtual scroll cache, search, processor view mode
  usePipeline()    →  processor CRUD, run/stop, progress, results
  useClaude()      →  chat history, streaming, API key
```

The three hooks are independent. There is **no shared state** between them at the hook level. Coordination happens through props in `App.tsx` (e.g., passing `sessionId` from `viewer.session` to `pipeline.run()`).

## `useLogViewer` — critical cache key semantics

`lineCache: Map<number, ViewLine>` is the virtualizer's backing store. The key **must** equal the virtualizer's `virtualItem.index` (0-based sequential).

- **Full mode**: `get_lines` returns `ViewLine.lineNum` = sequential index (0, 1, 2…). Cache key = `line.lineNum`. Virtualizer index = `line.lineNum`. ✓ Match.
- **Processor mode**: `get_lines` returns `ViewLine.lineNum` = **actual file line number** (e.g., 42, 57). Cache key = `line.lineNum`. Virtualizer index = 0, 1, 2… ✗ Mismatch. Known bug — processor view shows nothing.

`handleFetchNeeded` is a stable `useCallback` with `[]` deps, so it captures `sessionRef` and `processorIdRef` via refs, not state. When switching modes, always update the ref AND the state:
```typescript
processorIdRef.current = id;  // ref — for stable callbacks
setProcessorId(id);           // state — for re-renders
```

`pendingFetches` deduplicates by `"${mode}:${offset}:${count}"` string key. It is cleared on mode switches (`setProcessorView`, `clearProcessorView`) to prevent stale requests from populating the new mode's cache.

## `usePipeline` — event subscription lifecycle

`usePipeline` subscribes to `pipeline-progress` in a `useEffect` on mount. The unlisten function is stored in `unlistenRef` and called on unmount. The subscription is set up once and never re-created, because the hook lives for the lifetime of the `App` component.

`pipeline.run()` depends on `activeProcessorIds` (in its `useCallback` deps). If `activeProcessorIds` changes after `run` was called but before the backend responds, the closure captures the old set. The backend receives the correct `ids` array regardless because it's computed at call time.

## `useClaude` — streaming index tracking

`streamingIndexRef` holds the index of the currently-streaming assistant message in the `messages` array. It is set to `-1` when not streaming.

The streaming flow:
1. `sendMessage()` appends `[userMsg, assistantMsg]` to `messages`, sets `streamingIndexRef.current = newLength - 1`.
2. `claude-stream` events (kind: "text") append tokens to `messages[streamingIndexRef.current].content`.
3. `claude-stream` (kind: "done") sets `streaming: false` on that message, resets index to -1.
4. On error: removes the placeholder assistant message, resets streaming state.

**API key storage**: `localStorage` key `logtapper_claude_api_key`. On mount, the key is read from localStorage and synced to the backend via `setClaudeApiKey()`. If the backend restarts (dev mode), the key is re-synced automatically because `useClaude` is remounted.

## `useChartData` — on-demand fetch

`useChartData` (used by `ProcessorDashboard`) fetches chart data only when the "Charts" tab is selected. It stores results keyed by `"${sessionId}:${processorId}"`. It does **not** invalidate on new pipeline runs — if the user re-runs, they must switch away from and back to the Charts tab to refresh.
