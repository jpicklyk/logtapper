import { describe, it, expect, vi } from 'vitest';
import {
  decideAutoRun,
  createAutoRunScheduler,
  type IndexingCompleteBus,
} from './autoRunScheduler';

// ---------------------------------------------------------------------------
// Fake bus (mirrors tabSessionMap.test.ts style — a thin production-shaped stub)
// ---------------------------------------------------------------------------

function createFakeBus() {
  const handlers = new Set<(e: { sessionId: string }) => void>();
  const bus: IndexingCompleteBus = {
    on: (_event, handler) => { handlers.add(handler); },
    off: (_event, handler) => { handlers.delete(handler); },
  };
  return {
    bus,
    handlerCount: () => handlers.size,
    /** Simulate a session:indexing-complete for one session. */
    emitComplete: (sessionId: string) => {
      // Copy so a handler that unsubscribes itself doesn't disturb iteration.
      for (const h of [...handlers]) h({ sessionId });
    },
  };
}

const CHAIN = ['p1', 'p2'];
const DISABLED: string[] = [];

// ---------------------------------------------------------------------------
// decideAutoRun
// ---------------------------------------------------------------------------

describe('decideAutoRun', () => {
  it('runs now for a fully-indexed session', () => {
    expect(decideAutoRun(false)).toBe('run-now');
  });
  it('runs now when isIndexing is undefined (streams / .lts entries)', () => {
    expect(decideAutoRun(undefined)).toBe('run-now');
  });
  it('waits for indexing-complete while still indexing', () => {
    expect(decideAutoRun(true)).toBe('await-indexing');
  });
});

// ---------------------------------------------------------------------------
// createAutoRunScheduler — one-shot bookkeeping
// ---------------------------------------------------------------------------

