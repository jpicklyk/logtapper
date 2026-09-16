import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import type { WatchInfo, WatchMatchEvent, WatchUpdateEvent } from '@bridge/types';
import type { SessionStore } from '../app/index';
import { createWatchesStore } from './watchesStore';
import type { WatchesCommands, WatchesStore } from './watchesStore';

function criteria(text = 'error') {
  return {
    textSearch: text,
    regex: null,
    logLevels: null,
    tags: null,
    timeStart: null,
    timeEnd: null,
    pids: null,
    combine: 'and' as const,
  };
}

function watchInfo(id: string, overrides: Partial<WatchInfo> = {}): WatchInfo {
  return {
    watchId: id,
    sessionId: 's1',
    totalMatches: 0,
    active: true,
    criteria: criteria(),
    ...overrides,
  };
}

function updateEvent(action: WatchUpdateEvent['action'], watch: WatchInfo): WatchUpdateEvent {
  return { sessionId: watch.sessionId, action, watch };
}

function matchEvent(watch: WatchInfo, newMatches: number, totalMatches: number): WatchMatchEvent {
  return { watchId: watch.watchId, sessionId: watch.sessionId, newMatches, totalMatches };
}

/** Fake `onWatchMatch`/`onWatchUpdate`: captures the handler and exposes `emit`/`unlisten`. */
function makeListen<T>() {
  let handler: ((payload: T) => void) | null = null;
  const unlisten = vi.fn();
  const listen = vi.fn((cb: (payload: T) => void) => {
    handler = cb;
    return Promise.resolve(unlisten);
  });
  return { listen, unlisten, emit: (payload: T) => handler?.(payload) };
}

function makeCommands(): WatchesCommands {
  return {
    createWatch: vi.fn(),
    cancelWatch: vi.fn(() => Promise.resolve()),
    listWatches: vi.fn(() => Promise.resolve([])),
  };
}

/** A minimal `SessionStore` double — this store reads `focusedId()` and
 *  `order()` (the latter for the C-L5 prune sweep). Focusing an id implicitly
 *  "opens" it, so every pre-existing test keeps its session in `order()`
 *  without restating it; `close()` is what drives the prune. */
function fakeSessions() {
  const [focusedId, setFocusedId] = createSignal<string | null>(null);
  const [order, setOrder] = createSignal<readonly string[]>([]);
  return {
    store: { focusedId, order } as unknown as SessionStore,
    setFocused: (id: string | null) => {
      if (id !== null && !order().includes(id)) setOrder((prev) => [...prev, id]);
      setFocusedId(id);
    },
    close: (id: string) => setOrder((prev) => prev.filter((x) => x !== id)),
  };
}

