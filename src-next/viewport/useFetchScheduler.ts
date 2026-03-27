import { useRef, useEffect } from 'react';
import type { VirtualItem } from '@tanstack/react-virtual';
import { FetchScheduler } from '../cache';
import { diag, diagStart, diagEnd } from '../utils/diagnostics';
import type { DataSource } from './DataSource';

/**
 * Manages the FetchScheduler lifecycle, onFetch callback binding, and
 * scroll reporting for the two-phase viewport + prefetch fetch strategy.
 *
 * Handles:
 * - FetchScheduler creation and disposal
 * - Reset on data source change (stale-response cancellation via fetchGenRef)
 * - onFetch callback: viewport miss check → phase-1 fetch → phase-2 prefetch
 * - reportScroll on every virtualizer items update
 * - forceFetch after completed fetches and on initial mount
 */
export function useFetchScheduler(
  dataSource: DataSource,
  virtualBase: number,
  items: VirtualItem[],
  liveTotalLines: number,
  bumpCacheVersion: () => void,
): {
  schedulerRef: React.MutableRefObject<FetchScheduler | null>;
} {
  const schedulerRef = useRef<FetchScheduler | null>(null);
  const fetchInFlightRef = useRef(false);
  const fetchGenRef = useRef(0);
  const initialFetchDoneRef = useRef(false);

  // ── Create / destroy the scheduler ──────────────────────────────────────
  useEffect(() => {
    schedulerRef.current = new FetchScheduler();
    return () => {
      schedulerRef.current?.dispose();
      schedulerRef.current = null;
    };
  }, []);

  // ── Reset on data source change ──────────────────────────────────────────
  // Increment fetchGen so any in-flight promises are discarded. Also bump the
  // cache version to trigger a re-render for the new source.
  useEffect(() => {
    fetchGenRef.current++;
    fetchInFlightRef.current = false;
    initialFetchDoneRef.current = false;
    bumpCacheVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource.sourceId]);

  // ── Bind onFetch callback ────────────────────────────────────────────────
  // Rebound when dataSource changes. Ensures HMR / data-source swap never
  // leaves the scheduler stuck with a stale callback.
  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (!scheduler) return;
    // Reset in-flight so the new callback can fire immediately.
    fetchInFlightRef.current = false;

    scheduler.onFetch((viewport, prefetch) => {
      if (fetchInFlightRef.current) return;

      // Check viewport for cache misses via dataSource.getLine() → ViewCacheHandle
      let hasMiss = false;
      for (let line = viewport.offset; line < viewport.offset + viewport.count; line++) {
        if (!dataSource.getLine(line)) {
          hasMiss = true;
          break;
        }
      }
      diag('fetch', 'onFetch', { viewport, prefetch, hasMiss, sourceId: dataSource.sourceId });

      if (!hasMiss) {
        // Viewport cached — try prefetch.
        let hasPrefetchMiss = false;
        for (let line = prefetch.offset; line < prefetch.offset + prefetch.count; line++) {
          if (!dataSource.getLine(line)) {
            hasPrefetchMiss = true;
            break;
          }
        }
        if (hasPrefetchMiss) {
          fetchInFlightRef.current = true;
          const gen = fetchGenRef.current;
          Promise.resolve(dataSource.getLines(prefetch.offset, prefetch.count))
            .then(() => {
              if (gen !== fetchGenRef.current) return;
              bumpCacheVersion();
            })
            .catch(console.error)
            .finally(() => { fetchInFlightRef.current = false; });
        }
        return;
      }

      // Phase 1: viewport fill
      fetchInFlightRef.current = true;
      const gen = fetchGenRef.current;
      diagStart('fetch:viewport');
      Promise.resolve(dataSource.getLines(viewport.offset, viewport.count))
        .then(() => {
          diagEnd('fetch:viewport');
          if (gen !== fetchGenRef.current) { fetchInFlightRef.current = false; return; }
          diag('fetch', 'viewport filled — bumping cache version');
          bumpCacheVersion();

          // Phase 2: directional prefetch
          const pfGen = fetchGenRef.current;
          Promise.resolve(dataSource.getLines(prefetch.offset, prefetch.count))
            .then(() => {
              if (pfGen !== fetchGenRef.current) return;
              bumpCacheVersion();
            })
            .catch(console.error)
            .finally(() => {
              fetchInFlightRef.current = false;
              // Re-check viewport after every completed fetch. If the viewport
              // moved while the fetch was in-flight (e.g. programmatic scroll),
              // the reportScroll call that fired during the in-flight window set
              // dedup but was ignored by the fetchInFlightRef guard. forceFetch
              // clears dedup so the current viewport position is re-evaluated.
              schedulerRef.current?.forceFetch();
            });
        })
        .catch((err) => {
          console.error(err);
          fetchInFlightRef.current = false;
          schedulerRef.current?.forceFetch();
        });
    });

    // Safety net: flush any pending ranges that reportScroll may have queued
    // before this callback was bound (race between ResizeObserver timing and
    // effect execution order). The setTimeout(0) defers to after the current
    // React render + effects cycle so reportScroll has had a chance to fire.
    const timer = setTimeout(() => { scheduler.forceFetch(); }, 0);

    return () => { clearTimeout(timer); };
  }, [dataSource, bumpCacheVersion]);

  // ── Report scroll position to the scheduler whenever visible items change ─
  useEffect(() => {
    if (items.length === 0) return;
    const scheduler = schedulerRef.current;
    if (!scheduler) return;

    const first = items[0].index;
    const last = items[items.length - 1].index;
    const firstActual = virtualBase + first;
    const lastActual = virtualBase + last;

    scheduler.reportScroll(firstActual, lastActual, liveTotalLines);

    // On the first reportScroll for a new data source, force the scheduler to
    // bypass dedup. This handles edge cases where the initial fetch was silently
    // skipped due to timing between ResizeObserver and effect order.
    if (!initialFetchDoneRef.current) {
      initialFetchDoneRef.current = true;
      scheduler.forceFetch();
    }
  }, [items, dataSource, virtualBase, liveTotalLines]);

  return { schedulerRef };
}
