/** @jsxImportSource solid-js */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { LtwEditorTab } from '@bridge/types';

// Same module boundary as EditorTab.test.tsx: the native save dialog and the
// two file commands are the only write/read path this surface has.
const readTextFile = vi.fn();
const writeTextFile = vi.fn();
const saveDialog = vi.fn();
const openDialog = vi.fn();
vi.mock('@bridge/commands', () => ({
  readTextFile: (...args: unknown[]) => readTextFile(...(args as [string])),
  writeTextFile: (...args: unknown[]) => writeTextFile(...(args as [string, string])),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => saveDialog(...args),
  open: (...args: unknown[]) => openDialog(...args),
}));

import { EditorTabs } from './EditorTabs';
import { createEditorStore } from './editorStore';
import type { EditorWorkspacePort } from './editorStore';

// See createTextEditor.test.ts / EditorTab.test.tsx — CodeMirror needs a
// Range geometry jsdom does not provide.
beforeAll(() => {
  const emptyRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
  Range.prototype.getBoundingClientRect = () => emptyRect as DOMRect;
  Range.prototype.getClientRects = () =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;
});

function makeWorkspace(): EditorWorkspacePort {
  const [pending] = createSignal<readonly LtwEditorTab[]>([]);
  return { pendingEditorTabs: pending, takePendingEditorTabs: () => [], markMutated: vi.fn() };
}

afterEach(cleanup);
beforeEach(() => {
  readTextFile.mockReset();
  writeTextFile.mockReset().mockResolvedValue(undefined);
  saveDialog.mockReset();
  openDialog.mockReset();
});

describe('EditorTabs', () => {
  it('shows the empty state with no documents open', () => {
    const store = createEditorStore({ workspace: makeWorkspace() });
    render(() => <EditorTabs store={store} />);
    expect(screen.getByText(/no document open/i)).toBeTruthy();
  });

  it('creates and focuses a new document', () => {
    const store = createEditorStore({ workspace: makeWorkspace() });
    render(() => <EditorTabs store={store} />);

    fireEvent.click(screen.getByRole('button', { name: 'New document' }));

    expect(screen.getByText('Untitled')).toBeTruthy();
    expect(store.tabs()).toHaveLength(1);
  });

  it('shows a dirty marker after an edit and clears it after Save', async () => {
    const store = createEditorStore({ workspace: makeWorkspace() });
    const id = store.newDoc();
    const { container } = render(() => <EditorTabs store={store} />);

    expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeFalsy();

    store.setContent(id, 'draft text');
    expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeTruthy();

    saveDialog.mockResolvedValue('/tmp/draft.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeTextFile).toHaveBeenCalledWith('/tmp/draft.txt', 'draft text');
    expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeFalsy();
  });

  it('Ctrl+S saves the active document', async () => {
    const store = createEditorStore({ workspace: makeWorkspace() });
    const id = store.newDoc();
    store.setContent(id, 'x');
    render(() => <EditorTabs store={store} />);

    const saveSpy = vi.spyOn(store, 'save');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    expect(saveSpy).toHaveBeenCalledWith(id);
  });

  it('does nothing on Ctrl+S when no document is open', () => {
    const store = createEditorStore({ workspace: makeWorkspace() });
    render(() => <EditorTabs store={store} />);
    const saveSpy = vi.spyOn(store, 'save');

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('switching tabs swaps the displayed document', async () => {
    const store = createEditorStore({ workspace: makeWorkspace() });
    readTextFile.mockResolvedValueOnce('AAA');
    const idA = await store.open('/tmp/a.txt');
    readTextFile.mockResolvedValueOnce('BBB');
    const idB = await store.open('/tmp/b.txt');
    // The second open focuses itself.
    expect(store.activeId()).toBe(idB);

    const { container } = render(() => <EditorTabs store={store} />);
    expect(screen.getByText('b.txt')).toBeTruthy();
    expect(container.querySelector('.cm-content')?.textContent).toBe('BBB');

    store.setActive(idA);

    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(container.querySelector('.cm-content')?.textContent).toBe('AAA');
  });
});
