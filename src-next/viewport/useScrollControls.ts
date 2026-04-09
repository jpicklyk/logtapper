import { useRef, useState, useEffect, useCallback } from 'react';
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
 *
 * Accepts the scroll container element directly (not a ref) so the listener
 * effect re-runs when the element becomes available. This is required because
 * ReadOnlyViewer conditionally renders the scroll container — it doesn't exist
 * on the first mount when liveTotalLines === 0.
 */
export function useScrollControls(
  scrollContainer: HTMLDivElement | null,
  tailMode: boolean | undefined,
  totalLines: number,
  dataSource: DataSource,
  bumpCacheVersion: () => void,
): {
  autoScroll: boolean;
  autoScrollRef: React.MutableRefObject<boolean>;
  newLinesCount: number;
  liveTotalLines: number;
  userScrollingDownRef: React.MutableRefObject<boolean>;
  resetAutoScroll: () => void;
  disableAutoScroll: () => void;
} {
  const [autoScroll, setAutoScroll] = useState(true);
  const [newLinesCount, setNewLinesCount] = useState(0);
  const [streamTotal, setStreamTotal] = useState(dataSource.totalLines);

  const autoScrollRef = useRef(true);
  const userScrollingDownRef = useRef(false);
  const pointerIsDownRef = useRef(false);

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
  // Depends on scrollContainer so listeners are re-attached when the element
  // appears (e.g. after the "no data" early return is replaced by the viewer).
  useEffect(() => {
    if (!scrollContainer) return;

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

    const onPointerDown = () => { pointerIsDownRef.current = true; };
    const onPointerUp = () => { pointerIsDownRef.current = false; };

    const onScroll = () => {
      const nearBottom =
        scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < AT_BOTTOM_THRESHOLD;

      // Scrollbar drags produce no wheel/keyboard events — use pointer state
      // as a proxy to detect user-initiated scrollbar interaction.
      if (pointerIsDownRef.current && !nearBottom && autoScrollRef.current) {
        autoScrollRef.current = false;
        setAutoScroll(false);
      }

      // Re-enable: user scrolled (wheel/key/scrollbar drag) back to bottom.
      if (nearBottom && !autoScrollRef.current && (userScrollingDownRef.current || pointerIsDownRef.current)) {
        userScrollingDownRef.current = false;
        autoScrollRef.current = true;
        setAutoScroll(true);
        setNewLinesCount(0);
      }
    };

    scrollContainer.addEventListener('wheel', onWheel, { passive: true });
    scrollContainer.addEventListener('keydown', onKeyDown);
    scrollContainer.addEventListener('scroll', onScroll, { passive: true });
    scrollContainer.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      scrollContainer.removeEventListener('wheel', onWheel);
      scrollContainer.removeEventListener('keydown', onKeyDown);
      scrollContainer.removeEventListener('scroll', onScroll);
      scrollContainer.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [scrollContainer]);

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
    if (scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, [scrollContainer]);

  const disableAutoScroll = useCallback(() => {
    autoScrollRef.current = false;
    setAutoScroll(false);
  }, []);

  return {
    autoScroll,
    autoScrollRef,
    newLinesCount,
    liveTotalLines,
    userScrollingDownRef,
    resetAutoScroll,
    disableAutoScroll,
  };
}
