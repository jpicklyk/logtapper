/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import type { WorkspaceIdentity } from '@bridge/workspaceTypes';
import type { AppActions, SessionEntry, SessionStore } from '../app/index';
import type { LiveStreamStore } from '../stream';
import type { WorkspaceStore } from './workspaceStore';
import { WorkspaceHome } from './WorkspaceHome';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

afterEach(cleanup);
beforeEach(() => {
  window.localStorage.clear();
});

function ws(id: string, overrides: Partial<WorkspaceIdentity> = {}): WorkspaceIdentity {
  return { id, name: `Workspace ${id}`, filePath: null, dirty: false, ...overrides };
}

/** A hand-built `WorkspaceStore` double — this panel is tested as a renderer
 *  over the store's public surface, not against the real store (that is
 *  `workspaceStore.test.ts`'s job). */
function fakeWorkspaceStore(opts: {
  list?: WorkspaceIdentity[];
  activeId?: string | null;
  dirty?: boolean;
  rename?: ReturnType<typeof vi.fn>;
  remove?: ReturnType<typeof vi.fn>;
  warnings?: () => readonly string[];
  clearWarnings?: ReturnType<typeof vi.fn>;
} = {}): WorkspaceStore {
  const list = opts.list ?? [];
  const activeId = opts.activeId ?? null;
  return {
    list: () => list,
    activeId: () => activeId,
    active: () => list.find((w) => w.id === activeId) ?? null,
    dirty: () => opts.dirty ?? false,
    warnings: opts.warnings ?? (() => []),
    clearWarnings: opts.clearWarnings ?? vi.fn(),
    pendingEditorTabs: () => [],
    takePendingEditorTabs: vi.fn(() => []),
    markMutated: vi.fn(),
    hydrate: vi.fn(() => Promise.resolve()),
    startupRestore: vi.fn(() => Promise.resolve()),
    openWorkspace: vi.fn(() => Promise.resolve()),
    saveWorkspace: vi.fn(() => Promise.resolve()),
    autoSave: vi.fn(() => Promise.resolve()),
    switchWorkspace: vi.fn(() => Promise.resolve()),
    newWorkspace: vi.fn(() => Promise.resolve()),
    rename: opts.rename ?? vi.fn(() => Promise.resolve()),
    delete: opts.remove ?? vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  } as unknown as WorkspaceStore;
}

function fakeSessions(overrides: { order?: string[]; entries?: Record<string, SessionEntry>; focusedId?: string | null } = {}): SessionStore {
  const order = overrides.order ?? [];
  const entries = overrides.entries ?? {};
  return {
    order: () => order,
    focusedId: () => overrides.focusedId ?? null,
    byId: (id: string) => entries[id],
  } as unknown as SessionStore;
}

function sessionEntry(sourceName: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    load: { sessionId: sourceName, sourceName, filePath: null },
    totalLines: 100,
    isIndexing: false,
    kind: 'file',
    ...overrides,
  } as unknown as SessionEntry;
}

function fakeActions(overrides: Partial<AppActions> = {}): AppActions {
  return {
    openPath: vi.fn(() => Promise.resolve('s1')),
    openFileDialog: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
    reportError: vi.fn(),
    busy: () => false,
    error: () => '',
    ...overrides,
  } as unknown as AppActions;
}

/** A hand-built `LiveStreamStore` double, mirroring
 *  `StreamControlsPanel.test.tsx`'s own fake — WorkspaceHome only needs to
 *  prove it wires the real panel through unchanged, not re-verify the
 *  panel's own behavior. `devices`/`devicesError` cover the no-device and
 *  no-`adb` branches this task must render correctly. */
function fakeLiveStreamStore(
  overrides: { devices?: unknown[]; devicesError?: string | null } = {},
): LiveStreamStore {
  return {
    status: () => ({ phase: 'idle' }),
    active: () => false,
    devices: () => overrides.devices ?? [],
    devicesLoading: () => false,
    devicesError: () => overrides.devicesError ?? null,
    refreshDevices: vi.fn(() => Promise.resolve()),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    stopIfCurrent: vi.fn(() => Promise.resolve()),
    setAnonymize: vi.fn(() => Promise.resolve()),
    updateProcessors: vi.fn(() => Promise.resolve()),
    updateTrackers: vi.fn(() => Promise.resolve()),
    updateTransformers: vi.fn(() => Promise.resolve()),
    resolvePackagePids: vi.fn(() => Promise.resolve([])),
    saveCapture: vi.fn(() => Promise.resolve(0)),
    dispose: vi.fn(),
  } as unknown as LiveStreamStore;
}

