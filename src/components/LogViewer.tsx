import { useRef, useCallback, useEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ViewLine, SearchQuery } from '../bridge/types';
import LogLine from './LogLine';

const LINE_HEIGHT = 22; // px — monospace, single line
const OVERSCAN = 5;
const FETCH_THRESHOLD = 50; // fetch when within this many lines of window edge
const AT_BOTTOM_THRESHOLD = 60; // px from bottom to consider "at bottom"

// Chrome/Edge cap their DOM scrollHeight at 2^25 px. Beyond this the native
// scrollbar stops working. We keep the virtualizer's total height inside this
// limit by using a sliding "virtual base" offset for large files.
const MAX_BROWSER_SCROLL_PX = 33_554_428; // 2^25 − a few px (Chrome/Edge)
const MAX_VIRTUAL_LINES = Math.floor(MAX_BROWSER_SCROLL_PX / LINE_HEIGHT); // ≈1,525,201

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
  sessionId,
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

  // ── Large-file virtual base ──────────────────────────────────────────────────
  // When totalLines * LINE_HEIGHT > MAX_BROWSER_SCROLL_PX the native scrollbar
  // stops working (Chrome/Edge clamp scrollHeight at 2^25 px). We keep the
  // virtualizer within that limit by sliding a "virtual base" window across the
  // full file. virtualBase is the first *file* line shown as virtualizer item 0.
  const [virtualBase, setVirtualBase] = useState(0);
  const virtualBaseRef = useRef(0);
  // Target line waiting for a virtualBase change to settle before scrollToIndex.
  const pendingScrollTarget = useRef<number | null>(null);

  // Reset the virtual window whenever a new session is loaded.
  useEffect(() => {
    virtualBaseRef.current = 0;
    setVirtualBase(0);
    pendingScrollTarget.current = null;
  }, [sessionId]);
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

  // effectiveCount keeps the virtualizer's total height inside browser limits.
  // In filtered mode we use the filtered array length (always small enough).
  // In full-file mode we cap at MAX_VIRTUAL_LINES and slide virtualBase.
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
    if (!isStreaming || !autoScrollRef.current || effectiveCount === 0) return;
    lastProgrammaticScrollMs.current = Date.now();
    virtualizer.scrollToIndex(effectiveCount - 1, { align: 'end' });
  // Depends on `effectiveCount` (filtered or total) so we fire once per new batch.
  // autoScrollRef / lastProgrammaticScrollMs are refs — no need to list them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCount]);

  // Fetch missing windows as the user scrolls
  const lastFetchRef = useRef({ offset: -1, count: 0 });
  // Reset fetch dedup whenever the cache Map is replaced (search wipe, mode switch, etc.).
  // Doing this in the render body (not an effect) ensures lastFetchRef is cleared in the
  // same cycle where lineCache changes, so the subsequent fetch effect sees a clean slate.
  const prevLineCacheRef = useRef(lineCache);
  if (prevLineCacheRef.current !== lineCache) {
    prevLineCacheRef.current = lineCache;
    lastFetchRef.current = { offset: -1, count: 0 };
  }

  useEffect(() => {
    if (items.length === 0) return;
    // Streaming with filter: all lines arrive via batch events — no fetching needed.
    if (lineNumbers && isStreaming) return;

    const first = items[0].index;
    const last = items[items.length - 1].index;

    let fetchOffset: number;
    let fetchCount: number;

    if (lineNumbers) {
      // File mode with filter active: visible virtualizer indices map to actual
      // line numbers via lineNumbers[]. Cache is keyed by actual line number.
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
      // Full file mode: virtualizer indices are relative to virtualBase.
      // Translate to absolute file line numbers for cache lookup and fetch.
      let hasMiss = false;
      for (let i = first; i <= last; i++) {
        if (!lineCache.has(virtualBase + i)) {
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
      onFetchNeeded(fetchOffset, fetchCount);
    }
  }, [items, lineCache, onFetchNeeded, lineNumbers, isStreaming, virtualBase]);

  // Scroll to a specific line when requested (jumpToLine / search navigation).
  // Depends on `jumpSeq` so repeated jumps to the same line always re-fire.
  // Disable auto-scroll immediately before jumping — synchronously, so there
  // is no race with an incoming streaming batch that could override the jump.
  useEffect(() => {
    if (scrollToLine == null || scrollToLine < 0) return;
    autoScrollRef.current = false;
    setAutoScroll(false);
    lastManualScrollUpMs.current = Date.now();

    if (lineNumbers) {
      // Filtered mode: map actual line number to virtualizer index.
      const pos = lineNumbers.indexOf(scrollToLine);
      if (pos !== -1) virtualizer.scrollToIndex(pos, { align: 'center' });
      return;
    }

    // Full file mode: check whether scrollToLine is inside the current window.
    const relIndex = scrollToLine - virtualBaseRef.current;
    if (relIndex >= 0 && relIndex < MAX_VIRTUAL_LINES) {
      virtualizer.scrollToIndex(relIndex, { align: 'center' });
    } else {
      // Target is outside the current window — shift virtualBase to center on it.
      const half = Math.floor(MAX_VIRTUAL_LINES / 2);
      const newBase = Math.max(0, Math.min(scrollToLine - half, Math.max(0, totalLines - MAX_VIRTUAL_LINES)));
      pendingScrollTarget.current = scrollToLine;
      virtualBaseRef.current = newBase;
      setVirtualBase(newBase);
      // scrollToIndex fires in the deferred effect below after virtualBase settles.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToLine, jumpSeq, lineNumbers]);  // intentionally omit virtualizer/virtualBase — avoids infinite loop

  // Deferred scroll: fires after virtualBase state update settles so scrollToIndex
  // uses the newly-computed effectiveCount and correct item positions.
  useEffect(() => {
    const target = pendingScrollTarget.current;
    if (target == null) return;
    const relIndex = target - virtualBaseRef.current;
    if (relIndex >= 0 && relIndex < MAX_VIRTUAL_LINES) {
      pendingScrollTarget.current = null;
      virtualizer.scrollToIndex(relIndex, { align: 'center' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualBase]); // intentionally omit virtualizer — fires right after base change

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

  // Show navigation buttons when the file exceeds the browser scroll limit.
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
            // Advance by exactly one virtual window so lines continue sequentially.
            // Cap at the last possible base so the window always covers the file end.
            const newBase = Math.min(
              virtualBase + MAX_VIRTUAL_LINES,
              Math.max(0, totalLines - MAX_VIRTUAL_LINES),
            );
            // Scroll to the first line of the new window (relIndex = 0).
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
          // Map virtualizer index to absolute file line number.
          // lineNumbers mode: explicit filtered array; full mode: base + relative index.
          const actualLineNum = lineNumbers
            ? lineNumbers[virtualItem.index]
            : virtualBase + virtualItem.index;
          // Cache is keyed by absolute file line number.
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
    </div>
  );
}
