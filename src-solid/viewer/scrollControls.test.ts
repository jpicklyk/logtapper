// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { ScrollControls } from './scrollControls';
import type { DataSource } from '@viewport/DataSource';

// ── Helpers (ported from src-next/viewport/useScrollControls.test.tsx) ───────

/** Mock DataSource whose onAppend callback can be fired on demand. */
function makeDataSource(totalLines = 1000): {
  ds: DataSource;
  pushLines: (newTotal: number) => void;
  unsubscribe: () => void;
} {
  let appendCb: ((lines: never[], total: number) => void) | null = null;
  const unsubscribe = vi.fn(() => { appendCb = null; });
  const ds: DataSource = {
    totalLines,
    sourceId: 'test',
    getLine: vi.fn(),
    getLines: vi.fn(),
    onAppend: vi.fn((cb) => { appendCb = cb; return unsubscribe; }),
  };
  return { ds, pushLines: (t) => appendCb?.([] as never[], t), unsubscribe };
}

/**
 * jsdom does not lay elements out, so scrollHeight/scrollTop/clientHeight are
 * all 0 — override them to simulate a scrollable viewport.
 */
function setScrollGeometry(
  el: HTMLElement,
  opts: { scrollHeight: number; scrollTop: number; clientHeight: number },
) {
  Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: opts.scrollTop, configurable: true, writable: true });
  Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight, configurable: true });
}

function render(opts: {
  tailMode?: boolean;
  totalLines?: number;
  dataSource?: DataSource;
  attach?: boolean;
}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  // Default: viewport parked at the bottom.
  setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1500, clientHeight: 500 });

  const bumpCacheVersion = vi.fn();
  const made = makeDataSource(opts.totalLines ?? 1000);
  const ds = opts.dataSource ?? made.ds;
  const pushLines = opts.dataSource ? () => {} : made.pushLines;

  let sc!: ScrollControls;
  let setTailMode!: (v: boolean) => void;
  let setTotalLines!: (v: number) => void;
  let setDataSource!: (v: DataSource) => void;
  let tailMode!: Accessor<boolean>;

  const dispose = createRoot((d) => {
    const [tail, setTail] = createSignal(opts.tailMode ?? true);
    const [total, setTotal] = createSignal(opts.totalLines ?? 1000);
    const [source, setSource] = createSignal<DataSource>(ds);
    tailMode = tail;
    setTailMode = setTail;
    setTotalLines = setTotal;
    setDataSource = (v) => setSource(() => v);
    sc = new ScrollControls({
      tailMode: tail,
      totalLines: total,
      dataSource: source,
      bumpCacheVersion,
    });
    return d;
  });

  if (opts.attach !== false) sc.attach(el);

  return { sc, el, dispose, bumpCacheVersion, pushLines, ds, made, tailMode, setTailMode, setTotalLines, setDataSource };
}

