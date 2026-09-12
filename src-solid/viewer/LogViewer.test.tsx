/** @jsxImportSource solid-js */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import type { ViewLine } from '@bridge/generated/ViewLine';
import type { DataSource } from '@viewport/DataSource';
import { LogViewer } from './LogViewer';

vi.mock('@viewport/copyText', () => ({
  buildCopyText: vi.fn(() => 'COPIED'),
  writeClipboard: vi.fn(),
}));
import { buildCopyText, writeClipboard } from '@viewport/copyText';

// ── jsdom layout stubs ─────────────────────────────────────────────────────
// jsdom has no layout: clientHeight is always 0 and scrollTop is a no-op, so
// the viewer would compute an empty window. Back both with real storage.

const ROW_H = 22; // --viewer-row-h is unset in jsdom ⇒ DEFAULT_ROW_HEIGHT
const VIEWPORT_H = 220; // exactly 10 rows
const OVERSCAN = 10;

const scrollTops = new WeakMap<Element, number>();

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'grid' ? VIEWPORT_H : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      scrollTops.set(this, v);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'grid' ? 1e6 : 0;
    },
  });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

// ── Fake data source ───────────────────────────────────────────────────────

const makeLine = (n: number): ViewLine => ({
  lineNum: n,
  virtualIndex: n,
  raw: `line ${n}`,
  level: 'Info',
  tag: 'T',
  message: `line ${n}`,
  timestamp: n,
  pid: 1,
  tid: 1,
  sourceId: 'fake',
  highlights: [],
  matchedBy: [],
  isContext: false,
});

interface FakeSource extends DataSource {
  /** Fill the cache for [from, to) and notify appenders. */
  fill(from: number, to: number, total?: number): void;
  getLineSpy: ReturnType<typeof vi.fn>;
}

function makeSource(totalLines: number, cachedTo = totalLines): FakeSource {
  const cache = new Map<number, ViewLine>();
  for (let i = 0; i < cachedTo; i++) cache.set(i, makeLine(i));
  const listeners = new Set<(l: ViewLine[], t: number) => void>();
  let total = totalLines;
  const getLineSpy = vi.fn((n: number) => cache.get(n));

  const src: FakeSource = {
    get totalLines() {
      return total;
    },
    sourceId: 'fake:full',
    getLine: getLineSpy,
    // Resolve without filling — tests drive cache content explicitly via fill().
    getLines: () => Promise.resolve([]),
    onAppend(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    fill(from, to, newTotal) {
      for (let i = from; i < to; i++) cache.set(i, makeLine(i));
      if (newTotal != null) total = newTotal;
      for (const cb of listeners) cb([], total);
    },
    getLineSpy,
  };
  return src;
}

const grid = (c: HTMLElement) => c.querySelector('[role="grid"]') as HTMLElement;
const rows = (c: HTMLElement) => [...c.querySelectorAll('[data-line]')];
const lineNums = (c: HTMLElement) => rows(c).map((r) => Number(r.getAttribute('data-line')));
const activeLine = (c: HTMLElement) => {
  const el = c.querySelector('[data-active]');
  return el ? Number(el.getAttribute('data-line')) : null;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Windowing ──────────────────────────────────────────────────────────────

describe('LogViewer windowing', () => {
  it('renders the visible rows plus overscan at scrollTop 0', () => {
    const src = makeSource(1000);
    const { container } = render(() => <LogViewer dataSource={src} totalLineCount={1000} />);

    // 10 visible rows (0..9) + OVERSCAN below; nothing above line 0.
    expect(lineNums(container)).toEqual(
      Array.from({ length: VIEWPORT_H / ROW_H + OVERSCAN }, (_, i) => i),
    );
  });

  it('shifts the window when the container scrolls', () => {
    const src = makeSource(1000);
    const { container } = render(() => <LogViewer dataSource={src} totalLineCount={1000} />);

    const el = grid(container);
    el.scrollTop = 100 * ROW_H; // first visible line = 100
    fireEvent.scroll(el);

    const nums = lineNums(container);
    expect(nums[0]).toBe(100 - OVERSCAN);
    expect(nums[nums.length - 1]).toBe(109 + OVERSCAN);
    expect(nums).toHaveLength(VIEWPORT_H / ROW_H + 2 * OVERSCAN);
  });

  it('clamps the window to the last line of the file', () => {
    const src = makeSource(15);
    const { container } = render(() => <LogViewer dataSource={src} totalLineCount={15} />);
    expect(lineNums(container)).toEqual([...Array(15).keys()]);
  });

  it('renders nothing when the file is empty', () => {
    const src = makeSource(0);
    const { container } = render(() => <LogViewer dataSource={src} totalLineCount={0} />);
    expect(rows(container)).toHaveLength(0);
  });

  it('positions each row by --row-top rather than an inline pixel property', () => {
    const src = makeSource(50);
    const { container } = render(() => <LogViewer dataSource={src} totalLineCount={50} />);
    const third = rows(container)[2] as HTMLElement;
    expect(third.style.getPropertyValue('--row-top')).toBe(`${2 * ROW_H}px`);
    expect(third.style.top).toBe('');
  });

  it('renders a skeleton for a line that is not cached yet', () => {
    const src = makeSource(30, 10);
    const { container } = render(() => <LogViewer dataSource={src} totalLineCount={30} />);
    const byLine = new Map(rows(container).map((r) => [r.getAttribute('data-line'), r]));
    expect(byLine.get('5')!.hasAttribute('data-skeleton')).toBe(false);
    expect(byLine.get('15')!.hasAttribute('data-skeleton')).toBe(true);
  });
});

// ── Append repaints only the appended rows ─────────────────────────────────

describe('LogViewer append invalidation', () => {
  it('repaints only the rows whose line data resolved', async () => {
    const src = makeSource(30, 10); // 0..9 cached, 10..29 are skeletons
    const { container } = render(() => <LogViewer dataSource={src} totalLineCount={30} />);
    await flush();

    // Track every row the DOM actually touches from here on.
    const touched = new Set<number>();
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const node = r.target.nodeType === Node.TEXT_NODE ? r.target.parentElement : (r.target as Element);
        const row = node?.closest?.('[data-line]');
        if (row) touched.add(Number(row.getAttribute('data-line')));
      }
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true, attributes: true });

    src.fill(10, 20); // resolve exactly the rows that were skeletons
    await flush();
    observer.disconnect();

    // Every repainted row is one whose data changed — rows 0..9 are untouched
    // even though the shared cacheVersion signal re-ran all their memos.
    expect(touched.size).toBeGreaterThan(0);
    expect([...touched].every((n) => n >= 10 && n < 20)).toBe(true);

    const byLine = new Map(rows(container).map((r) => [r.getAttribute('data-line'), r]));
    expect(byLine.get('15')!.hasAttribute('data-skeleton')).toBe(false);
    expect(byLine.get('15')!.textContent).toContain('line 15');
  });
});

