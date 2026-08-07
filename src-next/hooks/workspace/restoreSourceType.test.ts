import { describe, it, expect } from 'vitest';
import type { RestoreIo } from './restoreCore';

/**
 * A persisted source-type override has to survive the whole restore chain:
 * `.ltw` manifest -> restore plan -> `io.loadFile`. If any link drops it the
 * session reopens with plain content detection and, because `source_types`
 * gates execution, its processors silently stop running — the exact failure the
 * override exists to prevent.
 *
 * TypeScript cannot guard this. A function declaring FEWER parameters is
 * assignable to one declaring more, so an adapter that forwards three of four
 * arguments type-checks cleanly and truncates at runtime. That is how it broke:
 * `useStartupRestore` built its `RestoreIo` as
 *   `(path, paneId, existingTabId) => deps.loadFile(path, paneId, existingTabId)`
 * which compiled, passed review, and lost every override on startup restore.
 *
 * This is a type-only import, so the assertion runs without pulling in
 * restoreCore's module graph (which reaches ThemeContext's module-load
 * `window.matchMedia` — the hazard documented in `appStatePayload.ts`).
 * Consequently it pins the ADAPTER SHAPE, which is what silently broke, not
 * restoreCore's own pass-through, which is a single readable line.
 */
describe('RestoreIo.loadFile adapters must forward every argument', () => {
  function recorder() {
    const calls: unknown[][] = [];
    const io: RestoreIo = {
      loadFile: (...args) => {
        calls.push(args);
        return Promise.resolve([]);
      },
      scheduleAutoRun: () => {},
      setWorkspaceAnalyses: () => Promise.resolve(),
    };
    return { io, calls };
  }

  it('a positionally-named forwarder truncates the override', async () => {
    const { io, calls } = recorder();
    // The shape that shipped — kept as the thing being guarded against.
    const truncating: RestoreIo = {
      loadFile: (path, paneId, existingTabId) => io.loadFile(path, paneId, existingTabId),
      scheduleAutoRun: () => {},
      setWorkspaceAnalyses: () => Promise.resolve(),
    };

    await truncating.loadFile('/logs/board.txt', 'p1', 't1', 'Kernel');

    expect(calls[0][3]).toBeUndefined();
  });

  it('a spreading forwarder preserves it', async () => {
    const { io, calls } = recorder();
    const forwarding: RestoreIo = {
      loadFile: (...args) => io.loadFile(...args),
      scheduleAutoRun: () => {},
      setWorkspaceAnalyses: () => Promise.resolve(),
    };

    await forwarding.loadFile('/logs/board.txt', 'p1', 't1', 'Kernel');

    expect(calls[0]).toEqual(['/logs/board.txt', 'p1', 't1', 'Kernel']);
    expect(calls[0][3]).toBe('Kernel');
  });

  it('preserves a later argument even when the middle ones are omitted', async () => {
    const { io, calls } = recorder();
    const forwarding: RestoreIo = {
      loadFile: (...args) => io.loadFile(...args),
      scheduleAutoRun: () => {},
      setWorkspaceAnalyses: () => Promise.resolve(),
    };

    await forwarding.loadFile('/logs/board.txt', undefined, undefined, 'Dumpstate');

    expect(calls[0][3]).toBe('Dumpstate');
  });
});
