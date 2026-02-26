import { describe, it, expect, vi } from 'vitest';
import { createCacheDataSource } from './CacheDataSource';
import { DataSourceRegistry } from './DataSourceRegistry';
import { ViewCacheHandle } from '../cache/CacheManager';
import type { ViewLine, LineWindow } from '../bridge/types';

/** Create a minimal ViewLine for testing. */
function makeLine(lineNum: number): ViewLine {
  return {
    lineNum,
    virtualIndex: lineNum,
    raw: `line ${lineNum}`,
    level: 'Info',
    tag: 'Test',
    message: `message ${lineNum}`,
    timestamp: lineNum * 1000,
    pid: 1,
    tid: 1,
    sourceId: 'test',
    highlights: [],
    matchedBy: [],
    isContext: false,
  };
}

function makeLines(start: number, count: number): ViewLine[] {
  return Array.from({ length: count }, (_, i) => makeLine(start + i));
}

function makeWindow(offset: number, count: number, total: number): LineWindow {
  return { totalLines: total, lines: makeLines(offset, count) };
}

// ---------------------------------------------------------------------------
// Basic CacheDataSource operations
// ---------------------------------------------------------------------------

describe('CacheDataSource', () => {
  it('getLine returns cached data', () => {
    const cache = new ViewCacheHandle(5000);
    cache.put([makeLine(10), makeLine(20)]);

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
    });

    expect(ds.getLine(10)?.lineNum).toBe(10);
    expect(ds.getLine(20)?.lineNum).toBe(20);
    expect(ds.getLine(30)).toBeUndefined();
  });

  it('getLine with lineNumbers maps virtual index to actual line', () => {
    const cache = new ViewCacheHandle(5000);
    cache.put([makeLine(100), makeLine(200), makeLine(300)]);

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
      lineNumbers: [100, 200, 300],
    });

    // Virtual index 0 → actual line 100
    expect(ds.getLine(0)?.lineNum).toBe(100);
    expect(ds.getLine(1)?.lineNum).toBe(200);
    expect(ds.getLine(2)?.lineNum).toBe(300);
    expect(ds.getLine(3)).toBeUndefined(); // out of bounds
  });

  it('totalLines reflects lineNumbers length in processor mode', () => {
    const cache = new ViewCacheHandle(5000);
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
      lineNumbers: [10, 20, 30],
    });
    expect(ds.totalLines).toBe(3);
  });

  it('totalLines starts at 0 in full mode', () => {
    const cache = new ViewCacheHandle(5000);
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
    });
    expect(ds.totalLines).toBe(0);
  });

  it('sourceId distinguishes full from processor mode', () => {
    const cache = new ViewCacheHandle(5000);

    const dsFull = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
    });
    expect(dsFull.sourceId).toBe('sess1:full');

    const dsProc = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
      lineNumbers: [1, 2, 3],
    });
    expect(dsProc.sourceId).toBe('sess1:processor');
  });

  // -----------------------------------------------------------------------
  // getLines — cache hit path
  // -----------------------------------------------------------------------

  it('getLines serves from cache when all lines are cached', async () => {
    const cache = new ViewCacheHandle(5000);
    cache.put(makeLines(0, 10));

    const fetchLines = vi.fn();
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    const result = await ds.getLines(0, 5);
    expect(result).toHaveLength(5);
    expect(result[0].lineNum).toBe(0);
    expect(result[4].lineNum).toBe(4);
    expect(fetchLines).not.toHaveBeenCalled();
  });

  it('getLines on cache hit does not invoke fetchLines', async () => {
    const cache = new ViewCacheHandle(5000);
    cache.put(makeLines(0, 5));

    const fetchLines = vi.fn();
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    const result = await ds.getLines(0, 3);
    expect(result).toHaveLength(3);
    expect(result[0].lineNum).toBe(0);
    expect(result[2].lineNum).toBe(2);
    expect(fetchLines).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // getLines — cache miss path
  // -----------------------------------------------------------------------

  it('getLines fetches from backend on cache miss', async () => {
    const cache = new ViewCacheHandle(5000);
    const fetchLines = vi.fn().mockResolvedValue(makeWindow(5, 5, 100));

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    const result = await ds.getLines(5, 5);
    expect(fetchLines).toHaveBeenCalledWith(5, 5);
    expect(result).toHaveLength(5);
    expect(result[0].lineNum).toBe(5);

    // Should be stored in cache now
    expect(cache.has(5)).toBe(true);
    expect(cache.has(9)).toBe(true);
  });

  it('getLines updates totalLines from backend response', async () => {
    const cache = new ViewCacheHandle(5000);
    const fetchLines = vi.fn().mockResolvedValue(makeWindow(0, 5, 1000));

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    expect(ds.totalLines).toBe(0);
    await ds.getLines(0, 5);
    expect(ds.totalLines).toBe(1000);
  });

  it('getLines fetches only the missing suffix on partial cache hit', async () => {
    const cache = new ViewCacheHandle(5000);
    // Cache lines 0-2, but request 0-4 (lines 3,4 missing)
    cache.put(makeLines(0, 3));

    // Mock returns 2 lines for the suffix fetch (offset=3, count=2)
    const fetchLines = vi.fn().mockResolvedValue(makeWindow(3, 2, 100));
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    const result = await ds.getLines(0, 5);
    // Only the missing suffix [3, 4] is fetched
    expect(fetchLines).toHaveBeenCalledWith(3, 2);
    // Returns window.lines directly (the 2 fetched lines)
    expect(result).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // _fetchGen stale-data guard (Fix #4)
  // -----------------------------------------------------------------------

  it('invalidate() discards in-flight fetch results', async () => {
    const cache = new ViewCacheHandle(5000);
    let resolvePromise: (w: LineWindow) => void;
    const pending = new Promise<LineWindow>((r) => { resolvePromise = r; });
    const fetchLines = vi.fn().mockReturnValue(pending);

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    const resultPromise = ds.getLines(0, 5);

    // Invalidate before the fetch resolves
    ds.invalidate();

    // Now resolve the original fetch — should be discarded
    resolvePromise!(makeWindow(0, 5, 100));
    const result = await resultPromise;

    expect(result).toEqual([]); // stale fetch discarded
    expect(cache.has(0)).toBe(false); // not stored in cache
  });

  it('dispose() discards in-flight fetch results', async () => {
    const cache = new ViewCacheHandle(5000);
    let resolvePromise: (w: LineWindow) => void;
    const pending = new Promise<LineWindow>((r) => { resolvePromise = r; });
    const fetchLines = vi.fn().mockReturnValue(pending);

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    const resultPromise = ds.getLines(0, 5);
    ds.dispose();

    resolvePromise!(makeWindow(0, 5, 100));
    const result = await resultPromise;

    expect(result).toEqual([]);
    expect(cache.has(0)).toBe(false);
  });

  it('sequential getLines without invalidate both apply (Fix #4: no ++_fetchGen per call)', async () => {
    const cache = new ViewCacheHandle(5000);
    let callCount = 0;
    const fetchLines = vi.fn().mockImplementation((offset: number, count: number) => {
      callCount++;
      return Promise.resolve(makeWindow(offset, count, 1000));
    });

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    // Two sequential fetches — both should apply since no invalidation
    const r1 = await ds.getLines(0, 5);
    const r2 = await ds.getLines(10, 5);

    expect(r1).toHaveLength(5);
    expect(r2).toHaveLength(5);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(10)).toBe(true);
    expect(callCount).toBe(2);
  });

  it('concurrent getLines both resolve when no invalidation', async () => {
    const cache = new ViewCacheHandle(5000);
    const fetchLines = vi.fn().mockImplementation((offset: number, count: number) =>
      Promise.resolve(makeWindow(offset, count, 1000))
    );

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    // Fire two concurrent fetches — both should apply (Fix #4)
    const [r1, r2] = await Promise.all([
      ds.getLines(0, 5),
      ds.getLines(100, 5),
    ]);

    expect(r1).toHaveLength(5);
    expect(r2).toHaveLength(5);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(100)).toBe(true);
  });

  it('invalidate between concurrent fetches discards both', async () => {
    const cache = new ViewCacheHandle(5000);
    const deferred: Array<(w: LineWindow) => void> = [];
    const fetchLines = vi.fn().mockImplementation(() => {
      return new Promise<LineWindow>((r) => { deferred.push(r); });
    });

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    const p1 = ds.getLines(0, 5);
    const p2 = ds.getLines(100, 5);

    // Invalidate — bumps gen, so both in-flight fetches captured old gen
    ds.invalidate();

    // Resolve both
    deferred[0](makeWindow(0, 5, 1000));
    deferred[1](makeWindow(100, 5, 1000));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual([]);
    expect(r2).toEqual([]);
    expect(cache.has(0)).toBe(false);
    expect(cache.has(100)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Streaming mode (pushStreamingLines / onAppend)
  // -----------------------------------------------------------------------

  it('pushStreamingLines fires onAppend listeners', () => {
    const cache = new ViewCacheHandle(5000);
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
    });

    const listener = vi.fn();
    ds.onAppend(listener);

    const lines = makeLines(0, 3);
    ds.pushStreamingLines(lines, 100);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(lines, 100);
  });

  it('pushStreamingLines updates totalLines', () => {
    const cache = new ViewCacheHandle(5000);
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
    });

    ds.pushStreamingLines(makeLines(0, 5), 500);
    expect(ds.totalLines).toBe(500);
  });

  it('onAppend unsubscribe stops notifications', () => {
    const cache = new ViewCacheHandle(5000);
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
    });

    const listener = vi.fn();
    const unsub = ds.onAppend(listener);

    ds.pushStreamingLines(makeLines(0, 1), 1);
    expect(listener).toHaveBeenCalledOnce();

    unsub();
    ds.pushStreamingLines(makeLines(1, 1), 2);
    expect(listener).toHaveBeenCalledOnce(); // no second call
  });

  it('dispose clears all onAppend listeners', () => {
    const cache = new ViewCacheHandle(5000);
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
    });

    const listener = vi.fn();
    ds.onAppend(listener);

    ds.dispose();
    ds.pushStreamingLines(makeLines(0, 1), 1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('multiple onAppend listeners all fire', () => {
    const cache = new ViewCacheHandle(5000);
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
    });

    const l1 = vi.fn();
    const l2 = vi.fn();
    const l3 = vi.fn();
    ds.onAppend(l1);
    ds.onAppend(l2);
    ds.onAppend(l3);

    ds.pushStreamingLines(makeLines(0, 1), 1);
    expect(l1).toHaveBeenCalledOnce();
    expect(l2).toHaveBeenCalledOnce();
    expect(l3).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // updateTotalLines
  // -----------------------------------------------------------------------

  it('updateTotalLines sets totalLines without side effects', () => {
    const cache = new ViewCacheHandle(5000);
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
    });

    ds.updateTotalLines(42);
    expect(ds.totalLines).toBe(42);
  });

  it('totalLines does not update from fetch in processor mode', async () => {
    const cache = new ViewCacheHandle(5000);
    const fetchLines = vi.fn().mockResolvedValue(makeWindow(0, 3, 99999));
    const lineNumbers = [10, 20, 30];

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
      lineNumbers,
    });

    // In processor mode, totalLines = lineNumbers.length, not from fetch
    await ds.getLines(0, 3);
    expect(ds.totalLines).toBe(3); // not 99999
  });

  // -----------------------------------------------------------------------
  // Registry integration
  // -----------------------------------------------------------------------

  it('registers with DataSourceRegistry on create', () => {
    const cache = new ViewCacheHandle(5000);
    const registry = new DataSourceRegistry();

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
      registry,
    });

    // Push through registry — should fire onAppend on ds
    const listener = vi.fn();
    ds.onAppend(listener);

    registry.pushToSession('sess1', makeLines(0, 1), 1);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('unregisters from DataSourceRegistry on dispose', () => {
    const cache = new ViewCacheHandle(5000);
    const registry = new DataSourceRegistry();

    const ds1 = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
      registry,
    });

    // Create a second source on the same session that stays alive
    const ds2 = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
      registry,
    });

    const listener1 = vi.fn();
    const listener2 = vi.fn();
    ds1.onAppend(listener1);
    ds2.onAppend(listener2);

    ds1.dispose();

    // Push after ds1 dispose — ds2 still receives, proving registry is active
    // but ds1 was specifically unregistered (not just its listeners cleared)
    registry.pushToSession('sess1', makeLines(0, 1), 1);
    expect(listener1).not.toHaveBeenCalled(); // disposed: unregistered + listeners cleared
    expect(listener2).toHaveBeenCalledOnce(); // proves registry still routes to live sources
  });

  it('without registry, no auto-registration', () => {
    const cache = new ViewCacheHandle(5000);

    // Should not throw even without registry
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines: vi.fn(),
    });

    ds.dispose(); // also should not throw without registry
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('getLines with 0 count returns empty without fetching', async () => {
    const cache = new ViewCacheHandle(5000);
    const fetchLines = vi.fn();
    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    // count=0 → loop never runs → firstMiss stays -1 → return prefixLines (empty)
    const result = await ds.getLines(0, 0);
    expect(fetchLines).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });

  it('getLines beyond lineNumbers array returns empty without fetching', async () => {
    const cache = new ViewCacheHandle(5000);
    const fetchLines = vi.fn();

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
      lineNumbers: [10, 20],
    });

    // offset=5 is beyond lineNumbers[1], so loop hits undefined → breaks immediately
    // firstMiss stays -1 → return prefixLines (empty)
    const result = await ds.getLines(5, 3);
    expect(fetchLines).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('fetch returning empty lines does not corrupt state', async () => {
    const cache = new ViewCacheHandle(5000);
    const fetchLines = vi.fn().mockResolvedValue({ totalLines: 0, lines: [] });

    const ds = createCacheDataSource({
      sessionId: 'sess1',
      viewCache: cache,
      fetchLines,
    });

    const result = await ds.getLines(0, 5);
    expect(result).toHaveLength(0);
    expect(ds.totalLines).toBe(0);
    expect(cache.size).toBe(0);
  });
});
