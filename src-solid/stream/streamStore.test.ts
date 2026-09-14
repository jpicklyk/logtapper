// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createLiveStreamStore } from './streamStore';
import type { AdbStreamEvent, LoadResult } from '@bridge/types';
import type { CacheController } from '@cache/CacheManager';
import type { StreamPusher } from '@viewport/DataSourceRegistry';
import { createSessionStore } from '../app/sessions';
import { createViewerController, CacheManager, DataSourceRegistry } from '../viewer';

// `createStreamSession` (wrapped by this store) is the only hard `@bridge/commands`
// dependency of `createLiveStreamStore` itself — every other bridge call this
// store makes is injectable via `deps.commands`, so only start/stop need mocking
// here, same split as `viewer/createStreamSession.test.ts`.
const startAdbStreamMock = vi.fn();
const stopAdbStreamMock = vi.fn();

vi.mock('@bridge/commands', () => ({
  startAdbStream: (...args: unknown[]) => startAdbStreamMock(...args),
  stopAdbStream: (...args: unknown[]) => stopAdbStreamMock(...args),
  // `createSessionStore` (built by `makeSessionStore` below) also imports
  // these two directly from `@bridge/commands` — mocked here for the same
  // reason `app/sessions.test.ts` mocks them.
  getLines: vi.fn(),
  setFocusedSession: vi.fn(() => Promise.resolve()),
}));

vi.mock('@bridge/events', () => ({
  onBridgeSessionOpened: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionClosed: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexProgress: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexComplete: vi.fn(() => Promise.resolve(() => {})),
}));

function makeLoadResult(overrides: Partial<LoadResult> = {}): LoadResult {
  return {
    sessionId: 's1',
    sourceId: 'adb-emulator-5554',
    sourceName: 'emulator-5554',
    filePath: null,
    totalLines: 0,
    fileSize: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    sourceType: 'Logcat',
    isStreaming: true,
    isIndexing: false,
    hasCrlf: false,
    encoding: 'UTF-8',
    ...overrides,
  };
}

/** Capture the `onEvent` callback `start()` hands to `startAdbStream`. */
function captureOnEvent(load: Partial<LoadResult> = {}): { fire: (e: AdbStreamEvent) => void } {
  let onEvent: ((e: AdbStreamEvent) => void) | undefined;
  startAdbStreamMock.mockImplementation((..._args: unknown[]) => {
    onEvent = _args[4] as (e: AdbStreamEvent) => void;
    return Promise.resolve(makeLoadResult(load));
  });
  return { fire: (e) => onEvent?.(e) };
}

function makeCacheController(): CacheController {
  return {
    broadcastToSession: vi.fn(),
    clearSession: vi.fn(),
    releaseSessionViews: vi.fn(),
    getSessionEntries: vi.fn(function* () {}),
    setTotalBudget: vi.fn(),
  };
}

function makeRegistry(): StreamPusher {
  return { pushToSession: vi.fn() };
}

/** A real `SessionStore` — exercising the actual `add`/`byId`/`setStreamingKind`
 *  wiring is cheap here and catches integration mistakes a hand-rolled fake
 *  session-store double would hide. */
function makeSessionStore() {
  const cacheManager = new CacheManager(1000);
  const registry = new DataSourceRegistry();
  const controller = createViewerController({ focusSession: () => {} });
  const sessions = createSessionStore({ cacheManager, registry, controller });
  return { sessions, dispose: () => { sessions.dispose(); controller.dispose(); } };
}

beforeEach(() => {
  startAdbStreamMock.mockReset();
  stopAdbStreamMock.mockReset();
  stopAdbStreamMock.mockResolvedValue(undefined);
});