// ── Tail-mode follow: one layout-free rAF write per frame ──────────────────

describe('LogViewer tail-mode auto-scroll', () => {
  let rafQueue: FrameRequestCallback[] = [];
  let realRaf: typeof globalThis.requestAnimationFrame;
  let realCancel: typeof globalThis.cancelAnimationFrame;

  beforeEach(() => {
    rafQueue = [];
    realRaf = globalThis.requestAnimationFrame;
    realCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      rafQueue.push(cb)) as unknown as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as unknown as typeof globalThis.cancelAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancel;
  });

  /** Run everything queued for the next frame (callbacks may queue more). */
  const flushFrame = () => {
    const due = rafQueue;
    rafQueue = [];
    for (const cb of due) cb(0);
  };

  /** Count `scrollHeight` reads on every element until `restore()`. */
  const countScrollHeightReads = () => {
    const proto = HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'scrollHeight')!;
    let reads = 0;
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        reads += 1;
        return original.get!.call(this);
      },
    });
    return {
      reads: () => reads,
      restore: () => Object.defineProperty(proto, 'scrollHeight', original),
    };
  };

  const mountTailing = () => {
    const src = makeSource(100);
    const { container } = render(() => (
      <LogViewer dataSource={src} totalLineCount={100} tailMode />
    ));
    flushFrame(); // the mount-time follow
    return { src, container, el: grid(container) };
  };

  it('follows the tail without reading scrollHeight back off the element', () => {
    const { src, container, el } = mountTailing();
    const spy = countScrollHeightReads();
    try {
      src.fill(100, 200, 200);
      expect(rafQueue).toHaveLength(1);
      flushFrame();

      // The target comes from the spacer geometry the component already owns,
      // so the frame that commits the append performs no layout read.
      expect(spy.reads()).toBe(0);
      // jsdom does not clamp; the browser does. The write is deliberately the
      // full content height so no `scrollHeight` read is needed to stay pinned.
      expect(el.scrollTop).toBe(200 * ROW_H);
    } finally {
      spy.restore();
    }

    // The window moved to the tail inside the same frame — no scroll event
    // round-trip was needed to update the rendered rows.
    expect(lineNums(container)).toContain(199);
    expect(lineNums(container)).not.toContain(0);
  });

  it('coalesces several appends in one frame into a single scroll write', () => {
    const { src, el } = mountTailing();
    src.fill(100, 200, 200);
    src.fill(200, 300, 300);
    src.fill(300, 400, 400);

    // Three appends, one queued frame — and it targets the latest total.
    expect(rafQueue).toHaveLength(1);
    flushFrame();
    expect(el.scrollTop).toBe(400 * ROW_H);
    expect(rafQueue).toHaveLength(0);
  });

  it('schedules no follow frame once the user has scrolled away', () => {
    const { src, el } = mountTailing();
    fireEvent.wheel(el, { deltaY: -100 }); // disables auto-scroll
    src.fill(100, 200, 200);
    expect(rafQueue).toHaveLength(0);
  });
});

