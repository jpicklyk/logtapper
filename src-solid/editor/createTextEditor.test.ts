import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTextEditor } from './createTextEditor';
import type { TextEditorHandle } from './createTextEditor';

/**
 * CodeMirror measures with `Range.getClientRects()`, which jsdom implements as a
 * stub returning `undefined` — enough to construct an `EditorView`, but not to
 * measure. The shim below gives it an empty-but-valid geometry so the view can
 * be created and dispatched to; nothing in these tests depends on real layout.
 */
beforeAll(() => {
  const emptyRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
  Range.prototype.getBoundingClientRect = () => emptyRect as DOMRect;
  Range.prototype.getClientRects = () =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;
});

let handle: TextEditorHandle | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  handle?.dispose();
  handle = undefined;
  host?.remove();
  host = undefined;
});

function mount(options: Partial<Parameters<typeof createTextEditor>[0]> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  handle = createTextEditor({ parent: host, ...options });
  return handle;
}

describe('createTextEditor', () => {
  it('mounts a CodeMirror view into the given parent', () => {
    const editor = mount({ doc: 'hello' });
    expect(host!.querySelector('.cm-editor')).toBeTruthy();
    expect(editor.view.dom.isConnected).toBe(true);
  });

  it('round-trips the document through getValue/setValue', () => {
    const editor = mount({ doc: 'first' });
    expect(editor.getValue()).toBe('first');
    editor.setValue('second');
    expect(editor.getValue()).toBe('second');
    expect(editor.view.state.doc.toString()).toBe('second');
  });

  it('starts clean and goes dirty on an edit', () => {
    const editor = mount({ doc: 'a' });
    expect(editor.isDirty()).toBe(false);
    editor.view.dispatch({ changes: { from: 1, insert: 'b' } });
    expect(editor.getValue()).toBe('ab');
    expect(editor.isDirty()).toBe(true);
  });

  it('markSaved clears dirty; a later edit sets it again', () => {
    const editor = mount({ doc: 'a' });
    editor.view.dispatch({ changes: { from: 1, insert: 'b' } });
    editor.markSaved();
    expect(editor.isDirty()).toBe(false);
    editor.view.dispatch({ changes: { from: 2, insert: 'c' } });
    expect(editor.isDirty()).toBe(true);
  });

  it('setValue marks saved by default and can be told not to', () => {
    const editor = mount({ doc: 'a' });
    editor.setValue('loaded from disk');
    expect(editor.isDirty()).toBe(false);
    editor.setValue('programmatic edit', { markSaved: false });
    expect(editor.isDirty()).toBe(true);
  });

  it('notifies the constructor listener and every subscriber on a doc change', () => {
    const initial = vi.fn();
    const editor = mount({ doc: '', onChange: initial });
    const extra = vi.fn();
    const off = editor.onChange(extra);

    editor.view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(initial).toHaveBeenCalledWith('x');
    expect(extra).toHaveBeenCalledWith('x');

    off();
    editor.view.dispatch({ changes: { from: 1, insert: 'y' } });
    expect(extra).toHaveBeenCalledTimes(1);
    expect(initial).toHaveBeenCalledTimes(2);
  });

  it('switches modes and keeps the document', () => {
    const editor = mount({ doc: '# heading\n\ntext', mode: 'plain' });
    expect(editor.getMode()).toBe('plain');
    editor.setMode('markdown');
    expect(editor.getMode()).toBe('markdown');
    expect(editor.getValue()).toBe('# heading\n\ntext');
    editor.setMode('plain');
    expect(editor.getMode()).toBe('plain');
  });

  it('defaults line wrapping on in markdown mode and off in plain mode', () => {
    const markdown = mount({ mode: 'markdown' });
    expect(markdown.view.dom.querySelector('.cm-lineWrapping')).toBeTruthy();
    markdown.dispose();

    const plain = mount({ mode: 'plain' });
    expect(plain.view.dom.querySelector('.cm-lineWrapping')).toBeFalsy();
  });

  it('honours readOnly and can toggle it', () => {
    const editor = mount({ doc: 'x', readOnly: true });
    expect(editor.view.state.readOnly).toBe(true);
    editor.setReadOnly(false);
    expect(editor.view.state.readOnly).toBe(false);
  });

  it('dispose removes the view and unsubscribes listeners', () => {
    const editor = mount({ doc: 'x' });
    const listener = vi.fn();
    editor.onChange(listener);
    const dom = editor.view.dom;
    editor.dispose();
    handle = undefined;
    expect(dom.isConnected).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
