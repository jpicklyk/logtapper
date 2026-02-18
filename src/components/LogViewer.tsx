import { useRef, useCallback, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ViewLine, SearchQuery } from '../bridge/types';
import LogLine from './LogLine';

const LINE_HEIGHT = 22; // px — monospace, single line
const OVERSCAN = 5;
const FETCH_THRESHOLD = 50; // fetch when within this many lines of window edge

interface Props {
  sessionId: string;
  totalLines: number;
  /** Cache of already-fetched lines keyed by line number */
  lineCache: Map<number, ViewLine>;
  search?: SearchQuery;
  onFetchNeeded: (offset: number, count: number) => void;
  onLineClick?: (lineNum: number) => void;
  scrollToLine?: number;
}

export default function LogViewer({
  totalLines,
  lineCache,
  onFetchNeeded,
  onLineClick,
  scrollToLine,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: totalLines,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();

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

  // Scroll to a specific line when requested
  useEffect(() => {
    if (scrollToLine != null && scrollToLine >= 0) {
      virtualizer.scrollToIndex(scrollToLine, { align: 'center' });
    }
  }, [scrollToLine, virtualizer]);

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
