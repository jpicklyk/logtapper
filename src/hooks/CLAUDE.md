# src/hooks/ — Stateful Frontend Logic

These hooks are the single source of truth for all app state. Components receive state and callbacks via `useAppContext()` — they do not call bridge functions directly.

## Hook architecture

All hooks are instantiated in `App.tsx` and shared via `AppContext`. The root CLAUDE.md documents the full hook ownership table. Key architectural patterns:

### Unified cache architecture (`useLogViewer`)

All frontend line caching is unified through the `CacheManager` (`src/cache/`). Each `PaneContent` allocates a `ViewCacheHandle` via `useViewCache(viewId, sessionId)` — the sessionId enables multi-consumer broadcasting. `useLogViewer` receives the `CacheManager` directly (not individual handles).

**Streaming mode**: `handleAdbBatch` calls `cacheManager.broadcastToSession(sessionId, lines)` — this writes the batch into ALL allocated handles for that session, so every pane (logviewer, dashboard, etc.) sees the same data. `setStreamFilter` scans `cacheManager.getSessionEntries(sessionId)` for initial filter matches; subsequent batches are filtered incrementally.

**File mode**: `LogViewer` manages its own internal `visibleLinesRef` state. It calls `fetchLines(offset, count)` (a wrapper around the bridge `getLines()`) when the virtualizer's visible range changes. Fetched lines are also stored in the `ViewCacheHandle` for cache fallback.

### Ref + state dual-update pattern

`fetchLines` is a stable `useCallback` that reads `sessionRef`, `processorIdRef`, and `searchRef` via refs. When switching modes, update the ref AND the state:
```typescript
processorIdRef.current = id;  // ref — for stable callbacks
setProcessorId(id);           // state — for re-renders
```

### Claude streaming index tracking (`useClaude`)

`streamingIndexRef` holds the index of the currently-streaming assistant message in the `messages` array. It is set to `-1` when not streaming.

The streaming flow:
1. `sendMessage()` appends `[userMsg, assistantMsg]` to `messages`, sets `streamingIndexRef.current = newLength - 1`.
2. `claude-stream` events (kind: "text") append tokens to `messages[streamingIndexRef.current].content`.
3. `claude-stream` (kind: "done") sets `streaming: false` on that message, resets index to -1.
4. On error: removes the placeholder assistant message, resets streaming state.

**API key storage**: `localStorage` key `logtapper_claude_api_key`. On mount, the key is read from localStorage and synced to the backend via `setClaudeApiKey()`. If the backend restarts (dev mode), the key is re-synced automatically because `useClaude` is remounted.

### Chart data fetching (`useChartData`)

`useChartData` (used by `ProcessorDashboard`) fetches chart data only when the "Charts" tab is selected. It stores results keyed by `"${sessionId}:${processorId}"`. It does **not** invalidate on new pipeline runs — if the user re-runs, they must switch away from and back to the Charts tab to refresh.
