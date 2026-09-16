import { describe, expect, it, vi } from 'vitest';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { SearchProgress, SearchQuery, SearchSummary } from '@bridge/types';
import { createSearchRunner } from './search';
import type { SearchRunnerCommands } from './search';
import type { ViewerController } from '../viewer';

function query(text = 'crash'): SearchQuery {
  return {
    text,
    isRegex: false,
    caseSensitive: false,
    withinProcessor: null,
    minLevel: null,
    tags: null,
    startTime: null,
    endTime: null,
  };
}

function summary(matchLineNums: number[]): SearchSummary {
  return { totalMatches: matchLineNums.length, matchLineNums, byLevel: {}, byTag: { Alpha: matchLineNums.length } };
}

/**
 * A fake `onSearchProgress` the test drives by hand.
 *
 * `deferRegistration` holds the `listen()` promise open so a test can make
 * `searchLogs` settle *first* — the ordering L1 is about.
 */
function createFakeListen(deferRegistration = false) {
  const subscribers: Array<(p: SearchProgress) => void> = [];
  /** Every callback ever registered, in order — never spliced, so a test can
   *  invoke a superseded run's handler directly to simulate the exact race the
   *  `gen` guard protects against (a progress message already dispatched to a
   *  handler at the moment `unlisten()` runs). */
  const registered: Array<(p: SearchProgress) => void> = [];
  /** Resolvers for registrations held open by `deferRegistration`. */
  const heldRegistrations: Array<() => void> = [];
  const listen = (cb: (p: SearchProgress) => void): Promise<UnlistenFn> => {
    subscribers.push(cb);
    registered.push(cb);
    const unlisten = (() => {
      const i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    }) as UnlistenFn;
    if (!deferRegistration) return Promise.resolve(unlisten);
    return new Promise<UnlistenFn>((resolve) => {
      heldRegistrations.push(() => resolve(unlisten));
    });
  };
  const fill = (p: Partial<SearchProgress> & { sessionId: string }): SearchProgress => ({
    matchedSoFar: 0, linesScanned: 0, totalLines: 0, newMatches: [], done: false, ...p,
  });
  return {
    listen: listen as never,
    emit: (p: Partial<SearchProgress> & { sessionId: string }) => {
      for (const cb of [...subscribers]) cb(fill(p));
    },
    /** Invoke the Nth-ever-registered handler directly, bypassing unsubscription. */
    emitDirect: (index: number, p: Partial<SearchProgress> & { sessionId: string }) => {
      registered[index](fill(p));
    },
    /** Let every held `listen()` promise resolve. */
    releaseRegistrations: () => { while (heldRegistrations.length) heldRegistrations.shift()?.(); },
    get active() { return subscribers.length; },
  };
}

function fakeController() {
  return {
    setLineSet: vi.fn(),
    scrollToLine: vi.fn(),
  } as unknown as ViewerController;
}

