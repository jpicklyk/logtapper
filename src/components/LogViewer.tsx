import { useRef, useCallback, useEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ViewLine, SearchQuery, LineWindow } from '../bridge/types';
import type { ViewCacheHandle } from '../cache';
import { FetchScheduler } from '../cache';
import type { FetchRange } from '../cache';
import LogLine from './LogLine';

const LINE_HEIGHT = 22; // px — monospace, single line
const OVERSCAN = 10;
const AT_BOTTOM_THRESHOLD = 60; // px from bottom to consider "at bottom"

// Chrome/Edge cap their DOM scrollHeight at 2^25 px. Beyond this the native
// scrollbar stops working. We keep the virtualizer's total height inside this
// limit by using a sliding "virtual base" offset for large files.
const MAX_BROWSER_SCROLL_PX = 33_554_428; // 2^25 − a few px (Chrome/Edge)
const MAX_VIRTUAL_LINES = Math.floor(MAX_BROWSER_SCROLL_PX / LINE_HEIGHT); // ≈1,525,201

/** Selection state for multi-line selection. */
export interface Selection {
  anchor: number | null;
  selected: Set<number>;
}

interface Props {
  sessionId: string;
  totalLines: number;
  /** Fetch lines from backend for file mode. Returns a LineWindow. */
  fetchLines: (offset: number, count: number) => Promise<LineWindow>;
  search?: SearchQuery;
  onLineClick?: (lineNum: number) => void;
  scrollToLine?: number;
  /** Incremented on every jumpToLine call; ensures repeated jumps to the same
   *  line re-trigger the scroll effect and re-flash the highlight. */
  jumpSeq?: number;
  /** When set, the viewer is in Processor mode for this processor */
  processorId?: string;
  /** True when an ADB stream is active — enables auto-scroll-to-bottom */
  isStreaming?: boolean;
  /**
   * When provided, the virtualizer shows only these line numbers in order.
   * virtualItem.index maps to lineNumbers[index] for cache lookup.
   * Used when a stream filter is active.
   */
  lineNumbers?: number[];
  /** Pre-populated cache of ViewLine objects for all filter matches (file mode).
   *  When provided, LogViewer uses this instead of fetching on demand. */
  filterLineCache?: Map<number, ViewLine>;
  /** Set of line numbers that have a StateTracker transition — shows gutter dot. */
  transitionLineNums?: Set<number>;
  /** lineNum → list of tracker IDs that transitioned on that line. */
  transitionsByLine?: Record<number, string[]>;
  /** Optional global cache handle — when provided, fetched lines are stored here
   *  and cache misses fall through to fetchLines. */
  viewCache?: ViewCacheHandle | null;
  /** Multi-line selection state. */
  selection?: Selection;
  /** Called when a line is selected (click, shift-click, ctrl-click). */
  onLineSelect?: (lineNum: number, e: React.MouseEvent) => void;
}

