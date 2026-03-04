# src-next/viewport/ — Virtualized Log Viewer Components

## Public API (exported from barrel `index.ts`)

Key exports: `ReadOnlyViewer` (component), `createCacheDataSource` (factory), `useSelectionManager` (hook), `DataSource` / `StreamPusher` / `DataSourceRegistrar` / `CacheDataSource` / `GutterColumnDef` / `LineDecoratorDef` / `Selection` (interfaces/types). See `index.ts` for the full list.

`DataSourceRegistry` class, `FetchScheduler`, and `SelectionManager` internals are **not** exported. `DataSourceRegistry` construction is `CacheContext`'s responsibility — external code uses `StreamPusher` via the cache barrel.

## CacheDataSource factory

Use `createCacheDataSource({ sessionId, viewCache, fetchLines, registry })` — no `new`, no class import needed. The factory registers with DataSourceRegistry on creation, unregisters on `dispose()`.

## FetchScheduler

Lives inside `ReadOnlyViewer`. Computes two-phase fetch: viewport range first (immediate), then directional prefetch (debounced based on scroll velocity). Not exported — ReadOnlyViewer owns the scheduling logic.

## Selection model

Two modes managed by `useSelectionManager`:
- **Line mode**: click = single select, shift+click = range, ctrl+click = toggle
- **Box mode**: alt+drag = rectangular character selection (for copy)

Selection state is local to each viewer instance (principle #5).
