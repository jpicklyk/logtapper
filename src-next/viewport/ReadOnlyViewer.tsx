import React, { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { DataSource } from './DataSource';
import type { GutterColumnDef } from './GutterColumn';
import type { LineDecoratorDef } from './LineDecorator';
import type { Selection } from './SelectionManager';
import { FetchScheduler } from '../cache';
import type { FetchRange } from '../cache';
import TextLine, { TextLineSkeleton } from './TextLine';
import styles from './ReadOnlyViewer.module.css';

const LINE_HEIGHT = 22;
const OVERSCAN = 10;
const AT_BOTTOM_THRESHOLD = 60;

// Chrome/Edge cap their DOM scrollHeight at 2^25 px. Beyond this the native
// scrollbar stops working. We keep the virtualizer's total height inside this
// limit by using a sliding "virtual base" offset for large files.
const MAX_BROWSER_SCROLL_PX = 33_554_428;
const MAX_VIRTUAL_LINES = Math.floor(MAX_BROWSER_SCROLL_PX / LINE_HEIGHT);

interface ReadOnlyViewerProps {
  dataSource: DataSource;
  /** External total line count — drives virtualizer size for file mode. */
  totalLineCount?: number;
  scrollToLine?: number;
  jumpSeq?: number;
  tailMode?: boolean;
  gutterColumns?: GutterColumnDef[];
  lineDecorators?: LineDecoratorDef[];
  onLineClick?: (lineNum: number) => void;
  onSelectionChange?: (selection: Selection) => void;
  selection?: Selection;
  className?: string;
  /** Starting virtual-base line when a known data source is restored (e.g.
   *  switching back to a previously-viewed session). Avoids resetting to 0. */
  initialVirtualBase?: number;
  /** Written with the current virtualBase on every render so the parent can
   *  capture scroll position before a session switch. */
  virtualBaseOutRef?: React.MutableRefObject<number>;
}

export default function ReadOnlyViewer({
  dataSource,
  totalLineCount,
  scrollToLine,
  jumpSeq,
  tailMode,
  gutterColumns,
  lineDecorators,
  onLineClick,
  onSelectionChange,
  selection,
  className,
  initialVirtualBase,
  virtualBaseOutRef,
}: ReadOnlyViewerProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [newLinesCount, setNewLinesCount] = useState(0);

  // ── Cache version counter ───────────────────────────────────────────────
  // Bumped after every fetch completion or streaming append to trigger
  // a re-render so the virtualizer re-evaluates dataSource.getLine().
  const [, setCacheVersion] = useState(0);
  const bumpCacheVersion = () => setCacheVersion((v) => v + 1);
  const fetchGenRef = useRef(0);

  // Tracks whether the initial viewport fetch has been triggered for the
  // current data source. Reset on sourceId change. Used to force the
  // FetchScheduler on the first meaningful reportScroll.
  const initialFetchDoneRef = useRef(false);

  // Reset when data source changes.
  useEffect(() => {
    fetchGenRef.current++;
    fetchInFlightRef.current = false;
    initialFetchDoneRef.current = false;
    bumpCacheVersion();
  }, [dataSource.sourceId]);

  // ── Large-file virtual base ────────────────────────────────────────────
  const [virtualBase, setVirtualBase] = useState(0);
  const virtualBaseRef = useRef(0);
  const pendingScrollTarget = useRef<number | null>(null);

  // Sync the current position out so LogViewer can capture it during render
  // (before effects fire) when a session switch is about to happen.
  if (virtualBaseOutRef) virtualBaseOutRef.current = virtualBase;

  // Stable ref for the restore target — updated synchronously each render so
  // the sourceId reset effect always reads the up-to-date prop value.
  const initialVirtualBaseRef = useRef(initialVirtualBase ?? 0);
  initialVirtualBaseRef.current = initialVirtualBase ?? 0;

  // Reset the virtual window whenever a new data source is loaded.
  // Uses initialVirtualBase to restore a previously-saved scroll position
  // instead of always jumping to line 0.
  useEffect(() => {
    const base = initialVirtualBaseRef.current;
    virtualBaseRef.current = base;
    setVirtualBase(base);
    pendingScrollTarget.current = null;
  }, [dataSource.sourceId]);

  const autoScrollRef = useRef(true);
  const userScrollingDownRef = useRef(false);
  const lastSetScrollTopRef = useRef(-1);

  // ── Box selection state ─────────────────────────────────────────────────
  const charWidthRef = useRef(7.2);
  const gutterWidthRef = useRef(0);
  const boxDragging = useRef(false);
  const boxAnchor = useRef<{ line: number; col: number } | null>(null);
  const [boxSel, setBoxSel] = useState<{
    startLine: number; endLine: number; startCol: number; endCol: number;
  } | null>(null);

  // Re-enable auto-scroll when entering tail mode.
  useEffect(() => {
    if (tailMode) {
      autoScrollRef.current = true;
      setAutoScroll(true);
      setNewLinesCount(0);
      userScrollingDownRef.current = false;
      virtualBaseRef.current = 0;
      setVirtualBase(0);
    }
  }, [tailMode]);

  const totalLines = totalLineCount ?? dataSource.totalLines;

  const gutterWidth = useMemo(
    () => (gutterColumns ?? []).reduce((sum, col) => sum + col.width, 0),
    [gutterColumns],
  );
  useEffect(() => { gutterWidthRef.current = gutterWidth; }, [gutterWidth]);

  const effectiveCount = Math.min(Math.max(0, totalLines - virtualBase), MAX_VIRTUAL_LINES);

  const virtualizer = useVirtualizer({
    count: effectiveCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();

  // ── Char width measurement (once at mount) ─────────────────────────────
  useEffect(() => {
    const span = document.createElement('span');
    Object.assign(span.style, {
      position: 'fixed', top: '-9999px', visibility: 'hidden',
      whiteSpace: 'pre', fontSize: '12px', fontFamily: 'monospace',
    });
    const monoFont = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
    if (monoFont) span.style.fontFamily = monoFont;
    span.textContent = 'x'.repeat(100);
    document.body.appendChild(span);
    const w = span.offsetWidth;
    document.body.removeChild(span);
    if (w > 0) charWidthRef.current = w / 100;
  }, []);

  // ── Alt key → crosshair cursor (no React state, no re-renders) ─────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') parentRef.current?.classList.add(styles.altMode);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') parentRef.current?.classList.remove(styles.altMode);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // ── Scroll / interaction listeners ──────────────────────────────────────
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        userScrollingDownRef.current = false;
        autoScrollRef.current = false;
        setAutoScroll(false);
      } else if (e.deltaY > 0) {
        userScrollingDownRef.current = true;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) {
        userScrollingDownRef.current = false;
        autoScrollRef.current = false;
        setAutoScroll(false);
      } else if (['ArrowDown', 'PageDown', 'End'].includes(e.key)) {
        userScrollingDownRef.current = true;
      }
    };

    const onScroll = () => {
      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;

      if (nearBottom && !autoScrollRef.current && userScrollingDownRef.current) {
        userScrollingDownRef.current = false;
        autoScrollRef.current = true;
        setAutoScroll(true);
        setNewLinesCount(0);
      }
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  // ── Streaming: subscribe to appends ────────────────────────────────────
  const [streamTotal, setStreamTotal] = useState(dataSource.totalLines);

  useEffect(() => {
    setStreamTotal(dataSource.totalLines);
    if (!tailMode || !dataSource.onAppend) return;
    const unsubscribe = dataSource.onAppend((_newLines, total) => {
      // Lines are already in ViewCacheHandle via broadcastToSession().
      // Just update total and trigger re-render.
      setStreamTotal(total);
      bumpCacheVersion();
    });
    return unsubscribe;
  }, [dataSource, tailMode]);

  // Use streamTotal for streaming, dataSource.totalLines for file mode
  const liveTotalLines = tailMode ? streamTotal : totalLines;

  // ── Auto-scroll to bottom when new streaming lines arrive ──────────────
  const prevTotalRef = useRef(liveTotalLines);
  useEffect(() => {
    if (tailMode && !autoScrollRef.current) {
      const delta = liveTotalLines - prevTotalRef.current;
      if (delta > 0) setNewLinesCount((n) => n + delta);
    }
    prevTotalRef.current = liveTotalLines;
  }, [liveTotalLines, tailMode]);

  const liveEffectiveCount = Math.min(Math.max(0, liveTotalLines - virtualBase), MAX_VIRTUAL_LINES);

  useEffect(() => {
    if (!tailMode || !autoScrollRef.current || liveEffectiveCount === 0) return;
    const el = parentRef.current;
    if (!el) return;

    // Drift detection
    if (lastSetScrollTopRef.current >= 0) {
      const drift = Math.abs(el.scrollTop - lastSetScrollTopRef.current);
      if (drift > 2) {
        autoScrollRef.current = false;
        setAutoScroll(false);
        lastSetScrollTopRef.current = -1;
        return;
      }
    }

    el.scrollTop = el.scrollHeight;
    lastSetScrollTopRef.current = el.scrollTop;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEffectiveCount]);

  // ── File-mode: FetchScheduler-driven two-phase fetch ───────────────────
  const schedulerRef = useRef<FetchScheduler | null>(null);
  const fetchInFlightRef = useRef(false);

  useEffect(() => {
    schedulerRef.current = new FetchScheduler();
    return () => {
      schedulerRef.current?.dispose();
      schedulerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (!scheduler) return;
    // Reset on every rebind — ensures HMR / data source swap never leaves it stuck
    fetchInFlightRef.current = false;

    scheduler.onFetch((viewport: FetchRange, prefetch: FetchRange) => {
      if (tailMode) return; // streaming mode, skip file-fetch
      if (fetchInFlightRef.current) return;

      // Check viewport for cache misses via dataSource.getLine() → ViewCacheHandle
      let hasMiss = false;
      for (let line = viewport.offset; line < viewport.offset + viewport.count; line++) {
        if (!dataSource.getLine(line)) {
          hasMiss = true;
          break;
        }
      }

      if (!hasMiss) {
        // Viewport cached. Try prefetch.
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
              // Lines are now in ViewCacheHandle via dataSource.getLines().
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
      Promise.resolve(dataSource.getLines(viewport.offset, viewport.count))
        .then(() => {
          if (gen !== fetchGenRef.current) { fetchInFlightRef.current = false; return; }
          bumpCacheVersion();

          // Phase 2: directional prefetch
          const pfGen = fetchGenRef.current;
          Promise.resolve(dataSource.getLines(prefetch.offset, prefetch.count))
            .then(() => {
              if (pfGen !== fetchGenRef.current) return;
              bumpCacheVersion();
            })
            .catch(console.error)
            .finally(() => { fetchInFlightRef.current = false; });
        })
        .catch((err) => {
          console.error(err);
          fetchInFlightRef.current = false;
        });
    });

    // Safety net: flush any pending ranges that reportScroll may have queued
    // before this callback was bound (race between ResizeObserver timing and
    // effect execution order). The setTimeout(0) defers to after the current
    // React render + effects cycle so reportScroll has had a chance to fire.
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (!tailMode) {
      timer = setTimeout(() => { scheduler.forceFetch(); }, 0);
    }

    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [dataSource, tailMode]);

  // Report scroll position to the scheduler whenever visible items change.
  useEffect(() => {
    if (items.length === 0 || tailMode) return;
    const scheduler = schedulerRef.current;
    if (!scheduler) return;

    const first = items[0].index;
    const last = items[items.length - 1].index;
    const firstActual = virtualBase + first;
    const lastActual = virtualBase + last;

    scheduler.reportScroll(firstActual, lastActual, liveTotalLines);

    // On the first reportScroll for a new data source, force the scheduler
    // to bypass dedup. This handles edge cases where the initial fetch was
    // silently skipped due to timing between ResizeObserver and effect order.
    if (!initialFetchDoneRef.current) {
      initialFetchDoneRef.current = true;
      scheduler.forceFetch();
    }
  }, [items, dataSource, virtualBase, liveTotalLines]);

  // Scroll to a specific line when requested.
  useEffect(() => {
    if (scrollToLine == null || scrollToLine < 0) return;
    autoScrollRef.current = false;
    setAutoScroll(false);
    userScrollingDownRef.current = false;

    const relIndex = scrollToLine - virtualBaseRef.current;
    if (relIndex >= 0 && relIndex < MAX_VIRTUAL_LINES) {
      virtualizer.scrollToIndex(relIndex, { align: 'center' });
      schedulerRef.current?.forceFetch();
    } else {
      const half = Math.floor(MAX_VIRTUAL_LINES / 2);
      const newBase = Math.max(0, Math.min(scrollToLine - half, Math.max(0, liveTotalLines - MAX_VIRTUAL_LINES)));
      pendingScrollTarget.current = scrollToLine;
      virtualBaseRef.current = newBase;
      setVirtualBase(newBase);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToLine, jumpSeq]);

  // Deferred scroll after virtualBase change
  useEffect(() => {
    const target = pendingScrollTarget.current;
    if (target == null) return;
    const relIndex = target - virtualBaseRef.current;
    if (relIndex >= 0 && relIndex < MAX_VIRTUAL_LINES) {
      pendingScrollTarget.current = null;
      virtualizer.scrollToIndex(relIndex, { align: 'center' });
      schedulerRef.current?.forceFetch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualBase]);

  const handleLineClick = useCallback(
    (lineNum: number, e: React.MouseEvent) => {
      if (e.altKey) return;

      // Plain click after a drag-select: the user selected text within a line.
      // Don't activate line selection — let the browser own the copy.
      const hasTextSel = !!window.getSelection()?.toString();
      if (hasTextSel && !e.shiftKey && !e.ctrlKey && !e.metaKey) return;

      setBoxSel(null);
      // Clear any browser text selection so Ctrl+C unambiguously hits our handler.
      window.getSelection()?.removeAllRanges();

      // Notify selection change if handler provided
      if (onSelectionChange) {
        const sel = selection;
        if (e.shiftKey && sel?.anchor != null) {
          const lo = Math.min(sel.anchor, lineNum);
          const hi = Math.max(sel.anchor, lineNum);
          const newSelected = new Set<number>();
          for (let i = lo; i <= hi; i++) newSelected.add(i);
          onSelectionChange({ anchor: sel.anchor, selected: newSelected, mode: 'line' });
        } else if (e.ctrlKey || e.metaKey) {
          const newSelected = new Set(sel?.selected);
          if (newSelected.has(lineNum)) newSelected.delete(lineNum);
          else newSelected.add(lineNum);
          onSelectionChange({ anchor: lineNum, selected: newSelected, mode: 'line' });
        } else {
          onSelectionChange({ anchor: lineNum, selected: new Set([lineNum]), mode: 'line' });
        }
      }
      onLineClick?.(lineNum);
    },
    [onLineClick, onSelectionChange, selection],
  );

  // ── Box selection pointer handlers ──────────────────────────────────────
  const getLineColFromPointer = useCallback((clientX: number, clientY: number) => {
    const el = parentRef.current!;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top + el.scrollTop;
    const x = clientX - rect.left;
    const lineNum = virtualBaseRef.current + Math.max(0, Math.floor(y / LINE_HEIGHT));
    const col = Math.max(0, Math.floor((x - gutterWidthRef.current) / charWidthRef.current));
    return { lineNum, col };
  }, []);

  const handleViewerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.altKey) return;
      e.preventDefault();
      const { lineNum, col } = getLineColFromPointer(e.clientX, e.clientY);
      boxDragging.current = true;
      boxAnchor.current = { line: lineNum, col };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.classList.add(styles.dragging);
      onSelectionChange?.({ anchor: null, selected: new Set(), mode: 'line' });
      setBoxSel({ startLine: lineNum, endLine: lineNum, startCol: col, endCol: col });
    },
    [getLineColFromPointer, onSelectionChange],
  );

  const handleViewerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!boxDragging.current || !boxAnchor.current) return;
      const anchor = boxAnchor.current;
      const { lineNum, col } = getLineColFromPointer(e.clientX, e.clientY);
      setBoxSel({
        startLine: Math.min(anchor.line, lineNum),
        endLine: Math.max(anchor.line, lineNum),
        startCol: Math.min(anchor.col, col),
        endCol: Math.max(anchor.col, col),
      });
    },
    [getLineColFromPointer],
  );

  const handleViewerPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    boxDragging.current = false;
    boxAnchor.current = null;
    e.currentTarget.classList.remove(styles.dragging);
  }, []);

  // ── Ctrl+C copy handler for line and box selection ─────────────────────
  useEffect(() => {
    const hasSelection = boxSel != null || (selection?.selected.size ?? 0) > 0;
    if (!hasSelection) return;

    // Robust clipboard write: async Clipboard API with synchronous execCommand fallback.
    // navigator.clipboard can silently fail in Tauri WebView2 without the clipboard plugin.
    const writeClipboard = (text: string) => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
      } else {
        execCommandCopy(text);
      }
    };

    const execCommandCopy = (text: string) => {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(el);
      el.focus();
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    };

    const handleCopy = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
      // If the browser has a native text selection (user dragged within a line),
      // let the browser handle the copy — don't intercept.
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      if (boxSel) {
        const rows: string[] = [];
        for (let i = boxSel.startLine; i <= boxSel.endLine; i++) {
          rows.push((dataSource.getLine(i)?.raw ?? '').slice(boxSel.startCol, boxSel.endCol));
        }
        writeClipboard(rows.join('\n'));
      } else if (selection?.selected.size) {
        const sorted = Array.from(selection.selected).sort((a, b) => a - b);
        const text = sorted
          .map((n) => dataSource.getLine(n)?.raw)
          .filter(Boolean)
          .join('\n');
        writeClipboard(text);
      }
    };
    window.addEventListener('keydown', handleCopy);
    return () => window.removeEventListener('keydown', handleCopy);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, boxSel, dataSource]);

  if (liveTotalLines === 0) {
    return (
      <div className={`${styles.empty}${className ? ' ' + className : ''}`}>
        <p>No data available.</p>
      </div>
    );
  }

  const hasMoreAbove = virtualBase > 0;
  const hasMoreBelow = virtualBase + effectiveCount < liveTotalLines;

  return (
    <div className={`${styles.wrapper}${className ? ' ' + className : ''}`}>
      {hasMoreAbove && (
        <button
          className={`${styles.navButton} ${styles.navTop}`}
          onClick={() => {
            virtualBaseRef.current = 0;
            setVirtualBase(0);
          }}
          title="Jump to beginning of file"
        >
          Line 1
        </button>
      )}
      {tailMode && !autoScroll && newLinesCount > 0 && (
        <button
          className={styles.newLinesBadge}
          onClick={() => {
            autoScrollRef.current = true;
            setAutoScroll(true);
            setNewLinesCount(0);
            const el = parentRef.current;
            if (el) {
              el.scrollTop = el.scrollHeight;
              lastSetScrollTopRef.current = el.scrollTop;
            }
          }}
        >
          {newLinesCount > 999 ? '999+' : newLinesCount} new line{newLinesCount !== 1 ? 's' : ''} below
        </button>
      )}
      {hasMoreBelow && (
        <button
          className={`${styles.navButton} ${styles.navBottom}`}
          onClick={() => {
            const newBase = Math.min(
              virtualBase + MAX_VIRTUAL_LINES,
              Math.max(0, liveTotalLines - MAX_VIRTUAL_LINES),
            );
            pendingScrollTarget.current = newBase;
            virtualBaseRef.current = newBase;
            setVirtualBase(newBase);
          }}
          title="Continue to next section of file"
        >
          Line {(virtualBase + MAX_VIRTUAL_LINES + 1).toLocaleString()}
        </button>
      )}
      <div
        ref={parentRef}
        className={styles.viewer}
        onPointerDown={handleViewerPointerDown}
        onPointerMove={handleViewerPointerMove}
        onPointerUp={handleViewerPointerUp}
        onPointerCancel={handleViewerPointerUp}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {items.map((virtualItem) => {
            const actualLineNum = virtualBase + virtualItem.index;
            const line = dataSource.getLine(actualLineNum);
            const isTarget = scrollToLine != null && actualLineNum === scrollToLine;
            const isLineSelected = boxSel == null && (selection?.selected.has(actualLineNum) ?? false);
            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: virtualItem.start,
                  left: 0,
                  width: '100%',
                  height: virtualItem.size,
                  overflow: 'hidden',
                }}
              >
                {line ? (
                  <TextLine
                    line={line}
                    lineHeight={LINE_HEIGHT}
                    gutterColumns={gutterColumns}
                    decorators={lineDecorators}
                    isSelected={isLineSelected}
                    isJumpTarget={isTarget}
                    jumpSeq={isTarget ? jumpSeq : undefined}
                    onClick={handleLineClick}
                  />
                ) : (
                  <TextLineSkeleton lineNum={actualLineNum} lineHeight={LINE_HEIGHT} />
                )}
              </div>
            );
          })}
          {boxSel && boxSel.endCol > boxSel.startCol && (
            <div
              className={styles.boxOverlay}
              style={{
                position: 'absolute',
                top: (boxSel.startLine - virtualBase) * LINE_HEIGHT,
                height: (boxSel.endLine - boxSel.startLine + 1) * LINE_HEIGHT,
                left: gutterWidthRef.current + boxSel.startCol * charWidthRef.current,
                width: (boxSel.endCol - boxSel.startCol) * charWidthRef.current,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
