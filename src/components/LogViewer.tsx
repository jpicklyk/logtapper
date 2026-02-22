import { useRef, useCallback, useEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ViewLine, SearchQuery } from '../bridge/types';
import LogLine from './LogLine';

const LINE_HEIGHT = 22; // px — monospace, single line
const OVERSCAN = 10;
const FETCH_THRESHOLD = 150; // fetch when within this many lines of window edge
const AT_BOTTOM_THRESHOLD = 60; // px from bottom to consider "at bottom"

interface Props {
  sessionId: string;
  totalLines: number;
  /** Cache of already-fetched lines keyed by line number */
  lineCache: Map<number, ViewLine>;
  search?: SearchQuery;
  onFetchNeeded: (offset: number, count: number) => void;
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
  /** Set of line numbers that have a StateTracker transition — shows gutter dot. */
  transitionLineNums?: Set<number>;
  /** lineNum → list of tracker IDs that transitioned on that line. */
  transitionsByLine?: Record<number, string[]>;
}

export default function LogViewer({
  totalLines,
  lineCache,
  onFetchNeeded,
  onLineClick,
  scrollToLine,
  jumpSeq,
  isStreaming,
  lineNumbers,
  transitionLineNums,
  transitionsByLine,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [, setAutoScroll] = useState(true);
  // Ref mirrors autoScroll state so the totalLines effect reads it synchronously,
  // avoiding the race where React hasn't re-rendered yet when the next batch arrives.
  const autoScrollRef = useRef(true);
  // Timestamp of the last programmatic scrollToIndex call (ms). Used to ignore
  // the async scroll event it fires — which can arrive after a wheel-up event
  // and would otherwise re-enable auto-scroll the user just turned off.
  const lastProgrammaticScrollMs = useRef(0);
  // Timestamp of the last manual wheel-up or keyboard-up event. Prevents onScroll
  // from re-enabling auto-scroll when the user is still near the bottom (< threshold)
  // immediately after a small upward scroll — the classic "near-bottom race."
  const lastManualScrollUpMs = useRef(0);

  // When lineNumbers is provided (filter active), use its length as the count.
  // This allows the virtualizer to only show filtered lines.
  const count = lineNumbers ? lineNumbers.length : totalLines;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();

  // ── Scroll / interaction listeners ──────────────────────────────────────────
  //
  // DISABLE: onScroll disables auto-scroll whenever the view is not near the
  // bottom (covers wheel, scrollbar drag, touch, momentum — all mechanisms).
  // onWheel and onKeyDown additionally set lastManualScrollUpMs immediately,
  // before the scroll position has changed, to handle the near-bottom race case
  // where the view is still within AT_BOTTOM_THRESHOLD after a tiny upward scroll.
  //
  // RE-ENABLE: onScroll re-enables when near bottom AND the 600ms manual-scroll
  // guard has expired. Programmatic scrolls (scrollToIndex) set
  // lastProgrammaticScrollMs and are ignored entirely during the 150ms window.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const PROGRAMMATIC_GUARD_MS = 150;
    const MANUAL_SCROLL_GUARD_MS = 600;

    // Wheel scroll up → disable immediately (fires before position changes).
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        lastManualScrollUpMs.current = Date.now();
        autoScrollRef.current = false;
        setAutoScroll(false);
      }
    };

    // Keyboard up → disable immediately.
    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) {
        lastManualScrollUpMs.current = Date.now();
        autoScrollRef.current = false;
        setAutoScroll(false);
      }
    };

    // Handle all scroll events: disable when moved away from bottom (any mechanism),
    // re-enable when back near bottom (with manual-scroll guard).
    const onScroll = () => {
      const now = Date.now();
      // Ignore scroll events caused by our own programmatic scrollToIndex calls.
      if (now - lastProgrammaticScrollMs.current < PROGRAMMATIC_GUARD_MS) return;

      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;

      // Disable auto-scroll whenever the view is not near the bottom — this catches
      // scrollbar drags, touch/trackpad momentum, and any mechanism not covered by
      // the wheel/keydown handlers.
      if (!nearBottom && autoScrollRef.current) {
        lastManualScrollUpMs.current = now;
        autoScrollRef.current = false;
        setAutoScroll(false);
        return;
      }

      // Re-enable when user scrolls back near bottom, but only after the manual-scroll
      // guard window has expired (prevents near-bottom race: user barely scrolls up,
      // still within threshold, scroll event fires and immediately re-enables).
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
    if (!isStreaming || !autoScrollRef.current || count === 0) return;
    lastProgrammaticScrollMs.current = Date.now();
    virtualizer.scrollToIndex(count - 1, { align: 'end' });
  // Depends on `count` (filtered or total) so we fire once per new batch.
  // autoScrollRef / lastProgrammaticScrollMs are refs — no need to list them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  // Fetch missing windows as the user scrolls
  const lastFetchRef = useRef({ offset: -1, count: 0 });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    if (items.length === 0) return;
    // Streaming with filter: all lines arrive via batch events — no fetching needed.
    if (lineNumbers && isStreaming) return;

    rafRef.current = requestAnimationFrame(() => {
      const first = items[0].index;
      const last = items[items.length - 1].index;

      let fetchOffset: number;
      let fetchCount: number;

      if (lineNumbers) {
        // File mode with filter active: visible virtualizer indices map to actual
        // line numbers via lineNumbers[]. Check those for cache misses.
        let hasMiss = false;
        for (let i = first; i <= last; i++) {
          if (!lineCache.has(lineNumbers[i])) {
            hasMiss = true;
            break;
          }
        }
        if (!hasMiss) return;

        // Fetch a window of actual file lines around the visible filtered range.
        const firstActual = lineNumbers[first];
        const lastActual = lineNumbers[Math.min(last, lineNumbers.length - 1)];
        fetchOffset = Math.max(0, firstActual - FETCH_THRESHOLD);
        fetchCount = lastActual - fetchOffset + FETCH_THRESHOLD * 2;
      } else {
        // Normal file mode: sequential line indices.
        let missingStart = -1;
        for (let i = first; i <= last; i++) {
          if (!lineCache.has(i)) {
            missingStart = i;
            break;
          }
        }
        if (missingStart === -1) return;

        fetchOffset = Math.max(0, first - FETCH_THRESHOLD);
        fetchCount = last - fetchOffset + FETCH_THRESHOLD * 2;
      }

      if (
        fetchOffset !== lastFetchRef.current.offset ||
        fetchCount !== lastFetchRef.current.count
      ) {
        lastFetchRef.current = { offset: fetchOffset, count: fetchCount };
        onFetchNeeded(fetchOffset, fetchCount);
      }
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [items, lineCache, onFetchNeeded, lineNumbers, isStreaming]);

  // Scroll to a specific line when requested (jumpToLine / search navigation).
  // Depends on `jumpSeq` so repeated jumps to the same line always re-fire.
  // Disable auto-scroll immediately before jumping — synchronously, so there
  // is no race with an incoming streaming batch that could override the jump.
  useEffect(() => {
    if (scrollToLine != null && scrollToLine >= 0) {
      autoScrollRef.current = false;
      setAutoScroll(false);
      lastManualScrollUpMs.current = Date.now();
      virtualizer.scrollToIndex(scrollToLine, { align: 'center' });
    }
  }, [scrollToLine, jumpSeq, virtualizer]);

  const handleLineClick = useCallback(
    (lineNum: number) => onLineClick?.(lineNum),
    [onLineClick],
  );

  if (count === 0) {
    if (lineNumbers) {
      // Filter active but no matches yet
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

  return (
    <div ref={parentRef} className="log-viewer">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {items.map((virtualItem) => {
          // When lineNumbers is provided, map virtualizer index → actual line number
          const actualLineNum = lineNumbers
            ? lineNumbers[virtualItem.index]
            : virtualItem.index;
          const line = lineCache.get(actualLineNum);
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
  );
}
