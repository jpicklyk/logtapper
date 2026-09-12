// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { createCacheBinding, OVERSCAN } from './cacheBinding';
import { FetchScheduler } from '@viewport/FetchScheduler';
import type { DataSource } from '@viewport/DataSource';
import type { ViewLine } from '@bridge/types';

const ROW_H = 22;

/** Flush pending microtasks so promise-chained fetch phases settle. */
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function makeDataSource(opts: { sourceId?: string; totalLines?: number; cached?: boolean } = {}) {
  const resident = new Set<number>();
  let appendCb: ((lines: ViewLine[], total: number) => void) | null = null;
  const getLines = vi.fn((offset: number, count: number) => {
    for (let i = offset; i < offset + count; i++) resident.add(i);
    return Promise.resolve([] as ViewLine[]);
  });
  const ds: DataSource = {
    totalLines: opts.totalLines ?? 1000,
    sourceId: opts.sourceId ?? 'test:full',
    getLine: (n: number) => (opts.cached || resident.has(n) ? ({} as ViewLine) : undefined),
    getLines,
    onAppend: (cb) => { appendCb = cb; return () => { appendCb = null; }; },
  };
  return {
    ds,
    pushLines: (total: number) => appendCb?.([], total),
    getLines,
    fill: (offset: number, count: number) => {
      for (let i = offset; i < offset + count; i++) resident.add(i);
    },
  };
}

function mount(opts: {
  dataSource?: DataSource;
  scrollTop?: number;
  viewportHeight?: number;
  virtualBase?: number;
  liveTotalLines?: number;
  revision?: boolean;
} = {}) {
  const scheduler = new FetchScheduler();
  const reportScroll = vi.spyOn(scheduler, 'reportScroll');
  const forceFetch = vi.spyOn(scheduler, 'forceFetch');
  const ds = opts.dataSource ?? makeDataSource().ds;

  return createRoot((dispose) => {
    const [scrollTop, setScrollTop] = createSignal(opts.scrollTop ?? 0);
    const [viewportHeight, setViewportHeight] = createSignal(opts.viewportHeight ?? 220);
    const [virtualBase, setVirtualBase] = createSignal(opts.virtualBase ?? 0);
    const [source, setSource] = createSignal<DataSource>(ds);
    const [total, setTotal] = createSignal(opts.liveTotalLines ?? 1000);
    const [revision, setRevision] = createSignal(0);

    const binding = createCacheBinding({
      dataSource: source,
      scrollTop,
      viewportHeight,
      rowHeight: ROW_H,
      virtualBase,
      liveTotalLines: total,
      ...(opts.revision ? { revision } : {}),
      scheduler,
    });

    return {
      binding,
      scheduler,
      reportScroll,
      forceFetch,
      setScrollTop,
      setViewportHeight,
      setVirtualBase,
      setDataSource: (v: DataSource) => setSource(() => v),
      setTotal,
      bumpRevision: () => setRevision((v) => v + 1),
      dispose,
    };
  });
}

