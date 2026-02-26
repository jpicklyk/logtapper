import type { ViewLine, LineWindow } from '../bridge/types';
import type { DataSource } from './DataSource';
import type { WritableViewCache } from '../cache';
import type { DataSourceRegistrar } from './DataSourceRegistry';

interface CacheDataSourceOptions {
  sessionId: string;
  viewCache: WritableViewCache;
  fetchLines: (offset: number, count: number) => Promise<LineWindow>;
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
      // Scan prefix: collect cached lines until first miss or boundary
      const prefixLines: ViewLine[] = [];
      let firstMiss = -1;
      for (let i = 0; i < count; i++) {
        const idx = offset + i;
        const actualLine = ln ? ln[idx] : idx;
        if (actualLine === undefined) break; // filtered/processor mode boundary
        const line = viewCache.get(actualLine);
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

      // Fetch from firstMiss to end of requested range (skip cached prefix)
      const fetchOffset = offset + firstMiss;
      const fetchCount = count - firstMiss;
      console.debug('[CacheDataSource] getLines: partial miss → fetching', { sessionId, offset, count, fetchOffset, fetchCount, cacheSize: viewCache.size, allocation: viewCache.allocation, disposed: _disposed });
      const gen = _fetchGen;
      return fetchLines(fetchOffset, fetchCount).then((window: LineWindow) => {
        if (gen !== _fetchGen || _disposed) {
          console.debug('[CacheDataSource] getLines: fetch stale/disposed, discarding', { sessionId, fetchOffset, gen, currentGen: _fetchGen, disposed: _disposed });
          return [];
        }
        if (window.totalLines > _totalLines && !getLineNumbers?.()) {
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

/** Extended DataSource with cache-specific control methods. */
export interface CacheDataSource extends DataSource {
  updateTotalLines(n: number): void;
  pushStreamingLines(lines: ViewLine[], total: number): void;
  invalidate(): void;
  dispose(): void;
}
