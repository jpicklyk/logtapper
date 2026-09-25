import type { ViewLine, LinePage } from '../bridge/types';
import type { DataSource } from './DataSource';
import type { WritableViewCache } from '../cache';
import type { DataSourceRegistrar } from './DataSourceRegistry';

interface CacheDataSourceOptions {
  sessionId: string;
  viewCache: WritableViewCache;
  fetchLines: (offset: number, count: number) => Promise<LinePage>;
  /** For processor/filter view -- returns current line number mapping (called on every access).
   *  Using a getter instead of a static array lets LogViewer update the mapping via a ref
   *  without recreating the data source on every filter change. */
  getLineNumbers?: () => number[] | undefined;
  /** Registry for streaming push — auto-registers on create, auto-unregisters on dispose */
  registry?: DataSourceRegistrar;
}

/**
 * Creates a DataSource backed by a single ViewCacheHandle (bounded LRU).
 *
 * All line data lives exclusively in the ViewCacheHandle, which is managed
 * by the global CacheManager budget. No shadow caches, no unbounded Maps.
 *
 * File mode: ReadOnlyViewer drives fetches via its FetchScheduler. getLines()
 *   checks the cache, fetches misses from the backend, and stores via put().
 * Streaming mode: broadcastToSession() populates the ViewCacheHandle externally.
 *   pushStreamingLines() fires onAppend listeners for tail-mode auto-scroll.
 * Processor mode: lineNumbers array maps virtual index -> actual file line.
 */
