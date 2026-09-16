/**
 * Public API of the viewport module (principle 9).
 *
 * The framework-free half of the old React viewport: the data-source contract
 * a virtualized viewer reads through, the cache-backed implementation of it,
 * the fetch scheduler, the copy-text builder and the per-session scroll memory.
 * The rendering half (`ReadOnlyViewer`, `TextLine`, the React hooks) died with
 * `src-next/`; each frontend owns its own renderer.
 */
export type { DataSource } from './DataSource';
export { DataSourceRegistry } from './DataSourceRegistry';
export type { StreamPusher, DataSourceRegistrar } from './DataSourceRegistry';
export { createCacheDataSource } from './CacheDataSource';
export type { CacheDataSource } from './CacheDataSource';
export { FetchScheduler } from './FetchScheduler';
export type { FetchRange, FetchSchedulerConfig, FetchCallback } from './FetchScheduler';
export { buildCopyText, writeClipboard } from './copyText';
export type { Selection } from './selection';
export { sessionScrollPositions } from './sessionScrollPositions';
