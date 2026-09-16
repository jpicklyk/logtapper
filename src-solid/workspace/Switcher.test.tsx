/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { WorkspaceIdentity } from '@bridge/workspaceTypes';
import type { WorkspaceStore } from './workspaceStore';
import { Switcher } from './Switcher';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

afterEach(cleanup);

function ws(id: string, overrides: Partial<WorkspaceIdentity> = {}): WorkspaceIdentity {
  return { id, name: `Workspace ${id}`, filePath: null, dirty: false, ...overrides };
}

/** A hand-built `WorkspaceStore` double — see `WorkspaceHome.test.tsx` for why
 *  this panel is tested against a double rather than the real store. */
function fakeWorkspaceStore(opts: {
  list?: WorkspaceIdentity[];
  activeId?: string | null;
  dirty?: boolean;
  switchWorkspace?: ReturnType<typeof vi.fn>;
  saveWorkspace?: ReturnType<typeof vi.fn>;
} = {}): WorkspaceStore {
  const list = opts.list ?? [];
  const activeId = opts.activeId ?? null;
  return {
    list: () => list,
    activeId: () => activeId,
    active: () => list.find((w) => w.id === activeId) ?? null,
    dirty: () => opts.dirty ?? false,
    warnings: () => [],
    pendingEditorTabs: () => [],
    takePendingEditorTabs: vi.fn(() => []),
    markMutated: vi.fn(),
    hydrate: vi.fn(() => Promise.resolve()),
    startupRestore: vi.fn(() => Promise.resolve()),
    openWorkspace: vi.fn(() => Promise.resolve()),
    saveWorkspace: opts.saveWorkspace ?? vi.fn(() => Promise.resolve()),
    autoSave: vi.fn(() => Promise.resolve()),
    switchWorkspace: opts.switchWorkspace ?? vi.fn(() => Promise.resolve()),
    newWorkspace: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  } as unknown as WorkspaceStore;
}

/** Open the dropdown (clicking the trigger, the only button while closed) and
 *  return a query scoped to the panel — the active workspace's name is shown
 *  both on the trigger and, once open, in the recent-workspaces list. */
function openPanel(): ReturnType<typeof within> {
  fireEvent.click(screen.getByTestId('workspace-switcher').querySelector('button')!);
  return within(screen.getByTestId('workspace-switcher-panel'));
}

describe('Switcher', () => {
  it('closes the dropdown on Escape', () => {
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1' });
    render(() => <Switcher store={store} />);
    openPanel();
    expect(screen.queryByTestId('workspace-switcher-panel')).not.toBeNull();
    fireEvent.keyDown(screen.getByTestId('workspace-switcher'), { key: 'Escape' });
    expect(screen.queryByTestId('workspace-switcher-panel')).toBeNull();
  });

  it('shows the active workspace name', () => {
    const store = fakeWorkspaceStore({ list: [ws('w1', { name: 'USB plugin' })], activeId: 'w1' });
    render(() => <Switcher store={store} />);
    expect(screen.getByText('USB plugin')).toBeTruthy();
  });

  it('shows a placeholder when there is no active workspace', () => {
    render(() => <Switcher store={fakeWorkspaceStore()} />);
    expect(screen.getByText('No workspace')).toBeTruthy();
  });

  it('the dirty marker reflects store.dirty()', () => {
    const clean = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1', dirty: false });
    const { unmount } = render(() => <Switcher store={clean} />);
    expect(screen.queryByTitle('Unsaved changes')).toBeNull();
    unmount();

    const dirty = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1', dirty: true });
    render(() => <Switcher store={dirty} />);
    expect(screen.getByTitle('Unsaved changes')).toBeTruthy();
  });

  it('opens the dropdown and lists recent workspaces', () => {
    const store = fakeWorkspaceStore({
      list: [ws('w1', { name: 'Alpha' }), ws('w2', { name: 'Beta', dirty: true })],
      activeId: 'w1',
    });
    render(() => <Switcher store={store} />);
    const panel = openPanel();
    expect(panel.getByText('Alpha')).toBeTruthy();
    expect(panel.getByText('Beta')).toBeTruthy();
  });

  it('switching to a recent workspace invokes store.switchWorkspace with its id', () => {
    const switchWorkspace = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({
      list: [ws('w1', { name: 'Alpha' }), ws('w2', { name: 'Beta' })],
      activeId: 'w1',
      switchWorkspace,
    });
    render(() => <Switcher store={store} />);
    const panel = openPanel();
    fireEvent.click(panel.getByText('Beta'));
    expect(switchWorkspace).toHaveBeenCalledWith('w2');
  });

  it('switching to the already-active workspace does not call switchWorkspace', () => {
    const switchWorkspace = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({ list: [ws('w1', { name: 'Alpha' })], activeId: 'w1', switchWorkspace });
    render(() => <Switcher store={store} />);
    const panel = openPanel();
    fireEvent.click(panel.getByText('Alpha'));
    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  it('"Save" on a saved workspace invokes store.saveWorkspace with no destination', () => {
    const saveWorkspace = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({
      list: [ws('w1', { filePath: '/ws/w1.ltw' })], activeId: 'w1', saveWorkspace,
    });
    render(() => <Switcher store={store} />);
    const panel = openPanel();
    fireEvent.click(panel.getByText('Save'));
    expect(saveWorkspace).toHaveBeenCalledWith();
  });

  it('"Save" on a never-saved workspace prompts for a path like "Save As…"', async () => {
    // Without the prompt this silently auto-saves into the app-data dir: no
    // filename, no location, nothing on screen to say where it went.
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/first.ltw');
    const saveWorkspace = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1', saveWorkspace });
    render(() => <Switcher store={store} />);
    const panel = openPanel();
    fireEvent.click(panel.getByText('Save'));
    await vi.waitFor(() => expect(saveWorkspace).toHaveBeenCalledWith('/tmp/first.ltw'));
  });

  it('a cancelled prompt from "Save" on a never-saved workspace saves nothing', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce(null);
    const saveWorkspace = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1', saveWorkspace });
    render(() => <Switcher store={store} />);
    const panel = openPanel();
    fireEvent.click(panel.getByText('Save'));
    await Promise.resolve();
    expect(saveWorkspace).not.toHaveBeenCalled();
  });

  it('"Save As…" prompts the native dialog and saves to the chosen path', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/renamed.ltw');
    const saveWorkspace = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1', saveWorkspace });
    render(() => <Switcher store={store} />);
    const panel = openPanel();
    fireEvent.click(panel.getByText('Save As…'));
    await vi.waitFor(() => expect(saveWorkspace).toHaveBeenCalledWith('/tmp/renamed.ltw'));
  });

  it('a cancelled "Save As…" dialog does not call saveWorkspace', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce(null);
    const saveWorkspace = vi.fn(() => Promise.resolve());
    const store = fakeWorkspaceStore({ list: [ws('w1')], activeId: 'w1', saveWorkspace });
    render(() => <Switcher store={store} />);
    const panel = openPanel();
    fireEvent.click(panel.getByText('Save As…'));
    await Promise.resolve();
    expect(saveWorkspace).not.toHaveBeenCalled();
  });

  it('a refused save shows the error verbatim', async () => {
    const saveWorkspace = vi.fn(() => Promise.reject(new Error('CONFLICT: workspace is locked')));
    const store = fakeWorkspaceStore({
      list: [ws('w1', { filePath: '/ws/w1.ltw' })], activeId: 'w1', saveWorkspace,
    });
    render(() => <Switcher store={store} />);
    const panel = openPanel();
    fireEvent.click(panel.getByText('Save'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('CONFLICT: workspace is locked');
  });
});
