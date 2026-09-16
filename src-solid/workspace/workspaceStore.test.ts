// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import type { AppStateFile, LoadWorkspaceV4Result, WorkspaceEntry } from '@bridge/types';
import {
  SOLID_MIRROR_KEY,
  createWorkspaceStore,
  mirrorToStoredTabs,
} from './workspaceStore';
import type {
  ShellLayoutPort,
  WorkspaceSessionActions,
  WorkspaceSessions,
  WorkspaceStore,
} from './workspaceStore';
import { writeSolidLayout } from './layoutBlob';
import type { SolidLayout } from './layoutBlob';
import { widthsStorageKey } from '../shell';

// The store is the only module here that talks to the bridge, so both bridge
// modules are mocked wholesale (the presenceStore.test.ts pattern).
const getAppStateMock = vi.fn<() => Promise<AppStateFile>>();
const saveAppStateMock = vi.fn<(s: AppStateFile) => Promise<void>>();
const loadWorkspaceV4Mock = vi.fn<(p: string) => Promise<LoadWorkspaceV4Result>>();
const saveWorkspaceV4Mock = vi.fn<(o: Record<string, unknown>) => Promise<void>>();
const autoSaveWorkspaceMock = vi.fn<(o: Record<string, unknown>) => Promise<string>>();
const beginSwitchMock = vi.fn<() => Promise<void>>();
const syncWorkspaceEnvelopeMock = vi.fn<(o: Record<string, unknown>) => Promise<void>>();
const renameMock = vi.fn<(r: unknown) => Promise<WorkspaceEntry>>();
const deleteMock = vi.fn<(r: unknown) => Promise<void>>();
const restoreSessionMock = vi.fn<(o: unknown) => Promise<void>>();
const startupFileMock = vi.fn<() => Promise<string | null>>();

vi.mock('@bridge/commands', () => ({
  getAppState: () => getAppStateMock(),
  saveAppState: (s: AppStateFile) => saveAppStateMock(s),
  loadWorkspaceV4: (p: string) => loadWorkspaceV4Mock(p),
  saveWorkspaceV4: (o: Record<string, unknown>) => saveWorkspaceV4Mock(o),
  autoSaveWorkspace: (o: Record<string, unknown>) => autoSaveWorkspaceMock(o),
  beginWorkspaceSwitch: () => beginSwitchMock(),
  syncWorkspaceEnvelope: (o: Record<string, unknown>) => syncWorkspaceEnvelopeMock(o),
  renameWorkspace: (r: unknown) => renameMock(r),
  deleteWorkspace: (r: unknown) => deleteMock(r),
  restoreWorkspaceSession: (o: unknown) => restoreSessionMock(o),
  getStartupFile: () => startupFileMock(),
}));

type ListChanged = (p: { workspaceId: string; action: string }) => void;
const listeners: { list: ListChanged[]; auto: ((p: unknown) => void)[]; restored: ((p: unknown) => void)[] } = {
  list: [], auto: [], restored: [],
};
const unlistened: string[] = [];

vi.mock('@bridge/events', () => ({
  onWorkspaceListChanged: (cb: ListChanged) => {
    listeners.list.push(cb);
    return Promise.resolve(() => unlistened.push('list'));
  },
  onWorkspaceAutoSaved: (cb: (p: unknown) => void) => {
    listeners.auto.push(cb);
    return Promise.resolve(() => unlistened.push('auto'));
  },
  onWorkspaceRestored: (cb: (p: unknown) => void) => {
    listeners.restored.push(cb);
    return Promise.resolve(() => unlistened.push('restored'));
  },
}));

// `consumeStartupFile` memoises its backend read per module instance, so the
// module registry is reset between tests (below) to keep each test independent.
vi.mock('@hooks/workspace/startupFile', () => ({
  consumeStartupFile: () => startupFileMock(),
}));

// ── fakes ────────────────────────────────────────────────────────────────────

interface Fakes {
  sessions: WorkspaceSessions;
  actions: WorkspaceSessionActions;
  opened: string[];
  closed: string[];
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  store: Record<string, string>;
}

function makeFakes(): Fakes {
  // Reactive like the real session store's `order`, so the store's membership
  // effect (open/close → dirty) is exercised, not just the restore plumbing.
  const [order, setOrder] = createSignal<readonly string[]>([]);
  const paths = new Map<string, string>();
  const opened: string[] = [];
  const closed: string[] = [];
  const store: Record<string, string> = {};
  return {
    opened,
    closed,
    store,
    storage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
    sessions: {
      order,
      focusedId: () => order()[0] ?? null,
      byId: (id) => (paths.has(id) ? { load: { filePath: paths.get(id)! } } : undefined),
    },
    actions: {
      openPath: (path) => {
        opened.push(path);
        const id = `sess-${opened.length}`;
        setOrder((prev) => [...prev, id]);
        paths.set(id, path);
        return Promise.resolve(id);
      },
      close: (id) => {
        closed.push(id);
        setOrder((prev) => prev.filter((x) => x !== id));
        return Promise.resolve();
      },
    },
  };
}

function ltw(overrides: Partial<LoadWorkspaceV4Result> = {}): LoadWorkspaceV4Result {
  return {
    workspaceName: 'wifi-debug',
    workspaceId: 'ws-1',
    savedAt: 1000,
    sessions: [],
    pipelineChain: { chain: [], disabledIds: [] },
    editorTabs: [],
    layout: null,
    analyses: [],
    sessionData: [],
    ...overrides,
  } as LoadWorkspaceV4Result;
}

