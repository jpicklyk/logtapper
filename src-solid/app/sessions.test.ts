import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadResult } from '@bridge/types';
import { CacheManager, DataSourceRegistry } from '../viewer';
import { createViewerController, sessionScrollPositions } from '../viewer';
import type { ViewerController } from '../viewer';
import { createSessionStore, viewIdFor } from './sessions';
import type { SessionStore } from './sessions';

// The four backend subscriptions the store owns. Each mock records the callback
// so a test can fire the event, and hands back a distinguishable unlisten fn.
const bridge = vi.hoisted(() => ({
  handlers: {
    opened: null as ((payload: LoadResult) => void) | null,
    closed: null as ((payload: { sessionId: string }) => void) | null,
    progress: null as
      | ((payload: {
          sessionId: string;
          indexedLines: number;
          bytesScanned: number;
          totalBytes: number;
        }) => void)
      | null,
    complete: null as ((payload: { sessionId: string; totalLines: number }) => void) | null,
  },
  unlisten: {
    opened: vi.fn(),
    closed: vi.fn(),
    progress: vi.fn(),
    complete: vi.fn(),
  },
}));

vi.mock('@bridge/events', () => ({
  onBridgeSessionOpened: vi.fn((cb) => {
    bridge.handlers.opened = cb;
    return Promise.resolve(bridge.unlisten.opened);
  }),
  onBridgeSessionClosed: vi.fn((cb) => {
    bridge.handlers.closed = cb;
    return Promise.resolve(bridge.unlisten.closed);
  }),
  onFileIndexProgress: vi.fn((cb) => {
    bridge.handlers.progress = cb;
    return Promise.resolve(bridge.unlisten.progress);
  }),
  onFileIndexComplete: vi.fn((cb) => {
    bridge.handlers.complete = cb;
    return Promise.resolve(bridge.unlisten.complete);
  }),
}));

const commands = vi.hoisted(() => ({
  getLines: vi.fn(() =>
    Promise.resolve({
      sessionId: '',
      totalLines: 0,
      offset: 0,
      count: 0,
      truncated: false,
      lines: [],
    }),
  ),
  setFocusedSession: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() =>
    Promise.resolve({
      sessionId: '',
      sourceName: '',
      sourceType: 'Logcat',
      totalLines: 0,
      fileSize: 0,
      isLive: false,
      isIndexing: false,
      firstTimestamp: 1_111,
      lastTimestamp: 2_222,
      logLevelDistribution: {},
    }),
  ),
}));

vi.mock('@bridge/commands', () => commands);

function load(sessionId: string, overrides: Partial<LoadResult> = {}): LoadResult {
  return {
    sessionId,
    sourceId: sessionId,
    sourceName: `${sessionId}.log`,
    filePath: `C:/logs/${sessionId}.log`,
    totalLines: 100,
    fileSize: 4096,
    firstTimestamp: null,
    lastTimestamp: null,
    sourceType: 'Logcat',
    isStreaming: false,
    isIndexing: false,
    hasCrlf: false,
    encoding: 'UTF-8',
    ...overrides,
  };
}

interface Harness {
  store: SessionStore;
  cacheManager: CacheManager;
  registry: DataSourceRegistry;
  controller: ViewerController;
  dispose: () => void;
}

function mount(): Harness {
  const cacheManager = new CacheManager(10_000);
  const registry = new DataSourceRegistry();
  const controller = createViewerController({ focusSession: () => {} });
  const store = createSessionStore({ cacheManager, registry, controller });
  return {
    store,
    cacheManager,
    registry,
    controller,
    dispose: () => {
      store.dispose();
      controller.dispose();
    },
  };
}

let harness: Harness;

beforeEach(() => {
  vi.clearAllMocks();
  harness = mount();
});

afterEach(() => {
  harness.dispose();
});

