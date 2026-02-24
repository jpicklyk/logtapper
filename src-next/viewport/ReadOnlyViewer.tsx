import { useRef, useCallback, useEffect, useState } from 'react';
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
  scrollToLine?: number;
  jumpSeq?: number;
  tailMode?: boolean;
  gutterColumns?: GutterColumnDef[];
  lineDecorators?: LineDecoratorDef[];
  onLineClick?: (lineNum: number) => void;
  onSelectionChange?: (selection: Selection) => void;
  selection?: Selection;
  className?: string;
}

export default function ReadOnlyViewer({
  dataSource,
  scrollToLine,
  jumpSeq,
  tailMode,
  gutterColumns,
  lineDecorators,
  onLineClick,
  onSelectionChange,
  selection,
  className,
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

  // Reset when data source changes.
  useEffect(() => {
    fetchGenRef.current++;
    bumpCacheVersion();
  }, [dataSource.sourceId]);

  // ── Large-file virtual base ────────────────────────────────────────────
  const [virtualBase, setVirtualBase] = useState(0);
  const virtualBaseRef = useRef(0);
  const pendingScrollTarget = useRef<number | null>(null);

  // Reset the virtual window whenever a new data source is loaded.
  useEffect(() => {
    virtualBaseRef.current = 0;
    setVirtualBase(0);
    pendingScrollTarget.current = null;
  }, [dataSource.sourceId]);

  const autoScrollRef = useRef(true);
  const userScrollingDownRef = useRef(false);
  const lastSetScrollTopRef = useRef(-1);

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

  const totalLines = dataSource.totalLines;

  const effectiveCount = Math.min(Math.max(0, totalLines - virtualBase), MAX_VIRTUAL_LINES);

  const virtualizer = useVirtualizer({
    count: effectiveCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();

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
    if (!dataSource.onAppend) return;
    const unsubscribe = dataSource.onAppend((_newLines, total) => {
      // Lines are already in ViewCacheHandle via broadcastToSession().
      // Just update total and trigger re-render.
      setStreamTotal(total);
      bumpCacheVersion();
    });
    return unsubscribe;
  }, [dataSource]);

  // Use streamTotal for streaming, dataSource.totalLines for file mode
  const liveTotalLines = dataSource.onAppend ? streamTotal : totalLines;

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

    scheduler.onFetch((viewport: FetchRange, prefetch: FetchRange) => {
      if (dataSource.onAppend) return; // streaming mode, skip file-fetch
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
          if (gen !== fetchGenRef.current) return;
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
  }, [dataSource]);

  // Report scroll position to the scheduler whenever visible items change.
  useEffect(() => {
    if (items.length === 0 || dataSource.onAppend) return;
    const scheduler = schedulerRef.current;
    if (!scheduler) return;

    const first = items[0].index;
    const last = items[items.length - 1].index;
    const firstActual = virtualBase + first;
    const lastActual = virtualBase + last;

    scheduler.reportScroll(firstActual, lastActual, liveTotalLines);
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

  // ── Ctrl+C copy handler for multi-line selection ───────────────────────
  useEffect(() => {
    if (!selection || selection.selected.size === 0) return;
    const handleCopy = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        const sorted = Array.from(selection.selected).sort((a, b) => a - b);
        const text = sorted
          .map((n) => dataSource.getLine(n)?.raw)
          .filter(Boolean)
          .join('\n');
        navigator.clipboard.writeText(text);
      }
    };
    window.addEventListener('keydown', handleCopy);
    return () => window.removeEventListener('keydown', handleCopy);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, dataSource]);

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
      <div ref={parentRef} className={styles.viewer}>
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
            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                {line ? (
                  <TextLine
                    line={line}
                    lineHeight={LINE_HEIGHT}
                    gutterColumns={gutterColumns}
                    decorators={lineDecorators}
                    isSelected={selection?.selected.has(actualLineNum)}
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
        </div>
      </div>
    </div>
  );
}
