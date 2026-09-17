import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadResult } from '@bridge/types';
import type { AnalysisArtifact, AnalysisUpdateEvent } from '@bridge/types';
import { CacheManager, DataSourceRegistry, createViewerController } from '../viewer';
import type { ViewerController } from '../viewer';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import { createSessionStore } from '../app/index';
import type { SessionStore } from '../app/index';
import { createAnalysesStore } from './analysesStore';
import type { AnalysesCommands, AnalysesStore } from './analysesStore';

vi.mock('@bridge/events', () => ({
  onBridgeSessionOpened: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionClosed: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexProgress: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexComplete: vi.fn(() => Promise.resolve(() => {})),
  // Never called directly — every test injects its own `listen` — but the
  // store destructures the real export as its default at import time.
  onAnalysisUpdate: vi.fn(() => Promise.resolve(() => {})),
}));

const bridgeCommands = vi.hoisted(() => ({
  getLines: vi.fn(),
  setFocusedSession: vi.fn(() => Promise.resolve()),
  // Never called directly — every test injects its own `commands` — but the
  // store's default-commands object destructures these at import time, so
  // the mock module must define them.
  listAnalyses: vi.fn(() => Promise.resolve([])),
  getAnalysis: vi.fn(),
  publishAnalysis: vi.fn(),
  updateAnalysis: vi.fn(),
  deleteAnalysis: vi.fn(),
}));
vi.mock('@bridge/commands', () => bridgeCommands);

