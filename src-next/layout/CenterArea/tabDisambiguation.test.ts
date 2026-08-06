// @vitest-environment jsdom
/**
 * Tests for `computeTabDisplayInfo` — the pure, tree-only same-name tab
 * disambiguation used by `CenterArea` (see `tabDisambiguation.ts`).
 *
 * jsdom environment required: `computeTabDisplayInfo` imports `allPanes` from
 * the `hooks/workspace` barrel, which transitively pulls in `useCenterTree`
 * → `components/EditorTab` → `ThemeContext` (reads `window.matchMedia` at
 * module load, unavailable in jsdom). Same fix as
 * `hooks/workspace/useCenterTree.test.ts`: mock the EditorTab module's
 * constants directly instead of importing the real (ThemeContext-reaching)
 * module.
 *
 * Otherwise mirrors the style of `hooks/workspace/tabSessionMap.test.ts`:
 * small tree factories, plain `describe`/`it` assertions.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SplitNode, Tab } from '../../hooks';

vi.mock('../../components/EditorTab', () => ({
  LS_CONTENT_PREFIX: 'logtapper_scratchpad_',
  LS_MODE_PREFIX: 'logtapper_editor_mode_',
  LS_WRAP_PREFIX: 'logtapper_editor_wrap_',
  LS_FILEPATH_PREFIX: 'logtapper_editor_filepath_',
}));

import { computeTabDisplayInfo } from './tabDisambiguation';

// ---------------------------------------------------------------------------
// Tree factories
// ---------------------------------------------------------------------------

function makeLogviewerTab(id: string, label: string, sourcePath?: string | null, sourceTotalLines?: number): Tab {
  return { id, type: 'logviewer', label, closable: true, sourcePath, sourceTotalLines };
}

/** Single-pane tree holding every given tab — sufficient since disambiguation
 *  scans the whole tree via `allPanes`, regardless of pane boundaries. */
function makeTree(tabs: Tab[]): SplitNode {
  return {
    type: 'leaf',
    id: 'leaf-1',
    pane: { id: 'pane-1', tabs, activeTabId: tabs[0]?.id ?? '' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeTabDisplayInfo', () => {
  it('appends a " — <parentDir>/" suffix to both tabs when labels collide and paths differ', () => {
    const s23 = makeLogviewerTab('tab-s23', 'dumpstate.txt', '/logs/S23/dumpstate.txt');
    const xcover6 = makeLogviewerTab('tab-xcover6', 'dumpstate.txt', '/logs/XCover6/dumpstate.txt');
    const tree = makeTree([s23, xcover6]);

    const info = computeTabDisplayInfo(tree);

    expect(info.get('tab-s23')?.label).toBe('dumpstate.txt — S23/');
    expect(info.get('tab-xcover6')?.label).toBe('dumpstate.txt — XCover6/');
  });

  it('does not disambiguate when the colliding tabs share the same sourcePath', () => {
    // e.g. a multi-session .lts import producing two tabs from one container.
    const a = makeLogviewerTab('tab-a', 'dumpstate.txt', '/logs/same/dumpstate.txt');
    const b = makeLogviewerTab('tab-b', 'dumpstate.txt', '/logs/same/dumpstate.txt');
    const tree = makeTree([a, b]);

    const info = computeTabDisplayInfo(tree);

    expect(info.get('tab-a')?.label).toBe('dumpstate.txt');
    expect(info.get('tab-b')?.label).toBe('dumpstate.txt');
  });

  it('does not disambiguate when one colliding tab has an unknown sourcePath', () => {
    // e.g. a still-loading placeholder tab alongside an already-loaded one —
    // nothing honest to disambiguate a known path against an unknown one.
    const known = makeLogviewerTab('tab-known', 'dumpstate.txt', '/logs/S23/dumpstate.txt');
    const loading = makeLogviewerTab('tab-loading', 'dumpstate.txt'); // sourcePath undefined
    const tree = makeTree([known, loading]);

    const info = computeTabDisplayInfo(tree);

    expect(info.get('tab-known')?.label).toBe('dumpstate.txt');
    expect(info.get('tab-loading')?.label).toBe('dumpstate.txt');
  });

  it('builds a "path · N,NNN lines" tooltip when both are known', () => {
    const tab = makeLogviewerTab('tab-a', 'dumpstate.txt', '/logs/S23/dumpstate.txt', 12345);
    const tree = makeTree([tab]);

    const info = computeTabDisplayInfo(tree);

    expect(info.get('tab-a')?.tooltip).toBe('/logs/S23/dumpstate.txt · 12,345 lines');
  });

  it('falls back the tooltip to the label when sourcePath is unknown', () => {
    const tab = makeLogviewerTab('tab-a', 'dumpstate.txt');
    const tree = makeTree([tab]);

    const info = computeTabDisplayInfo(tree);

    expect(info.get('tab-a')?.tooltip).toBe('dumpstate.txt');
  });

  it('tooltip omits the line count when only the path is known', () => {
    const tab = makeLogviewerTab('tab-a', 'dumpstate.txt', '/logs/S23/dumpstate.txt');
    const tree = makeTree([tab]);

    const info = computeTabDisplayInfo(tree);

    expect(info.get('tab-a')?.tooltip).toBe('/logs/S23/dumpstate.txt');
  });

  it('disambiguates all three tabs in a three-way collision with distinct paths', () => {
    const a = makeLogviewerTab('tab-a', 'dumpstate.txt', '/logs/S23/dumpstate.txt');
    const b = makeLogviewerTab('tab-b', 'dumpstate.txt', '/logs/XCover6/dumpstate.txt');
    const c = makeLogviewerTab('tab-c', 'dumpstate.txt', '/logs/Pixel8/dumpstate.txt');
    const tree = makeTree([a, b, c]);

    const info = computeTabDisplayInfo(tree);

    expect(info.get('tab-a')?.label).toBe('dumpstate.txt — S23/');
    expect(info.get('tab-b')?.label).toBe('dumpstate.txt — XCover6/');
    expect(info.get('tab-c')?.label).toBe('dumpstate.txt — Pixel8/');
  });

  it('leaves a non-colliding tab label untouched (passthrough)', () => {
    const solo = makeLogviewerTab('tab-solo', 'logcat.txt', '/logs/S23/logcat.txt');
    const other = makeLogviewerTab('tab-other', 'kernel.log', '/logs/S23/kernel.log');
    const tree = makeTree([solo, other]);

    const info = computeTabDisplayInfo(tree);

    expect(info.get('tab-solo')?.label).toBe('logcat.txt');
    expect(info.get('tab-other')?.label).toBe('kernel.log');
  });

  it('ignores non-logviewer tabs entirely, even when their labels collide', () => {
    const editorA: Tab = { id: 'tab-e1', type: 'editor', label: 'Untitled 1', closable: true };
    const editorB: Tab = { id: 'tab-e2', type: 'editor', label: 'Untitled 1', closable: true };
    const tree = makeTree([editorA, editorB]);

    const info = computeTabDisplayInfo(tree);

    expect(info.size).toBe(0);
  });

  it('returns an empty map for a tree with no tabs', () => {
    const tree = makeTree([]);
    const info = computeTabDisplayInfo(tree);
    expect(info.size).toBe(0);
  });
});
