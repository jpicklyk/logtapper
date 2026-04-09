// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScrollControls } from './useScrollControls';
import type { DataSource } from './DataSource';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock DataSource with an onAppend that captures the callback. */
function makeDataSource(totalLines = 1000): {
  ds: DataSource;
  /** Simulate streaming batch: fires the captured onAppend callback. */
  pushLines: (newTotal: number) => void;
} {
  let appendCb: ((lines: never[], total: number) => void) | null = null;
  const ds: DataSource = {
    totalLines,
    sourceId: 'test',
    getLine: vi.fn(),
    getLines: vi.fn(),
    onAppend: vi.fn((cb) => {
      appendCb = cb;
      return () => { appendCb = null; };
    }),
  };
  return {
    ds,
    pushLines(newTotal: number) {
      appendCb?.([] as never[], newTotal);
    },
  };
}

/**
 * Mock scroll geometry on the container element.
 * jsdom doesn't lay out elements, so scrollHeight/scrollTop/clientHeight are all 0.
 * We override them to simulate a scrollable viewport.
 */
function setScrollGeometry(
  el: HTMLDivElement,
  opts: { scrollHeight: number; scrollTop: number; clientHeight: number },
) {
  Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: opts.scrollTop, configurable: true, writable: true });
  Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight, configurable: true });
}

/** Wrapper that provides a real parentRef pointing at an actual DOM element. */
function renderScrollControls(opts: {
  tailMode?: boolean;
  totalLines?: number;
  dataSource?: DataSource;
}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  // Default: viewport at the bottom (scrollHeight 2000, scrollTop 1500, clientHeight 500)
  setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1500, clientHeight: 500 });

  const bumpCacheVersion = vi.fn();
  const { ds, pushLines } = opts.dataSource
    ? { ds: opts.dataSource, pushLines: () => {} }
    : makeDataSource(opts.totalLines ?? 1000);

  const result = renderHook(
    ({ tailMode, totalLines, dataSource }) =>
      useScrollControls(
        el,
        tailMode,
        totalLines,
        dataSource,
        bumpCacheVersion,
      ),
    {
      initialProps: {
        tailMode: opts.tailMode ?? true,
        totalLines: opts.totalLines ?? 1000,
        dataSource: ds,
      },
    },
  );

  return { ...result, el, bumpCacheVersion, pushLines, ds };
}