function load(sessionId: string, overrides: Partial<LoadResult> = {}): LoadResult {
  return {
    sessionId,
    sourceId: sessionId,
    sourceName: `${sessionId}.txt`,
    filePath: `C:/logs/${sessionId}.txt`,
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

function page(totalLines: number) {
  return { sessionId: '', totalLines, offset: 0, count: 0, truncated: false, lines: [] };
}

function artifact(id: string, overrides: Partial<AnalysisArtifact> = {}): AnalysisArtifact {
  return { id, title: `Title ${id}`, createdAt: Date.now(), sections: [], ...overrides };
}

function updateEvent(artifactId: string, action: AnalysisUpdateEvent['action']): AnalysisUpdateEvent {
  return { artifactId, action, sessionIds: [], sessionId: null };
}

/** Fake `onAnalysisUpdate`: captures the handler and exposes `emit`/`unlisten`. */
function makeListen() {
  let handler: ((payload: AnalysisUpdateEvent) => void) | null = null;
  const unlisten = vi.fn();
  const listen = vi.fn((cb: (payload: AnalysisUpdateEvent) => void) => {
    handler = cb;
    return Promise.resolve(unlisten);
  });
  return { listen, unlisten, emit: (payload: AnalysisUpdateEvent) => handler?.(payload) };
}

function makeCommands(): AnalysesCommands {
  return {
    listAnalyses: vi.fn(() => Promise.resolve([])),
    getAnalysis: vi.fn(),
    publishAnalysis: vi.fn(),
    updateAnalysis: vi.fn(),
    deleteAnalysis: vi.fn(),
  };
}

/** Drain enough microtasks for the store's `queueMicrotask`/promise chains to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

let cacheManager: CacheManager;
let registry: DataSourceRegistry;
let controller: ViewerController;
let sessionStore: SessionStore;
let commands: AnalysesCommands;
let listen: ReturnType<typeof makeListen>;
let store: AnalysesStore;

beforeEach(() => {
  vi.clearAllMocks();
  bridgeCommands.getLines.mockResolvedValue(page(0));
  bridgeCommands.setFocusedSession.mockResolvedValue(undefined);
  cacheManager = new CacheManager(10_000);
  registry = new DataSourceRegistry();
  controller = createViewerController({ focusSession: vi.fn() });
  sessionStore = createSessionStore({ cacheManager, registry, controller });
  commands = makeCommands();
  listen = makeListen();
  store = createAnalysesStore({ sessions: sessionStore, controller, commands, listen: listen.listen as never });
});

afterEach(() => {
  store.dispose();
  sessionStore.dispose();
  controller.dispose();
});

describe('createAnalysesStore', () => {
  it('loads the full list on construction', async () => {
    const a1 = artifact('a1');
    (commands.listAnalyses as ReturnType<typeof vi.fn>).mockResolvedValue([a1]);
    // Rebuild against the resolved mock — the store above already fired its
    // one-shot initial fetch against the default `[]` resolution.
    store.dispose();
    store = createAnalysesStore({ sessions: sessionStore, controller, commands, listen: listen.listen as never });
    await flush();
    expect(store.list()).toEqual([a1]);
  });

  it('builds labels from the session store', () => {
    sessionStore.add(load('s1', { sourceName: 'app.log' }));
    sessionStore.add(load('s2', { sourceName: 'kernel.log' }));
    expect(store.labels()).toEqual(new Map([['s1', 'app.log'], ['s2', 'kernel.log']]));
  });

  describe('list refetch coalescing', () => {
    it('collapses a burst of analysis-update events into one listAnalyses() call', async () => {
      await flush();
      (commands.listAnalyses as ReturnType<typeof vi.fn>).mockClear();
      listen.emit(updateEvent('a1', 'published'));
      listen.emit(updateEvent('a2', 'published'));
      listen.emit(updateEvent('a3', 'updated'));
      await flush();
      expect(commands.listAnalyses).toHaveBeenCalledTimes(1);
    });

    // `set_workspace_analyses` (a workspace restore replacing the backend
    // store wholesale) emits one `restored` with an empty artifact id — the
    // list must be re-read from the backend, not patched from the event.
    it('a workspace restore ("restored" with no artifact id) re-reads the list from the backend', async () => {
      await flush();
      expect(store.list()).toEqual([]);
      const restored = [artifact('r1'), artifact('r2')];
      (commands.listAnalyses as ReturnType<typeof vi.fn>).mockClear();
      (commands.listAnalyses as ReturnType<typeof vi.fn>).mockResolvedValue(restored);
      listen.emit(updateEvent('', 'restored'));
      await flush();
      expect(commands.listAnalyses).toHaveBeenCalledTimes(1);
      expect(store.list()).toEqual(restored);
    });
  });

  describe('per-id cache (open)', () => {
    it('fetches once and serves the same object on a repeat open()', async () => {
      (commands.getAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(artifact('a1'));
      const first = await store.open('a1');
      const second = await store.open('a1');
      expect(commands.getAnalysis).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });

    it('invalidates and re-fetches the selected artifact on a matching analysis-update', async () => {
      (commands.getAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(artifact('a1'));
      store.select('a1');
      await flush();
      (commands.getAnalysis as ReturnType<typeof vi.fn>).mockClear();
      listen.emit(updateEvent('a1', 'updated'));
      await flush();
      expect(commands.getAnalysis).toHaveBeenCalledTimes(1);
    });

    it('does not re-fetch an id that is not selected', async () => {
      (commands.getAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(artifact('a1'));
      await store.open('a1');
      (commands.getAnalysis as ReturnType<typeof vi.fn>).mockClear();
      listen.emit(updateEvent('a1', 'updated'));
      await flush();
      expect(commands.getAnalysis).not.toHaveBeenCalled();
    });
  });

  describe('update dedupe', () => {
    it('handles duplicate analysis-update events for the same id+action once', async () => {
      (commands.getAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(artifact('a1'));
      store.select('a1');
      await flush();
      (commands.getAnalysis as ReturnType<typeof vi.fn>).mockClear();
      const payload = updateEvent('a1', 'updated');
      listen.emit(payload);
      listen.emit(payload);
      await flush();
      expect(commands.getAnalysis).toHaveBeenCalledTimes(1);
    });

    it('still processes a different action for the same id in the same batch', async () => {
      // 'deleted' clears the selection; a duplicate 'updated' for the same id
      // right after must not resurrect it via a re-fetch.
      (commands.getAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(artifact('a1'));
      store.select('a1');
      await flush();
      listen.emit(updateEvent('a1', 'deleted'));
      listen.emit(updateEvent('a1', 'deleted'));
      await flush();
      expect(store.selectedId()).toBeNull();
    });
  });

  describe('publish / update / remove', () => {
    it('publish() calls publishAnalysis with the generated positional shape and selects the result', async () => {
      const created = artifact('new-1');
      (commands.publishAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(created);
      const result = await store.publish({ title: 'A title', sections: [], sessionId: 's1' });
      expect(commands.publishAnalysis).toHaveBeenCalledWith('A title', [], 's1');
      expect(result).toBe(created);
      expect(store.selectedId()).toBe('new-1');
      expect(store.list()).toContainEqual(created);
    });

    it('update() calls updateAnalysis with the generated positional shape', async () => {
      const updated = artifact('a1', { title: 'New title' });
      (commands.updateAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
      const result = await store.update({ artifactId: 'a1', title: 'New title', sections: [] });
      expect(commands.updateAnalysis).toHaveBeenCalledWith('a1', 'New title', []);
      expect(result).toBe(updated);
    });

    it('remove() calls deleteAnalysis and clears a matching selection', async () => {
      (commands.deleteAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (commands.getAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(artifact('a1'));
      store.select('a1');
      await flush();
      await store.remove('a1');
      expect(commands.deleteAnalysis).toHaveBeenCalledWith('a1');
      expect(store.selectedId()).toBeNull();
    });
  });

  describe('draft seed (analyses/draftSeed.ts)', () => {
    it('round-trips the controller cursor into a SourceReference, consumed once', () => {
      controller.scrollToLine('s1', 42, { source: 'user' });
      store.captureDraftSeed();
      const seed = store.takeDraftSeed();
      expect(seed).toEqual({
        lineNumber: 42,
        endLine: null,
        label: 'Line 42',
        highlightType: 'Anchor',
        sessionId: 's1',
      });
      expect(store.takeDraftSeed()).toBeNull();
    });

    it('captures nothing when the controller has no cursor', () => {
      store.captureDraftSeed();
      expect(store.takeDraftSeed()).toBeNull();
    });

    it('cursorReference() reads live, without going through the pending buffer', () => {
      expect(store.cursorReference()).toBeNull();
      controller.scrollToLine('s2', 7, { source: 'user' });
      expect(store.cursorReference()).toEqual({
        lineNumber: 7,
        endLine: null,
        label: 'Line 7',
        highlightType: 'Anchor',
        sessionId: 's2',
      });
    });
  });

  describe('error channel', () => {
    it('surfaces a listAnalyses rejection, and clears it on the next success', async () => {
      (commands.listAnalyses as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bridge down'));
      const failing = createAnalysesStore({
        sessions: sessionStore,
        controller,
        commands,
        listen: listen.listen as never,
      });
      await flush();
      expect(failing.error()).toContain('bridge down');

      // Built once: `artifact()` stamps `createdAt: Date.now()`, so a second
      // `artifact('a1')` in the assertion below differs whenever the flush
      // crosses a millisecond boundary — which it did under a loaded run.
      const a1 = artifact('a1');
      (commands.listAnalyses as ReturnType<typeof vi.fn>).mockResolvedValueOnce([a1]);
      failing.retry();
      await flush();
      // A stale message used to survive every later success, forever.
      expect(failing.error()).toBeNull();
      expect(failing.list()).toEqual([a1]);
      failing.dispose();
    });
  });

  describe('jumpTo', () => {
    it('routes through controller.scrollToLine with source "analysis"', () => {
      const spy = vi.spyOn(controller, 'scrollToLine');
      store.jumpTo({ sessionId: 's1', line: 10, endLine: null });
      expect(spy).toHaveBeenCalledWith('s1', 10, { highlight: true, select: undefined, source: 'analysis' });
    });

    it('builds a [line, endLine] select range when the reference has an end line', () => {
      const spy = vi.spyOn(controller, 'scrollToLine');
      store.jumpTo({ sessionId: 's1', line: 10, endLine: 20 });
      expect(spy).toHaveBeenCalledWith('s1', 10, { highlight: true, select: [10, 20], source: 'analysis' });
    });

    it('falls back to the focused session when the reference is unattributed', () => {
      sessionStore.add(load('focused'));
      const spy = vi.spyOn(controller, 'scrollToLine');
      store.jumpTo({ sessionId: null, line: 5, endLine: null });
      expect(spy).toHaveBeenCalledWith('focused', 5, { highlight: true, select: undefined, source: 'analysis' });
    });
  });

  describe('dispose', () => {
    it('unlistens (even once the listener promise resolves after dispose) and stops further work', async () => {
      store.dispose();
      await flush();
      expect(listen.unlisten).toHaveBeenCalledTimes(1);

      (commands.listAnalyses as ReturnType<typeof vi.fn>).mockClear();
      listen.emit(updateEvent('a1', 'published'));
      await flush();
      expect(commands.listAnalyses).not.toHaveBeenCalled();
    });

    it('is idempotent', () => {
      store.dispose();
      expect(() => store.dispose()).not.toThrow();
    });
  });
});