// Shorthand event dispatchers
const wheelUp = (el: HTMLElement) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
const wheelDown = (el: HTMLElement) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
const keyDown = (el: HTMLElement, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
const pointerDown = (el: HTMLElement) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
const pointerUp = () => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
const pointerCancel = () => window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
const scrollEvent = (el: HTMLElement) => el.dispatchEvent(new Event('scroll', { bubbles: true }));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ScrollControls', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // ── Initial state ────────────────────────────────────────────────────────

  it('starts with autoScroll enabled and zero new lines', () => {
    const { sc, dispose } = render({});
    expect(sc.autoScroll()).toBe(true);
    expect(sc.autoScrollRef.value).toBe(true);
    expect(sc.newLinesCount()).toBe(0);
    dispose();
  });

  it('liveTotalLines uses the stream total in tail mode', () => {
    const { sc, pushLines, dispose } = render({ tailMode: true, totalLines: 500 });
    expect(sc.liveTotalLines()).toBe(500);
    pushLines(800);
    expect(sc.liveTotalLines()).toBe(800);
    dispose();
  });

  it('liveTotalLines uses the totalLines input in file mode', () => {
    const { sc, dispose } = render({ tailMode: false, totalLines: 500 });
    expect(sc.liveTotalLines()).toBe(500);
    dispose();
  });

  // ── Wheel events ─────────────────────────────────────────────────────────

  describe('wheel events', () => {
    it('wheel up disables auto-scroll', () => {
      const { sc, el, dispose } = render({});
      wheelUp(el);
      expect(sc.autoScroll()).toBe(false);
      expect(sc.autoScrollRef.value).toBe(false);
      dispose();
    });

    it('wheel up clears userScrollingDownRef', () => {
      const { sc, el, dispose } = render({});
      wheelDown(el);
      expect(sc.userScrollingDownRef.value).toBe(true);
      wheelUp(el);
      expect(sc.userScrollingDownRef.value).toBe(false);
      dispose();
    });

    it('wheel down sets userScrollingDownRef but does not disable auto-scroll', () => {
      const { sc, el, dispose } = render({});
      wheelDown(el);
      expect(sc.autoScroll()).toBe(true);
      expect(sc.userScrollingDownRef.value).toBe(true);
      dispose();
    });
  });

  // ── Keyboard events ──────────────────────────────────────────────────────

  describe('keyboard events', () => {
    it.each(['ArrowUp', 'PageUp', 'Home'])('%s disables auto-scroll', (key) => {
      const { sc, el, dispose } = render({});
      keyDown(el, key);
      expect(sc.autoScroll()).toBe(false);
      expect(sc.autoScrollRef.value).toBe(false);
      expect(sc.userScrollingDownRef.value).toBe(false);
      dispose();
    });

    it.each(['ArrowDown', 'PageDown', 'End'])('%s sets userScrollingDownRef', (key) => {
      const { sc, el, dispose } = render({});
      keyDown(el, key);
      expect(sc.autoScroll()).toBe(true);
      expect(sc.userScrollingDownRef.value).toBe(true);
      dispose();
    });
  });

  // ── Scrollbar drag detection ─────────────────────────────────────────────

  describe('scrollbar drag detection', () => {
    it('pointer down + scroll away from bottom disables auto-scroll', () => {
      const { sc, el, dispose } = render({});
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 });
      pointerDown(el);
      scrollEvent(el);
      expect(sc.autoScroll()).toBe(false);
      expect(sc.autoScrollRef.value).toBe(false);
      dispose();
    });

    it('does not touch layout on a scroll event it caused itself', () => {
      // Tail mode scrolls the element on every batch. With auto-scroll on and
      // the pointer up, neither branch of the handler can fire, so it must bail
      // before reading `scrollHeight` — that read is a forced reflow on a tree
      // the append just dirtied.
      const { sc, el, dispose } = render({});
      let reads = 0;
      Object.defineProperty(el, 'scrollHeight', {
        configurable: true,
        get: () => { reads += 1; return 2000; },
      });

      scrollEvent(el);
      expect(reads).toBe(0);
      expect(sc.autoScroll()).toBe(true);

      // …but a scroll while auto-scroll is off still consults the geometry.
      sc.disableAutoScroll();
      scrollEvent(el);
      expect(reads).toBe(1);
      dispose();
    });

    it('scroll away without pointer down does NOT disable auto-scroll', () => {
      const { sc, el, dispose } = render({});
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 });
      scrollEvent(el);
      expect(sc.autoScroll()).toBe(true);
      dispose();
    });

    it('pointer down + scroll near bottom does NOT disable auto-scroll', () => {
      const { sc, el, dispose } = render({});
      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1470, clientHeight: 500 });
      pointerDown(el);
      scrollEvent(el);
      expect(sc.autoScroll()).toBe(true);
      dispose();
    });

    it('scrollbar drag back to bottom re-enables auto-scroll', () => {
      const { sc, el, dispose } = render({});

      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 });
      pointerDown(el);
      scrollEvent(el);
      expect(sc.autoScroll()).toBe(false);

      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1480, clientHeight: 500 });
      scrollEvent(el);

      expect(sc.autoScroll()).toBe(true);
      expect(sc.autoScrollRef.value).toBe(true);
      expect(sc.newLinesCount()).toBe(0);
      dispose();
    });
  });

  // ── Scroll-to-bottom re-enable ───────────────────────────────────────────

  describe('scroll-to-bottom re-enable', () => {
    it('wheel down to bottom re-enables auto-scroll', () => {
      const { sc, el, dispose } = render({});
      wheelUp(el);
      expect(sc.autoScroll()).toBe(false);

      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1480, clientHeight: 500 });
      wheelDown(el);
      scrollEvent(el);

      expect(sc.autoScroll()).toBe(true);
      expect(sc.autoScrollRef.value).toBe(true);
      dispose();
    });

    it('scroll near bottom without user intent does NOT re-enable', () => {
      const { sc, el, dispose } = render({});
      wheelUp(el);
      expect(sc.autoScroll()).toBe(false);

      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 1480, clientHeight: 500 });
      scrollEvent(el);

      expect(sc.autoScroll()).toBe(false);
      dispose();
    });
  });

  // ── Pointer cleanup ──────────────────────────────────────────────────────

  describe('pointer cleanup', () => {
    it('pointerup on window clears pointer state', () => {
      const { sc, el, dispose } = render({});
      pointerDown(el);

      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 });
      scrollEvent(el);
      expect(sc.autoScroll()).toBe(false);

      sc.resetAutoScroll();
      expect(sc.autoScroll()).toBe(true);

      pointerUp();
      scrollEvent(el);

      expect(sc.autoScroll()).toBe(true);
      dispose();
    });

    it('pointercancel clears pointer state', () => {
      const { sc, el, dispose } = render({});
      pointerDown(el);
      pointerCancel();

      setScrollGeometry(el, { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 });
      scrollEvent(el);

      expect(sc.autoScroll()).toBe(true);
      dispose();
    });
  });

  // ── tailMode transitions ─────────────────────────────────────────────────

  describe('tailMode transitions', () => {
    it('entering tail mode resets auto-scroll and clears the badge', () => {
      const { sc, setTailMode, dispose } = render({ tailMode: false, totalLines: 500 });

      sc.disableAutoScroll();
      expect(sc.autoScroll()).toBe(false);

      setTailMode(true);

      expect(sc.autoScroll()).toBe(true);
      expect(sc.autoScrollRef.value).toBe(true);
      expect(sc.newLinesCount()).toBe(0);
      dispose();
    });

    it('entering tail mode clears an accumulated badge', () => {
      const { sc, el, pushLines, setTailMode, dispose } = render({ tailMode: true });
      wheelUp(el);
      pushLines(1050);
      expect(sc.newLinesCount()).toBe(50);

      setTailMode(false);
      setTailMode(true);

      expect(sc.newLinesCount()).toBe(0);
      expect(sc.autoScroll()).toBe(true);
      dispose();
    });
  });

  // ── Streaming (onAppend) ─────────────────────────────────────────────────

  describe('streaming (onAppend)', () => {
    it('onAppend updates liveTotalLines', () => {
      const { sc, pushLines, dispose } = render({ tailMode: true, totalLines: 100 });
      pushLines(1200);
      expect(sc.liveTotalLines()).toBe(1200);
      dispose();
    });

    it('onAppend calls bumpCacheVersion when one was supplied', () => {
      const { pushLines, bumpCacheVersion, dispose } = render({ tailMode: true });
      pushLines(1100);
      expect(bumpCacheVersion).toHaveBeenCalled();
      dispose();
    });

    it('subscribes on construction and unsubscribes on owner disposal', () => {
      const { ds, made, dispose } = render({});
      expect(ds.onAppend).toHaveBeenCalledTimes(1);
      expect(made.unsubscribe).not.toHaveBeenCalled();

      dispose();

      expect(made.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('re-subscribes when the data source changes', () => {
      const { made, setDataSource, dispose } = render({});
      const next = makeDataSource(2000);

      setDataSource(next.ds);

      expect(made.unsubscribe).toHaveBeenCalledTimes(1);
      expect(next.ds.onAppend).toHaveBeenCalledTimes(1);
      dispose();
    });
  });

  // ── New lines badge ──────────────────────────────────────────────────────

  describe('new lines badge', () => {
    it('increments when tail mode + auto-scroll off + new lines arrive', () => {
      const { sc, el, pushLines, dispose } = render({ tailMode: true });
      wheelUp(el);
      expect(sc.autoScroll()).toBe(false);

      pushLines(1050);
      pushLines(1100);

      expect(sc.newLinesCount()).toBe(100); // 1050-1000 + 1100-1050
      dispose();
    });

    it('does NOT increment when auto-scroll is enabled', () => {
      const { sc, pushLines, dispose } = render({ tailMode: true });
      pushLines(1050);
      pushLines(1100);
      expect(sc.newLinesCount()).toBe(0);
      dispose();
    });

    it('does NOT increment in file mode', () => {
      const { sc, el, pushLines, dispose } = render({ tailMode: false });
      wheelUp(el);
      pushLines(1050);
      expect(sc.newLinesCount()).toBe(0);
      dispose();
    });
  });

  // ── Callbacks ────────────────────────────────────────────────────────────

  describe('callbacks', () => {
    it('resetAutoScroll re-enables auto-scroll and clears the badge', () => {
      const { sc, el, pushLines, dispose } = render({ tailMode: true });
      wheelUp(el);
      pushLines(1050);
      expect(sc.autoScroll()).toBe(false);
      expect(sc.newLinesCount()).toBe(50);

      sc.resetAutoScroll();

      expect(sc.autoScroll()).toBe(true);
      expect(sc.autoScrollRef.value).toBe(true);
      expect(sc.newLinesCount()).toBe(0);
      dispose();
    });

    it('resetAutoScroll scrolls the attached element to the bottom', () => {
      const { sc, el, dispose } = render({});
      setScrollGeometry(el, { scrollHeight: 3000, scrollTop: 500, clientHeight: 500 });

      sc.resetAutoScroll();

      expect(el.scrollTop).toBe(3000);
      dispose();
    });

    it('disableAutoScroll sets both the signal and the mirror', () => {
      const { sc, dispose } = render({});
      sc.disableAutoScroll();
      expect(sc.autoScroll()).toBe(false);
      expect(sc.autoScrollRef.value).toBe(false);
      dispose();
    });
  });

  // ── Deferred attachment (the liveTotalLines===0 early-return case) ────────

  describe('deferred attachment', () => {
    it('has no listeners until attach() is called', () => {
      const { sc, el, dispose } = render({ attach: false });

      wheelUp(el);
      expect(sc.autoScroll()).toBe(true);

      sc.attach(el);

      wheelUp(el);
      expect(sc.autoScroll()).toBe(false);
      expect(sc.autoScrollRef.value).toBe(false);
      dispose();
    });

    it('attach() to a second element moves the listeners', () => {
      const { sc, el, dispose } = render({});
      const other = document.createElement('div');
      document.body.appendChild(other);
      setScrollGeometry(other, { scrollHeight: 2000, scrollTop: 1500, clientHeight: 500 });

      sc.attach(other);
      expect(sc.element).toBe(other);

      wheelUp(el); // old element — detached
      expect(sc.autoScroll()).toBe(true);

      wheelUp(other);
      expect(sc.autoScroll()).toBe(false);
      dispose();
    });
  });

  // ── Listener cleanup ─────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('removes every event listener on owner disposal', () => {
      const { el, dispose } = render({});
      const removeSpy = vi.spyOn(el, 'removeEventListener');
      const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

      dispose();

      const removed = removeSpy.mock.calls.map((c) => c[0]);
      expect(removed).toContain('wheel');
      expect(removed).toContain('keydown');
      expect(removed).toContain('scroll');
      expect(removed).toContain('pointerdown');

      const windowRemoved = windowRemoveSpy.mock.calls.map((c) => c[0]);
      expect(windowRemoved).toContain('pointerup');
      expect(windowRemoved).toContain('pointercancel');

      removeSpy.mockRestore();
      windowRemoveSpy.mockRestore();
    });

    it('detach() is idempotent', () => {
      const { sc, el, dispose } = render({});
      sc.detach();
      sc.detach();
      wheelUp(el);
      expect(sc.autoScroll()).toBe(true);
      expect(sc.element).toBeNull();
      dispose();
    });
  });
});
