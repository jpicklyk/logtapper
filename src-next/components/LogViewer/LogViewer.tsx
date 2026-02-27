import React, { useMemo, useCallback, useEffect, useRef } from 'react';
import type { ViewLine } from '../../bridge/types';
import type { GutterColumnDef, LineDecoratorDef, CacheDataSource } from '../../viewport';
import { ReadOnlyViewer, createCacheDataSource, sessionScrollPositions } from '../../viewport';
import { useViewCache, useCacheFocus, useDataSourceRegistry, useCacheManager } from '../../cache';
import {
  useSessionForPane,
  useIsStreamingForPane,
  useScrollTarget,
  useTrackerTransitions,
  useSearchQuery,
} from '../../context';
import styles from './LogViewer.module.css';

interface Props {
  paneId: string;
  fetchLines: (offset: number, count: number) => Promise<{ totalLines: number; lines: ViewLine[] }>;
  lineNumbers?: number[];
}

const LogViewer = React.memo(function LogViewer({
  paneId,
  fetchLines,
  lineNumbers,
}: Props) {
  // Scope to this pane's session — NOT the globally focused session.
  // Using useFocusedSession() here would release the cache handle whenever
  // focus moves to a pane without a session (e.g. Scratch), wiping all lines.
  const session = useSessionForPane(paneId);
  const isStreaming = useIsStreamingForPane(paneId);
  const totalLines = session?.totalLines ?? 0;
  const search = useSearchQuery();
  const cacheManager = useCacheManager();
  const { lineNum: scrollToLine, seq: jumpSeq, paneId: jumpPaneId } = useScrollTarget();
  // Only honour the jump if it targets this specific pane or is unfocused/global (null).
  const isJumpForThisPane = jumpPaneId === null || jumpPaneId === paneId;
  const effectiveScrollToLine = isJumpForThisPane ? scrollToLine : null;
  const effectiveJumpSeq = isJumpForThisPane ? jumpSeq : 0;
  const { allLineNums: transitionLineNums, byLine: transitionsByLine } = useTrackerTransitions();

  // View cache handle
  const sessionId = session?.sessionId ?? null;
  const viewId = sessionId ? `view-${sessionId}` : null;
  const viewCache = useViewCache(viewId, sessionId);
  const registry = useDataSourceRegistry();

  // Focus management: give this pane 60% of cache budget when active
  useCacheFocus(viewId);

  // ── Per-session scroll position preservation ───────────────────────────
  // Capture the current virtualBase (written by ReadOnlyViewer synchronously
  // during its render) whenever the session changes, then persist it to the
  // global sessionScrollPositions singleton so any pane — including a fresh
  // mount after a drag — can restore the correct position.
  const prevSessionIdRef = useRef<string | null>(null);
  const virtualBaseOutRef = useRef<number>(0);

  if (prevSessionIdRef.current !== sessionId) {
    if (prevSessionIdRef.current !== null) {
      sessionScrollPositions.set(prevSessionIdRef.current, virtualBaseOutRef.current);
    }
    prevSessionIdRef.current = sessionId;
  }

  const initialVirtualBase = sessionScrollPositions.get(sessionId ?? '');

  // Keep lineNumbers in a ref so the CacheDataSource getter always reads the
  // current value without the dataSource being recreated on every filter update.
  // lineNumbersRef is synced synchronously on every render (before useMemo).
  const lineNumbersRef = useRef<number[] | undefined>(lineNumbers);
  lineNumbersRef.current = lineNumbers;

  // Create CacheDataSource
  const dataSourceRef = useRef<CacheDataSource | null>(null);

  const dataSource = useMemo(() => {
    // Dispose previous
    dataSourceRef.current?.dispose?.();

    if (!sessionId || !viewCache) {
      console.debug('[LogViewer] dataSource → null', { sessionId, hasViewCache: !!viewCache, paneId });
      dataSourceRef.current = null;
      return null;
    }

    console.debug('[LogViewer] dataSource → created', { sessionId, paneId, totalLines });
    const ds = createCacheDataSource({
      sessionId,
      viewCache,
      fetchLines,
      // Pass a getter so lineNumbers changes don't recreate the data source.
      // The ref is synced synchronously before this memo runs, so the getter
      // always returns the current value (including during the render that
      // triggered this memo).
      getLineNumbers: () => lineNumbersRef.current,
      registry,
    });

    // Set initial total lines
    ds.updateTotalLines(totalLines);

    dataSourceRef.current = ds;
    return ds;
  // totalLines and lineNumbers excluded — updated imperatively / via ref
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, viewCache, fetchLines, registry]);

  // Update total lines imperatively without recreating the data source
  useEffect(() => {
    if (dataSourceRef.current && totalLines) {
      dataSourceRef.current.updateTotalLines(totalLines);
    }
  }, [totalLines]);

  // When the search query changes, evict stale cached lines so the viewport
  // re-fetches them with the new query (and receives correct highlight spans).
  //
  // Two guards prevent spurious clears:
  // 1. isStreaming — streaming lines never carry search highlights (they come
  //    from flush_batch, not getLines), so clearing is pointless and would
  //    destroy cached history that tailMode can never re-fetch.
  // 2. prevSearchRef identity — skips the clear when isStreaming→false fires
  //    the effect without an actual search change, and on fresh mounts where
  //    prevSearch === search (both null) and we haven't opened a new query.
  const prevSearchRef = useRef<typeof search>(null);
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

  // Gutter columns: line number + transition dot
  const gutterColumns = useMemo<GutterColumnDef[]>(() => {
    const cols: GutterColumnDef[] = [
      {
        id: 'linenum',
        width: 60,
        render: (lineNum: number) => (
          <span className={styles.lineNum}>
            {String(lineNum + 1).padStart(7, ' ')}
          </span>
        ),
      },
    ];

    if (transitionLineNums.size > 0) {
      cols.push({
        id: 'transition',
        width: 12,
        render: (lineNum: number) => {
          if (!transitionLineNums.has(lineNum)) return null;
          const trackers = transitionsByLine.get(lineNum);
          return (
            <span
              className={styles.transitionDot}
              title={trackers ? `Transition: ${trackers.join(', ')}` : 'Transition'}
            />
          );
        },
      });
    }

    return cols;
  }, [transitionLineNums, transitionsByLine]);

  // Line decorators: level coloring
  const lineDecorators = useMemo<LineDecoratorDef[]>(
    () => [
      {
        classNames: (line, _isSelected, _isJumpTarget) => {
          const cls: string[] = [];
          if (line.level) {
            cls.push(`log-level-${line.level.toLowerCase()}`);
          }
          if (line.isContext) {
            cls.push(styles.contextLine);
          }
          if (line.highlights.length > 0) {
            const hasActive = line.highlights.some((h) => h.kind.type === 'SearchActive');
            const hasSearch = hasActive || line.highlights.some((h) => h.kind.type === 'Search');
            if (hasActive) {
              cls.push(styles.searchActive);
            } else if (hasSearch) {
              cls.push(styles.searchMatch);
            }
          }
          return cls;
        },
      },
    ],
    [],
  );

  const handleLineClick = useCallback(
    (_lineNum: number) => {
      // Selection is handled inside ReadOnlyViewer — no scroll jump needed.
    },
    [],
  );

  if (!dataSource) {
    return (
      <div className={styles.empty}>
        <p>No log file loaded. Open a file to begin.</p>
      </div>
    );
  }

  // When filtering, the virtual list must be sized to the number of matched
  // lines, not the total session line count.
  const effectiveTotalLines = lineNumbers ? lineNumbers.length : totalLines;

  return (
    <ReadOnlyViewer
      dataSource={dataSource}
      totalLineCount={effectiveTotalLines}
      scrollToLine={effectiveScrollToLine ?? undefined}
      jumpSeq={effectiveJumpSeq}
      tailMode={isStreaming}
      gutterColumns={gutterColumns}
      lineDecorators={lineDecorators}
      onLineClick={handleLineClick}
      className={styles.viewer}
      initialVirtualBase={initialVirtualBase}
      virtualBaseOutRef={virtualBaseOutRef}
    />
  );
});

export default LogViewer;
