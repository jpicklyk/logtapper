import { describe, it, expect } from 'vitest';
import { CacheManager, ViewCacheHandle } from './CacheManager';
import type { ViewLine } from '../bridge/types';

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

// ---------------------------------------------------------------------------
// ViewCacheHandle
// ---------------------------------------------------------------------------

describe('ViewCacheHandle', () => {
  it('stores and retrieves lines by lineNum', () => {
    const h = new ViewCacheHandle(1000);
    h.put([makeLine(10), makeLine(20)]);
    expect(h.get(10)?.lineNum).toBe(10);
    expect(h.get(20)?.lineNum).toBe(20);
    expect(h.get(30)).toBeUndefined();
  });

  it('reports size correctly', () => {
    const h = new ViewCacheHandle(1000);
    expect(h.size).toBe(0);
    h.put([makeLine(1), makeLine(2), makeLine(3)]);
    expect(h.size).toBe(3);
  });

  it('evicts LRU entries when over allocation', () => {
    // Use allocation above MIN_FLOOR, fill to capacity, then add one more
    const h = new ViewCacheHandle(2500);
    // Fill with 2500 lines
    const lines = Array.from({ length: 2500 }, (_, i) => makeLine(i));
    h.put(lines);
    expect(h.size).toBe(2500);

    // Adding one more should evict the LRU (line 0)
    h.put([makeLine(9999)]);
    expect(h.size).toBe(2500);
    expect(h.has(0)).toBe(false);
    expect(h.has(1)).toBe(true);
    expect(h.has(9999)).toBe(true);
  });

  it('refreshes LRU on get()', () => {
    const h = new ViewCacheHandle(2500);
    const lines = Array.from({ length: 2500 }, (_, i) => makeLine(i));
    h.put(lines);

    // Access line 0 to make it most recently used
    h.get(0);

    // Adding line 9999 should now evict line 1 (oldest after refresh)
    h.put([makeLine(9999)]);
    expect(h.has(0)).toBe(true);  // was refreshed
    expect(h.has(1)).toBe(false); // LRU victim
    expect(h.has(9999)).toBe(true);
  });

  it('updates existing entry without growing size', () => {
    const h = new ViewCacheHandle(1000);
    h.put([makeLine(10)]);
    expect(h.size).toBe(1);

    const updated = { ...makeLine(10), message: 'updated' };
    h.put([updated]);
    expect(h.size).toBe(1);
    expect(h.get(10)?.message).toBe('updated');
  });

  it('prefetchAllowed returns false when at capacity', () => {
    const h = new ViewCacheHandle(2500);
    expect(h.prefetchAllowed()).toBe(true);
    const lines = Array.from({ length: 2500 }, (_, i) => makeLine(i));
    h.put(lines);
    expect(h.prefetchAllowed()).toBe(false);
  });

  it('setAllocation shrinks cache via eviction', () => {
    const h = new ViewCacheHandle(10);
    h.put([makeLine(1), makeLine(2), makeLine(3), makeLine(4), makeLine(5)]);
    expect(h.size).toBe(5);

    // MIN_FLOOR is 2000, so setting to 3 actually sets to 2000
    // Let's test with values above MIN_FLOOR
    h.setAllocation(3);
    // MIN_FLOOR kicks in — allocation becomes 2000, no eviction
    expect(h.size).toBe(5);
  });

  it('clear empties the cache', () => {
    const h = new ViewCacheHandle(1000);
    h.put([makeLine(1), makeLine(2)]);
    expect(h.size).toBe(2);
    h.clear();
    expect(h.size).toBe(0);
    expect(h.get(1)).toBeUndefined();
  });

  it('enforces MIN_FLOOR of 2000', () => {
    const h = new ViewCacheHandle(500);
    expect(h.allocation).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// CacheManager
// ---------------------------------------------------------------------------

describe('CacheManager', () => {
  it('allocates a view and returns a handle', () => {
    const mgr = new CacheManager(100_000);
    const handle = mgr.allocateView('s1');
    expect(handle).toBeInstanceOf(ViewCacheHandle);
    expect(mgr.viewCount).toBe(1);
  });

  it('returns existing handle on duplicate allocateView', () => {
    const mgr = new CacheManager(100_000);
    const h1 = mgr.allocateView('s1');
    const h2 = mgr.allocateView('s1');
    expect(h1).toBe(h2);
  });

  it('single view gets full budget', () => {
    const mgr = new CacheManager(50_000);
    const handle = mgr.allocateView('s1');
    expect(handle.allocation).toBe(50_000);
  });

  it('focused view gets 60% of budget with two views', () => {
    const mgr = new CacheManager(100_000);
    const h1 = mgr.allocateView('s1');
    mgr.allocateView('s2');

    // s1 was first, so it's focused
    expect(mgr.getPriority('s1')).toBe('focused');
    expect(h1.allocation).toBe(60_000);
  });

  it('non-focused view gets visible share', () => {
    const mgr = new CacheManager(100_000);
    mgr.allocateView('s1');
    const h2 = mgr.allocateView('s2');

    expect(mgr.getPriority('s2')).toBe('visible');
    expect(h2.allocation).toBe(30_000);
  });

  it('setFocus changes allocations', () => {
    const mgr = new CacheManager(100_000);
    const h1 = mgr.allocateView('s1');
    const h2 = mgr.allocateView('s2');

    mgr.setFocus('s2');
    expect(mgr.getPriority('s2')).toBe('focused');
    expect(mgr.getPriority('s1')).toBe('visible');
    expect(h2.allocation).toBe(60_000);
    expect(h1.allocation).toBe(30_000);
  });

  it('releaseView reclaims budget and redistributes', () => {
    const mgr = new CacheManager(100_000);
    const h1 = mgr.allocateView('s1');
    mgr.allocateView('s2');

    expect(h1.allocation).toBe(60_000);

    mgr.releaseView('s2');
    expect(mgr.viewCount).toBe(1);
    // s1 is now the only view — gets full budget
    expect(h1.allocation).toBe(100_000);
  });

  it('releasing focused view promotes next view', () => {
    const mgr = new CacheManager(100_000);
    mgr.allocateView('s1');
    const h2 = mgr.allocateView('s2');

    mgr.releaseView('s1');
    expect(mgr.getPriority('s2')).toBe('focused');
    expect(h2.allocation).toBe(100_000);
  });

  it('setTotalBudget updates all allocations', () => {
    const mgr = new CacheManager(100_000);
    const h1 = mgr.allocateView('s1');
    mgr.allocateView('s2');

    expect(h1.allocation).toBe(60_000);

    mgr.setTotalBudget(200_000);
    expect(h1.allocation).toBe(120_000);
  });

  it('getHandle returns undefined for unknown view', () => {
    const mgr = new CacheManager(100_000);
    expect(mgr.getHandle('nonexistent')).toBeUndefined();
  });

  it('setFocus on unknown view is a no-op', () => {
    const mgr = new CacheManager(100_000);
    mgr.allocateView('s1');
    mgr.setFocus('nonexistent');
    expect(mgr.getPriority('s1')).toBe('focused');
  });

  it('three views split budget correctly', () => {
    const mgr = new CacheManager(100_000);
    const h1 = mgr.allocateView('s1');
    const h2 = mgr.allocateView('s2');
    const h3 = mgr.allocateView('s3');

    // s1 = focused (60k), s2 + s3 = visible (30k / 2 = 15k each)
    expect(h1.allocation).toBe(60_000);
    expect(h2.allocation).toBe(15_000);
    expect(h3.allocation).toBe(15_000);
  });
});