// ── Keyboard ───────────────────────────────────────────────────────────────

describe('LogViewer keyboard navigation', () => {
  let src: FakeSource;
  let container: HTMLElement;

  beforeEach(() => {
    src = makeSource(1000);
    container = render(() => <LogViewer dataSource={src} totalLineCount={1000} />).container;
  });

  const key = (k: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(grid(container), { key: k, ...init });

  it('ArrowDown lands on the first visible line, then advances one line at a time', () => {
    key('ArrowDown');
    expect(activeLine(container)).toBe(0);
    key('ArrowDown');
    expect(activeLine(container)).toBe(1);
    key('ArrowDown');
    expect(activeLine(container)).toBe(2);
  });

  it('ArrowUp moves back one line and stops at the start of the file', () => {
    key('ArrowDown');
    key('ArrowDown');
    expect(activeLine(container)).toBe(1);
    key('ArrowUp');
    expect(activeLine(container)).toBe(0);
    key('ArrowUp');
    expect(activeLine(container)).toBe(0);
  });

  it('PageDown/PageUp move by visibleRows − 1', () => {
    key('ArrowDown'); // cursor → 0
    key('PageDown');
    expect(activeLine(container)).toBe(VIEWPORT_H / ROW_H - 1); // 9
    key('PageDown');
    expect(activeLine(container)).toBe(2 * (VIEWPORT_H / ROW_H - 1)); // 18
    key('PageUp');
    expect(activeLine(container)).toBe(VIEWPORT_H / ROW_H - 1);
  });

  it('End jumps to the last line and scrolls it into view; Home returns to the top', () => {
    key('End');
    expect(activeLine(container)).toBe(999);
    expect(grid(container).scrollTop).toBe(1000 * ROW_H - VIEWPORT_H);
    expect(lineNums(container)).toContain(999);
    expect(lineNums(container)).not.toContain(0);

    key('Home');
    expect(activeLine(container)).toBe(0);
    expect(grid(container).scrollTop).toBe(0);
    expect(lineNums(container)).toContain(0);
  });

  it('scrolls the cursor into view when it walks past the bottom of the viewport', () => {
    key('ArrowDown'); // 0
    for (let i = 0; i < 12; i++) key('ArrowDown'); // → 12, past the 10 visible rows
    expect(activeLine(container)).toBe(12);
    expect(grid(container).scrollTop).toBe(13 * ROW_H - VIEWPORT_H);
  });
});

// ── Copy ───────────────────────────────────────────────────────────────────

describe('LogViewer copy', () => {
  it('Ctrl+C builds the copy text from the current selection and writes it', () => {
    const src = makeSource(100);
    const { container } = render(() => <LogViewer dataSource={src} totalLineCount={100} />);

    const row3 = rows(container).find((r) => r.getAttribute('data-line') === '3')!;
    fireEvent.click(row3);
    expect(container.querySelector('[data-selected]')?.getAttribute('data-line')).toBe('3');

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });

    expect(buildCopyText).toHaveBeenCalledTimes(1);
    const [selection, getText] = vi.mocked(buildCopyText).mock.calls[0];
    expect(selection.mode).toBe('line');
    expect([...selection.selected]).toEqual([3]);
    expect(getText(3)).toBe('line 3');
    expect(writeClipboard).toHaveBeenCalledWith('COPIED');
  });

  it('does not copy when nothing is selected', () => {
    const src = makeSource(100);
    render(() => <LogViewer dataSource={src} totalLineCount={100} />);
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    expect(buildCopyText).not.toHaveBeenCalled();
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it('shift+click extends the selection from the anchor', () => {
    const src = makeSource(100);
    const { container } = render(() => <LogViewer dataSource={src} totalLineCount={100} />);
    const at = (n: number) => rows(container).find((r) => r.getAttribute('data-line') === String(n))!;

    fireEvent.click(at(2));
    fireEvent.click(at(5), { shiftKey: true });
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });

    const [selection] = vi.mocked(buildCopyText).mock.calls[0];
    expect([...selection.selected].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  });
});
