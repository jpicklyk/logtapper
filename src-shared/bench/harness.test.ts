// @vitest-environment jsdom
/**
 * Unit tests for the framework-free bench harness. Everything time-based is
 * driven by a stubbed `requestAnimationFrame` so the suite is deterministic and
 * a 60 s window costs nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  percentile,
  frameStats,
  observeLongTasks,
  installBench,
  __resetBench,
  BENCH_PREFIX,
  DROPPED_FRAME_MS,
} from './harness';

// ── rAF stub ───────────────────────────────────────────────────────────────
// Each frame advances a virtual clock by the next value in `frameDeltas`
// (cycling), and both `requestAnimationFrame` and `performance.now` read it.
let clock = 0;
let frameDeltas: number[] = [16];
let frameIndex = 0;

function stubClock(deltas: number[]) {
  clock = 0;
  frameDeltas = deltas;
  frameIndex = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    clock += frameDeltas[frameIndex % frameDeltas.length];
    frameIndex += 1;
    queueMicrotask(() => cb(clock));
    return frameIndex;
  });
}

/** A scroll container with jsdom-proof layout metrics. */
function makeScrollEl(scrollHeight: number, clientHeight: number, rows = 1): HTMLElement {
  const el = document.createElement('div');
  const sizer = document.createElement('div');
  el.appendChild(sizer);
  for (let i = 0; i < rows; i++) {
    const row = document.createElement('div');
    row.setAttribute('data-line', String(i));
    sizer.appendChild(row);
  }
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => { top = v; },
    configurable: true,
  });
  return el;
}

beforeEach(() => {
  __resetBench();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetBench();
});

describe('percentile', () => {
  it('uses nearest rank over an ascending array', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 95)).toBe(10);
    expect(percentile(s, 100)).toBe(10);
    expect(percentile(s, 0)).toBe(1);
  });

  it('returns 0 for an empty sample', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('picks the 95th of a 20-sample set as the 19th value', () => {
    const s = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(s, 95)).toBe(19);
  });
});

describe('frameStats', () => {
  it('sorts before computing and rounds to 0.01 ms', () => {
    const stats = frameStats([16.666, 33.3339, 8.1, 16.0], 74.1);
    expect(stats.frames).toBe(4);
    expect(stats.max).toBe(33.33);
    expect(stats.p50).toBe(16.0);
    expect(stats.p95).toBe(33.33);
    expect(stats.durationMs).toBe(74.1);
  });

  it('is all zeros with no frames', () => {
    expect(frameStats([], 0)).toEqual({ frames: 0, p50: 0, p95: 0, max: 0, durationMs: 0 });
  });
});

describe('observeLongTasks', () => {
  class FakeObserver {
    static last: FakeObserver | null = null;
    static pending: PerformanceEntry[] = [];
    static observed: PerformanceObserverInit | null = null;
    constructor(private cb: (list: { getEntries(): PerformanceEntry[] }) => void) {
      FakeObserver.last = this;
    }
    observe(init: PerformanceObserverInit) { FakeObserver.observed = init; }
    disconnect() {}
    takeRecords(): PerformanceEntry[] {
      const out = FakeObserver.pending;
      FakeObserver.pending = [];
      return out;
    }
    emit(durations: number[]) {
      this.cb({ getEntries: () => durations.map((duration) => ({ duration }) as PerformanceEntry) });
    }
  }

  it('aggregates count, max and total across callbacks and takeRecords()', () => {
    FakeObserver.pending = [{ duration: 80 } as PerformanceEntry];
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    const handle = observeLongTasks();
    expect(FakeObserver.observed).toEqual({ entryTypes: ['longtask'] });
    FakeObserver.last!.emit([60, 120.555]);
    const stats = handle.stop();
    expect(stats).toEqual({ count: 3, maxMs: 120.56, totalMs: 260.56, supported: true });
  });

  it('reports supported:false and zeros when longtask is unavailable', () => {
    vi.stubGlobal('PerformanceObserver', class {
      observe() { throw new Error('longtask not supported'); }
      disconnect() {}
      takeRecords() { return []; }
    });
    const stats = observeLongTasks().stop();
    expect(stats).toEqual({ count: 0, maxMs: 0, totalMs: 0, supported: false });
  });
});

