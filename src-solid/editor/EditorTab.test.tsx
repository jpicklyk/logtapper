/** @jsxImportSource solid-js */
import { createSignal } from 'solid-js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { EditorView } from '@codemirror/view';

// Both mocked at the module boundary the React EditorTab uses too: the native
// save dialog and the `write_text_file` command wrapper. No other write path.
const save = vi.fn();
const writeTextFile = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...args: unknown[]) => save(...args) }));
vi.mock('@bridge/commands', () => ({
  writeTextFile: (...args: unknown[]) => writeTextFile(...args),
}));

import { EditorTab, basename, modeForPath } from './EditorTab';

// See createTextEditor.test.ts — CodeMirror needs a Range geometry in jsdom.
beforeAll(() => {
  const emptyRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
  Range.prototype.getBoundingClientRect = () => emptyRect as DOMRect;
  Range.prototype.getClientRects = () =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;
});

afterEach(cleanup);
beforeEach(() => {
  save.mockReset();
  writeTextFile.mockReset();
  writeTextFile.mockResolvedValue(undefined);
});

/**
 * Type into the mounted CodeMirror view. The tab does not expose its handle, so
 * the view is recovered from the DOM the way any outside code would.
 */
function typeInEditor(container: Element, text: string) {
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement);
  if (!view) throw new Error('no CodeMirror view mounted');
  view.dispatch({ changes: { from: 0, to: 0, insert: text } });
}

describe('basename / modeForPath', () => {
  it('takes the last segment of either separator', () => {
    expect(basename('C:\\notes\\readme.md')).toBe('readme.md');
    expect(basename('/tmp/a/b.txt')).toBe('b.txt');
    expect(basename('bare')).toBe('bare');
  });

  it('picks markdown mode only for markdown extensions', () => {
    expect(modeForPath('notes.md')).toBe('markdown');
    expect(modeForPath('NOTES.MARKDOWN')).toBe('markdown');
    expect(modeForPath('log.txt')).toBe('plain');
    expect(modeForPath(null)).toBe('plain');
  });
});

describe('EditorTab', () => {
  it('titles the tab from the filename and shows Untitled without one', () => {
    const { unmount } = render(() => <EditorTab filePath="/tmp/notes.md" content="# hi" />);
    expect(screen.getByText('notes.md')).toBeTruthy();
    unmount();
    render(() => <EditorTab />);
    expect(screen.getByText('Untitled')).toBeTruthy();
  });

  it('opens a .md file in markdown mode with the preview beside the editor', () => {
    const { container } = render(() => (
      <EditorTab filePath="/tmp/notes.md" content="# heading" />
    ));
    expect(container.querySelector('[data-split="true"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="markdown"] h1')?.textContent).toBe('heading');
  });

  it('opens a .txt file in plain mode with no preview', () => {
    const { container } = render(() => <EditorTab filePath="/tmp/a.txt" content="plain" />);
    expect(container.querySelector('[data-split="true"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="markdown"]')).toBeFalsy();
  });

  it('switching the mode toggle to markdown reveals the preview', () => {
    const { container } = render(() => <EditorTab filePath="/tmp/a.txt" content="# x" />);
    fireEvent.change(container.querySelector('select')!, { target: { value: 'markdown' } });
    expect(container.querySelector('[data-testid="markdown"] h1')?.textContent).toBe('x');
  });

  it('keeps a picked mode when a controlling store echoes the content back', () => {
    // W9 passes `content` from its store; every keystroke round-trips through
    // it. That echo must not reset a mode the user chose in the select.
    const [content, setContent] = createSignal('# x');
    const onModeChanged = vi.fn();
    const { container } = render(() => (
      <EditorTab filePath={null} content={content()} mode="plain" onModeChanged={onModeChanged} />
    ));
    fireEvent.change(container.querySelector('select')!, { target: { value: 'markdown' } });
    expect(onModeChanged).toHaveBeenCalledWith('markdown');
    setContent('# x\n\nmore');
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('markdown');
    expect(container.querySelector('[data-testid="markdown"] h1')?.textContent).toBe('x');
  });

  it('goes dirty on an edit and clean again after Save', async () => {
    const onDirtyChanged = vi.fn();
    const { container } = render(() => (
      <EditorTab filePath="/tmp/a.txt" content="body" onDirtyChanged={onDirtyChanged} />
    ));
    expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeFalsy();

    typeInEditor(container, 'edited ');
    expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeTruthy();
    expect(onDirtyChanged).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(writeTextFile).toHaveBeenCalledWith('/tmp/a.txt', 'edited body');
    expect(save).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeFalsy();
    expect(onDirtyChanged).toHaveBeenLastCalledWith(false);
  });

  it('Save on a document with no path falls through to the save dialog', async () => {
    save.mockResolvedValue('/tmp/new.txt');
    const onFilePathChanged = vi.fn();
    render(() => <EditorTab content="scratch" onFilePathChanged={onFilePathChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ defaultPath: 'Untitled' });
    expect(writeTextFile).toHaveBeenCalledWith('/tmp/new.txt', 'scratch');
    expect(onFilePathChanged).toHaveBeenCalledWith('/tmp/new.txt');
    expect(screen.getByText('new.txt')).toBeTruthy();
  });

  it('Save As calls the dialog with the text-file filters and retitles the tab', async () => {
    save.mockResolvedValue('/tmp/renamed.md');
    render(() => <EditorTab filePath="/tmp/old.md" content="x" />);

    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(save.mock.calls[0][0]).toMatchObject({
      defaultPath: '/tmp/old.md',
      filters: [
        { name: 'Text Files', extensions: ['yaml', 'yml', 'md', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    expect(writeTextFile).toHaveBeenCalledWith('/tmp/renamed.md', 'x');
    expect(screen.getByText('renamed.md')).toBeTruthy();
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    save.mockResolvedValue(null);
    render(() => <EditorTab content="scratch" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
