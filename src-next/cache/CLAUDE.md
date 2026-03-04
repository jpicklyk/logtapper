# src-next/cache/ — Single-Store Caching Architecture

## The One Rule

**ViewCacheHandle is the only place ViewLine objects are stored.** No component, hook, or data source may keep its own Map, array, ref, or any other collection of ViewLine objects. Every line lookup goes through `ViewCacheHandle.get()`, which is bounded by the global `CacheManager` budget with LRU eviction.

If you are writing code that stores a ViewLine in a local variable, that's fine (stack/temporary). If you are writing code that stores ViewLine objects in a `Map`, `Set`, `Array`, `useRef`, or any persistent structure — **stop**. You are creating an unbounded shadow cache that defeats the memory budget.

## Public/Private API Split

The barrel (`cache/index.ts`) exports **narrow interfaces and hooks only** — not implementation classes. External code must import from the barrel; internal files import from each other directly.

### Three interface tiers

```
ViewCache (read-only)          — components that display cached lines
  └─ WritableViewCache         — CacheDataSource (stores fetched lines via put())
       └─ ViewCacheHandle      — CacheManager internals only (clear, setAllocation, entries)

CacheController (narrow)       — hooks that manage streaming (broadcast, clear, scan)
  └─ CacheManager              — CacheContext internals only (allocateView, releaseView, setFocus, etc.)
```

| Interface | Methods | Used by |
|---|---|---|
| `ViewCache` | `size`, `allocation`, `get()`, `has()`, `prefetchAllowed()` | Components displaying cached lines |
| `WritableViewCache` | extends ViewCache + `put()` | `CacheDataSource`, `useViewCache()` return type |
| `CacheController` | `broadcastToSession()`, `clearSession()`, `getSessionEntries()` | `useLogViewer`, `useCacheManager()` return type |

### What's NOT exported

`CacheManager` class, `ViewCacheHandle` class — these are internal to the cache module. `CacheContext.tsx` creates and manages them; external code only sees the narrow interfaces.

## Why This Matters

A ViewLine is ~500-1000 bytes (raw text, tag, message, sourceId — all strings). A 2M-line log file at 500 bytes/line = 1 GB of ViewLine objects. The CacheManager budget (default 100K lines) caps memory at ~50-100 MB. Any unbounded collection that retains ViewLine references outside ViewCacheHandle bypasses this cap and will eventually exhaust memory during long streaming sessions.

## Architecture

```
CacheManager (singleton, configurable line budget)
  │
  ├─ ViewCacheHandle "pane-A-session1" (focused priority share, LRU eviction)
  ├─ ViewCacheHandle "pane-B-session1" (visible priority share, LRU eviction)
  └─ ViewCacheHandle "pane-C-session1" (background priority share, LRU eviction)

CacheDataSource (per-viewer, stateless facade over ViewCacheHandle)
  │
  ├─ getLine(n)  →  viewCache.get(n)          // single lookup, no local storage
  ├─ getLines()  →  viewCache.get() per line   // check cache; on miss, fetch → viewCache.put()
  └─ pushStreamingLines()  →  fire onAppend listeners only (NO local storage)
```

## Data Flow

**File mode (fetch-on-demand):** User scrolls → FetchScheduler (inside ReadOnlyViewer) fires viewport + prefetch ranges → CacheDataSource fetches misses from backend → `viewCache.put()` → viewer re-renders via `cacheVersion` bump → `dataSource.getLine(n)` reads from ViewCacheHandle. FetchScheduler handles velocity-aware debouncing and two-phase fetch (viewport first, then directional prefetch). CacheDataSource is a pure lookup/fetch facade.

**Streaming mode (push from ADB events):** `adb-batch` event → `cacheManager.broadcastToSession()` stores lines in ALL ViewCacheHandles for that session → `registry.pushToSession()` fires `onAppend` listeners (updates totalLines counter only, does NOT store lines) → viewer re-renders and reads from ViewCacheHandle.

Key separation: `broadcastToSession` handles bounded storage (LRU); `pushStreamingLines` handles unbounded notification fan-out. These are different concerns and must stay separate.

## Budget Allocation

`CacheManager` distributes the total budget across views by priority: focused > visible > background. Single-view: 100% of budget. Every view is guaranteed a minimum floor regardless of budget math. `CacheProvider` accepts a `budget` prop that is reactive.

## Common Mistakes to Avoid

1. **Building a Map/Array of ViewLine during filter scans.** Filter results should be stored as `number[]` (line numbers only), not `Map<number, ViewLine>`. When the filter view needs to render a line, it calls `dataSource.getLine(lineNum)` which hits ViewCacheHandle.

2. **Storing fetched lines in a local ref "for fast re-render".** The ViewCacheHandle IS the fast lookup. `viewCache.get(n)` is a Map lookup — O(1). Adding another Map in front of it doubles memory without improving speed.

3. **Caching lines in ReadOnlyViewer's render loop.** The virtualizer calls `dataSource.getLine(n)` for each visible row on every render. This is intentional — it reads from the bounded ViewCacheHandle. Do not intercept and buffer these results.

4. **Storing streaming lines in CacheDataSource.** `pushStreamingLines()` must ONLY fire onAppend listeners and update the total lines counter. Lines are already stored in ViewCacheHandle via `broadcastToSession()` which runs before `pushToSession()`.

5. **Creating a "visible lines" Map in ReadOnlyViewer.** Previous versions had a `visibleLinesRef` that accumulated lines without eviction. This was removed. The cacheVersion counter + `dataSource.getLine()` pattern replaces it.

6. **Calling `allocateView`/`releaseView` directly from components.** Always use `useViewCache(viewId, sessionId)` — it handles allocation, re-allocation on viewId change, and cleanup on unmount automatically. Calling `allocateView` without a matching `releaseView` creates ghost handles that consume budget indefinitely.

## Adding New Views or Data Paths

When adding a new component that displays log lines:

1. Use `useViewCache(viewId, sessionId)` to get a ViewCacheHandle from CacheManager. It auto-releases on unmount and re-allocates when viewId changes — no manual cleanup needed.
2. Create a `CacheDataSource` via `createCacheDataSource({ sessionId, viewCache, fetchLines, registry })`
3. Pass the CacheDataSource to `ReadOnlyViewer` (or use `dataSource.getLine()` directly)
4. Call `useCacheFocus(viewId)` if this view should get priority budget when active
5. **Do not** create any intermediate storage for ViewLine objects

## StreamPusher interface

External code that pushes streaming lines uses the `StreamPusher` interface (exported from viewport barrel), not `DataSourceRegistry` directly. Hooks that only push lines (like `useLogViewer`) accept `StreamPusher`. Only `CacheContext.tsx` imports `DataSourceRegistry` for construction — the cache module owns the lifecycle.