function manifestSession(filePath: string) {
  return { filePath, sourceName: filePath, sourceType: 'Logcat' };
}

function emptySessionData() {
  return { bookmarks: [], analyses: [], activeProcessorIds: [], disabledProcessorIds: [] };
}

const appState = (workspaces: AppStateFile['workspaces'], activeWorkspaceId: string | null): AppStateFile =>
  ({ workspaces, activeWorkspaceId });

const entry = (id: string, over: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({
  id, name: id, ltwPath: null, dirty: false, autoSavePath: null, lastAutoSaveAt: null, ...over,
});

let created: WorkspaceStore[] = [];
function build(fakes: Fakes, extra: Partial<Parameters<typeof createWorkspaceStore>[0]> = {}): WorkspaceStore {
  const s = createWorkspaceStore({
    sessions: fakes.sessions,
    actions: fakes.actions,
    storage: fakes.storage,
    autoSaveDebounceMs: 50,
    ...extra,
  });
  created.push(s);
  return s;
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.list.length = 0;
  listeners.auto.length = 0;
  listeners.restored.length = 0;
  unlistened.length = 0;
  created = [];
  getAppStateMock.mockResolvedValue(appState([], null));
  saveAppStateMock.mockResolvedValue();
  saveWorkspaceV4Mock.mockResolvedValue();
  autoSaveWorkspaceMock.mockResolvedValue('C:/appdata/workspaces/ws-1.ltw');
  beginSwitchMock.mockResolvedValue();
  syncWorkspaceEnvelopeMock.mockResolvedValue(undefined);
  restoreSessionMock.mockResolvedValue();
  startupFileMock.mockResolvedValue(null);
  loadWorkspaceV4Mock.mockResolvedValue(ltw());
});

afterEach(() => {
  for (const s of created) s.dispose();
  vi.useRealTimers();
});

// ── hydration ────────────────────────────────────────────────────────────────

describe('hydrate', () => {
  it('creates a default workspace when disk and memory are both empty', async () => {
    const store = build(makeFakes());
    await store.hydrate();
    expect(store.list()).toHaveLength(1);
    expect(store.activeId()).toBe(store.list()[0]!.id);
    expect(saveAppStateMock).toHaveBeenCalledTimes(1);
  });

  it('takes the disk list and active id when disk is non-empty', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a'), entry('b')], 'b'));
    const store = build(makeFakes());
    await store.hydrate();
    expect(store.list().map((w) => w.id)).toEqual(['a', 'b']);
    expect(store.activeId()).toBe('b');
    // Disk was authoritative — no write-back.
    expect(saveAppStateMock).not.toHaveBeenCalled();
  });

  it('a re-hydrate does not move the active workspace out from under the open sessions', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a'), entry('b')], 'a'));
    const fakes = makeFakes();
    const store = build(fakes);
    await store.hydrate();
    await Promise.resolve();
    await store.switchWorkspace('b');
    await fakes.actions.openPath('b1.log');

    // Disk still names 'a' (the frontend's app-state write is fire-and-forget,
    // and the rename path re-reads the whole file). Adopting it here would
    // leave this window "in" 'a' with 'b's sessions on screen, then autosave
    // them into 'a'.
    listeners.list.forEach((cb) => cb({ workspaceId: 'a', action: 'renamed' }));
    await vi.waitFor(() => expect(getAppStateMock.mock.calls.length).toBeGreaterThan(1));
    expect(store.activeId()).toBe('b');
  });

  it('follows disk when the in-memory active workspace no longer exists', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a')], 'a'));
    const store = build(makeFakes());
    await store.hydrate();
    await Promise.resolve();
    getAppStateMock.mockResolvedValue(appState([entry('b')], 'b'));
    listeners.list.forEach((cb) => cb({ workspaceId: 'b', action: 'renamed' }));
    await vi.waitFor(() => expect(store.activeId()).toBe('b'));
  });
});

// ── explicit open ────────────────────────────────────────────────────────────

