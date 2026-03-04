import { useRef, useState, useEffect, useCallback } from 'react';
import type React from 'react';
import type { DataSource } from './DataSource';

const AT_BOTTOM_THRESHOLD = 60;

/**
 * Manages scroll interaction, tail-mode auto-scroll state, the "N new lines"
 * badge, and the streaming onAppend subscription.
 *
 * Handles:
 * - Wheel / keyboard / scroll event listeners → autoScrollRef, userScrollingDownRef
 * - tailMode transition → re-enable auto-scroll, clear badge
 * - onAppend subscription → streamTotal, bumpCacheVersion
 * - newLinesCount badge (incremented when tailMode + !autoScroll + new lines)
 *
 * Does NOT handle: auto-scroll-to-bottom (lives in ReadOnlyViewer because it
 * requires liveEffectiveCount which depends on virtualBase from useVirtualBase).
 */
export function useScrollControls(
  parentRef: React.RefObject<HTMLDivElement>,
  tailMode: boolean | undefined,
  totalLines: number,
  dataSource: DataSource,
  bumpCacheVersion: () => void,
): {
  autoScroll: boolean;
  autoScrollRef: React.MutableRefObject<boolean>;
  newLinesCount: number;
  liveTotalLines: number;
  lastSetScrollTopRef: React.MutableRefObject<number>;
  userScrollingDownRef: React.MutableRefObject<boolean>;
  resetAutoScroll: () => void;
  disableAutoScroll: () => void;
} {
  const [autoScroll, setAutoScroll] = useState(true);
  const [newLinesCount, setNewLinesCount] = useState(0);
  const [streamTotal, setStreamTotal] = useState(dataSource.totalLines);

  const autoScrollRef = useRef(true);
  const lastSetScrollTopRef = useRef(-1);
  const userScrollingDownRef = useRef(false);

  // tailMode: use streamTotal (updated by onAppend, faster than context propagation)
  // file mode: use totalLines from prop (authoritative count from session context)
  const liveTotalLines = tailMode ? streamTotal : totalLines;

  // ── Re-enable auto-scroll when entering tail mode ───────────────────────
  useEffect(() => {
    if (tailMode) {
      autoScrollRef.current = true;
      setAutoScroll(true);
      setNewLinesCount(0);
      userScrollingDownRef.current = false;
    }
  }, [tailMode]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Subscribe to streaming appends ──────────────────────────────────────
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
  }, [dataSource, bumpCacheVersion]);

  // ── Badge: count new lines when scrolled away from bottom ───────────────
  const prevTotalRef = useRef(liveTotalLines);
  useEffect(() => {
    if (tailMode && !autoScrollRef.current) {
      const delta = liveTotalLines - prevTotalRef.current;
      if (delta > 0) setNewLinesCount((n) => n + delta);
    }
    prevTotalRef.current = liveTotalLines;
  }, [liveTotalLines, tailMode]);

  // ── Callbacks ────────────────────────────────────────────────────────────
  const resetAutoScroll = useCallback(() => {
    autoScrollRef.current = true;
    setAutoScroll(true);
    setNewLinesCount(0);
    const el = parentRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      lastSetScrollTopRef.current = el.scrollTop;
    }
  }, [parentRef]);

  const disableAutoScroll = useCallback(() => {
    autoScrollRef.current = false;
    setAutoScroll(false);
  }, []);

  return {
    autoScroll,
    autoScrollRef,
    newLinesCount,
    liveTotalLines,
    lastSetScrollTopRef,
    userScrollingDownRef,
    resetAutoScroll,
    disableAutoScroll,
  };
}