describe('createAutoRunScheduler', () => {
  it('runs immediately with the restored chain for an already-indexed session and arms nothing (the bug fix)', () => {
    const { bus, handlerCount } = createFakeBus();
    const run = vi.fn();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', false, CHAIN, DISABLED);

    expect(run).toHaveBeenCalledExactlyOnceWith('s1', CHAIN, DISABLED);
    expect(handlerCount()).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.isScheduled('s1')).toBe(true);
  });

  it('defers a still-indexing session until its indexing-complete fires, then runs its chain', () => {
    const { bus, emitComplete, handlerCount } = createFakeBus();
    const run = vi.fn();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', true, CHAIN, DISABLED);
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.isPending('s1')).toBe(true);
    expect(handlerCount()).toBe(1);

    emitComplete('s1');
    expect(run).toHaveBeenCalledExactlyOnceWith('s1', CHAIN, DISABLED);
    // One-shot: handler removed after firing (but the session stays "scheduled").
    expect(scheduler.isPending('s1')).toBe(false);
    expect(handlerCount()).toBe(0);
    expect(scheduler.isScheduled('s1')).toBe(true);
  });

  it('is session-id-keyed — another session completing does not run a pending one', () => {
    const { bus, emitComplete } = createFakeBus();
    const run = vi.fn();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', true, CHAIN, DISABLED);
    emitComplete('s2'); // unrelated session

    expect(run).not.toHaveBeenCalled();
    expect(scheduler.isPending('s1')).toBe(true);
  });

  it('passes each session its own chain when several are deferred', () => {
    const { bus, emitComplete } = createFakeBus();
    const run = vi.fn();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', true, ['a'], []);
    scheduler.schedule('s2', true, ['b'], ['x']);

    emitComplete('s2');
    emitComplete('s1');

    expect(run).toHaveBeenNthCalledWith(1, 's2', ['b'], ['x']);
    expect(run).toHaveBeenNthCalledWith(2, 's1', ['a'], []);
  });

  it('does not double-run when indexing-complete fires more than once', () => {
    const { bus, emitComplete } = createFakeBus();
    const run = vi.fn();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', true, CHAIN, DISABLED);
    emitComplete('s1');
    emitComplete('s1'); // late/duplicate — handler already removed

    expect(run).toHaveBeenCalledTimes(1);
  });

  // The core-owns-`.ltw` / useWorkspaceRestore-owns-`.lts` split should keep a
  // session from being scheduled twice, but the scheduler must guarantee it.
  it('swallows a duplicate schedule for a session that already ran (run-now)', () => {
    const { bus, handlerCount } = createFakeBus();
    const run = vi.fn();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', false, ['a'], []); // ran now
    scheduler.schedule('s1', false, ['b'], []); // duplicate — must be swallowed

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('s1', ['a'], []);
    expect(handlerCount()).toBe(0);
  });

  it('swallows a duplicate schedule for a session that is already armed', () => {
    const { bus, emitComplete, handlerCount } = createFakeBus();
    const run = vi.fn();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', true, ['a'], []); // armed
    scheduler.schedule('s1', true, ['b'], []); // duplicate — swallowed, no second arm
    expect(handlerCount()).toBe(1);

    emitComplete('s1');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('s1', ['a'], []); // the first schedule's chain
  });

  it('forget clears the record so a reopen schedules again (Q5 recurring ids)', () => {
    const { bus } = createFakeBus();
    const run = vi.fn();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', false, ['a'], []); // ran
    expect(scheduler.isScheduled('s1')).toBe(true);

    scheduler.forget('s1');
    expect(scheduler.isScheduled('s1')).toBe(false);

    scheduler.schedule('s1', false, ['b'], []); // reopen — runs again
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith('s1', ['b'], []);
  });

  it('forget disarms a pending one-shot too', () => {
    const { bus, emitComplete, handlerCount } = createFakeBus();
    const run = vi.fn();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', true, CHAIN, DISABLED);
    expect(scheduler.isPending('s1')).toBe(true);

    scheduler.forget('s1');
    expect(scheduler.isPending('s1')).toBe(false);
    expect(handlerCount()).toBe(0);

    emitComplete('s1'); // nothing armed
    expect(run).not.toHaveBeenCalled();
  });

  it('dispose removes every armed one-shot and clears all records', () => {
    const { bus, emitComplete, handlerCount } = createFakeBus();
    const run = vi.fn();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', true, CHAIN, DISABLED);
    scheduler.schedule('s2', true, CHAIN, DISABLED);
    expect(scheduler.pendingCount()).toBe(2);

    scheduler.dispose();
    expect(handlerCount()).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.isScheduled('s1')).toBe(false);

    emitComplete('s1'); // nothing armed anymore
    expect(run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auto-run burst cap (workspace-restore-performance design, part 5)
// ---------------------------------------------------------------------------

describe('createAutoRunScheduler — run-concurrency cap', () => {
  /** An `AutoRunFn` whose promise stays pending until the test releases it,
   *  keyed by sessionId. */
  function createGatedRun() {
    const releasers = new Map<string, () => void>();
    const run = vi.fn((sessionId: string) => new Promise<void>((resolve) => {
      releasers.set(sessionId, resolve);
    }));
    return { run, release: (sessionId: string) => releasers.get(sessionId)?.() };
  }

  it('caps concurrent run-now sessions at 2, queuing the rest', async () => {
    const { bus } = createFakeBus();
    const { run, release } = createGatedRun();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', false, CHAIN, DISABLED);
    scheduler.schedule('s2', false, CHAIN, DISABLED);
    scheduler.schedule('s3', false, CHAIN, DISABLED);

    // Only the first two start immediately; the third is queued.
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith('s1', CHAIN, DISABLED);
    expect(run).toHaveBeenCalledWith('s2', CHAIN, DISABLED);
    expect(run).not.toHaveBeenCalledWith('s3', CHAIN, DISABLED);

    // Every session is still marked scheduled immediately — queuing only
    // delays the RUN, not the bookkeeping (isScheduled/swallow guard).
    expect(scheduler.isScheduled('s1')).toBe(true);
    expect(scheduler.isScheduled('s2')).toBe(true);
    expect(scheduler.isScheduled('s3')).toBe(true);

    // Freeing one slot starts the third.
    release('s1');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(run).toHaveBeenCalledWith('s3', CHAIN, DISABLED);
  });

  it('does not queue when only one session is scheduled (no behavior change for single-file opens)', async () => {
    const { bus } = createFakeBus();
    const run = vi.fn(async () => {});
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', false, CHAIN, DISABLED);

    expect(run).toHaveBeenCalledExactlyOnceWith('s1', CHAIN, DISABLED);
  });

  it('an indexing-complete-triggered run also goes through the concurrency gate', async () => {
    const { bus, emitComplete } = createFakeBus();
    const { run, release } = createGatedRun();
    const scheduler = createAutoRunScheduler(bus, run);

    // Two run-now sessions fill both slots.
    scheduler.schedule('s1', false, CHAIN, DISABLED);
    scheduler.schedule('s2', false, CHAIN, DISABLED);
    expect(run).toHaveBeenCalledTimes(2);

    // A third session finishes indexing while both slots are full.
    scheduler.schedule('s3', true, CHAIN, DISABLED);
    emitComplete('s3');
    expect(run).toHaveBeenCalledTimes(2); // still queued, not started

    release('s1');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(run).toHaveBeenCalledWith('s3', CHAIN, DISABLED);
  });

  it('a queued run still respects the strict one-shot swallow guard', () => {
    const { bus } = createFakeBus();
    const { run } = createGatedRun();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', false, ['a'], []);
    scheduler.schedule('s2', false, ['a'], []);
    scheduler.schedule('s3', false, ['a'], []); // queued
    scheduler.schedule('s3', false, ['b'], []); // duplicate while queued — swallowed

    expect(run).toHaveBeenCalledTimes(2); // s1, s2 only — s3 still queued
  });

  it('a run that rejects still frees its slot for the next queued run', async () => {
    const { bus } = createFakeBus();
    const releasers = new Map<string, (err?: unknown) => void>();
    const run = vi.fn((sessionId: string) => new Promise<void>((_resolve, reject) => {
      releasers.set(sessionId, (err) => reject(err ?? new Error('boom')));
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', false, CHAIN, DISABLED);
    scheduler.schedule('s2', false, CHAIN, DISABLED);
    scheduler.schedule('s3', false, CHAIN, DISABLED);
    expect(run).toHaveBeenCalledTimes(2);

    releasers.get('s1')!();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    warn.mockRestore();
  });

  it('dispose drops queued (not-yet-started) runs — freeing a slot afterward does not start them', async () => {
    const { bus } = createFakeBus();
    const { run, release } = createGatedRun();
    const scheduler = createAutoRunScheduler(bus, run);

    scheduler.schedule('s1', false, CHAIN, DISABLED);
    scheduler.schedule('s2', false, CHAIN, DISABLED);
    scheduler.schedule('s3', false, CHAIN, DISABLED); // queued
    expect(run).toHaveBeenCalledTimes(2);

    scheduler.dispose();

    // Freeing s1's slot after dispose would (incorrectly) pull s3 off the
    // queue if dispose hadn't cleared it — proves the queue is actually gone,
    // not just that s1/s2 happened to stay pending.
    release('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).toHaveBeenCalledTimes(2); // s3 never started
  });
});
