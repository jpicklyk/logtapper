import { useRef, useCallback, useEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ViewLine, SearchQuery } from '../bridge/types';
import LogLine from './LogLine';

const LINE_HEIGHT = 22; // px — monospace, single line
const OVERSCAN = 5;
const FETCH_THRESHOLD = 50; // fetch when within this many lines of window edge
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
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [, setAutoScroll] = useState(true);
  // Ref mirrors autoScroll state so the totalLines effect reads it synchronously,
  // avoiding the race where React hasn't re-rendered yet when the next batch arrives.
  const autoScrollRef = useRef(true);
  // Prevent the programmatic scroll from toggling autoScroll off
  const suppressScrollRef = useRef(false);

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

  // ── Scroll listener — detect whether user is near the bottom ────────────────
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const onScroll = () => {
      if (suppressScrollRef.current) return;
      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;
      autoScrollRef.current = nearBottom; // sync — read by effect without stale-state race
      setAutoScroll(nearBottom);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ── Auto-scroll to bottom when new streaming lines arrive ────────────────────
  useEffect(() => {
    if (!isStreaming || !autoScrollRef.current || count === 0) return;
    suppressScrollRef.current = true;
    virtualizer.scrollToIndex(count - 1, { align: 'end' });
    requestAnimationFrame(() => {
      suppressScrollRef.current = false;
    });
  // Depends on `count` (filtered or total) so we fire once per new batch.
  // When filter is active, count = lineNumbers.length and grows as matches arrive.
  // autoScrollRef is a ref — no need to list it; it's always current.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  // Fetch missing windows as the user scrolls
  const lastFetchRef = useRef({ offset: -1, count: 0 });

  useEffect(() => {
    // When lineNumbers is provided (filter active), all lines are already in the
    // cache (pushed via streaming batch events). Skip on-demand fetching.
    if (items.length === 0 || lineNumbers) return;

    const first = items[0].index;
    const last = items[items.length - 1].index;

    // Check if any visible lines are missing from cache
    let missingStart = -1;
    for (let i = first; i <= last; i++) {
      if (!lineCache.has(i)) {
        missingStart = i;
        break;
      }
    }

    if (missingStart === -1) return;

    // Request a generous window around the viewport
    const fetchOffset = Math.max(0, first - FETCH_THRESHOLD);
    const fetchCount = last - fetchOffset + FETCH_THRESHOLD * 2;

    if (
      fetchOffset !== lastFetchRef.current.offset ||
      fetchCount !== lastFetchRef.current.count
    ) {
      lastFetchRef.current = { offset: fetchOffset, count: fetchCount };
      onFetchNeeded(fetchOffset, fetchCount);
    }
  }, [items, lineCache, onFetchNeeded, lineNumbers]);

  // Scroll to a specific line when requested (jumpToLine / search navigation).
  // Depends on `jumpSeq` so repeated jumps to the same line always re-fire.
  useEffect(() => {
    if (scrollToLine != null && scrollToLine >= 0) {
      suppressScrollRef.current = true;
      virtualizer.scrollToIndex(scrollToLine, { align: 'center' });
      requestAnimationFrame(() => {
        suppressScrollRef.current = false;
      });
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