describe('createSessionStore', () => {
  it('adds a session, focuses the first one, and keeps insertion order', () => {
    const { store } = harness;
    store.add(load('a'));
    store.add(load('b'));

    expect(store.order()).toEqual(['a', 'b']);
    expect(store.focusedId()).toBe('a');
    expect(store.byId('b')?.load.sourceName).toBe('b.log');
    expect(store.focused()?.load.sessionId).toBe('a');
  });

  it('is idempotent: re-adding a session returns the same entry and builds nothing', () => {
    const { store } = harness;
    const first = store.add(load('a'));
    const second = store.add(load('a', { sourceName: 'renamed.log' }));

    expect(second).toBe(first);
    expect(store.order()).toEqual(['a']);
    expect(store.byId('a')?.load.sourceName).toBe('a.log');
  });

  it('setStreamingKind flips an open session between live and file', () => {
    const { store } = harness;
    store.add(load('a', { isStreaming: true }));
    expect(store.byId('a')?.kind).toBe('live');

    store.setStreamingKind('a', false);
    expect(store.byId('a')?.kind).toBe('file');

    store.setStreamingKind('a', true);
    expect(store.byId('a')?.kind).toBe('live');
  });

  it('setStreamingKind is a no-op for a session id that is not open', () => {
    const { store } = harness;
    expect(() => store.setStreamingKind('missing', false)).not.toThrow();
    expect(store.byId('missing')).toBeUndefined();
  });

  it('ignores a session-opened echo for a session it already has', () => {
    const { store } = harness;
    store.add(load('a'));
    bridge.handlers.opened?.(load('a'));

    expect(store.order()).toEqual(['a']);
  });

  it('adds a bridge-opened session it has never seen', () => {
    const { store } = harness;
    store.add(load('a'));
    bridge.handlers.opened?.(load('agent-1'));

    expect(store.order()).toEqual(['a', 'agent-1']);
  });

  it('removes a session, disposes its source and releases its view cache', () => {
    const { store, cacheManager, registry } = harness;
    store.add(load('a'));
    // `CacheDataSource.dispose()` unregisters itself from the registry — that
    // call is the observable proof it ran, and unlike a spy on the entry it
    // does not have to reach through the store proxy.
    const unregister = vi.spyOn(registry, 'unregister');
    const release = vi.spyOn(cacheManager, 'releaseView');

    store.remove('a');

    expect(unregister).toHaveBeenCalledWith('a', expect.anything());
    expect(release).toHaveBeenCalledWith(viewIdFor('a'));
    expect(store.byId('a')).toBeUndefined();
    expect(store.focusedId()).toBeNull();
  });

  it('refocuses the next tab when the focused one is removed, else the previous', () => {
    const { store } = harness;
    store.add(load('a'));
    store.add(load('b'));
    store.add(load('c'));

    store.setFocused('b');
    store.remove('b');
    // 'c' slid into b's slot.
    expect(store.focusedId()).toBe('c');

    store.remove('c');
    // Nothing after it: fall back to the one before.
    expect(store.focusedId()).toBe('a');
  });

  it('leaves focus alone when an unfocused session is removed', () => {
    const { store } = harness;
    store.add(load('a'));
    store.add(load('b'));

    store.remove('b');

    expect(store.focusedId()).toBe('a');
    expect(store.order()).toEqual(['a']);
  });

  it('ignores the session-closed echo of a close it started itself', () => {
    const { store } = harness;
    store.add(load('a'));
    store.markPendingClose('a');

    bridge.handlers.closed?.({ sessionId: 'a' });

    // The action surface removes it; the echo must not.
    expect(store.byId('a')).toBeDefined();
  });

  it('a released pending close no longer suppresses a foreign session-closed', () => {
    const { store } = harness;
    store.add(load('a'));
    store.markPendingClose('a');
    store.releasePendingClose('a');
    bridge.handlers.closed?.({ sessionId: 'a' });
    expect(store.byId('a')).toBeUndefined();
  });

  it('removes on a foreign session-closed, and only suppresses the echo once', () => {
    const { store } = harness;
    store.add(load('a'));
    store.add(load('b'));

    bridge.handlers.closed?.({ sessionId: 'a' });
    expect(store.byId('a')).toBeUndefined();

    // A second close for a session we DID claim, then a later foreign one for
    // the same id: the claim is consumed by the first echo only.
    store.markPendingClose('b');
    bridge.handlers.closed?.({ sessionId: 'b' });
    expect(store.byId('b')).toBeDefined();
    bridge.handlers.closed?.({ sessionId: 'b' });
    expect(store.byId('b')).toBeUndefined();
  });

  it('grows the total from index progress and settles it on completion', () => {
    const { store } = harness;
    store.add(load('a', { totalLines: 10, isIndexing: true }));

    bridge.handlers.progress?.({
      sessionId: 'a',
      indexedLines: 5_000,
      bytesScanned: 1,
      totalBytes: 2,
    });
    expect(store.byId('a')?.totalLines).toBe(5_000);
    expect(store.byId('a')?.isIndexing).toBe(true);
    // The data source carries its own copy — the viewer's spacer reads that
    // one, so a store-only update would leave the two disagreeing.
    expect(store.byId('a')?.dataSource.totalLines).toBe(5_000);

    bridge.handlers.complete?.({ sessionId: 'a', totalLines: 9_001 });
    expect(store.byId('a')?.totalLines).toBe(9_001);
    expect(store.byId('a')?.isIndexing).toBe(false);
    expect(store.byId('a')?.dataSource.totalLines).toBe(9_001);
  });

  it('re-reads the time range from session metadata once indexing completes', async () => {
    const { store } = harness;
    store.add(load('a', { isIndexing: true, firstTimestamp: null, lastTimestamp: null }));
    expect(store.byId('a')?.load.firstTimestamp).toBeNull();

    bridge.handlers.complete?.({ sessionId: 'a', totalLines: 9_001 });

    expect(commands.getSessionMetadata).toHaveBeenCalledWith('a');
    await vi.waitFor(() => expect(store.byId('a')?.load.firstTimestamp).toBe(1_111));
    expect(store.byId('a')?.load.lastTimestamp).toBe(2_222);
  });

  it('does not ask for metadata when index completion names a session it does not hold', () => {
    const { store } = harness;
    store.add(load('a'));

    bridge.handlers.complete?.({ sessionId: 'gone', totalLines: 5 });

    expect(commands.getSessionMetadata).not.toHaveBeenCalled();
  });

  it('ignores index progress for a session it does not hold', () => {
    const { store } = harness;
    store.add(load('a'));

    expect(() =>
      bridge.handlers.progress?.({
        sessionId: 'gone',
        indexedLines: 5,
        bytesScanned: 1,
        totalBytes: 2,
      }),
    ).not.toThrow();
    expect(store.byId('a')?.totalLines).toBe(100);
  });

  it('mirrors focus to the backend once per change, and not on mount', async () => {
    const { store } = harness;
    // Effects are queued; let the initial (deferred) run settle first.
    await Promise.resolve();
    expect(commands.setFocusedSession).not.toHaveBeenCalled();

    store.add(load('a'));
    store.add(load('b'));
    await Promise.resolve();
    expect(commands.setFocusedSession).toHaveBeenCalledTimes(1);
    expect(commands.setFocusedSession).toHaveBeenLastCalledWith('a');

    store.setFocused('b');
    await Promise.resolve();
    expect(commands.setFocusedSession).toHaveBeenCalledTimes(2);
    expect(commands.setFocusedSession).toHaveBeenLastCalledWith('b');

    // Re-selecting the same tab is not a change.
    store.setFocused('b');
    await Promise.resolve();
    expect(commands.setFocusedSession).toHaveBeenCalledTimes(2);
  });

  it('fetches with the controller view mode and the injected query provider', async () => {
    const cacheManager = new CacheManager(10_000);
    const registry = new DataSourceRegistry();
    const controller = createViewerController({ focusSession: () => {} });
    const store = createSessionStore({ cacheManager, registry, controller });

    const query = { text: 'boom', isRegex: false, caseSensitive: false } as never;
    store.setSearchQueryProvider(() => query);
    controller.setViewMode('a', { mode: 'Focus', center: 42 });

    const entry = store.add(load('a'));
    await entry.dataSource.getLines(0, 5);

    expect(commands.getLines).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'a',
        mode: { mode: 'Focus', center: 42 },
        search: query,
      }),
    );

    store.dispose();
    controller.dispose();
  });

  it('unlistens everything and empties itself on dispose', () => {
    const { store } = harness;
    store.add(load('a'));

    store.dispose();

    expect(bridge.unlisten.opened).toHaveBeenCalledOnce();
    expect(bridge.unlisten.closed).toHaveBeenCalledOnce();
    expect(bridge.unlisten.progress).toHaveBeenCalledOnce();
    expect(bridge.unlisten.complete).toHaveBeenCalledOnce();
    expect(store.order()).toEqual([]);
    expect(store.focusedId()).toBeNull();

    // Idempotent — App's onCleanup and a test teardown may both call it.
    expect(() => store.dispose()).not.toThrow();
  });

  it('can be built outside a component body (owns its root)', () => {
    // No createRoot wrapper anywhere in this file: the store supplies its own,
    // which is what lets App construct it as a plain value.
    const local = mount();
    expect(() => local.store.add(load('a'))).not.toThrow();
    local.dispose();
  });
});

