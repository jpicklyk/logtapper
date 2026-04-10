import { useEffect, useRef } from 'react';
import type { SearchQuery } from '../../bridge/types';
import type { CacheDataSource } from '../../viewport';
import type { CacheController } from '../../cache';

/**
 * Encapsulates the cross-module coordination required when the search query
 * changes: clear the session cache so the viewport re-fetches lines with the
 * new query (and receives correct highlight spans), then invalidate the data
 * source so ReadOnlyViewer triggers a fresh fetch cycle.
 *
 * Extracted from LogViewer to satisfy Principle 6 (no cross-hook orchestration
 * in render components). The hook owns the "search changed → invalidate cache"
 * concern so LogViewer is not responsible for wiring cache and viewport hooks
 * together.
 *
 * Two guards prevent spurious clears:
 * 1. isStreaming — streaming lines never carry search highlights (they come
 *    from flush_batch, not getLines), so clearing is pointless and would
 *    destroy cached history that tailMode can never re-fetch.
 * 2. prevSearchRef identity — skips the clear when isStreaming→false fires
 *    the effect without an actual search change, and on fresh mounts where
 *    prevSearch === search (both null) and we haven't opened a new query.
 */
export function useSearchCacheInvalidation(
  search: SearchQuery | null,
  isStreaming: boolean,
  sessionId: string | null,
  cacheManager: CacheController,
  dataSourceRef: React.RefObject<CacheDataSource | null>,
): void {
  const prevSearchRef = useRef<SearchQuery | null>(null);

  useEffect(() => {
    const prevSearch = prevSearchRef.current;
    prevSearchRef.current = search;
    if (isStreaming) return;
    if (prevSearch === search) return;
    if (!sessionId) return;
    cacheManager.clearSession(sessionId);
    dataSourceRef.current?.invalidate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, isStreaming]);
}