describe('createLiveStreamStore', () => {
  it('registers a session and focuses it once the stream starts', async () => {
    captureOnEvent();
    const { sessions, dispose: disposeSessions } = makeSessionStore();
    const store = createLiveStreamStore({
      cacheManager: makeCacheController(),
      registry: makeRegistry(),
      sessions,
    });

    await store.start('emulator-5554');

    const entry = sessions.byId('s1');
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('live');
    expect(sessions.focusedId()).toBe('s1');

    store.dispose();
    disposeSessions();
  });

  it('flips the session back to file kind when the stream stops, without removing it', async () => {
    captureOnEvent();
    const { sessions, dispose: disposeSessions } = makeSessionStore();
    const store = createLiveStreamStore({
      cacheManager: makeCacheController(),
      registry: makeRegistry(),
      sessions,
    });

    await store.start('emulator-5554');
    await store.stop();

    const entry = sessions.byId('s1');
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('file');
    expect(store.active()).toBe(false);

    store.dispose();
    disposeSessions();
  });

  it('stopIfCurrent stops only when the id matches the running stream', async () => {
    captureOnEvent();
    const { sessions, dispose: disposeSessions } = makeSessionStore();
    const store = createLiveStreamStore({
      cacheManager: makeCacheController(),
      registry: makeRegistry(),
      sessions,
    });

    await store.start('emulator-5554');

    await store.stopIfCurrent('some-other-session');
    expect(stopAdbStreamMock).not.toHaveBeenCalled();
    expect(store.active()).toBe(true);

    await store.stopIfCurrent('s1');
    expect(stopAdbStreamMock).toHaveBeenCalledWith('s1');
    expect(store.active()).toBe(false);

    store.dispose();
    disposeSessions();
  });

  it('stopIfCurrent is a no-op when nothing is streaming', async () => {
    const { sessions, dispose: disposeSessions } = makeSessionStore();
    const store = createLiveStreamStore({
      cacheManager: makeCacheController(),
      registry: makeRegistry(),
      sessions,
    });

    await store.stopIfCurrent('s1');
    expect(stopAdbStreamMock).not.toHaveBeenCalled();

    store.dispose();
    disposeSessions();
  });

  it('refreshDevices populates devices() from the injected command', async () => {
    const { sessions, dispose: disposeSessions } = makeSessionStore();
    const listAdbDevices = vi.fn(() =>
      Promise.resolve([{ serial: 'emulator-5554', model: 'sdk_gphone', state: 'device' }]),
    );
    const store = createLiveStreamStore({
      cacheManager: makeCacheController(),
      registry: makeRegistry(),
      sessions,
      commands: { listAdbDevices },
    });

    await store.refreshDevices();

    expect(store.devices()).toEqual([{ serial: 'emulator-5554', model: 'sdk_gphone', state: 'device' }]);
    expect(store.devicesLoading()).toBe(false);
    expect(store.devicesError()).toBeNull();

    store.dispose();
    disposeSessions();
  });

  it('surfaces a refreshDevices failure without throwing', async () => {
    const { sessions, dispose: disposeSessions } = makeSessionStore();
    const listAdbDevices = vi.fn(() => Promise.reject(new Error('adb not on PATH')));
    const store = createLiveStreamStore({
      cacheManager: makeCacheController(),
      registry: makeRegistry(),
      sessions,
      commands: { listAdbDevices },
    });

    await store.refreshDevices();

    expect(store.devices()).toEqual([]);
    expect(store.devicesError()).toContain('adb not on PATH');

    store.dispose();
    disposeSessions();
  });

  it('pass-through commands (anonymize, processors, trackers, transformers, save, pids) carry their exact arguments', async () => {
    const { sessions, dispose: disposeSessions } = makeSessionStore();
    const setStreamAnonymize = vi.fn(() => Promise.resolve());
    const updateStreamProcessors = vi.fn(() => Promise.resolve());
    const updateStreamTrackers = vi.fn(() => Promise.resolve());
    const updateStreamTransformers = vi.fn(() => Promise.resolve());
    const saveLiveCapture = vi.fn(() => Promise.resolve(42));
    const getPackagePids = vi.fn(() => Promise.resolve([111, 222]));

    const store = createLiveStreamStore({
      cacheManager: makeCacheController(),
      registry: makeRegistry(),
      sessions,
      commands: {
        setStreamAnonymize,
        updateStreamProcessors,
        updateStreamTrackers,
        updateStreamTransformers,
        saveLiveCapture,
        getPackagePids,
      },
    });

    await store.setAnonymize('s1', true);
    expect(setStreamAnonymize).toHaveBeenCalledWith('s1', true);

    await store.updateProcessors('s1', ['p1']);
    expect(updateStreamProcessors).toHaveBeenCalledWith('s1', ['p1']);

    await store.updateTrackers('s1', ['t1']);
    expect(updateStreamTrackers).toHaveBeenCalledWith('s1', ['t1']);

    await store.updateTransformers('s1', ['x1']);
    expect(updateStreamTransformers).toHaveBeenCalledWith('s1', ['x1']);

    await expect(store.saveCapture('s1', 'C:/out.log')).resolves.toBe(42);
    expect(saveLiveCapture).toHaveBeenCalledWith('s1', 'C:/out.log');

    await expect(store.resolvePackagePids('emulator-5554', 'com.example')).resolves.toEqual([111, 222]);
    expect(getPackagePids).toHaveBeenCalledWith('emulator-5554', 'com.example');

    store.dispose();
    disposeSessions();
  });

  it('dispose stops an in-flight stream (best-effort) rather than orphaning it', async () => {
    captureOnEvent();
    const { sessions, dispose: disposeSessions } = makeSessionStore();
    const store = createLiveStreamStore({
      cacheManager: makeCacheController(),
      registry: makeRegistry(),
      sessions,
    });

    await store.start('emulator-5554');
    store.dispose();

    await vi.waitFor(() => expect(stopAdbStreamMock).toHaveBeenCalledWith('s1'));

    disposeSessions();
  });

  it('deps.filter (L4) passes straight through to the wrapped createStreamSession', async () => {
    const channel = captureOnEvent();
    const { sessions, dispose: disposeSessions } = makeSessionStore();
    const appendFilterMatches = vi.fn();
    const levelEAst = { kind: 'field', field: 'level', value: 'E' } as unknown as import('@filter/index').FilterNode;
    const store = createLiveStreamStore({
      cacheManager: makeCacheController(),
      registry: makeRegistry(),
      sessions,
      filter: {
        filterAst: () => levelEAst,
        filterSessionId: () => 's1',
        packagePids: () => new Map(),
        appendFilterMatches,
      },
    });

    await store.start('emulator-5554');
    channel.fire({
      event: 'batch',
      data: {
        sessionId: 's1',
        lines: [
          { lineNum: 1, raw: 'l1', tag: 'T', message: 'l1', level: 'Error', timestamp: null, highlights: [] },
          { lineNum: 2, raw: 'l2', tag: 'T', message: 'l2', level: 'Info', timestamp: null, highlights: [] },
        ] as unknown as import('@bridge/types').ViewLine[],
        totalLines: 2,
        byteCount: 10,
        firstTimestamp: null,
        lastTimestamp: null,
        lostLineCount: 0,
      },
    });

    expect(appendFilterMatches).toHaveBeenCalledWith('s1', [1]);

    store.dispose();
    disposeSessions();
  });
});
