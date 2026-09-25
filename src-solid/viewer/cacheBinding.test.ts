// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { createCacheBinding, OVERSCAN } from './cacheBinding';
import { FetchScheduler } from '@viewport/FetchScheduler';
import type { DataSource } from '@viewport/DataSource';
import { createCacheDataSource } from '@viewport/CacheDataSource';
import { ViewCacheHandle } from '@cache/CacheManager';
import type { LinePage, ViewLine } from '@bridge/types';

const ROW_H = 22;

/** Flush pending microtasks so promise-chained fetch phases settle. */
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function makeDataSource(
  opts: { sourceId?: string; totalLines?: number; cached?: boolean; manual?: boolean } = {},
) {
  const resident = new Set<number>();
  let appendCb: ((lines: ViewLine[], total: number) => void) | null = null;
  /** Manual mode: every `getLines` stays pending until `settle(i)` resolves it. */
  const pending: Array<() => void> = [];
  const getLines = vi.fn((offset: number, count: number) => {
    if (opts.manual) {
      return new Promise<ViewLine[]>((resolve) => {
        pending.push(() => {
          for (let i = offset; i < offset + count; i++) resident.add(i);
          resolve([]);
        });
      });
    }
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
    pending,
    settle: (i: number) => pending[i]?.(),
    fill: (offset: number, count: number) => {
      for (let i = offset; i < offset + count; i++) resident.add(i);
    },
    /** Drop everything resident — what `CacheManager.clearSession` does to the real source. */
    evict: () => resident.clear(),
  };
}

function mount(opts: {
  dataSource?: DataSource;
  scrollTop?: number;
  viewportHeight?: number;
  virtualBase?: number;
  liveTotalLines?: number;
  revision?: boolean;
  maxVirtualLines?: number;
  /** Passed straight to the `FetchScheduler` (tests that need deterministic timing). */
  schedulerConfig?: ConstructorParameters<typeof FetchScheduler>[0];
} = {}) {
  const scheduler = new FetchScheduler(opts.schedulerConfig);
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
      ...(opts.maxVirtualLines != null ? { maxVirtualLines: () => opts.maxVirtualLines! } : {}),
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

    it('refetches the UNMOVED window when the bump follows a cache clear (a pure content refresh)', async () => {
      const src = makeDataSource();
      const h = mount({ dataSource: src.ds, revision: true });
      await flush(); // the initial viewport + prefetch fills land
      expect(src.getLines).toHaveBeenCalled();
      src.getLines.mockClear();
      h.reportScroll.mockClear();

      // The anonymizer mode entering/leaving `All`: the cache is emptied under
      // a stable source and window, then the revision bumps. The scheduler has
      // consumed its pending range, so `forceFetch` alone would run nothing —
      // the binding must re-report the current window to get the refetch.
      src.evict();
      h.bumpRevision();
      await flush();

      expect(h.reportScroll).toHaveBeenCalledWith(0, 19, 1000);
      expect(src.getLines).toHaveBeenCalled();
      expect(src.getLines.mock.calls[0]).toEqual([0, 20]);
      h.dispose();
    });

    it("resets exactly once and never runs the stale fetch's phase 2", async () => {
      const src = makeDataSource();
      const h = mount({ dataSource: src.ds, revision: true });
      const before = h.binding.cacheVersion();

      h.bumpRevision();          // resets the generation mid-flight
      const afterReset = h.binding.cacheVersion();
      await flush();             // the pre-reset promise settles here

      expect(afterReset).toBe(before + 1);
      // The stale fill may announce its landed lines (see the next test), but
      // exactly one prefetch runs after the reset — its own, not the stale one's.
      expect(h.binding.cacheVersion()).toBeGreaterThanOrEqual(afterReset);
      const prefetches = src.getLines.mock.calls.filter(([, count]) => count > 20);
      expect(prefetches.length).toBeLessThanOrEqual(1);
      h.dispose();
    });

    it('still announces a stale fill that landed in the unchanged source', async () => {
      // Live finding: the viewport fill went stale mid-flight (a geometry
      // change while the scheduler was unsettled), its lines landed anyway,
      // and the scheduler deduped the re-report of the same range — so no
      // bump ever fired and the first screen stayed skeletons until scrolled.
      const src = makeDataSource();
      const h = mount({ dataSource: src.ds, revision: true });
      h.bumpRevision();          // the in-flight fill is now stale
      src.fill(0, 1000);         // nothing a follow-up cycle could ask for is missing
      const afterReset = h.binding.cacheVersion();
      await flush();             // the stale fill lands

      expect(h.binding.cacheVersion()).toBeGreaterThan(afterReset);
      h.dispose();
    });

    it('does not announce a stale fill once the source has been swapped', async () => {
      const src = makeDataSource();
      const h = mount({ dataSource: src.ds });
      const other = makeDataSource({ sourceId: 'other:full', cached: true });
      h.setDataSource(other.ds); // swap resets; the swapped-in source has nothing to fetch
      const afterSwap = h.binding.cacheVersion();
      await flush();             // the first source's fill lands, for a cache nobody reads

      expect(h.binding.cacheVersion()).toBe(afterSwap);
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
  // ── Single-flight across overlapping fetches (M6) ─────────────────────────
  describe('single-flight guard with two fetches in flight', () => {
    /** Always "settled", so every reportScroll executes synchronously. */
    const IMMEDIATE = { velocityThreshold: Number.POSITIVE_INFINITY };

    it('does not let a stale fetch release the flag a newer fetch holds', async () => {
      const src = makeDataSource({ manual: true });
      const h = mount({ dataSource: src.ds, revision: true, schedulerConfig: IMMEDIATE });

      // F1 was issued at mount and is still pending.
      expect(src.getLines).toHaveBeenCalledTimes(1);

      // A revision bump supersedes F1 and clears the flag; the scroll that
      // follows issues F2, which now owns the single-flight slot.
      h.bumpRevision();
      h.setScrollTop(100 * ROW_H);
      expect(src.getLines).toHaveBeenCalledTimes(2);

      // F1 resolves *after* F2 started. It is stale — it must not touch the flag.
      src.settle(0);
      await flush();

      // With the flag wrongly cleared, this scroll issues a third fetch that
      // runs concurrently with F2 — the exact IPC multiplication the guard exists
      // to prevent.
      h.setScrollTop(200 * ROW_H);
      expect(src.getLines).toHaveBeenCalledTimes(2);

      // Once F2 itself resolves the slot is free again.
      src.settle(1);
      await flush();
      h.setScrollTop(300 * ROW_H);
      expect(src.getLines.mock.calls.length).toBeGreaterThan(2);

      h.dispose();
    });
  });

  // ── Filtered view over scattered lines ("Show matched lines") ────────────
  describe('filtered source with scattered line numbers', () => {
    /** Matches spread across a large file: a dense burst, then one match every ~9k lines. */
    const matched = [
      ...Array.from({ length: 12 }, (_, i) => 116_714 + i),
      ...Array.from({ length: 200 }, (_, i) => 130_000 + i * 9_000),
    ];
    const IMMEDIATE = { velocityThreshold: Number.POSITIVE_INFINITY, prefetchLines: 500 };

    function filteredSource() {
      const fetchLines = vi.fn((offset: number, count: number): Promise<LinePage> => Promise.resolve({
        sessionId: 's', totalLines: 2_000_000, offset, count, truncated: false,
        lines: Array.from({ length: count }, (_, i) => ({ lineNum: offset + i }) as ViewLine),
      }));
      const ds = createCacheDataSource({
        sessionId: 's',
        viewCache: new ViewCacheHandle(50_000),
        fetchLines,
        getLineNumbers: () => matched,
      });
      return { ds, fetchLines };
    }

    const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };

    function expectRowsLoaded(ds: DataSource, range: { start: number; end: number }) {
      for (let row = range.start; row <= range.end; row++) {
        expect(ds.getLine(row)?.lineNum, `row ${row}`).toBe(matched[row]);
      }
    }

    it('fills every visible row on the first pass, with no scroll', async () => {
      const { ds } = filteredSource();
      const h = mount({ dataSource: ds, liveTotalLines: matched.length, schedulerConfig: IMMEDIATE });

      await settle();

      expectRowsLoaded(ds, h.binding.visibleRange()!);
      h.dispose();
    });

    it('fills a far viewport after a jump, with no further scroll', async () => {
      const { ds } = filteredSource();
      const h = mount({ dataSource: ds, liveTotalLines: matched.length, schedulerConfig: IMMEDIATE });
      await settle();

      h.setScrollTop(150 * ROW_H);
      await settle();

      const range = h.binding.visibleRange()!;
      expect(range.start).toBeGreaterThan(100);
      expectRowsLoaded(ds, range);
      h.dispose();
    });
  });

  // ── The window the binding reports is the window the viewer renders (M4) ──
  describe('maxVirtualLines clamp', () => {
    it('never reports a row past the browser scroll-height cap', () => {
      // 1 M lines would otherwise fill the viewport+overscan window (0..19);
      // the cap says only 15 rows exist, so the last reportable row is 14.
      const h = mount({ liveTotalLines: 1_000_000, maxVirtualLines: 15 });
      expect(h.binding.visibleRange()).toEqual({ start: 0, end: 14 });
      h.dispose();
    });

    it('is unclamped when no cap is supplied', () => {
      const h = mount({ liveTotalLines: 1_000_000 });
      expect(h.binding.visibleRange()!.end).toBe(9 + OVERSCAN);
      h.dispose();
    });
  });
});
