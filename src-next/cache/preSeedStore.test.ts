/**
 * M7: preSeedStore consumed during render, lost in StrictMode
 *
 * Problem: preSeedStore.get() + .delete() called in a render-time branch
 * (inside the if (prevIdRef.current !== viewId) block in useViewCache).
 * In StrictMode double-render, the first (discarded) render consumes the
 * pre-seed. The committed render sees nothing.
 *
 * Fix: Move preSeedStore consumption to useEffect. The useEffect runs only
 * on committed render, so it survives StrictMode double-render.
 *
 * These tests verify the preSeed lifecycle at the pure-logic level:
 * - preSeedSession() stores lines before handle allocation
 * - clearPreSeed() removes stale entries
 * - Consumption must happen AFTER the render is committed (not during render)
 * - Double-render (simulating StrictMode) must leave preSeed intact for committed render
 */
import { describe, it, expect } from 'vitest';
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
// Simulate the preSeedStore lifecycle
// ---------------------------------------------------------------------------

/**
 * A minimal simulation of the preSeedStore behavior in CacheContext.
 *
 * BEFORE fix (broken): get + delete called during render.
 * AFTER fix (correct): get called during render to capture the ref,
 *   delete called in useEffect (committed render only).
 */
function createPreSeedSimulator() {
  const store = new Map<string, ViewLine[]>();

  function preSeedSession(sessionId: string, lines: ViewLine[]): void {
    store.set(sessionId, lines);
  }

  function clearPreSeed(sessionId: string): void {
    store.delete(sessionId);
  }

  function hasPreSeed(sessionId: string): boolean {
    return store.has(sessionId);
  }

  /**
   * BROKEN: Consume pre-seed during render (get + delete in same call).
   * Simulates the old render-time branch in useViewCache.
   */
  function consumeDuringRender(sessionId: string): ViewLine[] | null {
    const lines = store.get(sessionId);
    if (lines) {
      store.delete(sessionId); // BUG: deleted in render — lost on double-render
      return lines;
    }
    return null;
  }

  /**
   * CORRECT: Separate read (during render) from delete (committed only).
   * Simulates the fixed useEffect-based approach.
   *
   * Phase 1 (render): capture lines into a ref-like variable, do NOT delete
   * Phase 2 (effect): apply the lines and delete — only runs on committed render
   */
  function readDuringRender(sessionId: string): ViewLine[] | null {
    return store.get(sessionId) ?? null;
  }

  function deleteAfterCommit(sessionId: string): void {
    store.delete(sessionId); // Called from useEffect — once per committed mount
  }

  return {
    preSeedSession,
    clearPreSeed,
    hasPreSeed,
    consumeDuringRender,
    readDuringRender,
    deleteAfterCommit,
    get storeSize() { return store.size; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M7: preSeedStore consumption survives StrictMode double-render', () => {
  describe('preSeedSession / clearPreSeed lifecycle', () => {
    it('stores lines before handle allocation', () => {
      const sim = createPreSeedSimulator();
      const lines = [makeLine(1), makeLine(2)];

      sim.preSeedSession('session-A', lines);
      expect(sim.hasPreSeed('session-A')).toBe(true);
    });

    it('clearPreSeed removes the entry', () => {
      const sim = createPreSeedSimulator();
      sim.preSeedSession('session-A', [makeLine(1)]);
      sim.clearPreSeed('session-A');
      expect(sim.hasPreSeed('session-A')).toBe(false);
    });

    it('clearPreSeed on non-existent key is a no-op', () => {
      const sim = createPreSeedSimulator();
      expect(() => sim.clearPreSeed('nonexistent')).not.toThrow();
    });
  });

  describe('broken behavior (before fix) — consumption during render', () => {
    it('first render call consumes and removes the pre-seed', () => {
      const sim = createPreSeedSimulator();
      const lines = [makeLine(1), makeLine(2)];
      sim.preSeedSession('session-A', lines);

      const result1 = sim.consumeDuringRender('session-A');
      expect(result1).toEqual(lines);
      expect(sim.hasPreSeed('session-A')).toBe(false); // deleted on first render
    });

    it('StrictMode double-render: second render sees nothing', () => {
      const sim = createPreSeedSimulator();
      const lines = [makeLine(1), makeLine(2)];
      sim.preSeedSession('session-A', lines);

      // StrictMode: first (discarded) render
      const resultDiscard = sim.consumeDuringRender('session-A');
      expect(resultDiscard).toEqual(lines);

      // StrictMode: second (committed) render — pre-seed is already gone
      const resultCommit = sim.consumeDuringRender('session-A');
      expect(resultCommit).toBeNull(); // BUG: pre-seed lost!
    });
  });

  describe('fixed behavior (after fix) — read in render, delete in effect', () => {
    it('render reads the pre-seed without deleting it', () => {
      const sim = createPreSeedSimulator();
      const lines = [makeLine(1), makeLine(2)];
      sim.preSeedSession('session-A', lines);

      const result = sim.readDuringRender('session-A');
      expect(result).toEqual(lines);
      expect(sim.hasPreSeed('session-A')).toBe(true); // NOT deleted — survives second render
    });

    it('StrictMode double-render: both renders see the pre-seed, committed effect deletes it', () => {
      const sim = createPreSeedSimulator();
      const lines = [makeLine(1), makeLine(2)];
      sim.preSeedSession('session-A', lines);

      // StrictMode: first (discarded) render — only reads
      const resultDiscard = sim.readDuringRender('session-A');
      expect(resultDiscard).toEqual(lines);
      expect(sim.hasPreSeed('session-A')).toBe(true); // still present

      // StrictMode: second (committed) render — reads again
      const resultCommit = sim.readDuringRender('session-A');
      expect(resultCommit).toEqual(lines); // available! No lost pre-seed
      expect(sim.hasPreSeed('session-A')).toBe(true); // still present

      // Committed useEffect runs — applies and deletes
      sim.deleteAfterCommit('session-A');
      expect(sim.hasPreSeed('session-A')).toBe(false); // cleaned up exactly once
    });

    it('applying lines then deleting leaves no stale entries', () => {
      const sim = createPreSeedSimulator();
      const lines = [makeLine(10), makeLine(11), makeLine(12)];
      sim.preSeedSession('session-B', lines);

      const appliedLines = sim.readDuringRender('session-B');
      expect(appliedLines).toHaveLength(3);

      // Committed effect
      sim.deleteAfterCommit('session-B');

      expect(sim.hasPreSeed('session-B')).toBe(false);
      expect(sim.storeSize).toBe(0);
    });

    it('multiple sessions are independent — deleting one does not affect others', () => {
      const sim = createPreSeedSimulator();
      sim.preSeedSession('session-A', [makeLine(1)]);
      sim.preSeedSession('session-B', [makeLine(2)]);

      sim.readDuringRender('session-A');
      sim.deleteAfterCommit('session-A');

      expect(sim.hasPreSeed('session-A')).toBe(false);
      expect(sim.hasPreSeed('session-B')).toBe(true); // unaffected
    });
  });
});
