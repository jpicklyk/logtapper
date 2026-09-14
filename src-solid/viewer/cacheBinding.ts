import { createSignal, createMemo, createEffect, on, onCleanup, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { FetchScheduler } from '@viewport/FetchScheduler';
import type { DataSource } from '@viewport/DataSource';
import { DEFAULT_ROW_HEIGHT } from './virtualBase';
import { createGenerationGuard } from '../reactive';

/**
 * Solid port of `src-next/viewport/useFetchScheduler.ts`.
 *
 * Derives the visible line window from scroll geometry, reports it to a
 * `FetchScheduler`, and runs the same two-phase fetch (viewport fill, then
 * directional prefetch) with the same stale-generation cancellation.
 *
 * Ownership: `createCacheBinding` creates effects and registers `onCleanup`, so
 * it MUST be called inside a component body or an explicit `createRoot`.
 * Disposing that owner disposes the scheduler; `dispose()` is exposed for
 * callers that own the lifetime manually.
 */

/** Rows rendered above and below the viewport. */
export const OVERSCAN = 10;

export interface CacheBindingOptions {
  /** Current data source. A new `sourceId` resets generation + cache version. */
  dataSource: Accessor<DataSource>;
  /** Scroll offset of the container, in px. */
  scrollTop: Accessor<number>;
  /** Visible height of the container, in px. */
  viewportHeight: Accessor<number>;
  /** Runtime row height (`--viewer-row-h`). Accessor or constant; default 22. */
  rowHeight?: Accessor<number> | number;
  /** Window offset from `createVirtualBase`. */
  virtualBase: Accessor<number>;
  /** Total lines including streaming appends. Defaults to `dataSource().totalLines`. */
  liveTotalLines?: Accessor<number>;
  /**
   * View revision from `ViewerController.revision(sessionId)`. A bump means the
   * *contents* of the current source changed without its `sourceId` moving (a
   * new line set, view mode or highlight map), and is handled exactly like a
   * source swap. The initial value is ignored — only changes reset.
   */
  revision?: Accessor<number>;
  /** Rows of overscan; default {@link OVERSCAN}. */
  overscan?: number;
  /** Inject a scheduler (tests); otherwise one is constructed and owned here. */
  scheduler?: FetchScheduler;
}

/** Relative (virtual-window) index range currently visible, including overscan. */
export interface VisibleRange { start: number; end: number }

export interface CacheBinding {
  /**
   * Monotonic counter bumped whenever cached line data may have changed: a
   * completed viewport fetch, a streaming append, or a data-source swap.
   * The render layer keys its per-row `createMemo` on this so an append
   * repaints only the rows whose data actually resolved.
   */
  cacheVersion: Accessor<number>;
  /** Manual bump, for callers that write into the cache themselves. */
  bumpCacheVersion: () => void;
  /** The scheduler being driven — exposed for `setPrefetchLines` / `isSettled`. */
  scheduler: FetchScheduler;
  /** Visible relative index range, or `null` when nothing is renderable. */
  visibleRange: Accessor<VisibleRange | null>;
  /** Bypass dedup and re-evaluate the current position. */
  forceFetch: () => void;
  /** Dispose the scheduler. Also runs automatically via `onCleanup`. */
  dispose: () => void;
}

export function createCacheBinding(options: CacheBindingOptions): CacheBinding {
  const { dataSource, scrollTop, viewportHeight, virtualBase } = options;
  const overscan = options.overscan ?? OVERSCAN;

  const rowHeight: Accessor<number> =
    typeof options.rowHeight === 'function'
      ? options.rowHeight
      : () => (options.rowHeight as number | undefined) ?? DEFAULT_ROW_HEIGHT;

  const liveTotalLines = options.liveTotalLines ?? (() => dataSource().totalLines);

  const scheduler = options.scheduler ?? new FetchScheduler();
  const [cacheVersion, setCacheVersion] = createSignal(0);
  const bumpCacheVersion = () => setCacheVersion((v) => v + 1);

  let fetchInFlight = false;
  const fetchGuard = createGenerationGuard();
  let initialFetchDone = false;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    scheduler.dispose();
  };
  onCleanup(dispose);

  // ── Visible window ───────────────────────────────────────────────────────
  const visibleRange = createMemo<VisibleRange | null>(() => {
    const rh = Math.max(1, rowHeight());
    const count = Math.max(0, liveTotalLines() - virtualBase());
    if (count === 0 || viewportHeight() <= 0) return null;
    const top = Math.max(0, scrollTop());
    const first = Math.max(0, Math.floor(top / rh) - overscan);
    const last = Math.min(count - 1, Math.ceil((top + viewportHeight()) / rh) - 1 + overscan);
    if (last < first) return null;
    return { start: first, end: last };
  });

  // ── Reset on data source change ──────────────────────────────────────────
  // Bump the generation so in-flight promises are discarded, and bump the cache
  // version so the render layer re-reads for the new source.
  createEffect(
    on(
      () => dataSource().sourceId,
      () => {
        fetchGuard.bump();
        fetchInFlight = false;
        initialFetchDone = false;
        bumpCacheVersion();
      },
    ),
  );

  // ── Reset on a view revision bump ────────────────────────────────────────
  // Same reset as above — the rendered index space may have been remapped under
  // a stable `sourceId` — plus an immediate forceFetch, because nothing else
  // moves the scroll geometry afterwards to trigger one.
  const revision = options.revision;
  if (revision) {
    createEffect(
      on(
        revision,
        () => {
          fetchGuard.bump();
          fetchInFlight = false;
          initialFetchDone = false;
          bumpCacheVersion();
          if (!disposed) scheduler.forceFetch();
        },
        { defer: true },
      ),
    );
  }

  // ── Bind the onFetch callback ────────────────────────────────────────────
  createEffect(
    on(dataSource, (ds) => {
      fetchInFlight = false;

      scheduler.onFetch((viewport, prefetch) => {
        if (fetchInFlight) return;

        const missing = (offset: number, count: number): boolean => {
          for (let line = offset; line < offset + count; line++) {
            if (!ds.getLine(line)) return true;
          }
          return false;
        };

        if (!missing(viewport.offset, viewport.count)) {
          // Viewport already cached — try the prefetch range only.
          if (!missing(prefetch.offset, prefetch.count)) return;
          fetchInFlight = true;
          const gen = fetchGuard.current();
          Promise.resolve(ds.getLines(prefetch.offset, prefetch.count))
            .then(() => {
              if (!fetchGuard.isCurrent(gen)) return;
              bumpCacheVersion();
            })
            .catch(console.error)
            .finally(() => {
              fetchInFlight = false;
              // The viewport may have moved while this prefetch was in flight;
              // reportScroll's queued range was swallowed by the guard above.
              if (!disposed) scheduler.forceFetch();
            });
          return;
        }

        // Phase 1: viewport fill.
        fetchInFlight = true;
        const gen = fetchGuard.current();
        Promise.resolve(ds.getLines(viewport.offset, viewport.count))
          .then(() => {
            if (!fetchGuard.isCurrent(gen)) { fetchInFlight = false; return; }
            bumpCacheVersion();

            // Phase 2: directional prefetch. No bump here — the forceFetch in
            // .finally() re-evaluates and bumps only if the viewport moved.
            const pfGen = fetchGuard.current();
            Promise.resolve(ds.getLines(prefetch.offset, prefetch.count))
              .then(() => { if (!fetchGuard.isCurrent(pfGen)) return; })
              .catch(console.error)
              .finally(() => {
                fetchInFlight = false;
                if (!disposed) scheduler.forceFetch();
              });
          })
          .catch((err) => {
            console.error(err);
            fetchInFlight = false;
            if (!disposed) scheduler.forceFetch();
          });
      });

      // Safety net: flush ranges reported before this callback was bound.
      const timer = setTimeout(() => { if (!disposed) scheduler.forceFetch(); }, 0);
      onCleanup(() => clearTimeout(timer));
    }),
  );

  // ── Report scroll position whenever the visible window changes ───────────
  createEffect(() => {
    const range = visibleRange();
    const total = liveTotalLines();
    dataSource(); // re-report when the source swaps
    if (!range || disposed) return;
    const base = untrack(virtualBase);

    // Cancel a stale in-flight prefetch during fast scrolling so it cannot block
    // the post-settle viewport fetch. Uses the scheduler's own velocity notion.
    if (!scheduler.isSettled && fetchInFlight) {
      fetchGuard.bump();
      fetchInFlight = false;
    }

    scheduler.reportScroll(base + range.start, base + range.end, total);

    if (!initialFetchDone) {
      initialFetchDone = true;
      scheduler.forceFetch();
    }
  });

  // ── Streaming appends invalidate the rendered rows ───────────────────────
  createEffect(
    on(dataSource, (ds) => {
      if (!ds.onAppend) return;
      const unsubscribe = ds.onAppend(() => { bumpCacheVersion(); });
      onCleanup(unsubscribe);
    }),
  );

  return {
    cacheVersion,
    bumpCacheVersion,
    scheduler,
    visibleRange,
    forceFetch: () => { if (!disposed) scheduler.forceFetch(); },
    dispose,
  };
}