/** Deferred `searchLogs` so a test can control resolution order. */
function createFakeCommands() {
  const calls: { sessionId: string; query: SearchQuery }[] = [];
  const pending: { resolve: (s: SearchSummary) => void; reject: (e: unknown) => void }[] = [];
  const commands: SearchRunnerCommands = {
    searchLogs: (sessionId, q) => {
      calls.push({ sessionId, query: q });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  return { commands, calls, pending };
}

describe('createSearchRunner', () => {
  it('accumulates hits from progress, sorted and de-duplicated', async () => {
    const listen = createFakeListen();
    const { commands, pending } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', query());
    await Promise.resolve();

    listen.emit({ sessionId: 's1', matchedSoFar: 2, newMatches: [40, 10] });
    listen.emit({ sessionId: 's1', matchedSoFar: 3, newMatches: [10, 25] }); // 10 repeats

    expect(runner.hits()).toEqual([10, 25, 40]);

    pending[0].resolve(summary([10, 25, 40]));
    await Promise.resolve();
    await Promise.resolve();

    expect(runner.phase()).toBe('done');
    expect(runner.summary()?.totalMatches).toBe(3);
  });

  it('drops progress and the resolution of a superseded run', async () => {
    const listen = createFakeListen();
    const { commands, pending } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', query('a'));
    await Promise.resolve();
    runner.run('s1', query('b')); // supersedes — a new listener registration
    await Promise.resolve();

    expect(listen.active).toBe(1); // run A's handler was unregistered

    // Simulate a progress message already in flight to run A's handler at the
    // moment it was torn down — the `gen` guard, not unsubscription, must drop it.
    listen.emitDirect(0, { sessionId: 's1', matchedSoFar: 1, newMatches: [999] });
    expect(runner.hits()).not.toContain(999);

    // The FIRST run's `searchLogs` resolving late must not overwrite run B's summary.
    pending[0].resolve(summary([999]));
    await Promise.resolve();
    expect(runner.hits()).not.toContain(999);

    pending[1].resolve(summary([5]));
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.hits()).toEqual([5]);
  });

  it('jumps to the first match exactly once per run', async () => {
    const listen = createFakeListen();
    const { commands, pending } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', query());
    await Promise.resolve();
    listen.emit({ sessionId: 's1', matchedSoFar: 1, newMatches: [7] });
    listen.emit({ sessionId: 's1', matchedSoFar: 2, newMatches: [9] });
    pending[0].resolve(summary([7, 9]));
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.scrollToLine).toHaveBeenCalledTimes(1);
    expect(controller.scrollToLine).toHaveBeenCalledWith('s1', 7, { highlight: true, select: expect.any(Array), source: 'search' });
    expect(runner.current()).toBe(0);
  });

  it('next/prev wrap at either end', async () => {
    const listen = createFakeListen();
    const { commands, pending } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', query());
    await Promise.resolve();
    pending[0].resolve(summary([10, 20, 30]));
    await Promise.resolve();
    await Promise.resolve();

    expect(runner.current()).toBe(0); // auto-jumped to the first hit
    runner.next();
    expect(runner.current()).toBe(1);
    runner.next();
    expect(runner.current()).toBe(2);
    runner.next(); // wraps past the last
    expect(runner.current()).toBe(0);
    runner.prev(); // wraps before the first
    expect(runner.current()).toBe(2);
    expect(controller.scrollToLine).toHaveBeenLastCalledWith('s1', 30, { highlight: true, select: expect.any(Array), source: 'search' });
  });

  it('writes the search line set only while matchesOnly is on', async () => {
    const listen = createFakeListen();
    const { commands, pending } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', query());
    await Promise.resolve();
    pending[0].resolve(summary([1, 2, 3]));
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.setLineSet).not.toHaveBeenCalledWith('s1', 'search', expect.anything());

    runner.setMatchesOnly(true);
    expect(controller.setLineSet).toHaveBeenLastCalledWith('s1', 'search', new Set([1, 2, 3]));

    runner.setMatchesOnly(false);
    expect(controller.setLineSet).toHaveBeenLastCalledWith('s1', 'search', null);
  });

  // H3: an empty Set is not "no narrowing" to the controller — it stores `[]`,
  // which intersects to "render nothing". Publishing one blanked the viewer on
  // the two clicks below, with no way back but toggling Matches only twice.
  it('never narrows to an empty set: Matches only before any query publishes null', () => {
    const listen = createFakeListen();
    const { commands } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', null);
    runner.setMatchesOnly(true);

    expect(runner.hits()).toEqual([]);
    expect(controller.setLineSet).toHaveBeenLastCalledWith('s1', 'search', null);
    expect(controller.setLineSet).not.toHaveBeenCalledWith('s1', 'search', new Set());
  });

  it('never narrows to an empty set: clearing the query while Matches only is on publishes null', async () => {
    const listen = createFakeListen();
    const { commands, pending } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', query());
    await Promise.resolve();
    pending[0].resolve(summary([1, 2, 3]));
    await Promise.resolve();
    await Promise.resolve();
    runner.setMatchesOnly(true);
    expect(controller.setLineSet).toHaveBeenLastCalledWith('s1', 'search', new Set([1, 2, 3]));

    // Esc / clearing the text: `run(session, null)` with Matches only still on.
    runner.run('s1', null);

    expect(controller.setLineSet).toHaveBeenLastCalledWith('s1', 'search', null);
  });

  it('never narrows to an empty set: a run that finds nothing leaves the viewer whole', async () => {
    const listen = createFakeListen();
    const { commands, pending } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.setMatchesOnly(true);
    runner.run('s1', query('nothing-matches-this'));
    await Promise.resolve();
    pending[0].resolve(summary([]));
    await Promise.resolve();
    await Promise.resolve();

    expect(runner.phase()).toBe('done');
    expect(controller.setLineSet).toHaveBeenLastCalledWith('s1', 'search', null);
  });

  // L1: `searchLogs` can resolve before `listen()` does. The `.finally`
  // teardown then ran first, and the late `.then` stored the unlisten for a
  // finished run — leaving the listener registered until the next
  // run/cancel/dispose, merging late progress into a settled run's hits.
  it('unregisters a progress listener that resolves after its run already settled', async () => {
    const listen = createFakeListen(true);
    const { commands, pending } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', query());
    await Promise.resolve();
    expect(listen.active).toBe(1); // subscribed, but registration not yet resolved

    pending[0].resolve(summary([1]));
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.phase()).toBe('done');

    listen.releaseRegistrations();
    await Promise.resolve();
    await Promise.resolve();

    expect(listen.active).toBe(0);
    // So a late `search-progress` for the same session no longer reaches the
    // settled run's handler at all.
    listen.emit({ sessionId: 's1', matchedSoFar: 2, newMatches: [999] });
    expect(runner.hits()).toEqual([1]);
  });

  it('run(sessionId, null) clears state without calling searchLogs', () => {
    const listen = createFakeListen();
    const { commands, calls } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', null);

    expect(calls).toHaveLength(0);
    expect(runner.phase()).toBe('idle');
    expect(runner.hits()).toEqual([]);
  });

  it('surfaces a rejected searchLogs as an error phase', async () => {
    const listen = createFakeListen();
    const { commands, pending } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', query());
    await Promise.resolve();
    pending[0].reject(new Error('bad regex'));
    await Promise.resolve();
    await Promise.resolve();

    expect(runner.phase()).toBe('error');
    expect(runner.error()).toBe('bad regex');
  });

  it('cancel() stops the run and unregisters the progress listener', async () => {
    const listen = createFakeListen();
    const { commands } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.run('s1', query());
    await Promise.resolve();
    expect(listen.active).toBe(1);

    runner.cancel();
    expect(listen.active).toBe(0);
    expect(runner.phase()).toBe('idle');

    // A late progress event from the cancelled run must not resurrect state.
    listen.emit({ sessionId: 's1', matchedSoFar: 1, newMatches: [1] });
    expect(runner.hits()).toEqual([]);
  });

  it('dispose() is idempotent and tears down the reactive root', () => {
    const listen = createFakeListen();
    const { commands } = createFakeCommands();
    const controller = fakeController();
    const runner = createSearchRunner({ controller, listen: listen.listen, commands });

    runner.dispose();
    expect(() => runner.dispose()).not.toThrow();
  });
});