describe('openWorkspace', () => {
  it('applies the .ltw layout and restores sessions in manifest order', async () => {
    const applied: SolidLayout[] = [];
    const shellLayout: ShellLayoutPort = {
      read: () => ({
        columns: {}, collapsed: [], tabs: [], activeTab: null,
        split: { active: false, secondarySessionId: null, ratio: 0.5 },
      }),
      apply: (l) => applied.push(l),
    };
    const saved: SolidLayout = {
      columns: { navigator: 333 }, collapsed: ['presence'], tabs: ['a.log', 'b.log'], activeTab: 'b.log',
      split: { active: true, secondarySessionId: 'a.log', ratio: 0.4 },
    };
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('a.log'), manifestSession('b.log'), manifestSession('c.log')],
      sessionData: [emptySessionData(), emptySessionData(), emptySessionData()],
      layout: writeSolidLayout({ leftPaneWidth: 260 }, saved),
    }));

    const fakes = makeFakes();
    const store = build(fakes, { shellLayout });
    await store.hydrate();
    await store.openWorkspace('C:/ws/wifi.ltw');

    expect(fakes.opened).toEqual(['a.log', 'b.log', 'c.log']);
    expect(applied).toEqual([saved]);
    expect(store.active()?.name).toBe('wifi-debug');
    expect(store.active()?.filePath).toBe('C:/ws/wifi.ltw');
    // One restore_workspace_session per manifest entry that produced a session.
    expect(restoreSessionMock).toHaveBeenCalledTimes(3);
  });

  it('closes what is already open before replaying the manifest', async () => {
    const fakes = makeFakes();
    const store = build(fakes);
    await store.hydrate();
    await fakes.actions.openPath('stale.log');
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('fresh.log')], sessionData: [emptySessionData()],
    }));
    await store.openWorkspace('C:/ws/x.ltw');
    expect(fakes.closed).toEqual(['sess-1']);
    expect(fakes.opened).toEqual(['stale.log', 'fresh.log']);
  });

  it('keeps a failed reopen as a warning naming the file until dismissed', async () => {
    const fakes = makeFakes();
    const realOpen = fakes.actions.openPath;
    fakes.actions.openPath = (path) =>
      path === 'E:/usb/gone.log'
        ? Promise.reject(new Error('Failed to read metadata for E:/usb/gone.log: os error 3'))
        : realOpen(path);
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('E:/usb/gone.log'), manifestSession('c.log')],
      sessionData: [emptySessionData(), emptySessionData()],
    }));
    const store = build(fakes);
    await store.hydrate();
    await store.openWorkspace('C:/ws/x.ltw');

    // The surviving session still opens; the missing one is reported, not
    // swallowed — the reopen failure itself, then the pairing step's note that
    // the file's bookmarks/analyses stayed in the .ltw rather than landing on
    // another session.
    expect(fakes.opened).toEqual(['c.log']);
    expect(store.warnings()).toHaveLength(2);
    expect(store.warnings()[0]).toContain('E:/usb/gone.log');
    expect(store.warnings()[0]).toContain('os error 3');
    expect(store.warnings()[1]).toMatch(/E:\/usb\/gone.log .* artifacts were skipped/);

    store.clearWarnings();
    expect(store.warnings()).toEqual([]);
  });

  it('adds a list entry for the opened .ltw instead of re-pointing the active one', async () => {
    getAppStateMock.mockResolvedValue(appState(
      [entry('a', { ltwPath: 'C:/a.ltw', autoSavePath: 'C:/appdata/a.ltw', lastAutoSaveAt: 111 })],
      'a',
    ));
    loadWorkspaceV4Mock.mockResolvedValue(ltw({ workspaceId: 'ws-b', workspaceName: 'battery' }));
    const store = build(makeFakes());
    await store.hydrate();

    await store.openWorkspace('C:/ws/b.ltw');

    // The workspace that was active survives, with its own path and auto-save
    // bookkeeping intact — re-pointing it dropped it from Recent workspaces and
    // left the opened file wearing the old workspace's auto-save timestamp.
    expect(store.list().map((w) => w.id)).toEqual(['a', 'ws-b']);
    const [a, b] = store.list();
    expect(a!.filePath).toBe('C:/a.ltw');
    expect(a!.autoSavePath).toBe('C:/appdata/a.ltw');
    expect(a!.lastAutoSaveAt).toBe(111);
    expect(store.activeId()).toBe('ws-b');
    expect(b!.name).toBe('battery');
    expect(b!.filePath).toBe('C:/ws/b.ltw');
    expect(b!.autoSavePath).toBeNull();
    expect(b!.lastAutoSaveAt).toBeNull();
  });

  it('reopening the same .ltw reuses its entry rather than growing a duplicate', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a')], 'a'));
    loadWorkspaceV4Mock.mockResolvedValue(ltw({ workspaceId: 'ws-b', workspaceName: 'battery' }));
    const store = build(makeFakes());
    await store.hydrate();
    await store.openWorkspace('C:/ws/b.ltw');
    await store.openWorkspace('C:/ws/b.ltw');
    expect(store.list().map((w) => w.id)).toEqual(['a', 'ws-b']);
  });

  it('hands the .ltw editor tabs to W9 rather than applying them itself', async () => {
    const tabs = [{ label: 'notes', content: '# hi', viewMode: 'editor', wordWrap: false, filePath: null }];
    loadWorkspaceV4Mock.mockResolvedValue(ltw({ editorTabs: tabs }));
    const store = build(makeFakes());
    await store.hydrate();
    await store.openWorkspace('C:/ws/x.ltw');
    expect(store.pendingEditorTabs()).toEqual(tabs);
    expect(store.takePendingEditorTabs()).toEqual(tabs);
    expect(store.pendingEditorTabs()).toEqual([]);
  });
});

// ── save ─────────────────────────────────────────────────────────────────────

