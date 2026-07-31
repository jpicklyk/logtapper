// Public API — hooks + narrow interfaces only
export { CacheProvider, useCacheManager, useViewCache, useCacheFocus, useDataSourceRegistry, preSeedSession, clearPreSeed } from './CacheContext';
export type { ViewCache, WritableViewCache, CacheController, ViewPriority } from './CacheManager';
// CacheManager class and ViewCacheHandle class are NOT exported.
// FetchScheduler lives in viewport/ next to its sole consumer (useFetchScheduler) — not exported here.
