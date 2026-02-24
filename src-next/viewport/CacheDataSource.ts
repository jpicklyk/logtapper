import type { ViewLine, LineWindow } from '../bridge/types';
import type { DataSource } from './DataSource';
import type { WritableViewCache } from '../cache';
import type { DataSourceRegistry } from './DataSourceRegistry';

interface CacheDataSourceOptions {
  sessionId: string;
  viewCache: WritableViewCache;
  fetchLines: (offset: number, count: number) => Promise<LineWindow>;
  /** For processor view -- maps virtual index to actual file line number */
  lineNumbers?: number[];
  /** Registry for streaming push — auto-registers on create, auto-unregisters on dispose */
  registry?: DataSourceRegistry;
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
    lineNumbers,
    registry,
  } = options;

  let _totalLines = lineNumbers ? lineNumbers.length : 0;
  let _disposed = false;
  let _fetchGen = 0;

  // Append subscribers (streaming mode — tail-mode auto-scroll)
  const _appendListeners = new Set<(newLines: ViewLine[], total: number) => void>();

  const source: CacheDataSource = {
    get totalLines(): number {
      return lineNumbers ? lineNumbers.length : _totalLines;
    },

    get sourceId(): string {
      return `${sessionId}:${lineNumbers ? 'processor' : 'full'}`;
    },

    getLine(lineNum: number): ViewLine | undefined {
      if (lineNumbers) {
        const actualLine = lineNumbers[lineNum];
        if (actualLine === undefined) return undefined;
        return viewCache.get(actualLine);
      }
      return viewCache.get(lineNum);
    },

    getLines(offset: number, count: number): Promise<ViewLine[]> {
      // Try to serve entirely from cache
      const result: ViewLine[] = [];
      let allCached = true;
      for (let i = 0; i < count; i++) {
        const idx = offset + i;
        const actualLine = lineNumbers ? lineNumbers[idx] : idx;
        if (actualLine === undefined) break;
        const cached = viewCache.get(actualLine);
        if (cached) {
          result.push(cached);
        } else {
          allCached = false;
          break;
        }
      }
      if (allCached && result.length > 0) {
        return Promise.resolve(result);
      }

      // Cache miss — fetch from backend, store in ViewCacheHandle (bounded LRU)
      // Capture current gen (only invalidate() and dispose() bump it)
      const gen = _fetchGen;
      return fetchLines(offset, count).then((window: LineWindow) => {
        if (gen !== _fetchGen || _disposed) return [];
        if (window.totalLines > _totalLines && !lineNumbers) {
          _totalLines = window.totalLines;
        }
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