describe('WorkspaceHome', () => {
  it('renders the bookmarks and analyses slots as sections of the pane', () => {
    render(() => (
      <WorkspaceHome
        store={fakeWorkspaceStore()}
        sessions={fakeSessions()}
        actions={fakeActions()}
        liveStream={fakeLiveStreamStore()}
        bookmarks={<div data-testid="bm-slot" />}
        analyses={<div data-testid="an-slot" />}
      />
    ));
    expect(screen.getByTestId('workspace-bookmarks').contains(screen.getByTestId('bm-slot'))).toBe(true);
    const analyses = screen.getByTestId('workspace-analyses');
    expect(analyses.contains(screen.getByTestId('an-slot'))).toBe(true);
    expect(within(analyses).getByText('Analyses')).toBeTruthy();
  });

  it('shows the empty state when there are no workspaces yet', () => {
    render(() => <WorkspaceHome store={fakeWorkspaceStore()} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);
    expect(screen.getByText(/no workspaces yet/i)).toBeTruthy();
  });

  it('renders restore warnings with the missing file named, and dismisses through the store', () => {
    const clearWarnings = vi.fn();
    const store = fakeWorkspaceStore({
      list: [ws('w1')],
      activeId: 'w1',
      warnings: () => ['Failed to reopen "E:/usb/gone.log": Error: os error 3'],
      clearWarnings,
    });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);
    const notice = screen.getByTestId('restore-warnings');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('Part of this workspace could not be restored');
    expect(notice.textContent).toContain('E:/usb/gone.log');
    // Tells the user why: the workspace links to the file, only .lts embeds it.
    expect(notice.textContent).toMatch(/links to its log files/);
    fireEvent.click(screen.getByLabelText('Dismiss restore warnings'));
    expect(clearWarnings).toHaveBeenCalledTimes(1);
  });

  it('renders no warning block when the last restore was clean', () => {
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);
    expect(screen.queryByTestId('restore-warnings')).toBeNull();
  });

  it('shows the empty state when the active workspace has no sessions', () => {
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);
    expect(screen.getByText(/no sessions in this workspace/i)).toBeTruthy();
  });

  it('grid and list views render the same workspace set', () => {
    const list = [ws('w1', { name: 'Alpha' }), ws('w2', { name: 'Beta' })];
    const store = fakeWorkspaceStore({ list, activeId: 'w1' });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);

    // Default view is grid.
    const grid = within(screen.getByTestId('workspace-grid'));
    expect(grid.getAllByTestId('workspace-card')).toHaveLength(2);
    expect(grid.getByText('Alpha')).toBeTruthy();
    expect(grid.getByText('Beta')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'List' }));

    const listView = within(screen.getByTestId('workspace-list'));
    expect(listView.getAllByTestId('workspace-card')).toHaveLength(2);
    expect(listView.getByText('Alpha')).toBeTruthy();
    expect(listView.getByText('Beta')).toBeTruthy();
  });

  it('persists the grid/list choice across remounts', () => {
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
    const { unmount } = render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByTestId('workspace-list')).toBeTruthy();
    unmount();

    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);
    expect(screen.getByTestId('workspace-list')).toBeTruthy();
  });

  it('renaming a workspace calls store.rename with the workspace id and new name', () => {
    const rename = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({ list: [ws('w1', { name: 'Old name' })], activeId: 'w1', rename });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);

    fireEvent.click(screen.getByTitle('Rename workspace'));
    const input = screen.getByLabelText('Rename Old name') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(rename).toHaveBeenCalledWith('w1', 'New name');
  });

  it('deleting a workspace requires a confirm click, then calls store.delete with the workspace id', () => {
    const remove = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1', remove });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);

    fireEvent.click(screen.getByTitle('Delete workspace'));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm'));

    expect(remove).toHaveBeenCalledWith('w1', { deleteFile: false, force: true });
  });

  it('deleting a non-active workspace does not force-close it', () => {
    const remove = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({ list: [ws('w1'), ws('w2')], activeId: 'w1', remove });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);

    const deleteButtons = screen.getAllByTitle('Delete workspace');
    fireEvent.click(deleteButtons[1]);
    fireEvent.click(screen.getByText('Confirm'));

    expect(remove).toHaveBeenCalledWith('w2', { deleteFile: false, force: false });
  });

  it('checking "Also delete .ltw" passes deleteFile:true through to store.delete', () => {
    const remove = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1', remove });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);

    fireEvent.click(screen.getByTitle('Delete workspace'));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Confirm'));

    expect(remove).toHaveBeenCalledWith('w1', { deleteFile: true, force: true });
  });

  it('shows a refused delete error verbatim', async () => {
    const remove = vi.fn(() => Promise.reject(new Error('NOT_ALLOWED: outside the allowlist')));
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1', remove });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);

    fireEvent.click(screen.getByTitle('Delete workspace'));
    fireEvent.click(screen.getByText('Confirm'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('NOT_ALLOWED: outside the allowlist');
  });

  it('lists the active workspace\'s sessions with kind, line count and a focused marker', () => {
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
    const sessions = fakeSessions({
      order: ['s1', 's2'],
      entries: {
        s1: sessionEntry('dumpstate.log', { totalLines: 1200, kind: 'file' }),
        s2: sessionEntry('logcat_live', { totalLines: 42, kind: 'live' }),
      },
      focusedId: 's2',
    });
    render(() => <WorkspaceHome store={store} sessions={sessions} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);

    const rows = screen.getAllByTestId('session-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('dumpstate.log');
    expect(rows[0].textContent).toContain('1,200 lines');
    expect(rows[1].textContent).toContain('logcat_live');
    expect(rows[1].textContent).toContain('Focused');
  });

  it('focus/close buttons on a session row route through the app actions', () => {
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
    const sessions = fakeSessions({ order: ['s1'], entries: { s1: sessionEntry('a.log') } });
    const actions = fakeActions();
    render(() => <WorkspaceHome store={store} sessions={sessions} actions={actions} liveStream={fakeLiveStreamStore()} />);

    fireEvent.click(screen.getByText('Focus'));
    expect(actions.focus).toHaveBeenCalledWith('s1');

    fireEvent.click(screen.getByText('Close'));
    expect(actions.close).toHaveBeenCalledWith('s1');
  });

  it('"New workspace" calls store.newWorkspace', () => {
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);
    fireEvent.click(screen.getByText('New workspace'));
    expect(store.newWorkspace).toHaveBeenCalled();
  });

  it('clicking a recent workspace card switches to it', () => {
    const store = fakeWorkspaceStore({ list: [ws('w1'), ws('w2', { name: 'Other' })], activeId: 'w1' });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);
    fireEvent.click(screen.getByText('Other'));
    expect(store.switchWorkspace).toHaveBeenCalledWith('w2');
  });

  it('clicking the already-active card does not call switchWorkspace', () => {
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />);
    fireEvent.click(screen.getByTestId('workspace-card'));
    expect(store.switchWorkspace).not.toHaveBeenCalled();
  });

  it('"Open file…" in the sessions empty state routes through the app actions', async () => {
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
    const actions = fakeActions();
    render(() => <WorkspaceHome store={store} sessions={fakeSessions()} actions={actions} liveStream={fakeLiveStreamStore()} />);
    fireEvent.click(screen.getByTestId('sessions-empty-open-file'));
    await waitFor(() => expect(actions.openFileDialog).toHaveBeenCalled());
  });

  describe('first-run attach', () => {
    it('offers both ways in and keeps the device picker collapsed by default', () => {
      const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
      render(() => (
        <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={fakeLiveStreamStore()} />
      ));

      expect(screen.getByTestId('workspace-first-run')).toBeTruthy();
      expect(screen.getByTestId('attach-device-toggle')).toBeTruthy();
      expect(screen.getByTestId('sessions-empty-open-file')).toBeTruthy();
      expect(screen.queryByTestId('workspace-attach-panel')).toBeNull();
      expect(screen.queryByTestId('stream-controls')).toBeNull();
    });

    it('"Attach a device" reveals L1\'s picker and does not build a second one', () => {
      const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
      const liveStream = fakeLiveStreamStore();
      render(() => (
        <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={liveStream} />
      ));

      fireEvent.click(screen.getByTestId('attach-device-toggle'));

      expect(screen.getByTestId('workspace-attach-panel')).toBeTruthy();
      // Real `StreamControlsPanel` markup, not a re-implementation — and it
      // drives the exact store instance this panel was handed.
      expect(screen.getByTestId('stream-controls')).toBeTruthy();
      expect(liveStream.refreshDevices).toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('attach-device-toggle'));
      expect(screen.queryByTestId('workspace-attach-panel')).toBeNull();
    });

    it('shows the ordinary no-device hint when a device is connected but adb finds none', () => {
      const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
      const liveStream = fakeLiveStreamStore({ devices: [] });
      render(() => (
        <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={liveStream} />
      ));

      fireEvent.click(screen.getByTestId('attach-device-toggle'));

      expect(screen.getByText(/no devices found/i)).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('surfaces a missing-adb failure as the picker\'s own error text, not a crash', () => {
      const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
      const liveStream = fakeLiveStreamStore({
        devices: [],
        devicesError: "Failed to launch 'adb': program not found",
      });
      render(() => (
        <WorkspaceHome store={store} sessions={fakeSessions()} actions={fakeActions()} liveStream={liveStream} />
      ));

      fireEvent.click(screen.getByTestId('attach-device-toggle'));

      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('program not found');
    });
  });
});
