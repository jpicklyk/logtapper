# src-next/viewport/ — Virtualized Log Viewer Components

## Public API (exported from barrel `index.ts`)

| Export | Kind | Description |
|---|---|---|
| `ReadOnlyViewer` | Component | Virtualized log viewer — renders visible rows via DataSource |
| `TextLine` / `TextLineSkeleton` | Component | Single log line + loading skeleton |
| `createCacheDataSource` | Factory | Creates a CacheDataSource (stateless facade over ViewCacheHandle) |
| `useSelectionManager` | Hook | Line mode (click/shift/ctrl) + box mode (alt+drag) selection |
| `StreamPusher` | Interface | Narrow push-only interface for streaming (used by useLogViewer) |
| `DataSourceRegistrar` | Interface | Extends StreamPusher + register/unregister (used by createCacheDataSource) |
| `DataSource` | Interface | Read contract: `getLine`, `getLines`, `onAppend`, `dispose` |
| `CacheDataSource` | Type | Returned by `createCacheDataSource` — typed DataSource backed by cache |
| `GutterColumnDef` | Interface | Custom gutter column configuration |
| `LineDecoratorDef` | Interface | Per-line decoration (highlight, marker) |
| `Selection` | Interface | Current selection state |

## Internal (NOT in barrel)

| Module | Why internal |
|---|---|
| `DataSourceRegistry` class | Construction is CacheContext's responsibility. External code uses the `StreamPusher` interface via `useDataSourceRegistry()` from cache barrel. |
| `FetchScheduler` | Lives inside ReadOnlyViewer — velocity-aware debounce for viewport + directional prefetch |
| `SelectionManager` internals | Only `useSelectionManager` hook + `Selection` type are public |

## DataSource interface contract

```typescript
interface DataSource {
  getLine(index: number): ViewLine | null;        // Single lookup — may return null (cache miss)
  getLines(offset: number, count: number): Promise<ViewLine[]>;  // Batch fetch with cache-miss backfill
  onAppend(listener: AppendListener): () => void;  // Streaming notification (NOT storage)
  dispose(): void;                                  // Cleanup — unregisters from DataSourceRegistry
}
```

## CacheDataSource factory

Use `createCacheDataSource({ sessionId, viewCache, fetchLines, registry })` — no `new`, no class import needed. The factory registers with DataSourceRegistry on creation, unregisters on `dispose()`.

## FetchScheduler

Lives inside `ReadOnlyViewer`. Computes two-phase fetch: viewport range first (immediate), then directional prefetch (debounced based on scroll velocity). Not exported — ReadOnlyViewer owns the scheduling logic.

## Selection model

Two modes managed by `useSelectionManager`:
- **Line mode**: click = single select, shift+click = range, ctrl+click = toggle
- **Box mode**: alt+drag = rectangular character selection (for copy)

Selection state is local to each viewer instance (principle #5).
