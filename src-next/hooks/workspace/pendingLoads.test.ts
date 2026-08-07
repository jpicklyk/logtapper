import { describe, it, expect, vi } from 'vitest';
import { registerPendingLoad, getPendingLoads, waitForPendingLoads } from './pendingLoads';

/**
 * Regression tests for the pending-loads registry — the SAVE HOLE fix (item
 * 6b9d644c-eff7-486c-982f-9034b3e7f84f). `doAutoSave` (useWorkspace.ts)
 * awaits `waitForPendingLoads()` before snapshotting the workspace so a file
 * whose `load_log_file` IPC hasn't resolved yet gets a chance to register
 * into backend `state.sessions` first, instead of silently being absent from
 * the saved `.ltw`.
 */
describe('pendingLoads', () => {
  it('getPendingLoads is empty when nothing is registered', async () => {
    // Drain anything left by other tests in this file before asserting.
    await waitForPendingLoads(0);
    expect(getPendingLoads()).toEqual([]);
  });

  it('registerPendingLoad makes the promise visible via getPendingLoads', () => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => { resolve = r; });
    registerPendingLoad('load-1', p);
    expect(getPendingLoads()).toContain(p);
    resolve();
    return p;
  });

  it('a settled load self-removes from the registry', async () => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => { resolve = r; });
    registerPendingLoad('load-2', p);
    expect(getPendingLoads()).toContain(p);
    resolve();
    await p;
    // .finally() runs as a microtask after the promise settles — flush it.
    await Promise.resolve();
    expect(getPendingLoads()).not.toContain(p);
  });

  it('a rejected load also self-removes (settled, not just resolved)', async () => {
    let reject!: (e: unknown) => void;
    const p = new Promise<void>((_res, rej) => { reject = rej; });
    registerPendingLoad('load-3', p);
    reject(new Error('boom'));
    await p.catch(() => {});
    await Promise.resolve();
    expect(getPendingLoads()).not.toContain(p);
  });

  it('waitForPendingLoads resolves immediately when nothing is pending', async () => {
    await waitForPendingLoads(0);
    const start = Date.now();
    await waitForPendingLoads(5000);
    // No real delay — nothing to wait for.
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('waitForPendingLoads waits for an in-flight load to settle before returning', async () => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => { resolve = r; });
    registerPendingLoad('load-4', p);

    let settled = false;
    const waitPromise = waitForPendingLoads(5000).then(() => {
      // At this point the registered load must already have settled —
      // that's the whole point of waiting for it before an auto-save reads
      // backend state.
      expect(settled).toBe(true);
    });

    // Give the wait a moment to start racing, then settle the load.
    await Promise.resolve();
    settled = true;
    resolve();

    await waitPromise;
  });

  it('waitForPendingLoads tolerates a rejected load (does not throw)', async () => {
    let reject!: (e: unknown) => void;
    const p = new Promise<void>((_res, rej) => { reject = rej; });
    registerPendingLoad('load-5', p);
    reject(new Error('load failed'));
    await expect(waitForPendingLoads(5000)).resolves.toBeUndefined();
  });

  it('waitForPendingLoads is bounded by its timeout — a hung load does not block forever', async () => {
    vi.useFakeTimers();
    try {
      // A load that never settles (simulates a stalled decompress).
      const hung = new Promise<void>(() => {});
      registerPendingLoad('load-hung', hung);

      let resolved = false;
      const waitPromise = waitForPendingLoads(1000).then(() => { resolved = true; });

      // Not resolved before the timeout.
      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).toBe(false);

      // Resolved once the bounded timeout elapses, even though the load
      // itself never settled.
      await vi.advanceTimersByTimeAsync(600);
      await waitPromise;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
