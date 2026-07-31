# src-next/viewport/ — Virtualized Log Viewer Components

## Public API (exported from barrel `index.ts`)

Key exports: `ReadOnlyViewer` (component), `createCacheDataSource` (factory), `useSelectionManager` (hook), `writeClipboard` (WebView2-safe clipboard write, used by `ReadOnlyViewer`'s Ctrl+C handler and by consumers outside this module such as `BookmarkPanel`), `DataSource` / `StreamPusher` / `DataSourceRegistrar` / `CacheDataSource` / `GutterColumnDef` / `LineDecoratorDef` / `Selection` (interfaces/types). See `index.ts` for the full list.

`DataSourceRegistry` class, `FetchScheduler`, and `SelectionManager` internals are **not** exported. `DataSourceRegistry` construction is `CacheContext`'s responsibility — external code uses `StreamPusher` via the cache barrel.

## CacheDataSource factory

Use `createCacheDataSource({ sessionId, viewCache, fetchLines, registry })` — no `new`, no class import needed. The factory registers with DataSourceRegistry on creation, unregisters on `dispose()`.

## FetchScheduler

`FetchScheduler.ts` — computes two-phase fetch: viewport range first (immediate), then directional prefetch (debounced based on scroll velocity). Used exclusively by `useFetchScheduler.ts` (its sole consumer), which `ReadOnlyViewer` calls to own the scheduling logic. Not exported from the barrel — moved here from `cache/` (U65) since it has no dependency on `CacheManager` internals and only ever had the one consumer.

## Selection model

Two modes managed by `useSelectionManager`:
- **Line mode**: click = single select, shift+click = range, ctrl+click = toggle
- **Box mode**: alt+drag = rectangular character selection (for copy)

Selection state is local to each viewer instance (principle #5).
