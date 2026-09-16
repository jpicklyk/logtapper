/**
 * Public API of the cache module (principle 9).
 *
 * The bounded-LRU line cache and its per-view handles. Framework-free: the
 * React provider that used to live here (`CacheContext.tsx`) was removed with
 * the React tree; a frontend binds `CacheManager` to its own reactivity.
 */
export { CacheManager, ViewCacheHandle } from './CacheManager';
export type { ViewCache, WritableViewCache, CacheController, ViewPriority } from './CacheManager';
