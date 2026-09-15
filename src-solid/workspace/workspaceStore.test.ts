// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The store is the only module here that talks to the bridge, so both bridge
// modules are mocked wholesale (the presenceStore.test.ts pattern).
const getAppStateMock = vi.fn<() => Promise<AppStateFile>>();
const saveAppStateMock = vi.fn<(s: AppStateFile) => Promise<void>>();
const loadWorkspaceV4Mock = vi.fn<(p: string) => Promise<LoadWorkspaceV4Result>>();
const saveWorkspaceV4Mock = vi.fn<(o: Record<string, unknown>) => Promise<void>>();
const autoSaveWorkspaceMock = vi.fn<(o: Record<string, unknown>) => Promise<string>>();
const beginSwitchMock = vi.fn<() => Promise<void>>();
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
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  store: Record<string, string>;
}

function makeFakes(): Fakes {
  const order: string[] = [];
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
    },
    sessions: {
      order: () => order,
      focusedId: () => order[0] ?? null,
      byId: (id) => (paths.has(id) ? { load: { filePath: paths.get(id)! } } : undefined),
    },
    actions: {
      openPath: (path) => {
        opened.push(path);
        const id = `sess-${opened.length}`;
        order.push(id);
        paths.set(id, path);
        return Promise.resolve(id);
      },
      close: (id) => {
        closed.push(id);
        const i = order.indexOf(id);
        if (i >= 0) order.splice(i, 1);
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
    const state = saveAppStateMock.mock.calls[0]![0];
    expect(state.workspaces[0]!.ltwPath).toBe('C:/ws/x.ltw');
    expect(state.workspaces[0]!.dirty).toBe(false);
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
    const store = build(makeFakes());
    await store.hydrate();
    await Promise.resolve();
    listeners.list.forEach((cb) => cb({ workspaceId: 'a', action: 'deleted' }));
    expect(store.list().map((w) => w.id)).toEqual(['b']);
    expect(store.activeId()).toBe('b');
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

  it('prefers the mirror alone when a CLI startup file won', async () => {
    getAppStateMock.mockResolvedValue(appState([entry('a', { ltwPath: 'C:/a.ltw' })], 'a'));
    startupFileMock.mockResolvedValue('D:/dropped.log');
    const fakes = makeFakes();
    fakes.store[SOLID_MIRROR_KEY] = JSON.stringify({
      activeWorkspaceId: 'a', tabPaths: ['mirrored.log'], activeTabPath: 'mirrored.log',
    });
    const store = build(fakes);
    await store.hydrate();
    await store.startupRestore();
    // The `.ltw` is not even read — the startup file is what the user asked for.
    expect(loadWorkspaceV4Mock).not.toHaveBeenCalled();
    expect(fakes.opened).toEqual(['mirrored.log']);
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
