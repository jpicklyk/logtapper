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
}

export default function LogViewer({
  totalLines,
  lineCache,
  onFetchNeeded,
  onLineClick,
  scrollToLine,
  jumpSeq,
  isStreaming,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // Prevent the programmatic scroll from toggling autoScroll off
  const suppressScrollRef = useRef(false);

  const virtualizer = useVirtualizer({
    count: totalLines,
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
      setAutoScroll(nearBottom);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ── Auto-scroll to bottom when new streaming lines arrive ────────────────────
  useEffect(() => {
    if (!isStreaming || !autoScroll || totalLines === 0) return;
    suppressScrollRef.current = true;
    virtualizer.scrollToIndex(totalLines - 1, { align: 'end' });
    requestAnimationFrame(() => {
      suppressScrollRef.current = false;
    });
  // Intentionally only depends on totalLines so we fire once per new batch
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalLines]);

  // Fetch missing windows as the user scrolls
  const lastFetchRef = useRef({ offset: -1, count: 0 });

  useEffect(() => {
    if (items.length === 0) return;
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
  }, [items, lineCache, onFetchNeeded]);

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

  if (totalLines === 0) {
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
          const line = lineCache.get(virtualItem.index);
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
                  isJumpTarget={virtualItem.index === scrollToLine}
                  jumpSeq={virtualItem.index === scrollToLine ? jumpSeq : undefined}
                />
              ) : (
                <div className="log-line log-line-loading" style={{ height: LINE_HEIGHT }}>
                  <span className="log-linenum">
                    {String(virtualItem.index + 1).padStart(7, ' ')}
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
