# src-next/cache/ — Single-Store Caching Architecture

## The One Rule

**ViewCacheHandle is the only place ViewLine objects are stored.** No component, hook, or data source may keep its own Map, array, ref, or any other collection of ViewLine objects. Every line lookup goes through `ViewCacheHandle.get()`, which is bounded by the global `CacheManager` budget with LRU eviction.

If you are writing code that stores a ViewLine in a local variable, that's fine (stack/temporary). If you are writing code that stores ViewLine objects in a `Map`, `Set`, `Array`, `useRef`, or any persistent structure — **stop**. You are creating an unbounded shadow cache that defeats the memory budget.

## Why This Matters

A ViewLine is ~500-1000 bytes (raw text, tag, message, sourceId — all strings). A 2M-line log file at 500 bytes/line = 1 GB of ViewLine objects. The CacheManager budget (default 100K lines) caps memory at ~50-100 MB. Any unbounded collection that retains ViewLine references outside ViewCacheHandle bypasses this cap and will eventually exhaust memory during long streaming sessions.

## Architecture

```
CacheManager (singleton, 100K line budget)
  │
  ├─ ViewCacheHandle "pane-A-session1" (60% budget = 60K lines, LRU eviction)
  ├─ ViewCacheHandle "pane-B-session1" (30% budget = 30K lines, LRU eviction)
  └─ ViewCacheHandle "pane-C-session1" (10% budget = 10K lines, LRU eviction)

CacheDataSource (per-viewer, stateless facade over ViewCacheHandle)
  │
  ├─ getLine(n)  →  viewCache.get(n)          // single lookup, no local storage
  ├─ getLines()  →  viewCache.get() per line   // check cache; on miss, fetch → viewCache.put()
  └─ pushStreamingLines()  →  fire onAppend listeners only (NO local storage)
```

## Data Flow

### File mode (fetch-on-demand)

```
User scrolls → ReadOnlyViewer reports visible range to FetchScheduler
  → FetchScheduler fires (viewport + prefetch ranges)
    → CacheDataSource.getLines() checks ViewCacheHandle for misses
      → On miss: fetch from Rust backend via IPC → viewCache.put(lines)
        → ReadOnlyViewer bumps cacheVersion state → re-render
          → dataSource.getLine(n) → viewCache.get(n) → render TextLine
```

The FetchScheduler lives in ReadOnlyViewer (not CacheDataSource). It handles velocity-aware debouncing and two-phase fetch (viewport first, then directional prefetch). CacheDataSource is a pure lookup/fetch facade.

### Streaming mode (push from ADB events)

```
adb-batch Tauri event → useLogViewer handler:
  1. cacheManager.broadcastToSession(sessionId, lines)
       → viewCache.put(lines) on ALL ViewCacheHandles for this session
  2. registry.pushToSession(sessionId, lines, totalLines)
       → CacheDataSource.pushStreamingLines() on ALL registered sources
         → fires onAppend listeners (updates totalLines counter, NOT line storage)
           → ReadOnlyViewer bumps cacheVersion + streamTotal → re-render
             → dataSource.getLine(n) → viewCache.get(n) → render TextLine
```

Key: `broadcastToSession` stores lines in ViewCacheHandle. `pushStreamingLines` only notifies — it does NOT store lines itself. The separation exists because storage (bounded LRU in ViewCacheHandle) and notification (unbounded event fan-out to listeners) are different concerns.

## Components and Their Roles

| Component | Role | Stores ViewLine? |
|---|---|---|
| `CacheManager` | Budget distribution, view lifecycle, session broadcast | NO (delegates to ViewCacheHandle) |
| `ViewCacheHandle` | Bounded LRU Map keyed by line number | **YES — the only store** |
| `CacheDataSource` | Stateless facade: lookup, fetch-on-miss, streaming notification | NO |
| `DataSourceRegistry` | Routes streaming push to all CacheDataSources for a session | NO |
| `FetchScheduler` | Velocity-aware debounce, computes viewport + prefetch ranges | NO |
| `ReadOnlyViewer` | Virtualizer, calls `dataSource.getLine()` per visible row | NO |
| `LogViewer` | Creates CacheDataSource, wires focus management | NO |
| `useLogViewer` | Handles ADB events, calls broadcastToSession + pushToSession | NO |

## Budget Allocation

`CacheManager` distributes the total budget (default 100K lines) across views by priority:

| Priority | Share | When |
|---|---|---|
| `focused` | 60% | The active/visible pane (set via `useCacheFocus`) |
| `visible` | 30% (shared) | Other open panes |
| `background` | 10% (shared) | Minimized/hidden panes |

Single-view optimization: if only one view exists, it gets 100% of the budget.

Minimum floor: every view is guaranteed at least 2,000 lines regardless of budget math.

## Common Mistakes to Avoid

1. **Building a Map/Array of ViewLine during filter scans.** Filter results should be stored as `number[]` (line numbers only), not `Map<number, ViewLine>`. When the filter view needs to render a line, it calls `dataSource.getLine(lineNum)` which hits ViewCacheHandle.

2. **Storing fetched lines in a local ref "for fast re-render".** The ViewCacheHandle IS the fast lookup. `viewCache.get(n)` is a Map lookup — O(1). Adding another Map in front of it doubles memory without improving speed.

3. **Caching lines in ReadOnlyViewer's render loop.** The virtualizer calls `dataSource.getLine(n)` for each visible row on every render. This is intentional — it reads from the bounded ViewCacheHandle. Do not intercept and buffer these results.

4. **Storing streaming lines in CacheDataSource.** `pushStreamingLines()` must ONLY fire onAppend listeners and update the total lines counter. Lines are already stored in ViewCacheHandle via `broadcastToSession()` which runs before `pushToSession()`.

5. **Creating a "visible lines" Map in ReadOnlyViewer.** Previous versions had a `visibleLinesRef` that accumulated lines without eviction. This was removed. The cacheVersion counter + `dataSource.getLine()` pattern replaces it.

## Adding New Views or Data Paths

When adding a new component that displays log lines:

1. Use `useViewCache(viewId, sessionId)` to get a ViewCacheHandle from CacheManager
2. Create a `CacheDataSource` via `createCacheDataSource({ sessionId, viewCache, fetchLines, registry })`
3. Pass the CacheDataSource to `ReadOnlyViewer` (or use `dataSource.getLine()` directly)
4. Call `useCacheFocus(viewId)` if this view should get priority budget when active
5. **Do not** create any intermediate storage for ViewLine objects
