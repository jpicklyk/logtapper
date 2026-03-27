import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { ViewLine } from '../../bridge/types';
import type { GutterColumnDef, LineDecoratorDef, CacheDataSource, Selection } from '../../viewport';
import { ReadOnlyViewer, createCacheDataSource, sessionScrollPositions } from '../../viewport';
import { useViewCache, useCacheFocus, useDataSourceRegistry, useCacheManager } from '../../cache';
import {
  useSessionForPane,
  useIsStreamingForPane,
  useScrollTarget,
  useTrackerTransitions,
  useSearchQuery,
} from '../../context';
import { useBookmarks, useBookmarkLines, useBookmarkLookup, useSettings } from '../../hooks';
import { bus } from '../../events';
import type { AppEvents } from '../../events';
import { absoluteLineToFilteredIndex } from './scrollMapping';
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

  // Bookmark gutter markers
  const sessionId = session?.sessionId ?? null;
  const { bookmarks } = useBookmarks(sessionId);
  const bookmarkLines = useBookmarkLines(bookmarks);
  const bookmarkLookup = useBookmarkLookup(bookmarks);
  const { settings } = useSettings();
  const categoryColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of settings.bookmarkCategories) map[c.id] = c.color;
    return map;
  }, [settings.bookmarkCategories]);
  const { lineNum: scrollToLine, seq: jumpSeq, paneId: jumpPaneId } = useScrollTarget();
  // Only honour the jump if it targets this specific pane or is unfocused/global (null).
  const isJumpForThisPane = jumpPaneId === null || jumpPaneId === paneId;
  // When a line filter is active, the virtualizer operates on filtered indices
  // (0..N-1), not absolute line numbers.  Map the absolute scrollToLine to its
  // position in the filtered array so ReadOnlyViewer scrolls to the right row.
  const mappedScrollToLine = useMemo(() => {
    const abs = isJumpForThisPane ? scrollToLine : null;
    if (abs == null || !lineNumbers) return abs;
    return absoluteLineToFilteredIndex(abs, lineNumbers);
  }, [isJumpForThisPane, scrollToLine, lineNumbers]);
  const effectiveScrollToLine = mappedScrollToLine;
  const effectiveJumpSeq = isJumpForThisPane ? jumpSeq : 0;
  const { allLineNums: transitionLineNums, byLine: transitionsByLine } = useTrackerTransitions();

  // View cache handle
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

  // Create CacheDataSource synchronously during render via ref identity tracking.
  // This is React 19 StrictMode-safe: on double-invoke, prevDataSourceKeyRef already
  // matches the key, so the factory doesn't run again (same pattern as useViewCache).
  //
  // A version counter (`dsVersion`) triggers a re-render after creation so that
  // downstream effects (useFetchScheduler's onFetch binding) re-fire with the
  // new dataSource reference. Without this, the ref change is invisible to effects.
  const dataSourceRef = useRef<CacheDataSource | null>(null);
  const prevDataSourceKeyRef = useRef<string | null>(null);
  const [, setDsVersion] = useState(0);

  const dataSourceKey = sessionId && viewCache ? sessionId : null;

  if (prevDataSourceKeyRef.current !== dataSourceKey) {
    // Key changed — dispose previous, create new (or null)
    if (prevDataSourceKeyRef.current !== null && dataSourceRef.current) {
      dataSourceRef.current.dispose();
    }
    prevDataSourceKeyRef.current = dataSourceKey;

    if (!dataSourceKey || !sessionId || !viewCache) {
      dataSourceRef.current = null;
    } else {
      console.debug('[LogViewer] dataSource → created', { sessionId, paneId, totalLines });
      const ds = createCacheDataSource({
        sessionId,
        viewCache,
        fetchLines,
        getLineNumbers: () => lineNumbersRef.current,
        registry,
      });
      ds.updateTotalLines(totalLines);
      dataSourceRef.current = ds;
    }
  }

  const dataSource = dataSourceRef.current;

  // Notify downstream effects that the DataSource changed. Scheduled as a
  // microtask so the current render completes first (the DataSource is already
  // available synchronously via ref for this render's children).
  useEffect(() => {
    setDsVersion((v: number) => v + 1);
  }, [dataSourceKey]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      dataSourceRef.current?.dispose();
      dataSourceRef.current = null;
    };
  }, []);

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
  const prevSearchRef = useRef<typeof search | null>(null);
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

  // Gutter columns: line number + transition dot + bookmark dot
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

    if (bookmarkLines.size > 0) {
      cols.push({
        id: 'bookmarks',
        width: 16,
        render: (lineNum: number) => {
          if (!bookmarkLines.has(lineNum)) return null;
          const bookmark = bookmarkLookup(lineNum);
          const color = bookmark?.category
            ? (categoryColorMap[bookmark.category ?? 'custom'] ?? 'var(--text-dimmed)')
            : 'var(--text-dimmed)';
          return (
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: color,
                opacity: 0.85,
              }}
              title={bookmark?.label ?? 'Bookmark'}
            />
          );
        },
      });
    }

    return cols;
  }, [transitionLineNums, transitionsByLine, bookmarkLines, bookmarkLookup, categoryColorMap]);

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

  // Broadcast selection changes via event bus so StateTimeline and FileInfoPanel
  // can show cursors / highlight corresponding sections.
  // sessionId read from ref to keep callback reference stable across session switches
  // (avoids stale emission via ReadOnlyViewer's [selection, onSelectionChange] effect).
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Track the latest selection in a ref so context-menu / Ctrl+B can read it
  // without creating a new callback on every selection change.
  const lastSelectionRef = useRef<Selection | null>(null);

  const handleSelectionChange = useCallback(
    (sel: Selection) => {
      lastSelectionRef.current = sel;
      const sid = sessionIdRef.current;
      if (sel.selected.size === 0) {
        bus.emit('selection:changed', { paneId, sessionId: sid, anchor: null, range: null });
        return;
      }
      // Map virtual indices to actual line numbers when filtering is active.
      const ln = lineNumbersRef.current;
      const toActual = (v: number): number => ln ? (ln[v] ?? v) : v;
      let min = Infinity, max = -Infinity;
      for (const n of sel.selected) {
        const actual = toActual(n);
        if (actual < min) min = actual;
        if (actual > max) max = actual;
      }
      const anchor = sel.anchor != null ? toActual(sel.anchor) : null;
      bus.emit('selection:changed', { paneId, sessionId: sid, anchor, range: [min, max] });
    },
    [paneId],
  );

  // Helper: emit bookmark:create-request for the current selection.
  // Selection indices are virtual (0-based in the filtered view). When a filter
  // is active, map them to actual file line numbers via lineNumbersRef.
  const emitBookmarkRequest = useCallback(
    (position?: { x: number; y: number }) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const sel = lastSelectionRef.current;
      if (!sel || sel.anchor == null || sel.selected.size === 0) return;

      const ln = lineNumbersRef.current;
      const toActual = (virtualIdx: number): number =>
        ln ? (ln[virtualIdx] ?? virtualIdx) : virtualIdx;

      let lineNumber: number;
      let lineNumberEnd: number | undefined;

      if (sel.selected.size > 1) {
        let min = Infinity, max = -Infinity;
        for (const n of sel.selected) {
          if (n < min) min = n;
          if (n > max) max = n;
        }
        lineNumber = toActual(min);
        lineNumberEnd = toActual(max);
      } else {
        lineNumber = toActual(sel.anchor);
      }

      const payload: AppEvents['bookmark:create-request'] = {
        paneId,
        sessionId: sid,
        lineNumber,
        lineNumberEnd,
        position,
      };
      bus.emit('bookmark:create-request', payload);
    },
    [paneId],
  );

  // Right-click context menu → bookmark creation
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Only intercept if there is an active selection; otherwise let the browser default.
      const sel = lastSelectionRef.current;
      if (!sel || sel.anchor == null || sel.selected.size === 0) return;
      e.preventDefault();
      emitBookmarkRequest({ x: e.clientX, y: e.clientY });
    },
    [emitBookmarkRequest],
  );

  // Ctrl+B keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        const sel = lastSelectionRef.current;
        if (!sel || sel.anchor == null || sel.selected.size === 0) return;
        e.preventDefault();
        emitBookmarkRequest();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [emitBookmarkRequest]);

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
    // Wrap in a div to capture context-menu events before they bubble out.
    // onContextMenu is suppressed when there is no selection (handled in handler).
    <div className={styles.viewerRoot} onContextMenu={handleContextMenu}>
      <ReadOnlyViewer
        dataSource={dataSource}
        totalLineCount={effectiveTotalLines}
        scrollToLine={effectiveScrollToLine ?? undefined}
        jumpSeq={effectiveJumpSeq}
        tailMode={isStreaming}
        gutterColumns={gutterColumns}
        lineDecorators={lineDecorators}
        onLineClick={handleLineClick}
        onSelectionChange={handleSelectionChange}
        className={styles.viewer}
        initialVirtualBase={initialVirtualBase}
        virtualBaseOutRef={virtualBaseOutRef}
      />
    </div>
  );
});

export default LogViewer;