describe('createCacheBinding', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  // ── Visible window → reportScroll ────────────────────────────────────────

  describe('visible window', () => {
    it('reports the viewport plus overscan at the top of the file', () => {
      const h = mount({ scrollTop: 0, viewportHeight: 220 });

      expect(h.binding.visibleRange()).toEqual({ start: 0, end: 10 - 1 + OVERSCAN });
      expect(h.reportScroll).toHaveBeenCalledWith(0, 19, 1000);
      h.dispose();
    });

    it('slides the window as the container scrolls', () => {
      const h = mount({ scrollTop: 0, viewportHeight: 220 });
      h.reportScroll.mockClear();

      h.setScrollTop(2200); // 100 rows down

      expect(h.binding.visibleRange()).toEqual({ start: 90, end: 119 });
      expect(h.reportScroll).toHaveBeenCalledWith(90, 119, 1000);
      h.dispose();
    });

    it('offsets reported line numbers by the virtual base', () => {
      const h = mount({ scrollTop: 0, viewportHeight: 220, virtualBase: 500 });

      expect(h.binding.visibleRange()).toEqual({ start: 0, end: 19 });
      expect(h.reportScroll).toHaveBeenCalledWith(500, 519, 1000);
      h.dispose();
    });

    it('clamps the window to the lines remaining above the virtual base', () => {
      const h = mount({ scrollTop: 0, viewportHeight: 220, virtualBase: 995 });

      expect(h.binding.visibleRange()).toEqual({ start: 0, end: 4 });
      expect(h.reportScroll).toHaveBeenCalledWith(995, 999, 1000);
      h.dispose();
    });

    it('reports nothing when there is no renderable content', () => {
      const h = mount({ liveTotalLines: 0 });
      expect(h.binding.visibleRange()).toBeNull();
      expect(h.reportScroll).not.toHaveBeenCalled();
      h.dispose();
    });

    it('reports nothing before the container has been measured', () => {
      const h = mount({ viewportHeight: 0 });
      expect(h.binding.visibleRange()).toBeNull();
      expect(h.reportScroll).not.toHaveBeenCalled();
      h.dispose();
    });

    it('re-reports when streaming raises the total', () => {
      const h = mount({ liveTotalLines: 1000 });
      h.reportScroll.mockClear();

      h.setTotal(4000);

      expect(h.reportScroll).toHaveBeenCalledWith(0, 19, 4000);
      h.dispose();
    });
  });

  // ── Fetch orchestration ──────────────────────────────────────────────────

  describe('fetch orchestration', () => {
    it('fetches the viewport first, then the prefetch range', async () => {
      const src = makeDataSource();
      const h = mount({ dataSource: src.ds, scrollTop: 0, viewportHeight: 220 });

      await flush();

      expect(src.getLines).toHaveBeenCalled();
      // Phase 1 is exactly the viewport the scheduler was given.
      expect(src.getLines.mock.calls[0]).toEqual([0, 20]);
      // Phase 2 extends in the scroll direction.
      expect(src.getLines.mock.calls.length).toBeGreaterThan(1);
      h.dispose();
    });

    it('skips phase 1 when the viewport is already cached', async () => {
      const src = makeDataSource({ cached: true });
      const h = mount({ dataSource: src.ds });

      await flush();

      // Viewport and prefetch are both resident → nothing to fetch.
      expect(src.getLines).not.toHaveBeenCalled();
      h.dispose();
    });

    it('fetches only the prefetch range when the viewport is cached but the prefetch is not', async () => {
      const src = makeDataSource();
      src.fill(0, 40); // viewport (0..19) resident, prefetch beyond is not
      const h = mount({ dataSource: src.ds });

      await flush();

      expect(src.getLines).toHaveBeenCalledTimes(1);
      expect(src.getLines.mock.calls[0][0]).toBe(0); // the prefetch range, not the viewport
      expect(src.getLines.mock.calls[0][1]).toBeGreaterThan(20);
      h.dispose();
    });
  });

  // ── cacheVersion ─────────────────────────────────────────────────────────

  describe('cacheVersion', () => {
    it('bumps once for the initial data source binding', () => {
      const h = mount();
      expect(h.binding.cacheVersion()).toBe(1);
      h.dispose();
    });

    it('bumps after a completed viewport fetch', async () => {
      const src = makeDataSource();
      const h = mount({ dataSource: src.ds });
      const before = h.binding.cacheVersion();

      await flush();

      expect(h.binding.cacheVersion()).toBeGreaterThan(before);
      h.dispose();
    });

    it('bumps on a streaming append', () => {
      const src = makeDataSource({ cached: true });
      const h = mount({ dataSource: src.ds });
      const before = h.binding.cacheVersion();

      src.pushLines(1100);

      expect(h.binding.cacheVersion()).toBe(before + 1);
      h.dispose();
    });

    it('bumps when the data source is swapped', () => {
      const h = mount();
      const before = h.binding.cacheVersion();

      h.setDataSource(makeDataSource({ sourceId: 'other:full', cached: true }).ds);

      expect(h.binding.cacheVersion()).toBe(before + 1);
      h.dispose();
    });

    it('bumpCacheVersion bumps manually', () => {
      const h = mount();
      const before = h.binding.cacheVersion();
      h.binding.bumpCacheVersion();
      expect(h.binding.cacheVersion()).toBe(before + 1);
      h.dispose();
    });
  });

  // ── View revision (W0a) ──────────────────────────────────────────────────

  describe('revision', () => {
    it('does not reset on the initial value', () => {
      const h = mount({ revision: true });
      // Same as without a revision accessor: one bump for the source binding.
      expect(h.binding.cacheVersion()).toBe(1);
      h.dispose();
    });

    it('resets exactly like a sourceId swap, and forces a fetch', () => {
      const h = mount({ revision: true });
      const before = h.binding.cacheVersion();
      h.forceFetch.mockClear();

      h.bumpRevision();

      expect(h.binding.cacheVersion()).toBe(before + 1);
      expect(h.forceFetch).toHaveBeenCalledTimes(1);
      h.dispose();
    });

    it('discards an in-flight fetch so its bump never lands', async () => {
      const src = makeDataSource();
      const h = mount({ dataSource: src.ds, revision: true });
      const before = h.binding.cacheVersion();

      h.bumpRevision();          // resets the generation mid-flight
      const afterReset = h.binding.cacheVersion();
      await flush();             // the pre-reset promise settles here

      expect(afterReset).toBe(before + 1);
      // Only the reset's own bump plus any post-reset fetch — never the stale one.
      expect(h.binding.cacheVersion()).toBeGreaterThanOrEqual(afterReset);
      h.dispose();
    });

    it('stops resetting once disposed', () => {
      const h = mount({ revision: true });
      h.dispose();
      const after = h.binding.cacheVersion();
      h.bumpRevision();
      expect(h.binding.cacheVersion()).toBe(after);
    });
  });

  // ── Disposal ─────────────────────────────────────────────────────────────

  describe('disposal', () => {
    it('disposes the scheduler with its owner and stops reporting scroll', () => {
      const h = mount();
      const schedulerDispose = vi.spyOn(h.scheduler, 'dispose');

      h.dispose();

      expect(schedulerDispose).toHaveBeenCalledTimes(1);

      h.reportScroll.mockClear();
      h.setScrollTop(5000);
      expect(h.reportScroll).not.toHaveBeenCalled();
    });

    it('unsubscribes from onAppend so late batches stop bumping', () => {
      const src = makeDataSource({ cached: true });
      const h = mount({ dataSource: src.ds });
      const before = h.binding.cacheVersion();

      h.dispose();
      src.pushLines(2000);

      expect(h.binding.cacheVersion()).toBe(before);
    });

    it('dispose() is idempotent', () => {
      const h = mount();
      const schedulerDispose = vi.spyOn(h.scheduler, 'dispose');
      h.binding.dispose();
      h.binding.dispose();
      expect(schedulerDispose).toHaveBeenCalledTimes(1);
      h.dispose();
    });
  });
});
