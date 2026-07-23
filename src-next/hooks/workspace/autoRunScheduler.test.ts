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