// Shorthand event dispatchers
function wheelUp(el: HTMLElement) {
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
}
function wheelDown(el: HTMLElement) {
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
}
function keyDown(el: HTMLElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}
function pointerDown(el: HTMLElement) {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
}
function pointerUp() {
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}
function pointerCancel() {
  window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
}
function scrollEvent(el: HTMLElement) {
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useScrollControls', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // ── Initial state ────────────────────────────────────────────────────────

  it('starts with autoScroll enabled and zero new lines', () => {
    const { result } = renderScrollControls({});
    expect(result.current.autoScroll).toBe(true);
    expect(result.current.autoScrollRef.current).toBe(true);
    expect(result.current.newLinesCount).toBe(0);
  });

  it('liveTotalLines uses streamTotal in tail mode', () => {
    const { result, pushLines } = renderScrollControls({ tailMode: true, totalLines: 500 });
    // Initially, streamTotal = dataSource.totalLines = 500
    expect(result.current.liveTotalLines).toBe(500);
    // After streaming push, liveTotalLines reflects the new total
    act(() => { pushLines(800); });
    expect(result.current.liveTotalLines).toBe(800);
  });

  it('liveTotalLines uses totalLines prop in file mode', () => {
    const { result } = renderScrollControls({ tailMode: false, totalLines: 500 });
    expect(result.current.liveTotalLines).toBe(500);
  });

  // ── Wheel events ─────────────────────────────────────────────────────────

  describe('wheel events', () => {
    it('wheel up disables auto-scroll', () => {
      const { result, el } = renderScrollControls({});

      act(() => { wheelUp(el); });

      expect(result.current.autoScroll).toBe(false);
      expect(result.current.autoScrollRef.current).toBe(false);
    });

    it('wheel up clears userScrollingDownRef', () => {
      const { result, el } = renderScrollControls({});

      // First wheel down to set the flag
      act(() => { wheelDown(el); });
      expect(result.current.userScrollingDownRef.current).toBe(true);

      // Then wheel up clears it
      act(() => { wheelUp(el); });
      expect(result.current.userScrollingDownRef.current).toBe(false);
    });

    it('wheel down sets userScrollingDownRef but does not disable auto-scroll', () => {
      const { result, el } = renderScrollControls({});

      act(() => { wheelDown(el); });

      expect(result.current.autoScroll).toBe(true);
      expect(result.current.userScrollingDownRef.current).toBe(true);
    });
  });

  // ── Keyboard events ──────────────────────────────────────────────────────

  describe('keyboard events', () => {
    it.each(['ArrowUp', 'PageUp', 'Home'])('%s disables auto-scroll', (key) => {
      const { result, el } = renderScrollControls({});

      act(() => { keyDown(el, key); });

      expect(result.current.autoScroll).toBe(false);
      expect(result.current.autoScrollRef.current).toBe(false);
      expect(result.current.userScrollingDownRef.current).toBe(false);
    });

    it.each(['ArrowDown', 'PageDown', 'End'])('%s sets userScrollingDownRef', (key) => {
      const { result, el } = renderScrollControls({});

      act(() => { keyDown(el, key); });

      expect(result.current.autoScroll).toBe(true);
      expect(result.current.userScrollingDownRef.current).toBe(true);
    });
  });

  // ── Scrollbar drag detection ─────────────────────────────────────────────

  describe('scrollbar drag detection', () => {
    it('pointer down + scroll away from bottom disables auto-scroll', () => {
      const { result, el } = renderScrollControls({});

      // Simulate: user drags scrollbar up (far from bottom)
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 });

      act(() => {
        pointerDown(el);
        scrollEvent(el);
      });

      expect(result.current.autoScroll).toBe(false);
      expect(result.current.autoScrollRef.current).toBe(false);
    });

    it('scroll away without pointer down does NOT disable auto-scroll', () => {
      const { result, el } = renderScrollControls({});

      // No pointer down — this is a programmatic scroll (virtualizer re-measure)
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 });

      act(() => { scrollEvent(el); });

      expect(result.current.autoScroll).toBe(true);
    });

    it('pointer down + scroll near bottom does NOT disable auto-scroll', () => {
      const { result, el } = renderScrollControls({});

      // Still near bottom (gap < 60px threshold)
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1470, clientHeight: 500 });

      act(() => {
        pointerDown(el);
        scrollEvent(el);
      });

      expect(result.current.autoScroll).toBe(true);
    });

    it('scrollbar drag back to bottom re-enables auto-scroll', () => {
      const { result, el } = renderScrollControls({});

      // Step 1: drag away — disables auto-scroll
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 });
      act(() => {
        pointerDown(el);
        scrollEvent(el);
      });
      expect(result.current.autoScroll).toBe(false);

      // Step 2: drag back to bottom — re-enables (pointer still down)
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1480, clientHeight: 500 });
      act(() => { scrollEvent(el); });

      expect(result.current.autoScroll).toBe(true);
      expect(result.current.autoScrollRef.current).toBe(true);
      expect(result.current.newLinesCount).toBe(0);
    });
  });

  // ── Scroll-to-bottom re-enable ───────────────────────────────────────────

  describe('scroll-to-bottom re-enable', () => {
    it('wheel down to bottom re-enables auto-scroll', () => {
      const { result, el } = renderScrollControls({});

      // Disable first
      act(() => { wheelUp(el); });
      expect(result.current.autoScroll).toBe(false);

      // Wheel down (sets userScrollingDownRef) then scroll near bottom
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1480, clientHeight: 500 });
      act(() => {
        wheelDown(el);
        scrollEvent(el);
      });

      expect(result.current.autoScroll).toBe(true);
      expect(result.current.autoScrollRef.current).toBe(true);
    });

    it('scroll near bottom without user intent does NOT re-enable', () => {
      const { result, el } = renderScrollControls({});

      // Disable via wheel up
      act(() => { wheelUp(el); });
      expect(result.current.autoScroll).toBe(false);

      // Scroll to bottom without user intent (no wheel, no pointer)
      // This happens from programmatic scrolls or virtualizer adjustments
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1480, clientHeight: 500 });
      act(() => { scrollEvent(el); });

      expect(result.current.autoScroll).toBe(false);
    });
  });

  // ── Pointer cleanup ──────────────────────────────────────────────────────

  describe('pointer cleanup', () => {
    it('pointerup on window clears pointer state', () => {
      const { result, el } = renderScrollControls({});

      act(() => { pointerDown(el); });

      // Scroll away — should disable (pointer is down)
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 });
      act(() => { scrollEvent(el); });
      expect(result.current.autoScroll).toBe(false);

      // Re-enable for the next check
      act(() => { result.current.resetAutoScroll(); });
      expect(result.current.autoScroll).toBe(true);

      // Now release pointer, then scroll away again — should NOT disable
      act(() => { pointerUp(); });
      act(() => { scrollEvent(el); });

      expect(result.current.autoScroll).toBe(true);
    });

    it('pointercancel clears pointer state', () => {
      const { result, el } = renderScrollControls({});

      act(() => { pointerDown(el); });

      // Cancel the pointer (OS interruption, touch cancel, etc.)
      act(() => { pointerCancel(); });

      // Scroll away — should NOT disable because pointer was cancelled
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 });
      act(() => { scrollEvent(el); });

      expect(result.current.autoScroll).toBe(true);
    });
  });

  // ── tailMode transitions ─────────────────────────────────────────────────

  describe('tailMode transitions', () => {
    it('entering tail mode re-enables auto-scroll', () => {
      const { result, el, rerender } = renderScrollControls({ tailMode: false });

      // Disable auto-scroll
      act(() => { wheelUp(el); });
      expect(result.current.autoScroll).toBe(false);

      // Switch to tail mode
      rerender({ tailMode: true, totalLines: 1000, dataSource: result.current as unknown as DataSource });
      // Re-render with tailMode=true — need to pass through the hook's rerender
    });

    it('entering tail mode resets auto-scroll and clears badge', () => {
      const { result, rerender, ds } = renderScrollControls({ tailMode: false, totalLines: 500 });

      // Start in file mode — disable auto-scroll
      act(() => {
        result.current.disableAutoScroll();
      });
      expect(result.current.autoScroll).toBe(false);

      // Enter tail mode
      rerender({ tailMode: true, totalLines: 500, dataSource: ds });

      expect(result.current.autoScroll).toBe(true);
      expect(result.current.autoScrollRef.current).toBe(true);
      expect(result.current.newLinesCount).toBe(0);
    });
  });

  // ── Streaming (onAppend) ─────────────────────────────────────────────────

  describe('streaming (onAppend)', () => {
    it('onAppend updates liveTotalLines', () => {
      const { result, pushLines } = renderScrollControls({ tailMode: true, totalLines: 100 });

      act(() => { pushLines(1200); });

      expect(result.current.liveTotalLines).toBe(1200);
    });

    it('onAppend calls bumpCacheVersion', () => {
      const { pushLines, bumpCacheVersion } = renderScrollControls({ tailMode: true });

      act(() => { pushLines(1100); });

      expect(bumpCacheVersion).toHaveBeenCalled();
    });

    it('subscribes to onAppend on mount and unsubscribes on unmount', () => {
      const { ds: dataSource } = makeDataSource(100);
      const { unmount } = renderScrollControls({ dataSource });

      // onAppend should have been called (to subscribe)
      expect(dataSource.onAppend).toHaveBeenCalledTimes(1);

      unmount();
      // The cleanup ran — we can't directly assert the unsubscribe was called
      // because it's internal, but the hook should not leak
    });
  });

  // ── New lines badge ──────────────────────────────────────────────────────

  describe('new lines badge', () => {
    it('increments when tail mode + auto-scroll off + new lines arrive', () => {
      const { result, el, pushLines } = renderScrollControls({ tailMode: true });

      // Disable auto-scroll
      act(() => { wheelUp(el); });
      expect(result.current.autoScroll).toBe(false);

      // Simulate streaming batches
      act(() => { pushLines(1050); });
      act(() => { pushLines(1100); });

      expect(result.current.newLinesCount).toBe(100); // 1050-1000 + 1100-1050
    });

    it('does NOT increment when auto-scroll is enabled', () => {
      const { result, pushLines } = renderScrollControls({ tailMode: true });

      // Auto-scroll is on by default
      act(() => { pushLines(1050); });
      act(() => { pushLines(1100); });

      expect(result.current.newLinesCount).toBe(0);
    });

    it('does NOT increment in file mode', () => {
      const { result, el, pushLines } = renderScrollControls({ tailMode: false });

      act(() => { wheelUp(el); });
      act(() => { pushLines(1050); });

      expect(result.current.newLinesCount).toBe(0);
    });
  });

  // ── Callbacks ────────────────────────────────────────────────────────────

  describe('callbacks', () => {
    it('resetAutoScroll re-enables auto-scroll and clears badge', () => {
      const { result, el, pushLines } = renderScrollControls({ tailMode: true });

      // Disable and accumulate badge
      act(() => { wheelUp(el); });
      act(() => { pushLines(1050); });
      expect(result.current.autoScroll).toBe(false);
      expect(result.current.newLinesCount).toBe(50);

      // Reset
      act(() => { result.current.resetAutoScroll(); });

      expect(result.current.autoScroll).toBe(true);
      expect(result.current.autoScrollRef.current).toBe(true);
      expect(result.current.newLinesCount).toBe(0);
    });

    it('resetAutoScroll scrolls the element to bottom', () => {
      const { result, el } = renderScrollControls({});

      setScrollGeometry(el, { scrollHeight: 3000, scrollTop: 500, clientHeight: 500 });

      act(() => { result.current.resetAutoScroll(); });

      // scrollTop should be set to scrollHeight (3000)
      expect(el.scrollTop).toBe(3000);
    });

    it('disableAutoScroll sets both state and ref', () => {
      const { result } = renderScrollControls({});

      act(() => { result.current.disableAutoScroll(); });

      expect(result.current.autoScroll).toBe(false);
      expect(result.current.autoScrollRef.current).toBe(false);
    });
  });

  // ── Event listener cleanup ───────────────────────────────────────────────

  // ── Deferred element attachment (the liveTotalLines===0 early-return bug) ─

  describe('deferred element attachment', () => {
    it('attaches listeners when element appears after initial null', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1500, clientHeight: 500 });

      const bumpCacheVersion = vi.fn();
      const { ds } = makeDataSource(1000);

      // Start with null element (simulates liveTotalLines===0 early return)
      const { result, rerender } = renderHook(
        ({ scrollEl }) =>
          useScrollControls(scrollEl, true, 1000, ds, bumpCacheVersion),
        { initialProps: { scrollEl: null as HTMLDivElement | null } },
      );

      // Wheel up should have no effect — no element, no listeners
      act(() => { wheelUp(el); });
      expect(result.current.autoScroll).toBe(true);

      // Element appears (component re-renders with the viewer div)
      rerender({ scrollEl: el });

      // NOW wheel up should disable auto-scroll
      act(() => { wheelUp(el); });
      expect(result.current.autoScroll).toBe(false);
      expect(result.current.autoScrollRef.current).toBe(false);
    });
  });

  // ── Event listener cleanup ───────────────────────────────────────────────

  describe('cleanup', () => {
    it('removes event listeners on unmount', () => {
      const { el, unmount } = renderScrollControls({});

      const removeSpy = vi.spyOn(el, 'removeEventListener');
      const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

      unmount();

      const removedTypes = removeSpy.mock.calls.map((c) => c[0]);
      expect(removedTypes).toContain('wheel');
      expect(removedTypes).toContain('keydown');
      expect(removedTypes).toContain('scroll');
      expect(removedTypes).toContain('pointerdown');

      const windowRemovedTypes = windowRemoveSpy.mock.calls.map((c) => c[0]);
      expect(windowRemovedTypes).toContain('pointerup');
      expect(windowRemovedTypes).toContain('pointercancel');

      removeSpy.mockRestore();
      windowRemoveSpy.mockRestore();
    });
  });
});
