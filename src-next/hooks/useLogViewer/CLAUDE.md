# src-next/hooks/useLogViewer/ — Log Viewer Hooks

## Module overview

`useLogViewer` is the top-level orchestration hook for the log viewer pane. It composes:

- `useFilterScan` — filter expression parsing, backend scan coordination, incremental match appending
- `useStreamSession` — ADB stream lifecycle, batch processing, live line appending
- `useSessionTabManager` — session tab open/close, warm-up cache population

`SharedLogViewerRefs` (`types.ts`) carries all stable refs threaded through these hooks.

---

## Filter architecture — don't reimplement in JS

**Filtering always goes through `create_filter` (backend).** Never reimplement backend filter logic in frontend JS, regardless of source type (file or streaming).

### Why the backend is always correct

`create_filter` dispatches through the `LogSource` trait. Both `FileLogSource` and `StreamLogSource` implement `raw_line(n)` / `meta_at(n)` / `total_lines()` transparently:

- `FileLogSource`: reads from the memory-mapped file.
- `StreamLogSource`: reads from the in-memory retention vec **or** the `SpillFile` for evicted lines, transparently. `total_lines()` includes evicted lines.

A JS scan over `CacheManager.getSessionEntries()` only sees lines in the LRU cache (~100K lines). Any lines evicted to `SpillFile` are silently skipped. For a long-running stream this can be a large silent miss.

### The filter flow in `useFilterScan.setStreamFilter`

1. **Parse** — `parseFilter(expr)` produces a `FilterNode` AST.
2. **Resolve PIDs** — if the expression has `pkg:` qualifiers, resolve package names to PIDs via `getPackagePids`.
3. **`create_filter`** — backend scans lines `0..total_lines` (snapshot at call time). Emits `filter-progress` events.
4. **`getFilteredLines` + `onFilterProgress`** — progressive results fetched in pages, optionally re-validated with `matchesFilter` (JS second pass for expressions the backend can't express exactly), broadcast to cache, accumulated in `filteredLineNums`.
5. **`appendMatches`** — called by `useStreamSession.handleAdbBatch` for lines arriving **after** the snapshot. This is the only legitimate incremental JS filter path.

### The JS second pass (`needsJsPass`)

`buildBackendFilter` extracts the tightest `FilterCriteria` superset from the AST. When the backend criteria is a superset (not exact), `needsJsPass=true` and each page of backend candidates is re-validated with `matchesFilter` before being accepted.

### The JS fallback scan

For expressions the backend cannot reduce at all (top-level `NOT`, `tid:`, fully heterogeneous ORs), `buildBackendFilter` returns `null`. In this case `useFilterScan` falls back to a full JS scan — but it fetches lines via `getLines` IPC (which reads from `LogSource` directly, including evicted lines), **not** from `CacheManager`. This is correct.

### The one legitimate use of `matchesFilter` for live lines

`useStreamSession.handleAdbBatch` applies `matchesFilter` to **newly arriving batch lines only** (lines past the `create_filter` snapshot). This is correct and necessary — it extends the existing filter result without re-scanning history.

---

## `appendMatches` contract

`appendMatches(lineNums: number[])` is exposed on `FilterScanResult` and called via ref by `useStreamSession`. It appends line numbers to the session's `filteredLineNums` in context. It is a no-op when no filter is active (the caller checks `filterAstRef.current` before calling).

---

## `refs.isStreamingRef`

Written by `useStreamSession` when a stream starts/stops. Still present in `SharedLogViewerRefs` and used by `useStreamSession` — do not remove. It is no longer read by `useFilterScan` (the streaming JS branch was removed; `create_filter` handles all source types uniformly).