export function createCacheDataSource(options: CacheDataSourceOptions): CacheDataSource {
  const {
    sessionId,
    viewCache,
    fetchLines,
    getLineNumbers,
    registry,
  } = options;

  let _totalLines = 0;
  let _disposed = false;
  let _fetchGen = 0;

  // Append subscribers (streaming mode — tail-mode auto-scroll)
  const _appendListeners = new Set<(newLines: ViewLine[], total: number) => void>();

  /**
   * Filtered mode: `ln` maps virtual index -> file line, and those file lines
   * are usually scattered (a processor's matches, a filter's hits). The
   * backend only serves contiguous ranges, so one range starting at the first
   * missing line would load only the matches that happen to sit inside it,
   * leaving the rest of the requested rows unloaded — and the cache binding
   * issues one fetch per viewport, so those rows stayed skeletons until the
   * user scrolled. Instead, fetch every missing line of the request, grouped
   * into clusters of nearby lines (one contiguous range each), so a single
   * `getLines` call loads every row it was asked for.
   */
  function getFilteredLines(ln: number[], offset: number, count: number): Promise<ViewLine[]> {
    const end = Math.min(offset + count, ln.length);
    const missing: number[] = [];
    for (let idx = offset; idx < end; idx++) {
      if (!viewCache.get(ln[idx])) missing.push(ln[idx]);
    }
    const collect = (): ViewLine[] => {
      const out: ViewLine[] = [];
      for (let idx = offset; idx < end; idx++) {
        const line = viewCache.get(ln[idx]);
        if (line) out.push(line);
      }
      return out;
    };
    if (missing.length === 0) return Promise.resolve(collect());

    const ranges = clusterLines(missing, FILTERED_CLUSTER_GAP);
    console.debug('[CacheDataSource] getLines: filtered miss → fetching', { sessionId, offset, count, missing: missing.length, ranges: ranges.length });
    const gen = _fetchGen;
    const stale = (): boolean => gen !== _fetchGen || _disposed;
    // A prefetch window can span thousands of scattered matches, so the
    // ranges are fetched by a small worker pool rather than all at once.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ranges.length && !stale()) {
        const [from, n] = ranges[next++];
        const page = await fetchLines(from, n);
        if (!stale()) viewCache.put(page.lines);
      }
    };
    const workers = Array.from({ length: Math.min(FILTERED_FETCH_CONCURRENCY, ranges.length) }, worker);
    return Promise.all(workers).then(() => {
      if (stale()) {
        console.debug('[CacheDataSource] getLines: filtered fetch stale/disposed, discarding', { sessionId, gen, currentGen: _fetchGen, disposed: _disposed });
        return [];
      }
      return collect();
    });
  }

  const source: CacheDataSource = {
    get totalLines(): number {
      const ln = getLineNumbers?.();
      return ln ? ln.length : _totalLines;
    },

    get sourceId(): string {
      return `${sessionId}:${getLineNumbers?.() ? 'filtered' : 'full'}`;
    },

    getLine(lineNum: number): ViewLine | undefined {
      const ln = getLineNumbers?.();
      if (ln) {
        const actualLine = ln[lineNum];
        if (actualLine === undefined) return undefined;
        return viewCache.get(actualLine);
      }
      return viewCache.get(lineNum);
    },

    getLines(offset: number, count: number): Promise<ViewLine[]> {
      const ln = getLineNumbers?.();
      if (ln) return getFilteredLines(ln, offset, count);
      // Scan prefix: collect cached lines until first miss
      const prefixLines: ViewLine[] = [];
      let firstMiss = -1;
      for (let i = 0; i < count; i++) {
        const line = viewCache.get(offset + i);
        if (line) {
          prefixLines.push(line);
        } else {
          firstMiss = i;
          break;
        }
      }

      if (firstMiss === -1) {
        return Promise.resolve(prefixLines);
      }

      // Fetch from firstMiss to end of requested range (skip cached prefix).
      const fetchOffset = offset + firstMiss;
      const rawFetchCount = count - firstMiss;
      // Minimum fetch size to avoid tiny IPC round-trips during progressive
      // indexing (totalLines grows by small increments, each triggering a
      // forceFetch that would otherwise fetch 1-50 lines at a time).
      const MIN_FETCH = 500;
      const fetchCount = Math.max(rawFetchCount, MIN_FETCH);
      console.debug('[CacheDataSource] getLines: partial miss → fetching', { sessionId, offset, count, fetchOffset, fetchCount, rawFetchCount, cacheSize: viewCache.size, allocation: viewCache.allocation, disposed: _disposed });
      const gen = _fetchGen;
      return fetchLines(fetchOffset, fetchCount).then((window: LinePage) => {
        if (gen !== _fetchGen || _disposed) {
          console.debug('[CacheDataSource] getLines: fetch stale/disposed, discarding', { sessionId, fetchOffset, gen, currentGen: _fetchGen, disposed: _disposed });
          return [];
        }
        if (window.totalLines > _totalLines) {
          _totalLines = window.totalLines;
        }
        console.debug('[CacheDataSource] getLines: put', { sessionId, fetchOffset, lines: window.lines.length, cacheSize: viewCache.size });
        viewCache.put(window.lines);
        return window.lines;
      });
    },

    onAppend(cb: (newLines: ViewLine[], totalLines: number) => void): () => void {
      _appendListeners.add(cb);
      return () => { _appendListeners.delete(cb); };
    },

    updateTotalLines(n: number): void {
      _totalLines = n;
    },

    /** Notify append listeners only. Lines are already in ViewCacheHandle
     *  via broadcastToSession(). No local storage needed. */
    pushStreamingLines(lines: ViewLine[], total: number): void {
      _totalLines = total;
      for (const cb of _appendListeners) {
        cb(lines, total);
      }
    },

    invalidate(): void {
      _fetchGen++;
    },

    dispose(): void {
      _disposed = true;
      registry?.unregister(sessionId, source);
      _appendListeners.clear();
    },
  };

  registry?.register(sessionId, source);

  return source;
}

/**
 * Two missing filtered lines at most this far apart share one fetch. Fetching
 * the lines in between costs far less than another IPC round-trip, but a much
 * larger gap would fill the bounded cache with lines the view never shows.
 */
export const FILTERED_CLUSTER_GAP = 64;

/** How many filtered-mode range fetches run at once. */
export const FILTERED_FETCH_CONCURRENCY = 8;

/**
 * Group ascending file line numbers into contiguous fetch ranges: a new range
 * starts whenever the next line is more than `maxGap` past the previous one.
 * Returns `[offset, count]` pairs covering every input line.
 */
export function clusterLines(lines: readonly number[], maxGap: number): [number, number][] {
  const ranges: [number, number][] = [];
  let start = lines[0];
  let prev = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line - prev > maxGap) {
      ranges.push([start, prev - start + 1]);
      start = line;
    }
    prev = line;
  }
  if (lines.length > 0) ranges.push([start, prev - start + 1]);
  return ranges;
}

/** Extended DataSource with cache-specific control methods. */
export interface CacheDataSource extends DataSource {
  onAppend: (cb: (newLines: ViewLine[], totalLines: number) => void) => () => void;
  updateTotalLines(n: number): void;
  pushStreamingLines(lines: ViewLine[], total: number): void;
  invalidate(): void;
  dispose(): void;
}