describe('saveWorkspace', () => {
  it('writes the namespaced blob and the app-state payload', async () => {
    const current: SolidLayout = {
      columns: { navigator: 280 }, collapsed: [], tabs: ['a.log'], activeTab: 'a.log',
      split: { active: false, secondarySessionId: null, ratio: 0.5 },
    };
    loadWorkspaceV4Mock.mockResolvedValue(ltw({ layout: { leftPaneWidth: 260, centerTree: { type: 'leaf' } } }));
    const store = build(makeFakes(), {
      shellLayout: { read: () => current, apply: () => undefined },
      getEditorTabs: () => [],
      getPipelineChain: () => ({ chain: ['__pii_anonymizer'], disabledIds: ['x'] }),
    });
    await store.hydrate();
    await store.openWorkspace('C:/ws/x.ltw');
    saveAppStateMock.mockClear();

    await store.saveWorkspace();

    const options = saveWorkspaceV4Mock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.destPath).toBe('C:/ws/x.ltw');
    expect(options.pipelineChain).toEqual(['__pii_anonymizer']);
    expect(options.disabledChainIds).toEqual(['x']);
    // React's keys from the loaded blob survive the Solid save.
    expect(options.layout).toEqual({
      leftPaneWidth: 260,
      centerTree: { type: 'leaf' },
      solid: { v: 1, ...current },
    });
    // The opened `.ltw` has its own entry (it does not displace the workspace
    // that was active), so read the one the save actually targeted.
    const state = saveAppStateMock.mock.calls[0]![0];
    const saved = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
    expect(saved!.ltwPath).toBe('C:/ws/x.ltw');
    expect(saved!.dirty).toBe(false);
  });

  it("keeps React's layout keys after a startup restore that trusted the mirror", async () => {
    // The mirror holds tabs, so the .ltw view state is NOT applied on startup;
    // the loaded blob must still be the base of the next save.
    getAppStateMock.mockResolvedValue(appState([entry('a', { ltwPath: 'C:/a.ltw' })], 'a'));
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('a.log')], sessionData: [emptySessionData()],
      layout: { leftPaneWidth: 260, centerTree: { type: 'leaf' }, bottomPaneTab: 'timeline' },
    }));
    const fakes = makeFakes();
    fakes.store[SOLID_MIRROR_KEY] = JSON.stringify({
      activeWorkspaceId: 'a', tabPaths: ['a.log'], activeTabPath: 'a.log',
    });
    const current: SolidLayout = {
      columns: {}, collapsed: [], tabs: ['a.log'], activeTab: 'a.log',
      split: { active: false, secondarySessionId: null, ratio: 0.5 },
    };
    const store = build(fakes, { shellLayout: { read: () => current, apply: () => undefined } });
    await store.hydrate();
    await store.startupRestore();

    await store.saveWorkspace();

    const options = saveWorkspaceV4Mock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.layout).toEqual({
      leftPaneWidth: 260,
      centerTree: { type: 'leaf' },
      bottomPaneTab: 'timeline',
      solid: { v: 1, ...current },
    });
  });

  it("does not write one workspace's React layout keys into the next workspace's file", async () => {
    // The blob is remembered from the `.ltw` a workspace was opened with, and
    // "New workspace" loads no `.ltw` at all — so without a reset the fresh
    // workspace's first save stamps the previous workspace's pane tree and tab
    // selections into its own file.
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      layout: { leftPaneWidth: 260, centerTree: { type: 'leaf' }, rightPaneTab: 'analyses' },
    }));
    const current: SolidLayout = {
      columns: {}, collapsed: [], tabs: [], activeTab: null,
      split: { active: false, secondarySessionId: null, ratio: 0.5 },
    };
    const store = build(makeFakes(), { shellLayout: { read: () => current, apply: () => undefined } });
    await store.hydrate();
    await store.openWorkspace('C:/ws/a.ltw');

    await store.newWorkspace();
    await store.saveWorkspace();

    const options = autoSaveWorkspaceMock.mock.calls[0]![0];
    expect(options.layout).toEqual({ solid: { v: 1, ...current } });
  });

  it('drops the remembered blob when switching into a workspace that has no .ltw', async () => {
    getAppStateMock.mockResolvedValue(
      appState([entry('a', { ltwPath: 'C:/a.ltw' }), entry('b')], 'a'),
    );
    loadWorkspaceV4Mock.mockResolvedValue(ltw({ layout: { leftPaneWidth: 260 } }));
    const current: SolidLayout = {
      columns: {}, collapsed: [], tabs: [], activeTab: null,
      split: { active: false, secondarySessionId: null, ratio: 0.5 },
    };
    const store = build(makeFakes(), { shellLayout: { read: () => current, apply: () => undefined } });
    await store.hydrate();
    await store.startupRestore();

    await store.switchWorkspace('b');
    await store.saveWorkspace();

    const options = autoSaveWorkspaceMock.mock.calls[0]![0];
    expect(options.layout).toEqual({ solid: { v: 1, ...current } });
  });

  it('auto-saves to the app-data dir when the workspace has no path', async () => {
    const store = build(makeFakes());
    await store.hydrate();
    await store.saveWorkspace();
    expect(saveWorkspaceV4Mock).not.toHaveBeenCalled();
    expect(autoSaveWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(store.active()?.autoSavePath).toBe('C:/appdata/workspaces/ws-1.ltw');
  });

  it('mirrors the open tab paths to localStorage for crash recovery', async () => {
    const fakes = makeFakes();
    const store = build(fakes);
    await store.hydrate();
    await fakes.actions.openPath('a.log');
    await fakes.actions.openPath('b.log');
    await store.saveWorkspace();
    const mirror = JSON.parse(fakes.store[SOLID_MIRROR_KEY]!) as Record<string, unknown>;
    expect(mirror.tabPaths).toEqual(['a.log', 'b.log']);
    expect(mirror.activeTabPath).toBe('a.log');
  });
});

// ── autosave guards ──────────────────────────────────────────────────────────