describe('installBench', () => {
  const options = (el: HTMLElement, ready = true) => ({
    label: 'test',
    getScrollEl: () => el,
    getTotalLines: () => 1_000_000,
    rowHeight: () => 22,
    isReady: () => ready,
  });

  it('registers window.__bench and is idempotent', () => {
    const el = makeScrollEl(1000, 100);
    stubClock([16]);
    const a = installBench(options(el));
    const b = installBench({ ...options(el), label: 'second' });
    expect(a).toBe(b);
    expect(window.__bench).toBe(a);
  });

  it('run() resolves with the expected keys and logs a scrapeable line', async () => {
    const el = makeScrollEl(1000, 100);
    stubClock([16]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bench = installBench(options(el));
    const result = await bench.run({ stepLines: 10, streamSeconds: 0 });

    expect(Object.keys(result).sort()).toEqual(
      ['firstPaintedRowMs', 'heap', 'label', 'rowHeight', 'startedAt', 'stream', 'sweep', 'totalLines', 'userAgent'].sort(),
    );
    expect(result.label).toBe('test');
    expect(result.totalLines).toBe(1_000_000);
    expect(result.rowHeight).toBe(22);
    expect(result.stream).toBeNull();
    expect(result.sweep).not.toBeNull();
    // maxTop = 1000 - 100 = 900, stepPx = 10 * 22 = 220 → 0,220,440,660,880 up
    // (5 steps) and 900,680,460,240,20 down (5 steps).
    expect(result.sweep!.steps).toBe(10);
    expect(result.sweep!.frames).toBe(10);
    expect(result.sweep!.stepLines).toBe(10);
    expect(result.sweep!.p50).toBe(16);
    expect(result.sweep!.longTasks.count).toBe(0);
    expect(bench.metrics()).toBe(result);

    const line = log.mock.calls.at(-1)![0] as string;
    expect(line.startsWith(BENCH_PREFIX)).toBe(true);
    expect(JSON.parse(line.slice(BENCH_PREFIX.length)).label).toBe('test');
  });

  it('streamWindow() counts dropped frames over the requested window', async () => {
    const el = makeScrollEl(1000, 100);
    // 10 ms, 10 ms, 30 ms repeating → one dropped frame in three.
    stubClock([10, 10, 30]);
    const bench = installBench(options(el));
    const stream = await bench.streamWindow(0.3); // 300 ms of virtual time
    expect(stream.seconds).toBe(0.3);
    expect(stream.frames).toBeGreaterThan(0);
    expect(stream.dropped).toBeGreaterThan(0);
    expect(stream.dropped).toBeLessThan(stream.frames);
    expect(stream.max).toBeGreaterThan(DROPPED_FRAME_MS);
    expect(stream.droppedPct).toBeCloseTo((stream.dropped / stream.frames) * 100, 1);
    expect(stream.busyPct).toBe(0); // no longtask support in jsdom
  });

  it('markLinePage() measures to the first frame with a row, once', async () => {
    const el = makeScrollEl(1000, 100);
    stubClock([16]);
    let ready = false;
    const bench = installBench({ ...options(el), isReady: () => ready });
    bench.markLinePage();
    await Promise.resolve();
    ready = true;
    // Let the poll run a few frames.
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => queueMicrotask(r));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await bench.run({ stepLines: 10, streamSeconds: 0 });
    log.mockRestore();
    expect(result.firstPaintedRowMs).not.toBeNull();
    expect(result.firstPaintedRowMs!).toBeGreaterThan(0);
  });

  it('reports heap as null when performance.memory is absent', () => {
    const el = makeScrollEl(1000, 100);
    stubClock([16]);
    const bench = installBench(options(el));
    expect(bench.heap()).toBeNull();
  });

  it('reports heap numbers when performance.memory exists', () => {
    const el = makeScrollEl(1000, 100);
    stubClock([16]);
    Object.defineProperty(performance, 'memory', {
      value: { usedJSHeapSize: 42, totalJSHeapSize: 84, jsHeapSizeLimit: 168 },
      configurable: true,
    });
    try {
      const bench = installBench(options(el));
      expect(bench.heap()).toEqual({ usedJSHeapSize: 42, totalJSHeapSize: 84, jsHeapSizeLimit: 168 });
    } finally {
      Reflect.deleteProperty(performance, 'memory');
    }
  });

  it('run() rejects when the scroll element is missing', async () => {
    stubClock([16]);
    const bench = installBench({ ...options(document.createElement('div')), getScrollEl: () => null });
    await expect(bench.run({ streamSeconds: 0 })).rejects.toThrow(/no scroll element/);
  });
});
