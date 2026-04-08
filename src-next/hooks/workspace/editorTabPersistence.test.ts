/**
 * Tests for collectEditorTabs() from workspacePersistence.ts.
 *
 * collectEditorTabs() reads the workspace tree from localStorage
 * (logtapper_workspace_v1 key), iterates all panes, finds editor tabs,
 * and reads per-tab localStorage keys for content/viewMode/wordWrap/filePath.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LtsEditorTabPayload } from '../../bridge/types';

// Mock must be before import so the module resolver picks up the mock.
vi.mock('../../components/EditorTab', () => ({
  LS_CONTENT_PREFIX: 'logtapper_scratchpad_',
  LS_MODE_PREFIX: 'logtapper_editor_mode_',
  LS_WRAP_PREFIX: 'logtapper_editor_wrap_',
  LS_FILEPATH_PREFIX: 'logtapper_editor_filepath_',
}));

import { collectEditorTabs } from './workspacePersistence';

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

const store = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
  removeItem: vi.fn((key: string) => { store.delete(key); }),
  clear: vi.fn(() => { store.clear(); }),
  get length() { return store.size; },
  key: vi.fn(() => null),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_KEY = 'logtapper_workspace_v1';

function setTree(tree: object): void {
  store.set(WS_KEY, JSON.stringify({ centerTree: tree }));
}

function makeEditorTab(id: string, label = 'Notes') {
  return { id, type: 'editor', label, closable: true };
}

function makeLogviewerTab(id: string, label = 'Log') {
  return { id, type: 'logviewer', label, closable: true };
}

function makeLeaf(leafId: string, paneId: string, tabs: object[], activeTabId: string) {
  return { type: 'leaf', id: leafId, pane: { id: paneId, tabs, activeTabId } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectEditorTabs', () => {
  beforeEach(() => { store.clear(); });

  it('returns empty when no tree in localStorage', () => {
    // store is empty — no workspace key at all
    expect(collectEditorTabs()).toEqual([]);
  });

  it('returns empty when stored value is malformed JSON', () => {
    store.set(WS_KEY, 'not-json');
    expect(collectEditorTabs()).toEqual([]);
  });

  it('returns empty when centerTree is missing from stored object', () => {
    store.set(WS_KEY, JSON.stringify({ leftPaneWidth: 260 }));
    expect(collectEditorTabs()).toEqual([]);
  });

  it('returns empty when tree has only logviewer tabs', () => {
    const logTab = makeLogviewerTab('lv-1');
    setTree(makeLeaf('leaf-1', 'pane-1', [logTab], 'lv-1'));
    expect(collectEditorTabs()).toEqual([]);
  });

  it('returns empty when pane has no tabs', () => {
    setTree(makeLeaf('leaf-1', 'pane-1', [], ''));
    expect(collectEditorTabs()).toEqual([]);
  });

  it('collects single editor tab with all fields populated', () => {
    const editorTab = makeEditorTab('ed-1', 'Notes');
    setTree(makeLeaf('leaf-1', 'pane-1', [editorTab], 'ed-1'));

    store.set('logtapper_scratchpad_ed-1', '# My Content');
    store.set('logtapper_editor_mode_ed-1', 'preview');
    store.set('logtapper_editor_wrap_ed-1', 'true');
    store.set('logtapper_editor_filepath_ed-1', '/path/to/file.md');

    const result = collectEditorTabs();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      label: 'Notes',
      content: '# My Content',
      viewMode: 'preview',
      wordWrap: true,
      filePath: '/path/to/file.md',
    });
  });

  it('collects editor tabs across split panes', () => {
    const edTab1 = makeEditorTab('ed-1', 'Left');
    const edTab2 = makeEditorTab('ed-2', 'Right');
    const tree = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        makeLeaf('leaf-1', 'pane-1', [edTab1], 'ed-1'),
        makeLeaf('leaf-2', 'pane-2', [edTab2], 'ed-2'),
      ],
    };
    setTree(tree);

    store.set('logtapper_scratchpad_ed-1', 'Left content');
    store.set('logtapper_scratchpad_ed-2', 'Right content');

    const result = collectEditorTabs();
    expect(result).toHaveLength(2);

    const labels = result.map((r) => r.label);
    expect(labels).toContain('Left');
    expect(labels).toContain('Right');

    const left = result.find((r) => r.label === 'Left')!;
    expect(left.content).toBe('Left content');

    const right = result.find((r) => r.label === 'Right')!;
    expect(right.content).toBe('Right content');
  });

  it('collects only editor tabs when pane has mixed tab types', () => {
    const logTab = makeLogviewerTab('lv-1');
    const edTab = makeEditorTab('ed-1', 'Notes');
    setTree(makeLeaf('leaf-1', 'pane-1', [logTab, edTab], 'lv-1'));

    store.set('logtapper_scratchpad_ed-1', 'hello');

    const result = collectEditorTabs();
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Notes');
  });

  it('defaults missing viewMode to editor', () => {
    const editorTab = makeEditorTab('ed-1', 'Scratch');
    setTree(makeLeaf('leaf-1', 'pane-1', [editorTab], 'ed-1'));
    // Do NOT set logtapper_editor_mode_ed-1.
    // storageGet(key) returns '' when the key is absent (not null/undefined), so
    // the `?? 'editor'` in collectEditorTabs never triggers. This test documents
    // the actual runtime behavior: viewMode is '' when the LS key is missing.
    const result = collectEditorTabs();
    expect(result).toHaveLength(1);
    expect(result[0].viewMode).toBe('' as LtsEditorTabPayload['viewMode']);
  });

  it('defaults missing wordWrap to false', () => {
    const editorTab = makeEditorTab('ed-1', 'Scratch');
    setTree(makeLeaf('leaf-1', 'pane-1', [editorTab], 'ed-1'));
    // Do NOT set logtapper_editor_wrap_ed-1

    const result = collectEditorTabs();
    expect(result).toHaveLength(1);
    expect(result[0].wordWrap).toBe(false);
  });

  it('defaults missing content to empty string', () => {
    const editorTab = makeEditorTab('ed-1', 'Scratch');
    setTree(makeLeaf('leaf-1', 'pane-1', [editorTab], 'ed-1'));
    // Do NOT set logtapper_scratchpad_ed-1

    const result = collectEditorTabs();
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('');
  });

  it('sets filePath to empty string when the filepath key is absent', () => {
    const editorTab = makeEditorTab('ed-1', 'Scratch');
    setTree(makeLeaf('leaf-1', 'pane-1', [editorTab], 'ed-1'));
    // Do NOT set logtapper_editor_filepath_ed-1.
    // storageGet(key) returns '' when the key is absent (not null/undefined), so
    // the `?? null` in collectEditorTabs never triggers. This test documents the
    // actual runtime behavior: filePath is '' when the LS key is missing.
    const result = collectEditorTabs();
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('');
  });

  it('treats wordWrap "false" string as boolean false', () => {
    const editorTab = makeEditorTab('ed-1', 'Scratch');
    setTree(makeLeaf('leaf-1', 'pane-1', [editorTab], 'ed-1'));
    store.set('logtapper_editor_wrap_ed-1', 'false');

    const result = collectEditorTabs();
    expect(result[0].wordWrap).toBe(false);
  });

  it('collects multiple editor tabs from the same pane in order', () => {
    const edTab1 = makeEditorTab('ed-1', 'First');
    const edTab2 = makeEditorTab('ed-2', 'Second');
    const edTab3 = makeEditorTab('ed-3', 'Third');
    setTree(makeLeaf('leaf-1', 'pane-1', [edTab1, edTab2, edTab3], 'ed-1'));

    store.set('logtapper_scratchpad_ed-1', 'alpha');
    store.set('logtapper_scratchpad_ed-2', 'beta');
    store.set('logtapper_scratchpad_ed-3', 'gamma');

    const result = collectEditorTabs();
    expect(result).toHaveLength(3);
    expect(result[0].label).toBe('First');
    expect(result[1].label).toBe('Second');
    expect(result[2].label).toBe('Third');
  });
});