describe('autoSave', () => {
  it('does nothing when the workspace is not dirty', async () => {
    const store = build(makeFakes());
    await store.hydrate();
    await store.autoSave();
    expect(saveWorkspaceV4Mock).not.toHaveBeenCalled();
    expect(autoSaveWorkspaceMock).not.toHaveBeenCalled();
  });

  it('does nothing when there is no active workspace', async () => {
    const store = build(makeFakes());
    await store.autoSave();
    expect(autoSaveWorkspaceMock).not.toHaveBeenCalled();
  });

  it('markMutated arms a debounce that collapses a burst into one save', async () => {
    vi.useFakeTimers();
    const store = build(makeFakes());
    await store.hydrate();

    store.markMutated();
    store.markMutated();
    store.markMutated();
    expect(store.dirty()).toBe(true);
    expect(autoSaveWorkspaceMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(49);
    expect(autoSaveWorkspaceMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(autoSaveWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(store.dirty()).toBe(false);
  });

  it('opening or closing a session outside a restore marks the workspace dirty and autosaves', async () => {
    vi.useFakeTimers();
    const fakes = makeFakes();
    const store = build(fakes);
    await store.hydrate();
    expect(store.dirty()).toBe(false);

    // The user's dialog, an agent's open_file, a session-closed echo — all land
    // in `sessions.order()`; the manifest is that list, so each must autosave.
    const id = await fakes.actions.openPath('fresh.log');
    expect(store.dirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(autoSaveWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(store.dirty()).toBe(false);

    await fakes.actions.close(id);
    expect(store.dirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(autoSaveWorkspaceMock).toHaveBeenCalledTimes(2);
  });

  it('a restore or a workspace switch changes membership without dirtying anything', async () => {
    vi.useFakeTimers();
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('a.log')], sessionData: [emptySessionData()],
    }));
    const fakes = makeFakes();
    const store = build(fakes);
    await store.hydrate();
    await store.openWorkspace('C:/ws/a.ltw');
    expect(fakes.opened).toEqual(['a.log']);
    expect(store.dirty()).toBe(false);

    await store.newWorkspace(); // tears the restored session down
    expect(fakes.closed).toEqual(['sess-1']);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.list().every((w) => !w.dirty)).toBe(true);
    expect(autoSaveWorkspaceMock).not.toHaveBeenCalled();
  });

  it('is suppressed while a restore is in flight', async () => {
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('a.log')], sessionData: [emptySessionData()],
    }));
    const fakes = makeFakes();
    const store = build(fakes, {
      actions: {
        close: fakes.actions.close,
        openPath: (p: string) => {
          // A restore legitimately produces mutations as each session lands.
          store.markMutated();
          return fakes.actions.openPath(p);
        },
      },
    } as never);
    await store.hydrate();
    await store.openWorkspace('C:/ws/x.ltw');
    expect(store.dirty()).toBe(false);
  });
});

// ── switch ───────────────────────────────────────────────────────────────────

describe('switchWorkspace', () => {
  it('arms the backend switch, closes every session, then opens the target', async () => {
    getAppStateMock.mockResolvedValue(
      appState([entry('a', { ltwPath: 'C:/a.ltw' }), entry('b', { ltwPath: 'C:/b.ltw' })], 'a'),
    );
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('b1.log')], sessionData: [emptySessionData()],
    }));
    const fakes = makeFakes();
    const store = build(fakes);
    await store.hydrate();
    await fakes.actions.openPath('a1.log');

    await store.switchWorkspace('b');

    expect(beginSwitchMock).toHaveBeenCalledTimes(1);
    expect(fakes.closed).toEqual(['sess-1']);
    expect(loadWorkspaceV4Mock).toHaveBeenCalledWith('C:/b.ltw');
    expect(fakes.opened).toEqual(['a1.log', 'b1.log']);
    expect(store.activeId()).toBe('b');
  });

  it('surfaces a failed load after the switch has torn down the old sessions', async () => {
    getAppStateMock.mockResolvedValue(
      appState([entry('a', { ltwPath: 'C:/a.ltw' }), entry('b', { ltwPath: 'C:/missing.ltw' })], 'a'),
    );
    loadWorkspaceV4Mock.mockRejectedValue(new Error('NOT_FOUND: C:/missing.ltw'));
    const fakes = makeFakes();
    const store = build(fakes);
    await store.hydrate();
    await fakes.actions.openPath('a1.log');

    await expect(store.switchWorkspace('b')).rejects.toThrow('NOT_FOUND');
    expect(fakes.closed).toEqual(['sess-1']);
    expect(store.activeId()).toBe('b');
  });

  it('is a no-op for the already-active workspace', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a')], 'a'));
    const store = build(makeFakes());
    await store.hydrate();
    await store.switchWorkspace('a');
    expect(beginSwitchMock).not.toHaveBeenCalled();
  });

  it('flushes the dirty outgoing workspace before arming the switch and tearing it down', async () => {
    // React's `runTransition` calls this ordering load-bearing: the frontend
    // half of the payload (the Solid layout blob, the editor tabs) is written
    // only by this save, so cancelling it instead of flushing loses it.
    const order: string[] = [];
    getAppStateMock.mockResolvedValue(
      appState([entry('a', { ltwPath: 'C:/a.ltw' }), entry('b')], 'a'),
    );
    saveWorkspaceV4Mock.mockImplementation(() => { order.push('save'); return Promise.resolve(); });
    beginSwitchMock.mockImplementation(() => { order.push('begin-switch'); return Promise.resolve(); });
    const fakes = makeFakes();
    const realClose = fakes.actions.close;
    fakes.actions.close = (id) => { order.push('close'); return realClose(id); };
    const store = build(fakes);
    await store.hydrate();
    await fakes.actions.openPath('a1.log');
    expect(store.dirty()).toBe(true);

    await store.switchWorkspace('b');

    expect(order).toEqual(['save', 'begin-switch', 'close']);
    expect(store.list().find((w) => w.id === 'a')!.dirty).toBe(false);
  });

  it('does not prompt when the flush saved the outgoing workspace', async () => {
    getAppStateMock.mockResolvedValue(
      appState([entry('a', { ltwPath: 'C:/a.ltw' }), entry('b')], 'a'),
    );
    const confirmDiscard = vi.fn(() => true);
    const fakes = makeFakes();
    const store = build(fakes, { confirmDiscard });
    await store.hydrate();
    await fakes.actions.openPath('a1.log');
    await store.switchWorkspace('b');
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(store.activeId()).toBe('b');
  });

  it('asks before discarding state the flush could not save, and a refusal aborts the switch', async () => {
    getAppStateMock.mockResolvedValue(
      appState([entry('a', { ltwPath: 'C:/a.ltw' }), entry('b')], 'a'),
    );
    saveWorkspaceV4Mock.mockRejectedValue(new Error('EACCES: C:/a.ltw'));
    const confirmDiscard = vi.fn(() => false);
    const fakes = makeFakes();
    const store = build(fakes, { confirmDiscard });
    await store.hydrate();
    await fakes.actions.openPath('a1.log');

    await store.switchWorkspace('b');

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(store.activeId()).toBe('a');
    expect(beginSwitchMock).not.toHaveBeenCalled();
    expect(fakes.closed).toEqual([]);
  });
});