// ── Per-session lifecycle: the controller and the cache manager ────────────

describe('createSessionStore — closing a session forgets it everywhere (review A-M1)', () => {
  it('remove() drops the controller state and the saved scroll position', () => {
    const { store, controller } = harness;
    store.add(load('a'));
    controller.setLineSet('a', 'filter', new Set([3, 7, 11]));
    controller.setHighlights(
      'a',
      new Map([[3, [{ start: 0, end: 2, kind: { type: 'Search' } }]]]),
    );
    sessionScrollPositions.set('a', 2_200_000);
    expect(controller.lineNumbers('a')).toEqual([3, 7, 11]);

    store.remove('a');

    expect(controller.lineNumbers('a')).toBeUndefined();
    expect(controller.highlights('a')).toBeNull();
    expect(sessionScrollPositions.get('a')).toBe(0);
  });

  it('dispose() forgets every open session, not just the focused one', () => {
    const { store, controller, dispose } = harness;
    store.add(load('a'));
    store.add(load('b'));
    controller.setLineSet('a', 'search', new Set([1]));
    controller.setLineSet('b', 'search', new Set([2]));

    dispose();

    expect(controller.lineNumbers('a')).toBeUndefined();
    expect(controller.lineNumbers('b')).toBeUndefined();
    // Re-dispose in afterEach must stay harmless.
    harness = mount();
  });
});

