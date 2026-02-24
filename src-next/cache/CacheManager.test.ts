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

/** Create an array of consecutive ViewLines [start, start+count). */
function makeLines(start: number, count: number): ViewLine[] {
  return Array.from({ length: count }, (_, i) => makeLine(start + i));
}

// ---------------------------------------------------------------------------
// ViewCacheHandle — basic operations
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
    const h = new ViewCacheHandle(2500);
    h.put(makeLines(0, 2500));
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
    h.put(makeLines(0, 2500));

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
    h.put(makeLines(0, 2500));
    expect(h.prefetchAllowed()).toBe(false);
  });

  it('setAllocation below MIN_FLOOR clamps to floor without evicting', () => {
    const h = new ViewCacheHandle(2000);
    h.put([makeLine(1), makeLine(2), makeLine(3), makeLine(4), makeLine(5)]);
    expect(h.size).toBe(5);

    // Setting to 3 clamps to MIN_FLOOR (2000) — no eviction since 5 < 2000
    h.setAllocation(3);
    expect(h.allocation).toBe(2000);
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

  // -----------------------------------------------------------------------
  // LRU linked-list correctness (Fix #1)
  // -----------------------------------------------------------------------

  it('evicts in correct LRU order across many insertions', () => {
    const h = new ViewCacheHandle(2005);
    // Insert 2005 lines: 0..2004
    h.put(makeLines(0, 2005));
    expect(h.size).toBe(2005);

    // Insert 5 more — should evict 0,1,2,3,4
    h.put(makeLines(5000, 5));
    expect(h.size).toBe(2005);
    for (let i = 0; i < 5; i++) {
      expect(h.has(i)).toBe(false);
    }
    expect(h.has(5)).toBe(true);
    expect(h.has(5004)).toBe(true);
  });

  it('promote via get() moves line to MRU position', () => {
    const h = new ViewCacheHandle(2003);
    h.put(makeLines(0, 2003));

    // Access oldest lines to promote them
    h.get(0);
    h.get(1);
    h.get(2);

    // Evict 3 entries — should evict 3, 4, 5 (the new LRU entries)
    h.put(makeLines(10000, 3));
    expect(h.has(0)).toBe(true);
    expect(h.has(1)).toBe(true);
    expect(h.has(2)).toBe(true);
    expect(h.has(3)).toBe(false);
    expect(h.has(4)).toBe(false);
    expect(h.has(5)).toBe(false);
  });

  it('put() of existing entry promotes it to MRU', () => {
    const h = new ViewCacheHandle(2003);
    h.put(makeLines(0, 2003));

    // Re-put line 0 (update) — promotes to MRU
    h.put([{ ...makeLine(0), message: 're-inserted' }]);

    // Evict 1 entry
    h.put([makeLine(9999)]);
    expect(h.has(0)).toBe(true); // was promoted by re-put
    expect(h.get(0)?.message).toBe('re-inserted');
    expect(h.has(1)).toBe(false); // evicted as LRU
  });

  it('get() on missing key does not corrupt LRU state', () => {
    const h = new ViewCacheHandle(2003);
    h.put(makeLines(0, 3));

    // get() on a miss
    expect(h.get(999)).toBeUndefined();

    // Should still function normally
    h.put(makeLines(3, 2000));
    expect(h.size).toBe(2003);
    expect(h.has(0)).toBe(true);
  });

  it('clear() followed by reuse works correctly', () => {
    const h = new ViewCacheHandle(2010);
    h.put(makeLines(0, 100));
    h.clear();
    expect(h.size).toBe(0);

    // Re-populate and verify LRU works
    h.put(makeLines(500, 2010));
    expect(h.size).toBe(2010);

    h.put([makeLine(9999)]);
    expect(h.size).toBe(2010);
    expect(h.has(500)).toBe(false); // oldest evicted
    expect(h.has(501)).toBe(true);
    expect(h.has(9999)).toBe(true);
  });

  it('put() with empty array is a no-op', () => {
    const h = new ViewCacheHandle(2000);
    h.put([]);
    expect(h.size).toBe(0);
  });

  it('single-element cache works correctly', () => {
    // MIN_FLOOR prevents allocation below 2000, so this is effectively 2000
    const h = new ViewCacheHandle(2000);
    h.put([makeLine(42)]);
    expect(h.get(42)?.lineNum).toBe(42);
    expect(h.size).toBe(1);
  });

  it('entries() iterates all cached lines', () => {
    const h = new ViewCacheHandle(5000);
    h.put(makeLines(10, 5));
    const entries = [...h.entries()];
    expect(entries).toHaveLength(5);
    const keys = entries.map(([k]) => k).sort((a, b) => a - b);
    expect(keys).toEqual([10, 11, 12, 13, 14]);
  });

  it('has() does not promote in LRU', () => {
    const h = new ViewCacheHandle(2002);
    h.put(makeLines(0, 2002));

    // has() should not promote line 0
    expect(h.has(0)).toBe(true);

    // Evict 1 entry — line 0 should be evicted since has() doesn't promote
    h.put([makeLine(9999)]);
    expect(h.has(0)).toBe(false);
    expect(h.has(1)).toBe(true);
  });

  it('rapid get/put interleaving maintains consistency', () => {
    const h = new ViewCacheHandle(2005);
    h.put(makeLines(0, 2005));

    // Interleave gets and puts
    h.get(100);
    h.put([makeLine(5000)]);
    h.get(200);
    h.put([makeLine(5001)]);
    h.get(300);

    // 2005 + 2 new - 2 evicted = 2005
    expect(h.size).toBe(2005);
    // Lines 0 and 1 should have been evicted (LRU, not promoted)
    expect(h.has(0)).toBe(false);
    expect(h.has(1)).toBe(false);
    // Promoted lines should survive
    expect(h.has(100)).toBe(true);
    expect(h.has(200)).toBe(true);
    expect(h.has(300)).toBe(true);
    expect(h.has(5000)).toBe(true);
    expect(h.has(5001)).toBe(true);
  });

  it('setAllocation above MIN_FLOOR triggers eviction', () => {
    const h = new ViewCacheHandle(3000);
    h.put(makeLines(0, 3000));
    expect(h.size).toBe(3000);

    h.setAllocation(2500);
    expect(h.allocation).toBe(2500);
    expect(h.size).toBe(2500);
    // First 500 lines (LRU) should be evicted
    expect(h.has(0)).toBe(false);
    expect(h.has(499)).toBe(false);
    expect(h.has(500)).toBe(true);
  });

  it('setAllocation growing does not lose data', () => {
    const h = new ViewCacheHandle(2500);
    h.put(makeLines(0, 2500));
    expect(h.size).toBe(2500);

    h.setAllocation(5000);
    expect(h.allocation).toBe(5000);
    expect(h.size).toBe(2500); // no data lost, no data magically appears
    expect(h.has(0)).toBe(true);
    expect(h.has(2499)).toBe(true);
  });

  it('duplicate lineNum in a single put batch is handled', () => {
    const h = new ViewCacheHandle(5000);
    const line1 = { ...makeLine(42), message: 'first' };
    const line2 = { ...makeLine(42), message: 'second' };
    h.put([line1, line2]);
    expect(h.size).toBe(1);
    // Second write wins
    expect(h.get(42)?.message).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// CacheManager — basic operations
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

  // -----------------------------------------------------------------------
  // Budget floor overflow protection (Fix #3)
  // -----------------------------------------------------------------------

  it('no floor overshoot when per-visible exceeds MIN_FLOOR', () => {
    const mgr = new CacheManager(100_000);
    // 1 focused + 9 visible = 10 total
    const focused = mgr.allocateView('f');
    const visibleHandles: ViewCacheHandle[] = [];
    for (let i = 0; i < 9; i++) {
      visibleHandles.push(mgr.allocateView(`v${i}`));
    }

    // visibleBudget = 30,000, perVisible = floor(30000/9) = 3333 — above MIN_FLOOR
    // No clamping needed, so focused keeps full 60% allocation
    expect(focused.allocation).toBe(60_000);
    for (const h of visibleHandles) {
      expect(h.allocation).toBe(Math.floor(30_000 / 9)); // 3333 exactly
    }

    // Verify total does not exceed budget (floor truncation may leave slack)
    let total = focused.allocation;
    for (const h of visibleHandles) total += h.allocation;
    expect(total).toBeLessThanOrEqual(100_000);
  });

  it('many visible views with floor clamping reduces focused budget', () => {
    // Budget so small that visible per-view < MIN_FLOOR
    // 20,000 total, 1 focused + 15 visible
    const mgr = new CacheManager(20_000);
    const focused = mgr.allocateView('f');
    const visibleHandles: ViewCacheHandle[] = [];
    for (let i = 0; i < 15; i++) {
      visibleHandles.push(mgr.allocateView(`v${i}`));
    }

    // visibleBudget = floor(20000 * 0.3) = 6000, perVisible = 6000/15 = 400
    // Each visible view clamped to MIN_FLOOR=2000
    // Floor overshoot = 15 * (2000 - 400) = 24,000
    // focusedBudget = floor(20000 * 0.6) = 12,000
    // adjustedFocused = max(2000, 12000 - 24000) = 2000 (clamped to own floor)
    expect(focused.allocation).toBe(2000);
    for (const h of visibleHandles) {
      expect(h.allocation).toBe(2000);
    }
  });

  it('floor clamping reduces focused but not below MIN_FLOOR', () => {
    // Design a scenario where overshoot would push focused below floor
    const mgr = new CacheManager(30_000);
    const focused = mgr.allocateView('f');
    const v1 = mgr.allocateView('v1');
    const v2 = mgr.allocateView('v2');
    const v3 = mgr.allocateView('v3');
    const v4 = mgr.allocateView('v4');
    const v5 = mgr.allocateView('v5');

    // visibleBudget = floor(30000*0.3) = 9000, perVisible = 9000/5 = 1800
    // Each clamped to 2000, overshoot = 5 * (2000 - 1800) = 1000
    // focusedBudget = floor(30000*0.6) = 18000
    // adjusted = max(2000, 18000 - 1000) = 17000
    expect(focused.allocation).toBe(17_000);
    expect(v1.allocation).toBe(2000);
    expect(v2.allocation).toBe(2000);
    expect(v3.allocation).toBe(2000);
    expect(v4.allocation).toBe(2000);
    expect(v5.allocation).toBe(2000);
  });

  // -----------------------------------------------------------------------
  // Session-scoped operations
  // -----------------------------------------------------------------------

  it('broadcastToSession writes to all handles for that session', () => {
    const mgr = new CacheManager(100_000);
    const h1 = mgr.allocateView('p1-sess1', 'sess1');
    const h2 = mgr.allocateView('p2-sess1', 'sess1');
    const h3 = mgr.allocateView('p3-sess2', 'sess2');

    mgr.broadcastToSession('sess1', [makeLine(42)]);

    expect(h1.has(42)).toBe(true);
    expect(h2.has(42)).toBe(true);
    expect(h3.has(42)).toBe(false); // different session
  });

  it('broadcastToSession with no matching session is a no-op', () => {
    const mgr = new CacheManager(100_000);
    mgr.allocateView('p1', 'sess1');
    // Should not throw
    mgr.broadcastToSession('nonexistent', [makeLine(1)]);
  });

  it('clearSession clears only matching handles', () => {
    const mgr = new CacheManager(100_000);
    const h1 = mgr.allocateView('p1-sess1', 'sess1');
    const h2 = mgr.allocateView('p2-sess2', 'sess2');

    h1.put([makeLine(1)]);
    h2.put([makeLine(2)]);

    mgr.clearSession('sess1');
    expect(h1.size).toBe(0);
    expect(h2.size).toBe(1); // untouched
  });

  it('getSessionEntries returns entries from the largest handle', () => {
    const mgr = new CacheManager(100_000);
    const h1 = mgr.allocateView('p1-s1', 's1');
    const h2 = mgr.allocateView('p2-s1', 's1');

    h1.put(makeLines(0, 10));
    h2.put(makeLines(0, 5));

    const entries = [...mgr.getSessionEntries('s1')];
    expect(entries).toHaveLength(10); // h1 is larger
  });

  it('getSessionEntries returns empty iterator for unknown session', () => {
    const mgr = new CacheManager(100_000);
    const entries = [...mgr.getSessionEntries('nonexistent')];
    expect(entries).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Edge cases and robustness
  // -----------------------------------------------------------------------

  it('releasing unknown view is a no-op', () => {
    const mgr = new CacheManager(100_000);
    mgr.releaseView('nonexistent'); // should not throw
    expect(mgr.viewCount).toBe(0);
  });

  it('releasing all views leaves manager empty', () => {
    const mgr = new CacheManager(100_000);
    mgr.allocateView('a');
    mgr.allocateView('b');
    mgr.releaseView('a');
    mgr.releaseView('b');
    expect(mgr.viewCount).toBe(0);
  });

  it('releasing and re-allocating same viewId gives fresh handle', () => {
    const mgr = new CacheManager(100_000);
    const h1 = mgr.allocateView('s1');
    h1.put([makeLine(42)]);
    mgr.releaseView('s1');

    const h2 = mgr.allocateView('s1');
    expect(h2.size).toBe(0); // fresh handle
    expect(h2).not.toBe(h1);
  });

  it('setFocus to already-focused view is a no-op', () => {
    const mgr = new CacheManager(100_000);
    const h = mgr.allocateView('s1');
    mgr.setFocus('s1');
    expect(h.allocation).toBe(100_000); // still full budget, single view
  });

  it('getPriority returns undefined for unknown view', () => {
    const mgr = new CacheManager(100_000);
    expect(mgr.getPriority('ghost')).toBeUndefined();
  });

  it('allocateView without sessionId sets null sessionId', () => {
    const mgr = new CacheManager(100_000);
    mgr.allocateView('s1');
    // broadcastToSession should not match null sessionId
    mgr.broadcastToSession('null', [makeLine(1)]);
    const h = mgr.getHandle('s1')!;
    expect(h.size).toBe(0);
  });

  it('setTotalBudget to very small value applies MIN_FLOOR', () => {
    const mgr = new CacheManager(100_000);
    const h = mgr.allocateView('s1');
    mgr.setTotalBudget(100); // well below MIN_FLOOR
    // Single view gets full budget, but setAllocation clamps to MIN_FLOOR
    expect(h.allocation).toBe(2000);
  });

  it('cycling focus across many views preserves data despite allocation shrinking', () => {
    // Budget 30K with 5 views:
    //   focused = 18K, each visible = floor(9K/4) = 2250 → clamped to MIN_FLOOR=2000
    // When focus shifts, old focused goes from 18K → 2000 allocation.
    // If a view had ~3000 lines, it must survive when allocation shrinks to 2000.
    const mgr = new CacheManager(30_000);
    const handles: ViewCacheHandle[] = [];
    for (let i = 0; i < 5; i++) {
      const h = mgr.allocateView(`v${i}`, 'sess');
      // Put 2000 lines in each handle — exactly at MIN_FLOOR
      h.put(makeLines(i * 10000, 2000));
      handles.push(h);
    }

    // v0 starts focused. Cycle focus through all views.
    for (let i = 1; i < 5; i++) {
      mgr.setFocus(`v${i}`);
    }
    // v4 is now focused, v0-v3 are visible with allocation=2000

    // All data should survive: each handle has exactly 2000 lines = MIN_FLOOR
    for (let i = 0; i < 5; i++) {
      expect(handles[i].size).toBe(2000);
      // Verify data is the correct data (not corrupted by eviction)
      expect(handles[i].has(i * 10000)).toBe(true);
      expect(handles[i].has(i * 10000 + 1999)).toBe(true);
    }
  });

  it('releasing the only view and re-allocating works', () => {
    const mgr = new CacheManager(50_000);
    const h1 = mgr.allocateView('only');
    mgr.releaseView('only');
    expect(mgr.viewCount).toBe(0);

    const h2 = mgr.allocateView('new-only');
    expect(mgr.viewCount).toBe(1);
    expect(mgr.getPriority('new-only')).toBe('focused');
    expect(h2.allocation).toBe(50_000);
  });

  it('releasing focused view with multiple remaining views picks new focus', () => {
    const mgr = new CacheManager(100_000);
    mgr.allocateView('a');
    const hb = mgr.allocateView('b');
    const hc = mgr.allocateView('c');

    // a is focused. Release it.
    mgr.releaseView('a');

    // Exactly one of b or c must become focused
    const bPri = mgr.getPriority('b');
    const cPri = mgr.getPriority('c');
    const focusedViews = [bPri, cPri].filter(p => p === 'focused');
    const visibleViews = [bPri, cPri].filter(p => p === 'visible');
    expect(focusedViews).toHaveLength(1);
    expect(visibleViews).toHaveLength(1);

    // The focused one gets 60%, the visible one gets 30%
    const focusedHandle = bPri === 'focused' ? hb : hc;
    const visibleHandle = bPri === 'focused' ? hc : hb;
    expect(focusedHandle.allocation).toBe(60_000);
    expect(visibleHandle.allocation).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// CacheManager — getSessionEntries empty iterator (Fix #6)
// ---------------------------------------------------------------------------

describe('CacheManager — getSessionEntries empty iterator', () => {
  it('empty iterator is reusable (not shared mutable state)', () => {
    const mgr = new CacheManager(100_000);

    // Call twice — each should return an independent empty iterator
    const iter1 = mgr.getSessionEntries('nope');
    const iter2 = mgr.getSessionEntries('nope');

    expect([...iter1]).toHaveLength(0);
    expect([...iter2]).toHaveLength(0);
  });

  it('empty iterator returns done immediately', () => {
    const mgr = new CacheManager(100_000);
    const iter = mgr.getSessionEntries('nope');
    expect(iter.next().done).toBe(true);
  });
});
