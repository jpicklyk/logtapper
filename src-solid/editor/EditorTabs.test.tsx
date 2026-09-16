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
  const [activeId] = createSignal<string | null>('ws-1');
  return { activeId, pendingEditorTabs: pending, takePendingEditorTabs: () => [], markMutated: vi.fn() };
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

    await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalledWith('/tmp/draft.txt', 'draft text'));
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

  it('leaves Ctrl+Shift+S alone even with a document open (that combo is the workspace save)', () => {
    const store = createEditorStore({ workspace: makeWorkspace() });
    const id = store.newDoc();
    store.setContent(id, 'x');
    render(() => <EditorTabs store={store} />);
    const saveSpy = vi.spyOn(store, 'save');

    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, shiftKey: true, cancelable: true });
    window.dispatchEvent(event);

    expect(saveSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does nothing on Ctrl+S when no document is open', () => {
    const store = createEditorStore({ workspace: makeWorkspace() });
    render(() => <EditorTabs store={store} />);
    const saveSpy = vi.spyOn(store, 'save');

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('renders an alert and keeps the dirty marker when Ctrl+S write rejects', async () => {
    // The store has no path, so Ctrl+S goes through the save dialog first.
    saveDialog.mockResolvedValue('/tmp/draft.txt');
    writeTextFile.mockRejectedValueOnce(new Error('disk full'));
    const store = createEditorStore({ workspace: makeWorkspace() });
    const id = store.newDoc();
    store.setContent(id, 'draft text');
    const { container } = render(() => <EditorTabs store={store} />);

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disk full'));
    expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeTruthy();
    expect(store.isDirty(id)).toBe(true);
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