export default function LogViewer({
  sessionId,
  totalLines,
  fetchLines,
  onLineClick,
  scrollToLine,
  jumpSeq,
  processorId,
  isStreaming,
  lineNumbers,
  filterLineCache,
  transitionLineNums,
  transitionsByLine,
  viewCache,
  selection,
  onLineSelect,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [newLinesCount, setNewLinesCount] = useState(0);

  // ── File-mode visible lines ──────────────────────────────────────────────────
  // In file mode, LogViewer fetches lines on demand. We use a ref (mutated in
  // place) + a version counter to trigger re-renders. This avoids O(N) Map
  // copies that the previous useState<Map> approach caused on every fetch.
  const visibleLinesRef = useRef<Map<number, ViewLine>>(new Map());
  const [, setVisibleVersion] = useState(0);
  const fetchGenRef = useRef(0); // generation counter to discard stale fetches

  // Reset visible lines when session or processor view changes
  useEffect(() => {
    fetchGenRef.current++;
    visibleLinesRef.current = new Map();
    setVisibleVersion((v) => v + 1);
  }, [sessionId, processorId]);

  // ── Large-file virtual base ──────────────────────────────────────────────────
  const [virtualBase, setVirtualBase] = useState(0);
  const virtualBaseRef = useRef(0);
  const pendingScrollTarget = useRef<number | null>(null);

  // Reset the virtual window whenever a new session is loaded.
  useEffect(() => {
    virtualBaseRef.current = 0;
    setVirtualBase(0);
    pendingScrollTarget.current = null;
  }, [sessionId]);

  const autoScrollRef = useRef(true);
  const userScrollingDownRef = useRef(false);

  // When lineNumbers is provided (filter active), use its length as the count.
  const count = lineNumbers ? lineNumbers.length : totalLines;

  // effectiveCount keeps the virtualizer's total height inside browser limits.
  const effectiveCount = lineNumbers
    ? lineNumbers.length
    : Math.min(Math.max(0, totalLines - virtualBase), MAX_VIRTUAL_LINES);

  const virtualizer = useVirtualizer({
    count: effectiveCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();

  // ── Scroll / interaction listeners ──────────────────────────────────────────
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // Scrolling up — immediately disable auto-scroll
        userScrollingDownRef.current = false;
        autoScrollRef.current = false;
        setAutoScroll(false);
      } else if (e.deltaY > 0) {
        // Scrolling down — track for re-engagement at bottom
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

    // onScroll detects scrollbar drags and other non-wheel scroll input.
    // This is the PRIMARY mechanism for disabling auto-scroll during
    // scrollbar drags — pointerdown does NOT fire for scrollbar interaction
    // in WebView2 (Windows).
    const onScroll = () => {
      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;

      // Disable auto-scroll when user scrolls away from bottom.
      if (!nearBottom && autoScrollRef.current) {
        autoScrollRef.current = false;
        setAutoScroll(false);
        return;
      }

      // Re-engage auto-scroll ONLY when the user actively scrolled DOWN
      // to the bottom (not from content growth pushing the threshold).
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

  // ── Auto-scroll to bottom when new streaming lines arrive ────────────────────
  const prevTotalRef = useRef(totalLines);
  useEffect(() => {
    if (isStreaming && !autoScrollRef.current) {
      const delta = totalLines - prevTotalRef.current;
      if (delta > 0) setNewLinesCount((n) => n + delta);
    }
    prevTotalRef.current = totalLines;
  }, [totalLines, isStreaming]);

  useEffect(() => {
    if (!isStreaming || !autoScrollRef.current || effectiveCount === 0) return;
    const el = parentRef.current;
    if (!el) return;
    // Defer to rAF so the browser processes pending scroll events first.
    // onScroll will detect a user's scrollbar drag and clear autoScrollRef
    // before the rAF callback checks it.
    // No cleanup — letting stale rAFs fire is harmless (scroll-to-bottom is
    // idempotent) and avoids StrictMode double-mount cancelling the rAF.
    requestAnimationFrame(() => {
      if (!autoScrollRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCount]);

  // ── File-mode: FetchScheduler-driven two-phase fetch ─────────────────────────
  const schedulerRef = useRef<FetchScheduler | null>(null);
  const fetchInFlightRef = useRef(false);

  // Create scheduler once on mount, dispose on unmount.
  useEffect(() => {
    schedulerRef.current = new FetchScheduler();
    return () => {
      schedulerRef.current?.dispose();
      schedulerRef.current = null;
    };
  }, []);

  // Register the fetch callback. Recreated when dependencies change so it
  // captures current refs/props. The scheduler stores only the latest callback.
  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (!scheduler) return;

    scheduler.onFetch((viewport: FetchRange, prefetch: FetchRange) => {
      if (isStreaming) return;
      if (fetchInFlightRef.current) return; // wait for current fetch to finish

      const map = visibleLinesRef.current;

      // Check cache misses in the viewport range
      let hasMiss = false;
      const vpStart = viewport.offset;
      const vpEnd = viewport.offset + viewport.count;
      for (let line = vpStart; line < vpEnd; line++) {
        // In filter mode, viewport offset/count are actual line numbers.
        // In full mode, they are actual line numbers (virtualBase + index).
        if (!map.has(line) && !(viewCache?.get(line))) {
          hasMiss = true;
          break;
        }
      }

      if (!hasMiss) {
        // Viewport is cached. Try prefetch only if allowed.
        if (viewCache?.prefetchAllowed()) {
          let hasPrefetchMiss = false;
          const pfStart = prefetch.offset;
          const pfEnd = prefetch.offset + prefetch.count;
          for (let line = pfStart; line < pfEnd; line++) {
            if (!map.has(line) && !(viewCache?.get(line))) {
              hasPrefetchMiss = true;
              break;
            }
          }
          if (hasPrefetchMiss) {
            fetchInFlightRef.current = true;
            const gen = fetchGenRef.current;
            fetchLines(prefetch.offset, prefetch.count)
              .then((window: LineWindow) => {
                if (gen !== fetchGenRef.current) return;
                // Prefetch: populate viewCache only, not visibleLinesRef
                if (viewCache) {
                  viewCache.put(window.lines);
                }
                // Also put in visibleLinesRef for immediate availability
                const m = visibleLinesRef.current;
                for (const l of window.lines) {
                  m.set(l.lineNum, l);
                }
                setVisibleVersion((v) => v + 1);
              })
              .catch(console.error)
              .finally(() => { fetchInFlightRef.current = false; });
          }
        }
        return;
      }

      // Phase 1: viewport fill
      fetchInFlightRef.current = true;
      const gen = fetchGenRef.current;
      fetchLines(viewport.offset, viewport.count)
        .then((window: LineWindow) => {
          if (gen !== fetchGenRef.current) return;
          const m = visibleLinesRef.current;
          for (const l of window.lines) {
            m.set(l.lineNum, l);
          }
          if (viewCache) {
            viewCache.put(window.lines);
          }
          setVisibleVersion((v) => v + 1);

          // Phase 2: directional prefetch (after viewport fill completes)
          if (viewCache?.prefetchAllowed()) {
            const pfGen = fetchGenRef.current;
            fetchLines(prefetch.offset, prefetch.count)
              .then((pfWindow: LineWindow) => {
                if (pfGen !== fetchGenRef.current) return;
                const pm = visibleLinesRef.current;
                for (const l of pfWindow.lines) {
                  pm.set(l.lineNum, l);
                }
                if (viewCache) {
                  viewCache.put(pfWindow.lines);
                }
                setVisibleVersion((v) => v + 1);
              })
              .catch(console.error)
              .finally(() => { fetchInFlightRef.current = false; });
          } else {
            fetchInFlightRef.current = false;
          }
        })
        .catch((err) => {
          console.error(err);
          fetchInFlightRef.current = false;
        });
    });
  }, [isStreaming, lineNumbers, fetchLines, viewCache]);

  // Report scroll position to the scheduler whenever visible items change.
  useEffect(() => {
    if (items.length === 0 || isStreaming) return;
    const scheduler = schedulerRef.current;
    if (!scheduler) return;

    const first = items[0].index;
    const last = items[items.length - 1].index;

    let firstActual: number;
    let lastActual: number;

    if (lineNumbers) {
      firstActual = lineNumbers[first];
      lastActual = lineNumbers[Math.min(last, lineNumbers.length - 1)];
    } else {
      firstActual = virtualBase + first;
      lastActual = virtualBase + last;
    }

    scheduler.reportScroll(firstActual, lastActual, totalLines);
  }, [items, isStreaming, lineNumbers, virtualBase, totalLines]);

  // Scroll to a specific line when requested (jumpToLine / search navigation).
  useEffect(() => {
    if (scrollToLine == null || scrollToLine < 0) return;
    autoScrollRef.current = false;
    setAutoScroll(false);
    userScrollingDownRef.current = false;

    if (lineNumbers) {
      const pos = lineNumbers.indexOf(scrollToLine);
      if (pos !== -1) {
        virtualizer.scrollToIndex(pos, { align: 'center' });
        schedulerRef.current?.forceFetch();
      }
      return;
    }

    const relIndex = scrollToLine - virtualBaseRef.current;
    if (relIndex >= 0 && relIndex < MAX_VIRTUAL_LINES) {
      virtualizer.scrollToIndex(relIndex, { align: 'center' });
      schedulerRef.current?.forceFetch();
    } else {
      const half = Math.floor(MAX_VIRTUAL_LINES / 2);
      const newBase = Math.max(0, Math.min(scrollToLine - half, Math.max(0, totalLines - MAX_VIRTUAL_LINES)));
      pendingScrollTarget.current = scrollToLine;
      virtualBaseRef.current = newBase;
      setVirtualBase(newBase);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToLine, jumpSeq, lineNumbers]);

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
      if (onLineSelect) onLineSelect(lineNum, e);
      onLineClick?.(lineNum);
    },
    [onLineClick, onLineSelect],
  );

  // Choose the data source based on mode.
  // When a file-mode filter is active, prefer filterLineCache (pre-populated
  // during the scan) so lines render instantly without on-demand fetching.
  // The viewCache provides a secondary lookup for cache hits from the global manager.
  // During streaming, visibleLinesRef is empty, so getLine falls through to viewCache.
  const primarySource = (lineNumbers && filterLineCache && filterLineCache.size > 0)
    ? filterLineCache
    : visibleLinesRef.current;

  // Combined lookup: primary source first, then viewCache fallback
  const getLine = (lineNum: number): ViewLine | undefined => {
    return primarySource.get(lineNum) ?? viewCache?.get(lineNum);
  };

  // ── Ctrl+C copy handler for multi-line selection ──────────────────────────────
  useEffect(() => {
    if (!selection || selection.selected.size === 0) return;
    const handleCopy = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        const sorted = Array.from(selection.selected).sort((a, b) => a - b);
        const text = sorted
          .map((n) => {
            const line = primarySource.get(n) ?? viewCache?.get(n);
            return line?.raw;
          })
          .filter(Boolean)
          .join('\n');
        navigator.clipboard.writeText(text);
      }
    };
    window.addEventListener('keydown', handleCopy);
    return () => window.removeEventListener('keydown', handleCopy);
  }, [selection, primarySource, viewCache]);

  if (count === 0) {
    if (lineNumbers) {
      return (
        <div className="log-viewer-empty">
          <p>No lines match the current filter.</p>
        </div>
      );
    }
    return (
      <div className="log-viewer-empty">
        <p>No log file loaded. Open a file to begin.</p>
      </div>
    );
  }

  const hasMoreBelow = !lineNumbers && virtualBase + effectiveCount < totalLines;
  const hasMoreAbove = !lineNumbers && virtualBase > 0;

  return (
    <div className="log-viewer-wrapper">
      {hasMoreAbove && (
        <button
          className="log-viewer-nav log-viewer-nav--top"
          onClick={() => {
            virtualBaseRef.current = 0;
            setVirtualBase(0);
          }}
          title="Jump to beginning of file"
        >
          ↑ Line 1
        </button>
      )}
      {isStreaming && !autoScroll && newLinesCount > 0 && (
        <button
          className="new-lines-badge"
          onClick={() => {
            autoScrollRef.current = true;
            setAutoScroll(true);
            setNewLinesCount(0);
            const el = parentRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          {newLinesCount > 999 ? '999+' : newLinesCount} new line{newLinesCount !== 1 ? 's' : ''} below
        </button>
      )}
      {hasMoreBelow && (
        <button
          className="log-viewer-nav log-viewer-nav--bottom"
          onClick={() => {
            const newBase = Math.min(
              virtualBase + MAX_VIRTUAL_LINES,
              Math.max(0, totalLines - MAX_VIRTUAL_LINES),
            );
            pendingScrollTarget.current = newBase;
            virtualBaseRef.current = newBase;
            setVirtualBase(newBase);
          }}
          title="Continue to next section of file"
        >
          ↓ Line {(virtualBase + MAX_VIRTUAL_LINES + 1).toLocaleString()}
        </button>
      )}
    <div ref={parentRef} className="log-viewer">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {items.map((virtualItem) => {
          const actualLineNum = lineNumbers
            ? lineNumbers[virtualItem.index]
            : virtualBase + virtualItem.index;
          const line = getLine(actualLineNum);
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
                <LogLine
                  line={line}
                  style={{ height: LINE_HEIGHT }}
                  onClick={handleLineClick}
                  isJumpTarget={isTarget}
                  jumpSeq={isTarget ? jumpSeq : undefined}
                  hasTransition={transitionLineNums?.has(actualLineNum)}
                  transitionTrackers={transitionsByLine?.[actualLineNum]}
                  isSelected={selection?.selected.has(actualLineNum)}
                />
              ) : (
                <div className="log-line log-line-skeleton" style={{ height: LINE_HEIGHT }}>
                  <span className="log-linenum">
                    {String(actualLineNum + 1).padStart(7, ' ')}
                  </span>
                  <span className="log-skeleton-bar" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
    </div>
  );
}
