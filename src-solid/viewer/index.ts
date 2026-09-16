/**
 * Public API of the Solid viewer core.
 *
 * Everything outside `src-solid/viewer/` imports from this barrel only.
 * Inside the module, files import each other directly.
 *
 * Two kinds of export live here:
 *  1. The Solid ports of the four React viewer hooks (this directory).
 *  2. Stable re-exports of the framework-free `src-shared/` modules the viewer
 *     reuses unchanged. They are re-exported here so no consumer has to know
 *     the `@viewport/…` / `@cache/…` alias layout.
 *
 * Reactive ownership: `createVirtualBase` and `createCacheBinding` create
 * effects, and `new ScrollControls(...)` does too. All three must be
 * constructed inside a component body or an explicit `createRoot` owned by the
 * caller. `SelectionManager` is owner-free.
 */

// ── Solid ports ───────────────────────────────────────────────────────────
export { createVirtualBase, MAX_BROWSER_SCROLL_PX, DEFAULT_ROW_HEIGHT } from './virtualBase';
export type { VirtualBase, VirtualBaseOptions, Ref } from './virtualBase';

export { ScrollControls } from './scrollControls';
export type { ScrollControlsOptions } from './scrollControls';

export { SelectionManager } from './selection';
export type { Selection, ClickModifiers, BoxPointerEvent } from './selection';

export { createCacheBinding, OVERSCAN } from './cacheBinding';
export type { CacheBinding, CacheBindingOptions, VisibleRange } from './cacheBinding';

export { createViewerController, intersectSorted, DEFAULT_PANE_ID, DEFAULT_VIEW_MODE } from './controller';
export type {
  ViewerController,
  ViewerControllerDeps,
  PaneHandle,
  LineSetKey,
  NavSource,
  CursorPosition,
  ScrollToLineOptions,
} from './controller';

export { createStreamSession } from './createStreamSession';
export type {
  StreamSession,
  StreamSessionOptions,
  StreamSessionStatus,
  StreamStartOptions,
} from './createStreamSession';

// ── Reused unchanged from src-shared/ (framework-free) ────────────────────
export { FetchScheduler } from '@viewport/FetchScheduler';
export type { FetchRange, FetchSchedulerConfig, FetchCallback } from '@viewport/FetchScheduler';

export { createCacheDataSource } from '@viewport/CacheDataSource';
export type { CacheDataSource } from '@viewport/CacheDataSource';

export { DataSourceRegistry } from '@viewport/DataSourceRegistry';
export type { StreamPusher, DataSourceRegistrar } from '@viewport/DataSourceRegistry';

export type { DataSource } from '@viewport/DataSource';

export { sessionScrollPositions } from '@viewport/sessionScrollPositions';

export { buildCopyText, writeClipboard } from '@viewport/copyText';

/**
 * Absolute backend line → index in a sorted line set, by binary search. The
 * viewer is the only place that needs it (`LogViewer` maps at the pane
 * boundary), but it is exported so nothing outside is ever tempted to write a
 * second copy — `@viewer`'s `scrollMapping` is the one implementation, with its
 * own unit tests.
 */
export { absoluteLineToFilteredIndex } from '@viewer';

export { CacheManager, ViewCacheHandle } from '@cache/CacheManager';
export type { ViewCache, WritableViewCache, CacheController, ViewPriority } from '@cache/CacheManager';

// ── Render layer (P3) ─────────────────────────────────────────────────────
export { LogViewer } from './LogViewer';
export type { LogViewerProps } from './LogViewer';

export { Row } from './Row';
export type { RowProps } from './Row';

export { HighlightedText, segments, segmentClass, mergeHighlights } from './HighlightedText';
export type { Segment } from './HighlightedText';
