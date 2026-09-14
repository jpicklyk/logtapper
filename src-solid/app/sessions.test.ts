import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadResult } from '@bridge/types';
import { CacheManager, DataSourceRegistry } from '../viewer';
import { createViewerController } from '../viewer';
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