describe('createSessionStore — the open edge resets view state (review A-M2)', () => {
  it('an agent open → filter → agent close → agent reopen comes back unfiltered', () => {
    const { store, controller } = harness;

    // Both edges here are the bridge's, never this UI's action surface.
    bridge.handlers.opened?.(load('agent'));
    controller.setLineSet('agent', 'filter', new Set([5, 6]));
    expect(controller.lineNumbers('agent')).toEqual([5, 6]);

    bridge.handlers.closed?.({ sessionId: 'agent' });
    expect(store.order()).toEqual([]);

    // Same deterministic id — the backend resolves a path to the same session.
    bridge.handlers.opened?.(load('agent'));

    expect(store.order()).toEqual(['agent']);
    expect(controller.lineNumbers('agent')).toBeUndefined();
    expect(controller.highlights('agent')).toBeNull();
  });

  it('add() clears line sets that outlived their session by some other route', () => {
    const { store, controller } = harness;
    // State for an id the store has never held — a close path that skipped
    // `remove`, or a surface that wrote ahead of the open.
    controller.setLineSet('late', 'section', new Set([1, 2, 3]));

    store.add(load('late'));

    expect(controller.lineNumbers('late')).toBeUndefined();
  });

  it('add() leaves the controller alone when there is nothing to clear', () => {
    const { store, controller } = harness;
    const setLineSet = vi.spyOn(controller, 'setLineSet');
    const setHighlights = vi.spyOn(controller, 'setHighlights');

    store.add(load('fresh'));

    // A `bump()` per key would throw away the viewport cache on every open —
    // the same cost D2-H1 removed from the sections store.
    expect(setLineSet).not.toHaveBeenCalled();
    expect(setHighlights).not.toHaveBeenCalled();
    expect(controller.revision('fresh')).toBe(0);
  });
});