// ── rename / delete / list events ────────────────────────────────────────────

describe('rename and delete', () => {
  it('rename goes through the B3 wrapper and adopts the returned name', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a', { name: 'old' })], 'a'));
    renameMock.mockResolvedValue(entry('a', { name: 'new' }));
    const store = build(makeFakes());
    await store.hydrate();
    await store.rename('a', 'new');
    expect(renameMock).toHaveBeenCalledWith({ workspaceId: 'a', newName: 'new' });
    expect(store.list()[0]!.name).toBe('new');
  });

  it('delete forwards deleteFile/force and drops the entry', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a'), entry('b')], 'a'));
    deleteMock.mockResolvedValue();
    const store = build(makeFakes());
    await store.hydrate();
    await store.delete('a', { deleteFile: true, force: true });
    expect(deleteMock).toHaveBeenCalledWith({ workspaceId: 'a', deleteFile: true, force: true });
    expect(store.list().map((w) => w.id)).toEqual(['b']);
    // Mirrors the backend: a forced delete of the active workspace leaves no
    // active id rather than promoting an unloaded neighbour.
    expect(store.activeId()).toBeNull();
  });

  it('reconciles the list when workspace-list-changed reports a delete', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a'), entry('b')], 'a'));
    const fakes = makeFakes();
    fakes.store[widthsStorageKey('a')] = JSON.stringify({ navigator: 320 });
    const store = build(fakes);
    await store.hydrate();
    await Promise.resolve();
    listeners.list.forEach((cb) => cb({ workspaceId: 'a', action: 'deleted' }));
    expect(store.list().map((w) => w.id)).toEqual(['b']);
    expect(store.activeId()).toBe('b');
    // A delete from elsewhere (an agent, another window) leaks the same dead
    // widths key as a local one.
    expect(fakes.store[widthsStorageKey('a')]).toBeUndefined();
  });

  it("removes the workspace's shell region widths when it is deleted", async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a'), entry('b')], 'a'));
    deleteMock.mockResolvedValue();
    const fakes = makeFakes();
    fakes.store[widthsStorageKey('a')] = JSON.stringify({ navigator: 320 });
    fakes.store[widthsStorageKey('b')] = JSON.stringify({ navigator: 300 });
    const store = build(fakes);
    await store.hydrate();
    await store.delete('a', { force: true });
    // Nothing else owns `logtapper-shell-widths:<id>` or expires it.
    expect(fakes.store[widthsStorageKey('a')]).toBeUndefined();
    expect(fakes.store[widthsStorageKey('b')]).toBeDefined();
  });

  it('re-hydrates from disk when workspace-list-changed reports a rename', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a', { name: 'old' })], 'a'));
    const store = build(makeFakes());
    await store.hydrate();
    await Promise.resolve();
    getAppStateMock.mockResolvedValue(appState([entry('a', { name: 'renamed' })], 'a'));
    listeners.list.forEach((cb) => cb({ workspaceId: 'a', action: 'renamed' }));
    await vi.waitFor(() => expect(store.list()[0]!.name).toBe('renamed'));
  });
});

// ── startup restore ──────────────────────────────────────────────────────────

