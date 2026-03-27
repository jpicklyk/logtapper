// Public API — hooks + narrow interfaces only
export { CacheProvider, useCacheManager, useViewCache, useCacheFocus, useDataSourceRegistry, preSeedSession, clearPreSeed } from './CacheContext';
export type { ViewCache, WritableViewCache, CacheController, ViewPriority } from './CacheManager';
export { FetchScheduler } from './FetchScheduler';
export type { FetchSchedulerConfig, FetchCallback, FetchRange } from './FetchScheduler';
// CacheManager class and ViewCacheHandle class are NOT exported
