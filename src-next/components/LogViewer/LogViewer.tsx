import React, { useMemo, useCallback, useEffect, useState, useRef } from 'react';
import type { ViewLine } from '../../bridge/types';
import type { GutterColumnDef } from '../../viewport/GutterColumn';
import type { LineDecoratorDef } from '../../viewport/LineDecorator';
import type { Selection } from '../../viewport/SelectionManager';
import { ReadOnlyViewer, createCacheDataSource } from '../../viewport';
import type { CacheDataSource } from '../../viewport';
import { useViewCache, useCacheFocus, useDataSourceRegistry } from '../../cache';
import {
  useSession,
  useIsStreaming,
  useScrollTarget,
  useTrackerTransitions,
  useViewerActions,
} from '../../context';
import { useViewerContext } from '../../context/ViewerContext';
import { useSessionContext } from '../../context/SessionContext';
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
  const session = useSession();
  const isStreaming = useIsStreaming();
  const { lineNum: scrollToLine, seq: jumpSeq } = useScrollTarget();
  const { allLineNums: transitionLineNums, byLine: transitionsByLine } = useTrackerTransitions();
  const { jumpToLine } = useViewerActions();
  const { processorId } = useViewerContext();
  const { session: sessionData } = useSessionContext();

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
  const viewId = sessionId ? `pane-${paneId}-${sessionId}` : null;
  const viewCache = useViewCache(viewId, sessionId);
  const registry = useDataSourceRegistry();

  // Focus management: give this pane 60% of cache budget when active
  useCacheFocus(viewId);

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
    ds.updateTotalLines(sessionData?.totalLines ?? 0);

    dataSourceRef.current = ds;
    return ds;
  }, [sessionId, viewCache, fetchLines, lineNumbers, sessionData?.totalLines, registry]);

  // Update total lines when session changes
  useEffect(() => {
    if (dataSourceRef.current && sessionData?.totalLines) {
      dataSourceRef.current.updateTotalLines(sessionData.totalLines);
    }
  }, [sessionData?.totalLines]);

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
        classNames: (line, isSelected, isJumpTarget) => {
          const cls: string[] = [];
          if (line.level) {
            cls.push(`log-level-${line.level.toLowerCase()}`);
          }
          if (line.isContext) {
            cls.push(styles.contextLine);
          }
          if (isSelected) {
            cls.push(styles.selected);
          }
          if (isJumpTarget) {
            cls.push(styles.jumpTarget);
          }
          return cls;
        },
      },
    ],
    [],
  );

  const handleLineClick = useCallback(
    (lineNum: number) => {
      jumpToLine(lineNum);
    },
    [jumpToLine],
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
      scrollToLine={scrollToLine ?? undefined}
      jumpSeq={jumpSeq}
      tailMode={isStreaming}
      gutterColumns={gutterColumns}
      lineDecorators={lineDecorators}
      onLineClick={handleLineClick}
      onSelectionChange={handleSelectionChange}
      selection={selection}
      className={styles.viewer}
    />
  );
});

export default LogViewer;