describe('startupRestore', () => {
  it('unions the mirror with the .ltw manifest', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a', { ltwPath: 'C:/a.ltw' })], 'a'));
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('from-manifest.log')], sessionData: [emptySessionData()],
    }));
    const fakes = makeFakes();
    fakes.store[SOLID_MIRROR_KEY] = JSON.stringify({
      activeWorkspaceId: 'a', tabPaths: ['opened-later.log'], activeTabPath: 'opened-later.log',
    });
    const store = build(fakes);
    await store.hydrate();
    await store.startupRestore();
    expect(fakes.opened.sort()).toEqual(['from-manifest.log', 'opened-later.log']);
  });

  it('opens the CLI startup file first, alongside the mirror, without replaying the manifest', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a', { ltwPath: 'C:/a.ltw' })], 'a'));
    startupFileMock.mockResolvedValue('D:/dropped.log');
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('from-manifest.log')], sessionData: [emptySessionData()],
    }));
    const fakes = makeFakes();
    fakes.store[SOLID_MIRROR_KEY] = JSON.stringify({
      activeWorkspaceId: 'a', tabPaths: ['mirrored.log'], activeTabPath: 'mirrored.log',
    });
    const store = build(fakes);
    await store.hydrate();
    await store.startupRestore();
    // `consumeStartupFile()` takes the backend value once per process, so a
    // double-clicked file that is not opened here is lost for good. It leads;
    // the mirror follows; the `.ltw` manifest is deliberately not replayed.
    expect(fakes.opened).toEqual(['D:/dropped.log', 'mirrored.log']);
  });

  it('does not open the CLI startup file twice when the mirror already holds it', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a', { ltwPath: 'C:/a.ltw' })], 'a'));
    startupFileMock.mockResolvedValue('D:/dropped.log');
    const fakes = makeFakes();
    fakes.store[SOLID_MIRROR_KEY] = JSON.stringify({
      // Same file, as the mirror would have spelled it on Windows.
      activeWorkspaceId: 'a', tabPaths: ['D:\\Dropped.log'], activeTabPath: 'D:\\Dropped.log',
    });
    const store = build(fakes);
    await store.hydrate();
    await store.startupRestore();
    expect(fakes.opened).toEqual(['D:\\Dropped.log']);
  });

  it("keeps React's layout keys when a CLI startup file won", async () => {
    // The `.ltw` is read for its blob only: nothing from its manifest is
    // replayed, but the first save after a double-click start must still
    // read-modify-write the file rather than stripping React's keys.
    getAppStateMock.mockResolvedValue(appState([entry('a', { ltwPath: 'C:/a.ltw' })], 'a'));
    startupFileMock.mockResolvedValue('D:/dropped.log');
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('from-manifest.log')], sessionData: [emptySessionData()],
      layout: { leftPaneWidth: 260, centerTree: { type: 'leaf' } },
    }));
    const current: SolidLayout = {
      columns: {}, collapsed: [], tabs: ['D:/dropped.log'], activeTab: 'D:/dropped.log',
      split: { active: false, secondarySessionId: null, ratio: 0.5 },
    };
    const store = build(makeFakes(), { shellLayout: { read: () => current, apply: () => undefined } });
    await store.hydrate();
    await store.startupRestore();

    await store.saveWorkspace();

    const options = saveWorkspaceV4Mock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.layout).toEqual({
      leftPaneWidth: 260,
      centerTree: { type: 'leaf' },
      solid: { v: 1, ...current },
    });
  });

  it('leaves the remembered blob alone when the startup-time .ltw read fails', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a', { ltwPath: 'C:/gone.ltw' })], 'a'));
    startupFileMock.mockResolvedValue('D:/dropped.log');
    loadWorkspaceV4Mock.mockRejectedValue(new Error('NOT_FOUND: C:/gone.ltw'));
    const fakes = makeFakes();
    const store = build(fakes);
    await store.hydrate();
    await expect(store.startupRestore()).resolves.toBeUndefined();
    expect(fakes.opened).toEqual(['D:/dropped.log']);
  });

  it('restores nothing and does not throw when there is no candidate at all', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a')], 'a'));
    const fakes = makeFakes();
    const store = build(fakes);
    await store.hydrate();
    await store.startupRestore();
    expect(fakes.opened).toEqual([]);
    expect(loadWorkspaceV4Mock).not.toHaveBeenCalled();
  });
});

// ── backend envelope cache ───────────────────────────────────────────────────
//
// Repro for the "chain/bookmark edits don't autosave until a first explicit
// workspace save" bug: `autosave.rs::flush` skips until something calls
// `cache_envelope`, and this store previously reached it only through
// `saveWorkspace()` — which `autoSave()` only runs once the workspace is
// dirty. A backend-owned mutation (an agent's chain commit or bookmark add)
// never dirties the Solid store, so it had nothing to flush into until the
// user explicitly saved once. `pushEnvelope()` closes that gap.

