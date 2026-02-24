import type { ViewLine, LineWindow } from '../bridge/types';
import type { DataSource } from './DataSource';
import type { ViewCacheHandle } from '../cache';
import { FetchScheduler } from '../cache';
import type { FetchRange } from '../cache';

interface CacheDataSourceOptions {
  sessionId: string;
  viewCache: ViewCacheHandle;
  fetchLines: (offset: number, count: number) => Promise<LineWindow>;
  isStreaming: boolean;
  /** For processor view -- maps virtual index to actual file line number */
  lineNumbers?: number[];
  /** For file-mode filter -- pre-populated cache of filter matches */
  filterLineCache?: Map<number, ViewLine>;
}

/**
 * Creates a DataSource backed by ViewCacheHandle + FetchScheduler.
 *
 * File mode: uses FetchScheduler for velocity-aware prefetch; fetches on cache miss.
 * Streaming mode: reads from viewCache (populated externally via broadcastToSession).
 * Processor mode: lineNumbers array maps virtual index -> actual file line number.
 */
export function createCacheDataSource(options: CacheDataSourceOptions): DataSource {
  const {
    sessionId,
    viewCache,
    fetchLines,
    isStreaming,
    lineNumbers,
    filterLineCache,
  } = options;

  // -- Internal state --
  let _totalLines = lineNumbers ? lineNumbers.length : 0;
  let _disposed = false;
  let _fetchInFlight = false;
  let _fetchGen = 0;

  // Local map for lines fetched during this source's lifetime (supplements viewCache)
  const _visibleLines = new Map<number, ViewLine>();

  // Append subscribers (streaming mode)
  const _appendListeners = new Set<(newLines: ViewLine[], total: number) => void>();

  // FetchScheduler for file mode
  const scheduler = new FetchScheduler();

  // Wire up the two-phase fetch callback
  scheduler.onFetch((viewport: FetchRange, prefetch: FetchRange) => {
    if (isStreaming || _disposed) return;
    if (_fetchInFlight) return;

    // Phase 1: check viewport cache misses
    let hasMiss = false;
    const vpEnd = viewport.offset + viewport.count;
    for (let line = viewport.offset; line < vpEnd; line++) {
      const actualLine = lineNumbers ? lineNumbers[line] : line;
      if (actualLine === undefined) continue;
      if (!_resolveLineFromCaches(actualLine)) {
        hasMiss = true;
        break;
      }
    }

    if (!hasMiss) {
      // Viewport is cached -- try prefetch if allowed
      if (viewCache.prefetchAllowed()) {
        _fetchPrefetchRange(prefetch);
      }
      return;
    }

    // Viewport has misses -- fetch viewport first, then prefetch
    _fetchInFlight = true;
    const gen = ++_fetchGen;
    const fetchOffset = lineNumbers ? viewport.offset : viewport.offset;
    fetchLines(fetchOffset, viewport.count)
      .then((window: LineWindow) => {
        if (gen !== _fetchGen || _disposed) return;
        _ingestLines(window);

        // Phase 2: prefetch after viewport fill
        if (viewCache.prefetchAllowed()) {
          const pfGen = _fetchGen;
          fetchLines(prefetch.offset, prefetch.count)
            .then((pfWindow: LineWindow) => {
              if (pfGen !== _fetchGen || _disposed) return;
              _ingestLines(pfWindow);
            })
            .catch(() => {})
            .finally(() => { _fetchInFlight = false; });
        } else {
          _fetchInFlight = false;
        }
      })
      .catch(() => { _fetchInFlight = false; });
  });

  // -- Helpers --

  function _resolveLineFromCaches(lineNum: number): ViewLine | undefined {
    return filterLineCache?.get(lineNum)
      ?? _visibleLines.get(lineNum)
      ?? viewCache.get(lineNum);
  }

  function _ingestLines(window: LineWindow): void {
    if (window.totalLines > _totalLines && !lineNumbers) {
      _totalLines = window.totalLines;
    }
    viewCache.put(window.lines);
    for (const l of window.lines) {
      _visibleLines.set(l.lineNum, l);
    }
  }

  function _fetchPrefetchRange(prefetch: FetchRange): void {
    let hasPrefetchMiss = false;
    const pfEnd = prefetch.offset + prefetch.count;
    for (let line = prefetch.offset; line < pfEnd; line++) {
      const actualLine = lineNumbers ? lineNumbers[line] : line;
      if (actualLine === undefined) continue;
      if (!_resolveLineFromCaches(actualLine)) {
        hasPrefetchMiss = true;
        break;
      }
    }
    if (!hasPrefetchMiss) return;

    _fetchInFlight = true;
    const gen = _fetchGen;
    fetchLines(prefetch.offset, prefetch.count)
      .then((window: LineWindow) => {
        if (gen !== _fetchGen || _disposed) return;
        _ingestLines(window);
      })
      .catch(() => {})
      .finally(() => { _fetchInFlight = false; });
  }

  // -- DataSource implementation --

  const source: DataSource & {
    updateTotalLines(n: number): void;
    pushStreamingLines(lines: ViewLine[], total: number): void;
    invalidate(): void;
    dispose(): void;
  } = {
    get totalLines(): number {
      return lineNumbers ? lineNumbers.length : _totalLines;
    },

    get sourceId(): string {
      return `${sessionId}:${lineNumbers ? 'processor' : 'full'}`;
    },

    getLine(lineNum: number): ViewLine | undefined {
      if (lineNumbers) {
        // Processor mode: lineNum is a virtual index
        const actualLine = lineNumbers[lineNum];
        if (actualLine === undefined) return undefined;
        return _resolveLineFromCaches(actualLine);
      }
      return _resolveLineFromCaches(lineNum);
    },

    getLines(offset: number, count: number): Promise<ViewLine[]> {
      // Try to serve entirely from cache first
      const result: ViewLine[] = [];
      let allCached = true;
      for (let i = 0; i < count; i++) {
        const idx = offset + i;
        const actualLine = lineNumbers ? lineNumbers[idx] : idx;
        if (actualLine === undefined) break;
        const cached = _resolveLineFromCaches(actualLine);
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

      // Cache miss -- fetch from backend
      const gen = ++_fetchGen;
      return fetchLines(offset, count).then((window: LineWindow) => {
        if (gen !== _fetchGen || _disposed) return [];
        _ingestLines(window);
        return window.lines;
      });
    },

    notifyVisible(firstLine: number, lastLine: number): void {
      if (isStreaming || _disposed) return;
      scheduler.reportScroll(firstLine, lastLine, _totalLines);
    },

    onAppend(cb: (newLines: ViewLine[], totalLines: number) => void): () => void {
      _appendListeners.add(cb);
      return () => { _appendListeners.delete(cb); };
    },

    // -- Extended methods (not part of DataSource interface) --

    /** Update totalLines externally (e.g. from streaming batches or index progress). */
    updateTotalLines(n: number): void {
      _totalLines = n;
    },

    /** Push new streaming lines and notify append listeners. */
    pushStreamingLines(lines: ViewLine[], total: number): void {
      _totalLines = total;
      for (const l of lines) {
        _visibleLines.set(l.lineNum, l);
      }
      for (const cb of _appendListeners) {
        cb(lines, total);
      }
    },

    /** Invalidate fetch generation (e.g. on source change). Discards in-flight fetches. */
    invalidate(): void {
      _fetchGen++;
      _visibleLines.clear();
    },

    /** Clean up scheduler and internal state. */
    dispose(): void {
      _disposed = true;
      scheduler.dispose();
      _appendListeners.clear();
      _visibleLines.clear();
    },
  };

  return source;
}

/** Extended DataSource with cache-specific control methods. */
export type CacheDataSource = ReturnType<typeof createCacheDataSource>;
