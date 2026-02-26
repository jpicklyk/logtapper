import React, { useMemo, useCallback, useEffect, useState, useRef } from 'react';
import type { ViewLine } from '../../bridge/types';
import type { GutterColumnDef, LineDecoratorDef, Selection, CacheDataSource } from '../../viewport';
import { ReadOnlyViewer, createCacheDataSource, sessionScrollPositions } from '../../viewport';
import { useViewCache, useCacheFocus, useDataSourceRegistry } from '../../cache';
import {
  useSessionForPane,
  useScrollTarget,
  useTrackerTransitions,
  useProcessorId,
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
  const isStreaming = session?.isStreaming ?? false;
  const totalLines = session?.totalLines ?? 0;
  const { lineNum: scrollToLine, seq: jumpSeq, paneId: jumpPaneId } = useScrollTarget();
  // Only honour the jump if it targets this specific pane or is unfocused/global (null).
  const isJumpForThisPane = jumpPaneId === null || jumpPaneId === paneId;
  const effectiveScrollToLine = isJumpForThisPane ? scrollToLine : null;
  const effectiveJumpSeq = isJumpForThisPane ? jumpSeq : 0;
  const { allLineNums: transitionLineNums, byLine: transitionsByLine } = useTrackerTransitions();
  const processorId = useProcessorId();

  // Selection state (local to this viewer)
  const [selection, setSelection] = useState<Selection>({
    anchor: null,
    selected: new Set(),
    mode: 'line',
  });

  // Clear selection on session/mode changes
  useEffect(() => {
    setSelection({ anchor: null, selected: new Set(), mode: 'line' });
  }, [session?.sessionId, processorId]);

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

  // Create CacheDataSource
  const dataSourceRef = useRef<CacheDataSource | null>(null);

  const dataSource = useMemo(() => {
    // Dispose previous
    dataSourceRef.current?.dispose?.();

    if (!sessionId || !viewCache) {
      dataSourceRef.current = null;
      return null;
    }

    const ds = createCacheDataSource({
      sessionId,
      viewCache,
      fetchLines,
      lineNumbers,
      registry,
    });

    // Set initial total lines
    ds.updateTotalLines(totalLines);

    dataSourceRef.current = ds;
    return ds;
  // totalLines excluded — updated imperatively below to avoid recreating the data source
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, viewCache, fetchLines, lineNumbers, registry]);

  // Update total lines imperatively without recreating the data source
  useEffect(() => {
    if (dataSourceRef.current && totalLines) {
      dataSourceRef.current.updateTotalLines(totalLines);
    }
  }, [totalLines]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      dataSourceRef.current?.dispose?.();
    };
  }, []);

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
      // Selection is handled via onSelectionChange — no scroll jump needed.
    },
    [],
  );

  const handleSelectionChange = useCallback((sel: Selection) => {
    setSelection(sel);
  }, []);

  if (!dataSource) {
    return (
      <div className={styles.empty}>
        <p>No log file loaded. Open a file to begin.</p>
      </div>
    );
  }

  return (
    <ReadOnlyViewer
      dataSource={dataSource}
      totalLineCount={totalLines}
      scrollToLine={effectiveScrollToLine ?? undefined}
      jumpSeq={effectiveJumpSeq}
      tailMode={isStreaming}
      gutterColumns={gutterColumns}
      lineDecorators={lineDecorators}
      onLineClick={handleLineClick}
      onSelectionChange={handleSelectionChange}
      selection={selection}
      className={styles.viewer}
      initialVirtualBase={initialVirtualBase}
      virtualBaseOutRef={virtualBaseOutRef}
    />
  );
});

export default LogViewer;