describe('backend envelope cache (pushEnvelope)', () => {
  it('caches the envelope after an explicit open, with the exact field set saveWorkspace would send', async () => {
    loadWorkspaceV4Mock.mockResolvedValue(ltw({ workspaceId: 'ws-b', workspaceName: 'battery' }));
    const tabs = [{ label: 'n', content: '', viewMode: 'editor' as const, wordWrap: false, filePath: null }];
    const store = build(makeFakes(), {
      getEditorTabs: () => tabs,
      getPipelineChain: () => ({ chain: ['__pii_anonymizer'], disabledIds: ['x'] }),
    });
    await store.hydrate();

    await store.openWorkspace('C:/ws/b.ltw');

    expect(syncWorkspaceEnvelopeMock).toHaveBeenCalledTimes(1);
    expect(syncWorkspaceEnvelopeMock).toHaveBeenCalledWith({
      workspaceId: 'ws-b',
      workspaceName: 'battery',
      ltwPath: 'C:/ws/b.ltw',
      editorTabs: tabs,
      layout: {
        solid: {
          v: 1, columns: {}, collapsed: [], tabs: [], activeTab: null,
          split: { active: false, secondarySessionId: null, ratio: 0.5 },
        },
      },
      pipelineChain: ['__pii_anonymizer'],
      disabledChainIds: ['x'],
    });
  });

  it('caches the envelope for a fresh "new workspace", keyed on its own fresh id', async () => {
    const store = build(makeFakes());
    await store.hydrate();
    syncWorkspaceEnvelopeMock.mockClear();

    await store.newWorkspace();

    expect(syncWorkspaceEnvelopeMock).toHaveBeenCalledTimes(1);
    const options = syncWorkspaceEnvelopeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.workspaceId).toBe(store.activeId());
    expect(options.ltwPath).toBeNull();
  });

  it('caches the envelope after a trusted startup restore', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a', { ltwPath: 'C:/a.ltw' })], 'a'));
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('from-manifest.log')], sessionData: [emptySessionData()],
    }));
    const store = build(makeFakes());
    await store.hydrate();

    await store.startupRestore();

    expect(syncWorkspaceEnvelopeMock).toHaveBeenCalledTimes(1);
    expect((syncWorkspaceEnvelopeMock.mock.calls[0]![0] as Record<string, unknown>).workspaceId).toBe('a');
  });

  it('caches the envelope even at startup with no restore candidate at all', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a')], 'a'));
    const store = build(makeFakes());
    await store.hydrate();

    await store.startupRestore();

    // No .ltw to read, but the workspace is active — a bookmark added before
    // any explicit save must still have somewhere to flush into.
    expect(syncWorkspaceEnvelopeMock).toHaveBeenCalledTimes(1);
    expect((syncWorkspaceEnvelopeMock.mock.calls[0]![0] as Record<string, unknown>).workspaceId).toBe('a');
  });

  it('caches the envelope when switching into a workspace that has no .ltw yet', async () => {
    getAppStateMock.mockResolvedValue(
      appState([entry('a', { ltwPath: 'C:/a.ltw' }), entry('b')], 'a'),
    );
    const store = build(makeFakes());
    await store.hydrate();

    await store.switchWorkspace('b');

    expect(syncWorkspaceEnvelopeMock).toHaveBeenCalledTimes(1);
    const options = syncWorkspaceEnvelopeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.workspaceId).toBe('b');
    expect(options.ltwPath).toBeNull();
  });

  it('is not called until the switch has fully settled, not while sessions are torn down or replayed', async () => {
    getAppStateMock.mockResolvedValue(
      appState([entry('a', { ltwPath: 'C:/a.ltw' }), entry('b', { ltwPath: 'C:/b.ltw' })], 'a'),
    );
    loadWorkspaceV4Mock.mockResolvedValue(ltw({
      sessions: [manifestSession('b1.log')], sessionData: [emptySessionData()],
    }));
    const order: string[] = [];
    beginSwitchMock.mockImplementation(() => { order.push('begin-switch'); return Promise.resolve(); });
    syncWorkspaceEnvelopeMock.mockImplementation(() => { order.push('push-envelope'); return Promise.resolve(undefined); });
    const fakes = makeFakes();
    const realClose = fakes.actions.close;
    fakes.actions.close = (id) => { order.push('close'); return realClose(id); };
    const realOpen = fakes.actions.openPath;
    fakes.actions.openPath = (p) => { order.push(`open:${p}`); return realOpen(p); };
    const store = build(fakes);
    await store.hydrate();
    await fakes.actions.openPath('a1.log');
    order.length = 0; // drop the setup-time open above

    await store.switchWorkspace('b');

    // The push lands strictly after the outgoing session is closed and the
    // incoming one replayed — never in the window the backend's own
    // switch-suppression exists to protect.
    expect(order).toEqual(['begin-switch', 'close', 'open:b1.log', 'push-envelope']);
  });
});

// ── teardown ─────────────────────────────────────────────────────────────────

describe('dispose', () => {
  it('unlistens every bridge listener', async () => {
    const store = build(makeFakes());
    await Promise.resolve();
    await Promise.resolve();
    store.dispose();
    expect(unlistened.sort()).toEqual(['auto', 'list', 'restored']);
  });

  it('cancels a pending auto-save debounce', async () => {
    vi.useFakeTimers();
    const store = build(makeFakes());
    await store.hydrate();
    store.markMutated();
    store.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(autoSaveWorkspaceMock).not.toHaveBeenCalled();
  });
});

// ── pure helper ──────────────────────────────────────────────────────────────

describe('mirrorToStoredTabs', () => {
  it('shapes the flat mirror into the planner’s stored-tab pair', () => {
    expect(mirrorToStoredTabs({ activeWorkspaceId: 'a', tabPaths: ['x.log', 'y.log'], activeTabPath: 'y.log' }))
      .toEqual({
        storedTabs: [
          { tabId: 'solid-tab-0', paneId: 'main', isActive: false },
          { tabId: 'solid-tab-1', paneId: 'main', isActive: true },
        ],
        tabPaths: { 'solid-tab-0': 'x.log', 'solid-tab-1': 'y.log' },
      });
  });
});