describe('createSessionStore — replace (C2 reopen-as)', () => {
  it('rebuilds the entry in place: same id, fresh totalLines/isIndexing/kind, a new dataSource', () => {
    const { store } = harness;
    const original = store.add(load('a', { totalLines: 10, isIndexing: false, sourceType: 'Logcat' }));
    // Captured before the replace: `original` is a live reference into the
    // store (Solid keeps one stable proxy per still-open key), so reading
    // `original.dataSource` AFTER the replace would already show the NEW
    // value — the pre-replace `dataSource` must be snapshotted separately to
    // prove it was actually swapped out, not merely that the field settled
    // on some value.
    const originalDataSource = original.dataSource;
    const disposeSpy = vi.spyOn(originalDataSource, 'dispose');

    const replaced = store.replace(load('a', { totalLines: 999, isIndexing: true, sourceType: 'Kernel' }));

    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(replaced.dataSource).not.toBe(originalDataSource);
    expect(store.byId('a')?.totalLines).toBe(999);
    expect(store.byId('a')?.isIndexing).toBe(true);
    expect(store.byId('a')?.load.sourceType).toBe('Kernel');
    // Same id, so the tab is reused rather than duplicated.
    expect(store.order()).toEqual(['a']);
  });

  it('clears the session cache without releasing its view allocation', () => {
    const { store, cacheManager } = harness;
    store.add(load('a'));
    const clearSession = vi.spyOn(cacheManager, 'clearSession');
    const releaseView = vi.spyOn(cacheManager, 'releaseView');

    store.replace(load('a'));

    expect(clearSession).toHaveBeenCalledWith('a');
    expect(releaseView).not.toHaveBeenCalled();
  });

  it('resets controller line sets and highlights, the same sweep the open edge runs', () => {
    const { store, controller } = harness;
    store.add(load('a'));
    controller.setLineSet('a', 'filter', new Set([1, 2]));
    controller.setHighlights('a', new Map());

    store.replace(load('a'));

    expect(controller.lineNumbers('a')).toBeUndefined();
    expect(controller.highlights('a')).toBeNull();
  });

  // A plain, never-filtered session (no section/search/highlight state ever
  // set — the common case: an ordinary logcat) is exactly the case
  // `resetSessionView` leaves untouched, since there is nothing to clear.
  // `replace` must still force the viewer to refetch — see its own doc
  // comment for why a revision bump is the only thing that actually resets
  // `viewer/cacheBinding.ts`'s fetch generation and forces the refetch.
  it('bumps the controller revision even when there was nothing to clear (D2-style stale-viewer gap)', () => {
    const { store, controller } = harness;
    store.add(load('a'));
    expect(controller.revision('a')).toBe(0);

    store.replace(load('a', { sourceType: 'Kernel' }));

    expect(controller.revision('a')).toBeGreaterThan(0);
  });

  it('falls back to add() when the id is not already open', () => {
    const { store } = harness;
    const result = store.replace(load('fresh'));

    expect(store.order()).toEqual(['fresh']);
    expect(store.byId('fresh')).toBe(result);
    expect(store.focusedId()).toBe('fresh');
  });

  it('leaves focus and tab order alone for an already-open, already-focused session', () => {
    const { store } = harness;
    store.add(load('a'));
    store.add(load('b'));
    store.setFocused('b');

    store.replace(load('b', { totalLines: 55 }));

    expect(store.order()).toEqual(['a', 'b']);
    expect(store.focusedId()).toBe('b');
    expect(store.byId('b')?.totalLines).toBe(55);
  });
});

describe('createSessionStore — cache budget follows the focused session (review A-M3)', () => {
  it('calls setFocus for the first session and again on every focus change', () => {
    const { store, cacheManager } = harness;
    const setFocus = vi.spyOn(cacheManager, 'setFocus');

    store.add(load('a'));
    expect(setFocus).toHaveBeenCalledWith(viewIdFor('a'));

    store.add(load('b'));
    setFocus.mockClear();
    store.setFocused('b');

    expect(setFocus).toHaveBeenCalledWith(viewIdFor('b'));
    // Without this, `allocateView` would have left 'b' on the small 'visible'
    // allocation for the app's lifetime because 'a' claimed 'focused' first
    // (60% of the budget goes to the focused view).
    const viewA = cacheManager.allocateView(viewIdFor('a'), 'a');
    const viewB = cacheManager.allocateView(viewIdFor('b'), 'b');
    expect(viewB.allocation).toBeGreaterThan(viewA.allocation);
  });

  it('does not call setFocus for a session that is no longer open', () => {
    const { store, cacheManager } = harness;
    store.add(load('a'));
    const setFocus = vi.spyOn(cacheManager, 'setFocus');

    store.remove('a');

    expect(setFocus).not.toHaveBeenCalled();
  });
});