/** Drain enough microtasks for the store's promise chains to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

let sessions: ReturnType<typeof fakeSessions>;
let commands: WatchesCommands;
let listenMatch: ReturnType<typeof makeListen<WatchMatchEvent>>;
let listenUpdate: ReturnType<typeof makeListen<WatchUpdateEvent>>;
let store: WatchesStore;

beforeEach(() => {
  sessions = fakeSessions();
  commands = makeCommands();
  listenMatch = makeListen<WatchMatchEvent>();
  listenUpdate = makeListen<WatchUpdateEvent>();
  store = createWatchesStore({
    sessions: sessions.store,
    commands,
    listenMatch: listenMatch.listen as never,
    listenUpdate: listenUpdate.listen as never,
  });
});

afterEach(() => {
  store.dispose();
});

describe('createWatchesStore', () => {
  describe('lazy fetch on focus', () => {
    it("fetches a session's watches the first time it is focused", async () => {
      const w1 = watchInfo('w1');
      (commands.listWatches as ReturnType<typeof vi.fn>).mockResolvedValue([w1]);
      sessions.setFocused('s1');
      await flush();
      expect(commands.listWatches).toHaveBeenCalledWith('s1');
      expect(store.list('s1')).toEqual([w1]);
      expect(store.loading('s1')).toBe(false);
    });

    it('does not re-fetch on a second focus of the same session', async () => {
      sessions.setFocused('s1');
      await flush();
      (commands.listWatches as ReturnType<typeof vi.fn>).mockClear();
      sessions.setFocused('s2');
      sessions.setFocused('s1');
      await flush();
      expect(commands.listWatches).not.toHaveBeenCalledWith('s1');
    });

    it('a watch-update event applied while the initial fetch is in flight survives the fetch resolving', async () => {
      let resolveFetch!: (watches: WatchInfo[]) => void;
      (commands.listWatches as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<WatchInfo[]>((res) => { resolveFetch = res; }),
      );
      sessions.setFocused('s1'); // kicks off the (still-pending) fetch
      const w = watchInfo('w1');
      listenUpdate.emit(updateEvent('created', w)); // event lands before the fetch resolves
      resolveFetch([]); // server's stale snapshot, from before the create
      await flush();
      expect(store.list('s1')).toEqual([w]);
    });
  });

  describe('watch-update (create/cancel, from either caller)', () => {
    it('upserts a newly created watch into the focused session', async () => {
      sessions.setFocused('s1');
      await flush();
      const w = watchInfo('w1');
      listenUpdate.emit(updateEvent('created', w));
      expect(store.list('s1')).toEqual([w]);
      expect(store.active('s1')).toEqual([w]);
    });

    it('a cancelled event flips the existing row to inactive without duplicating it', async () => {
      sessions.setFocused('s1');
      await flush();
      const created = watchInfo('w1');
      listenUpdate.emit(updateEvent('created', created));
      const cancelled = { ...created, active: false };
      listenUpdate.emit(updateEvent('cancelled', cancelled));
      expect(store.list('s1')).toEqual([cancelled]);
      expect(store.active('s1')).toEqual([]);
      expect(store.cancelled('s1')).toEqual([cancelled]);
    });

    it('an event for a session that has never been focused still lands (agent-created, background session)', () => {
      const w = watchInfo('w1', { sessionId: 'background' });
      listenUpdate.emit(updateEvent('created', w));
      expect(store.list('background')).toEqual([w]);
    });
  });

  describe('watch-match (running counts)', () => {
    it('updates totalMatches for the matching watchId on the matching session', async () => {
      sessions.setFocused('s1');
      await flush();
      const w = watchInfo('w1');
      listenUpdate.emit(updateEvent('created', w));
      listenMatch.emit(matchEvent(w, 3, 3));
      expect(store.list('s1')[0].totalMatches).toBe(3);
      listenMatch.emit(matchEvent(w, 2, 5));
      expect(store.list('s1')[0].totalMatches).toBe(5);
    });

    it('a match arriving for a watch that was just cancelled still updates the count, without reactivating it', async () => {
      sessions.setFocused('s1');
      await flush();
      const w = watchInfo('w1');
      listenUpdate.emit(updateEvent('created', w));
      listenUpdate.emit(updateEvent('cancelled', { ...w, active: false }));
      // A match evaluated server-side just before the cancel took effect can
      // still arrive after the cancellation's `watch-update` event.
      listenMatch.emit(matchEvent(w, 1, 1));
      const row = store.list('s1')[0];
      expect(row.totalMatches).toBe(1);
      expect(row.active).toBe(false);
    });

    it('a match for a session with no fetched list yet is a no-op (nothing to update)', () => {
      const w = watchInfo('w1', { sessionId: 'never-focused' });
      expect(() => listenMatch.emit(matchEvent(w, 1, 1))).not.toThrow();
      expect(store.list('never-focused')).toEqual([]);
    });
  });

  describe('create / cancel', () => {
    it('create() calls createWatch and upserts the resolved watch', async () => {
      const created = watchInfo('new');
      (commands.createWatch as ReturnType<typeof vi.fn>).mockResolvedValue(created);
      const c = criteria('anr');
      const result = await store.create('s1', c);
      expect(commands.createWatch).toHaveBeenCalledWith('s1', c);
      expect(result).toBe(created);
      expect(store.list('s1')).toEqual([created]);
    });

    it('a create() result already applied by a racing watch-update event is not duplicated', async () => {
      const created = watchInfo('new');
      (commands.createWatch as ReturnType<typeof vi.fn>).mockResolvedValue(created);
      const promise = store.create('s1', criteria());
      listenUpdate.emit(updateEvent('created', created)); // event arrives before the command resolves
      await promise;
      expect(store.list('s1')).toEqual([created]);
    });

    it('cancel() calls cancelWatch with the watch\'s own sessionId; state updates via watch-update', async () => {
      sessions.setFocused('s1');
      await flush();
      const w = watchInfo('w1');
      listenUpdate.emit(updateEvent('created', w));
      await store.cancel('s1', 'w1');
      expect(commands.cancelWatch).toHaveBeenCalledWith('s1', 'w1');
      // No local mutation from cancel() itself — still active until the event lands.
      expect(store.list('s1')[0].active).toBe(true);
      listenUpdate.emit(updateEvent('cancelled', { ...w, active: false }));
      expect(store.list('s1')[0].active).toBe(false);
    });
  });

  describe('active / cancelled grouping', () => {
    it('splits a session\'s watches by active, preserving arrival order within each group', async () => {
      sessions.setFocused('s1');
      await flush();
      const a = watchInfo('a');
      const b = watchInfo('b', { active: false });
      const c = watchInfo('c');
      listenUpdate.emit(updateEvent('created', a));
      listenUpdate.emit(updateEvent('created', b));
      listenUpdate.emit(updateEvent('created', c));
      expect(store.active('s1').map((w) => w.watchId)).toEqual(['a', 'c']);
      expect(store.cancelled('s1').map((w) => w.watchId)).toEqual(['b']);
    });
  });

  describe('dispose', () => {
    it('unlistens both subscriptions', async () => {
      store.dispose();
      await flush();
      expect(listenMatch.unlisten).toHaveBeenCalled();
      expect(listenUpdate.unlisten).toHaveBeenCalled();
    });

    it('a listen() promise that settles after dispose is unlistened immediately, not applied', async () => {
      // Fresh store so this test controls exactly when `listen()` resolves.
      let resolveMatchListen!: (fn: () => void) => void;
      const lateListenMatch = vi.fn(() => new Promise<() => void>((res) => { resolveMatchListen = res; }));
      const lateUnlisten = vi.fn();
      const s = createWatchesStore({
        sessions: sessions.store,
        commands,
        listenMatch: lateListenMatch as never,
        listenUpdate: listenUpdate.listen as never,
      });
      s.dispose();
      resolveMatchListen(lateUnlisten);
      await flush();
      expect(lateUnlisten).toHaveBeenCalled();
    });
  });
});
