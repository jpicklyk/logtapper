// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import type { LtwEditorTab } from '@bridge/types';

// editorStore.ts imports these at module scope even though tests inject their
// own `commands` — the real module reaches Tauri's `invoke`, which jsdom has
// no shim for, so it is mocked wholesale the way EditorTab.test.tsx does.
vi.mock('@bridge/commands', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

import { createEditorStore } from './editorStore';
import type { ConfirmClose, EditorFileCommands, EditorStoreDeps, EditorWorkspacePort } from './editorStore';

function makeWorkspace(
  initialPending: readonly LtwEditorTab[] = [],
  initialActiveId: string | null = 'ws-1',
): {
  port: EditorWorkspacePort;
  setPending: (tabs: readonly LtwEditorTab[]) => void;
  setActiveId: (id: string | null) => void;
  markMutated: ReturnType<typeof vi.fn>;
  takeSpy: ReturnType<typeof vi.fn>;
} {
  const [pending, setPending] = createSignal<readonly LtwEditorTab[]>(initialPending);
  const [activeId, setActiveId] = createSignal<string | null>(initialActiveId);
  const markMutated = vi.fn();
  // A fake `takePendingEditorTabs`: reads-then-clears imperatively, exactly
  // like the real `workspaceStore.ts` implementation — not a reactive binding.
  // eslint-disable-next-line solid/reactivity -- imperative fake of a non-reactive method
  const takeSpy = vi.fn((): LtwEditorTab[] => {
    const current = pending();
    setPending([]);
    return [...current];
  });
  return {
    port: { activeId, pendingEditorTabs: pending, takePendingEditorTabs: takeSpy, markMutated },
    setPending,
    setActiveId,
    markMutated,
    takeSpy,
  };
}

function makeCommands(content = ''): EditorFileCommands & {
  readTextFile: ReturnType<typeof vi.fn>;
  writeTextFile: ReturnType<typeof vi.fn>;
} {
  return {
    readTextFile: vi.fn(() => Promise.resolve(content)),
    writeTextFile: vi.fn(() => Promise.resolve()),
  };
}

function makeStore(overrides: Partial<EditorStoreDeps> = {}) {
  const workspace = makeWorkspace();
  const commands = makeCommands();
  const store = createEditorStore({ workspace: workspace.port, commands, ...overrides });
  return { store, workspace, commands };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEditorStore', () => {
  it('starts a new note in markdown and persists a picked language mode', () => {
    const { store } = makeStore();
    const id = store.newDoc();
    expect(store.tabs().find((d) => d.id === id)?.mode).toBe('markdown');
    store.setMode(id, 'plain');
    expect(store.tabs().find((d) => d.id === id)?.mode).toBe('plain');
  });

  it('sets the dirty flag on edit and clears it on save', async () => {
    const { store, commands } = makeStore();
    const id = store.newDoc();
    expect(store.isDirty(id)).toBe(false);

    store.setContent(id, 'hello');
    expect(store.isDirty(id)).toBe(true);

    await store.saveAs(id, '/tmp/doc.txt');
    expect(commands.writeTextFile).toHaveBeenCalledWith('/tmp/doc.txt', 'hello');
    expect(store.isDirty(id)).toBe(false);
  });

  it('calls workspace.markMutated on edit', () => {
    const { store, workspace } = makeStore();
    const id = store.newDoc();
    workspace.markMutated.mockClear();
    store.setContent(id, 'x');
    expect(workspace.markMutated).toHaveBeenCalled();
  });

  it('restores tabs from pendingEditorTabs and takes them exactly once', async () => {
    const ltw: LtwEditorTab = { label: 'notes.md', content: 'hi', viewMode: 'split', wordWrap: true, filePath: '/n.md' };
    const workspace = makeWorkspace([ltw]);
    const store = createEditorStore({ workspace: workspace.port, commands: makeCommands() });
    // The restore effect is queued, not synchronous — same as every other
    // `createEffect` store in this codebase (see `app/sessions.test.ts`).
    await Promise.resolve();

    expect(workspace.takeSpy).toHaveBeenCalledTimes(1);
    expect(store.tabs()).toHaveLength(1);
    expect(store.tabs()[0]).toMatchObject({
      label: 'notes.md',
      content: 'hi',
      savedContent: 'hi',
      viewMode: 'split',
      wordWrap: true,
      filePath: '/n.md',
    });
    // The restored doc becomes active, and the pending queue is empty again.
    expect(store.activeId()).toBe(store.tabs()[0].id);
    expect(workspace.port.pendingEditorTabs()).toHaveLength(0);
  });

  it('adopts a later restore without duplicating an earlier one', async () => {
    const workspace = makeWorkspace();
    const store = createEditorStore({ workspace: workspace.port, commands: makeCommands() });
    await Promise.resolve();
    expect(store.tabs()).toHaveLength(0);

    const ltw: LtwEditorTab = { label: 'a.md', content: 'a', viewMode: 'editor', wordWrap: false, filePath: '/a.md' };
    workspace.setPending([ltw]);
    await Promise.resolve();
    expect(store.tabs()).toHaveLength(1);
    expect(workspace.takeSpy).toHaveBeenCalledTimes(1);
  });

  it('projects open docs into LtwEditorTab[] via toLtwTabs', () => {
    const { store } = makeStore();
    const id = store.newDoc();
    store.setContent(id, 'draft');
    store.setViewMode(id, 'preview');
    store.setWordWrap(id, true);
    expect(store.toLtwTabs()).toEqual([
      { label: 'Untitled', content: 'draft', viewMode: 'preview', wordWrap: true, filePath: null },
    ]);
  });

  describe('saveAs', () => {
    it('writes to the new path and updates filePath/savedContent', async () => {
      const { store, commands } = makeStore();
      const id = store.newDoc();
      store.setContent(id, 'v1');

      await store.saveAs(id, '/dest/report.md');

      expect(commands.writeTextFile).toHaveBeenCalledWith('/dest/report.md', 'v1');
      const doc = store.tabs().find((t) => t.id === id);
      expect(doc?.filePath).toBe('/dest/report.md');
      expect(doc?.savedContent).toBe('v1');
      expect(doc?.label).toBe('report.md');
    });

    it('does nothing when the dialog is cancelled (no path resolved)', async () => {
      const { store, commands } = makeStore({ chooseSavePath: vi.fn(() => Promise.resolve(null)) });
      const id = store.newDoc();
      store.setContent(id, 'v1');

      await store.saveAs(id);

      expect(commands.writeTextFile).not.toHaveBeenCalled();
      expect(store.isDirty(id)).toBe(true);
    });
  });

  describe('open', () => {
    it('focuses an already-open path instead of duplicating it', async () => {
      const { store, commands } = makeStore();
      const first = await store.open('/log/notes.md');
      const second = await store.open('/log/notes.md');

      expect(second).toBe(first);
      expect(store.tabs()).toHaveLength(1);
      expect(commands.readTextFile).toHaveBeenCalledTimes(1);
      expect(store.activeId()).toBe(first);
    });
  });

  describe('close', () => {
    it('closes a clean document immediately without prompting', async () => {
      const { store } = makeStore();
      const id = store.newDoc();
      const confirm = vi.fn<ConfirmClose>();

      const outcome = await store.close(id, confirm);

      // 'closed', not 'saved': nothing was written (review B-L11).
      expect(outcome).toBe('closed');
      expect(confirm).not.toHaveBeenCalled();
      expect(store.tabs()).toHaveLength(0);
    });

    it('refuses to close a dirty document with no confirm callback', async () => {
      const { store } = makeStore();
      const id = store.newDoc();
      store.setContent(id, 'unsaved');

      const outcome = await store.close(id);

      expect(outcome).toBe('cancelled');
      expect(store.tabs()).toHaveLength(1);
    });

    it('keeps the document open when the confirm callback cancels', async () => {
      const { store } = makeStore();
      const id = store.newDoc();
      store.setContent(id, 'unsaved');

      const outcome = await store.close(id, async () => 'cancel');

      expect(outcome).toBe('cancelled');
      expect(store.tabs()).toHaveLength(1);
    });

    it('discards without writing when the confirm callback discards', async () => {
      const { store, commands } = makeStore();
      const id = store.newDoc();
      store.setContent(id, 'unsaved');

      const outcome = await store.close(id, async () => 'discard');

      expect(outcome).toBe('discarded');
      expect(commands.writeTextFile).not.toHaveBeenCalled();
      expect(store.tabs()).toHaveLength(0);
    });

    it('saves then closes when the confirm callback saves', async () => {
      const { store, commands } = makeStore({ chooseSavePath: vi.fn(() => Promise.resolve('/chosen.md')) });
      const id = store.newDoc();
      store.setContent(id, 'unsaved');

      const outcome = await store.close(id, async () => 'save');

      expect(outcome).toBe('saved');
      expect(commands.writeTextFile).toHaveBeenCalledWith('/chosen.md', 'unsaved');
      expect(store.tabs()).toHaveLength(0);
    });

    it('does not discard content when the Save As dialog is cancelled during a save-close', async () => {
      const { store, commands } = makeStore({ chooseSavePath: vi.fn(() => Promise.resolve(null)) });
      const id = store.newDoc();
      store.setContent(id, 'important');

      const outcome = await store.close(id, async () => 'save');

      expect(outcome).toBe('cancelled');
      expect(commands.writeTextFile).not.toHaveBeenCalled();
      expect(store.tabs()).toHaveLength(1);
      expect(store.isDirty(id)).toBe(true);
    });

    it('keeps the document open and dirty when the write rejects during a save-close', async () => {
      const commands = makeCommands();
      commands.writeTextFile.mockRejectedValueOnce(new Error('disk full'));
      const { store } = makeStore({ commands, chooseSavePath: vi.fn(() => Promise.resolve('/chosen.md')) });
      const id = store.newDoc();
      store.setContent(id, 'unsaved');

      await expect(store.close(id, async () => 'save')).rejects.toThrow('disk full');

      expect(commands.writeTextFile).toHaveBeenCalledWith('/chosen.md', 'unsaved');
      expect(store.tabs()).toHaveLength(1);
      expect(store.isDirty(id)).toBe(true);
    });
  });

  describe('workspace-switch teardown', () => {
    it('closes the outgoing workspace docs before materialising the incoming one, with no duplicates', async () => {
      const workspace = makeWorkspace([], 'ws-1');
      const store = createEditorStore({ workspace: workspace.port, commands: makeCommands() });
      await Promise.resolve();

      const tabA: LtwEditorTab = { label: 'a.md', content: 'a', viewMode: 'editor', wordWrap: false, filePath: '/a.md' };
      workspace.setPending([tabA]);
      await Promise.resolve();
      expect(store.tabs()).toHaveLength(1);

      // Switch to a new workspace — its own pending tabs arrive afterwards,
      // exactly like `workspaceStore.ts`'s `switchWorkspace` (activeId first,
      // pendingEditorTabs later after the `.ltw` load resolves).
      workspace.setActiveId('ws-2');
      await Promise.resolve();
      expect(store.tabs()).toHaveLength(0);

      const tabB: LtwEditorTab = { label: 'b.md', content: 'b', viewMode: 'editor', wordWrap: false, filePath: '/b.md' };
      const tabC: LtwEditorTab = { label: 'c.md', content: 'c', viewMode: 'editor', wordWrap: false, filePath: '/c.md' };
      workspace.setPending([tabB, tabC]);
      await Promise.resolve();

      expect(store.tabs()).toHaveLength(2);
      expect(store.tabs().map((t) => t.filePath)).toEqual(['/b.md', '/c.md']);
    });

    it('closes open docs on a switch that delivers no pending tabs', async () => {
      const workspace = makeWorkspace([], 'ws-1');
      const store = createEditorStore({ workspace: workspace.port, commands: makeCommands() });
      await Promise.resolve();
      store.newDoc();
      expect(store.tabs()).toHaveLength(1);

      workspace.setActiveId('ws-2');
      await Promise.resolve();

      expect(store.tabs()).toHaveLength(0);
      expect(store.activeId()).toBeNull();
    });

    it('does not tear down docs when the workspace id has not changed', async () => {
      const workspace = makeWorkspace([], 'ws-1');
      const store = createEditorStore({ workspace: workspace.port, commands: makeCommands() });
      await Promise.resolve();
      const id = store.newDoc();

      // Re-triggering the effect with the same id (e.g. an unrelated signal
      // update elsewhere) must not clear anything.
      workspace.setActiveId('ws-1');
      await Promise.resolve();

      expect(store.tabs()).toHaveLength(1);
      expect(store.activeId()).toBe(id);
    });

    // ── W2 handoff: a dirty doc used to be dropped here with no trace ─────
    it('writes a dirty, path-backed doc back to its file before tearing it down', async () => {
      const workspace = makeWorkspace([], 'ws-1');
      const commands = makeCommands('on disk');
      const onWorkspaceTeardown = vi.fn();
      const store = createEditorStore({ workspace: workspace.port, commands, onWorkspaceTeardown });
      await Promise.resolve();
      const id = await store.open('/notes.md');
      store.setContent(id, 'edited but not saved');
      commands.writeTextFile.mockClear();

      workspace.setActiveId('ws-2');
      await Promise.resolve();

      expect(commands.writeTextFile).toHaveBeenCalledWith('/notes.md', 'edited but not saved');
      expect(onWorkspaceTeardown).toHaveBeenCalledWith({
        saved: [expect.objectContaining({ filePath: '/notes.md' })],
        unsaved: [],
      });
      expect(store.tabs()).toHaveLength(0);
    });

    it('reports a dirty untitled doc as unsaved rather than writing it somewhere', async () => {
      const workspace = makeWorkspace([], 'ws-1');
      const commands = makeCommands();
      const onWorkspaceTeardown = vi.fn();
      const store = createEditorStore({ workspace: workspace.port, commands, onWorkspaceTeardown });
      await Promise.resolve();
      const id = store.newDoc();
      store.setContent(id, 'scratch notes');

      workspace.setActiveId('ws-2');
      await Promise.resolve();

      expect(commands.writeTextFile).not.toHaveBeenCalled();
      expect(onWorkspaceTeardown).toHaveBeenCalledWith({
        saved: [],
        unsaved: [expect.objectContaining({ filePath: null, content: 'scratch notes' })],
      });
    });

    it('does not write or report anything when every open doc is clean', async () => {
      const workspace = makeWorkspace([], 'ws-1');
      const commands = makeCommands('on disk');
      const onWorkspaceTeardown = vi.fn();
      const store = createEditorStore({ workspace: workspace.port, commands, onWorkspaceTeardown });
      await Promise.resolve();
      await store.open('/notes.md');
      commands.writeTextFile.mockClear();

      workspace.setActiveId('ws-2');
      await Promise.resolve();

      expect(commands.writeTextFile).not.toHaveBeenCalled();
      expect(onWorkspaceTeardown).not.toHaveBeenCalled();
    });
  });

  // ── B-L10 ───────────────────────────────────────────────────────────────
  describe('open', () => {
    it('focuses the tab already open at a path that differs only in case or separators', async () => {
      const { store, commands } = makeStore();
      const first = await store.open('C:\\logs\\notes.md');
      expect(commands.readTextFile).toHaveBeenCalledTimes(1);

      const second = await store.open('c:/logs/Notes.md');

      // One tab, one read — not two tabs racing to overwrite one file.
      expect(second).toBe(first);
      expect(store.tabs()).toHaveLength(1);
      expect(commands.readTextFile).toHaveBeenCalledTimes(1);
    });

    it('still opens a genuinely different path as its own tab', async () => {
      const { store } = makeStore();
      await store.open('C:\\logs\\notes.md');
      await store.open('C:\\logs\\other.md');
      expect(store.tabs()).toHaveLength(2);
    });
  });
});
