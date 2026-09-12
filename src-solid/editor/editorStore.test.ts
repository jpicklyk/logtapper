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

function makeWorkspace(initialPending: readonly LtwEditorTab[] = []): {
  port: EditorWorkspacePort;
  setPending: (tabs: readonly LtwEditorTab[]) => void;
  markMutated: ReturnType<typeof vi.fn>;
  takeSpy: ReturnType<typeof vi.fn>;
} {
  const [pending, setPending] = createSignal<readonly LtwEditorTab[]>(initialPending);
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
    port: { pendingEditorTabs: pending, takePendingEditorTabs: takeSpy, markMutated },
    setPending,
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

      expect(outcome).toBe('saved');
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
  });
});
