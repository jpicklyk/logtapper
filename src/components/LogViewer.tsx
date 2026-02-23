import { useRef, useCallback, useEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ViewLine, SearchQuery, LineWindow } from '../bridge/types';
import LogLine from './LogLine';

const LINE_HEIGHT = 22; // px — monospace, single line
const OVERSCAN = 10;
const FETCH_THRESHOLD = 2000; // lines to pre-fetch beyond visible range (each side)
const AT_BOTTOM_THRESHOLD = 60; // px from bottom to consider "at bottom"

// Chrome/Edge cap their DOM scrollHeight at 2^25 px. Beyond this the native
// scrollbar stops working. We keep the virtualizer's total height inside this
// limit by using a sliding "virtual base" offset for large files.
const MAX_BROWSER_SCROLL_PX = 33_554_428; // 2^25 − a few px (Chrome/Edge)
const MAX_VIRTUAL_LINES = Math.floor(MAX_BROWSER_SCROLL_PX / LINE_HEIGHT); // ≈1,525,201

interface Props {
  sessionId: string;
  totalLines: number;
  /** Streaming-only cache: holds lines from ADB batch events. Only used when isStreaming. */
  streamCache: Map<number, ViewLine>;
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
}

export default function LogViewer({
  sessionId,
  totalLines,
  streamCache,
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
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [, setAutoScroll] = useState(true);

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
  const lastProgrammaticScrollMs = useRef(0);
  const lastManualScrollUpMs = useRef(0);

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

    const PROGRAMMATIC_GUARD_MS = 150;
    const MANUAL_SCROLL_GUARD_MS = 600;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        lastManualScrollUpMs.current = Date.now();
        autoScrollRef.current = false;
        setAutoScroll(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) {
        lastManualScrollUpMs.current = Date.now();
        autoScrollRef.current = false;
        setAutoScroll(false);
      }
    };

    const onScroll = () => {
      const now = Date.now();
      if (now - lastProgrammaticScrollMs.current < PROGRAMMATIC_GUARD_MS) return;

      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;

      if (!nearBottom && autoScrollRef.current) {
        lastManualScrollUpMs.current = now;
        autoScrollRef.current = false;
        setAutoScroll(false);
        return;
      }

      if (nearBottom && !autoScrollRef.current) {
        if (now - lastManualScrollUpMs.current < MANUAL_SCROLL_GUARD_MS) return;
        autoScrollRef.current = true;
        setAutoScroll(true);
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
  useEffect(() => {
    if (!isStreaming || !autoScrollRef.current || effectiveCount === 0) return;
    lastProgrammaticScrollMs.current = Date.now();
    virtualizer.scrollToIndex(effectiveCount - 1, { align: 'end' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCount]);

  // ── File-mode: fetch visible lines from backend on scroll ────────────────────
  const lastFetchRef = useRef({ offset: -1, count: 0 });

  // When the filter result changes, allow new fetches but do NOT clear the cache.
  // The cache is keyed by actual file line numbers which remain valid as the
  // filter result grows or changes. Clearing would cause placeholder flicker.
  useEffect(() => {
    lastFetchRef.current = { offset: -1, count: 0 };
  }, [lineNumbers]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    if (items.length === 0) return;
    // Streaming: all lines arrive via batch events — no fetching needed.
    if (isStreaming) return;

    rafRef.current = requestAnimationFrame(() => {
      const first = items[0].index;
      const last = items[items.length - 1].index;
      const map = visibleLinesRef.current;

      let fetchOffset: number;
      let fetchCount: number;

      if (lineNumbers) {
        // File mode with filter active: visible virtualizer indices map to actual
        // line numbers via lineNumbers[]. Check those for cache misses.
        let hasMiss = false;
        for (let i = first; i <= last; i++) {
          if (!map.has(lineNumbers[i])) {
            hasMiss = true;
            break;
          }
        }
        if (!hasMiss) return;

        const firstActual = lineNumbers[first];
        const lastActual = lineNumbers[Math.min(last, lineNumbers.length - 1)];
        fetchOffset = Math.max(0, firstActual - FETCH_THRESHOLD);
        fetchCount = lastActual - fetchOffset + FETCH_THRESHOLD * 2;
      } else {
        // Full file mode: virtualizer indices are relative to virtualBase.
        let hasMiss = false;
        for (let i = first; i <= last; i++) {
          if (!map.has(virtualBase + i)) {
            hasMiss = true;
            break;
          }
        }
        if (!hasMiss) return;

        fetchOffset = Math.max(0, virtualBase + first - FETCH_THRESHOLD);
        fetchCount = (virtualBase + last) - fetchOffset + FETCH_THRESHOLD * 2;
      }

      if (
        fetchOffset !== lastFetchRef.current.offset ||
        fetchCount !== lastFetchRef.current.count
      ) {
        lastFetchRef.current = { offset: fetchOffset, count: fetchCount };
        const gen = fetchGenRef.current;
        fetchLines(fetchOffset, fetchCount)
          .then((window: LineWindow) => {
            // Discard stale fetches from a previous session/mode
            if (gen !== fetchGenRef.current) return;
            // Mutate in place — no O(N) copy. Bump version to trigger re-render.
            // Key by lineNum (actual file line number), NOT virtualIndex which
            // is window-relative and resets to 0 for each fetch — using it would
            // overwrite earlier entries with wrong content.
            const m = visibleLinesRef.current;
            for (const line of window.lines) {
              m.set(line.lineNum, line);
            }
            setVisibleVersion((v) => v + 1);
          })
          .catch(console.error);
      }
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  // Note: visibleLinesRef is a ref — not in deps. The effect re-runs when
  // items/virtualBase change (scroll), which is when we need to check for misses.
  }, [items, isStreaming, lineNumbers, virtualBase, fetchLines]);

  // Scroll to a specific line when requested (jumpToLine / search navigation).
  useEffect(() => {
    if (scrollToLine == null || scrollToLine < 0) return;
    autoScrollRef.current = false;
    setAutoScroll(false);
    lastManualScrollUpMs.current = Date.now();

    if (lineNumbers) {
      const pos = lineNumbers.indexOf(scrollToLine);
      if (pos !== -1) virtualizer.scrollToIndex(pos, { align: 'center' });
      return;
    }

    const relIndex = scrollToLine - virtualBaseRef.current;
    if (relIndex >= 0 && relIndex < MAX_VIRTUAL_LINES) {
      virtualizer.scrollToIndex(relIndex, { align: 'center' });
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
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualBase]);

  const handleLineClick = useCallback(
    (lineNum: number) => onLineClick?.(lineNum),
    [onLineClick],
  );

  // Choose the data source based on mode.
  // When a file-mode filter is active, prefer filterLineCache (pre-populated
  // during the scan) so lines render instantly without on-demand fetching.
  const lineSource = isStreaming
    ? streamCache
    : (lineNumbers && filterLineCache && filterLineCache.size > 0)
      ? filterLineCache
      : visibleLinesRef.current;

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
          const line = lineSource.get(actualLineNum);
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
                />
              ) : (
                <div className="log-line log-line-loading" style={{ height: LINE_HEIGHT }}>
                  <span className="log-linenum">
                    {String(actualLineNum + 1).padStart(7, ' ')}
                  </span>
                  <span className="log-loading-indicator">…</span>
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
