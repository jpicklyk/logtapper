import { describe, it, expect } from 'vitest';
import { rebuildTreeSkeleton, createPaneResolver } from './restoreTreeSkeleton';
import { allPanes } from './splitTreeHelpers';
import type { SplitNode, Tab } from './workspaceTypes';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function logviewerTab(id: string, sourcePath: string | null, label = 'log'): Tab {
  return { id, type: 'logviewer', label, closable: true, sourcePath };
}

/** Mirrors `useCenterTree.openCenterTab` stamping `sourcePath` onto an
 *  editor tab created with a `filePath` (see restoreTreeSkeleton.ts's
 *  `TAB_RESTORE_STRATEGY` doc). `sourcePath: null`/omitted models an
 *  untitled (never-saved) editor tab. */
function editorTab(id: string, sourcePath: string | null, label = 'Untitled 1'): Tab {
  return { id, type: 'editor', label, closable: true, sourcePath };
}

function tab(id: string, type: Tab['type'], label: string = type): Tab {
  return { id, type, label, closable: true };
}

function leaf(paneId: string, tabs: Tab[]): SplitNode {
  return { type: 'leaf', id: `leaf-${paneId}`, pane: { id: paneId, tabs, activeTabId: tabs[0]?.id ?? '' } };
}

function split(direction: 'horizontal' | 'vertical', left: SplitNode, right: SplitNode, ratio = 0.5): SplitNode {
  return { type: 'split', id: 'split-1', direction, children: [left, right], ratio };
}

// ---------------------------------------------------------------------------
// rebuildTreeSkeleton
// ---------------------------------------------------------------------------

describe('rebuildTreeSkeleton', () => {
  it('returns null for a malformed / non-tree value (legacy .ltw without a saved tree)', () => {
    expect(rebuildTreeSkeleton(null)).toBeNull();
    expect(rebuildTreeSkeleton(undefined)).toBeNull();
    expect(rebuildTreeSkeleton('not-a-tree')).toBeNull();
    expect(rebuildTreeSkeleton({})).toBeNull();
    expect(rebuildTreeSkeleton({ type: 'split', children: [] })).toBeNull(); // wrong child count
  });

  it('rebuilds a two-pane split preserving direction, ratio and nesting, with fresh ids', () => {
    const saved = split(
      'horizontal',
      leaf('old-pane-1', [logviewerTab('t1', '/a.log')]),
      leaf('old-pane-2', [logviewerTab('t2', '/b.log')]),
      0.35,
    );

    const skeleton = rebuildTreeSkeleton(saved)!;
    expect(skeleton).not.toBeNull();
    expect(skeleton.tree.type).toBe('split');
    if (skeleton.tree.type !== 'split') throw new Error('unreachable');
    expect(skeleton.tree.direction).toBe('horizontal');
    expect(skeleton.tree.ratio).toBe(0.35);
    expect(skeleton.tree.id).not.toBe('split-1');

    const newPanes = allPanes(skeleton.tree);
    expect(newPanes).toHaveLength(2);
    // Every leaf got a fresh pane id, distinct from both saved ids.
    for (const p of newPanes) {
      expect(p.id).not.toBe('old-pane-1');
      expect(p.id).not.toBe('old-pane-2');
    }
    // logviewer tabs are dropped from the rebuilt tree — panes start empty.
    expect(newPanes.every((p) => p.tabs.length === 0)).toBe(true);
  });

  it('maps every old pane id to a fresh new pane id', () => {
    const saved = split('vertical', leaf('old-1', []), leaf('old-2', []));
    const skeleton = rebuildTreeSkeleton(saved)!;

    expect(skeleton.paneIdMap.size).toBe(2);
    expect(skeleton.paneIdMap.has('old-1')).toBe(true);
    expect(skeleton.paneIdMap.has('old-2')).toBe(true);
    expect(skeleton.paneIdMap.get('old-1')).not.toBe(skeleton.paneIdMap.get('old-2'));
  });

  it('records a placement per dropped logviewer tab, keyed by sourcePath and the old pane id', () => {
    const saved = split(
      'horizontal',
      leaf('old-1', [logviewerTab('t1', '/device-a/dumpstate.txt')]),
      leaf('old-2', [logviewerTab('t2', '/device-b/dumpstate.txt')]),
    );
    const skeleton = rebuildTreeSkeleton(saved)!;

    expect(skeleton.placements).toHaveLength(2);
    const p1 = skeleton.placements.find((p) => p.sourcePath === '/device-a/dumpstate.txt')!;
    const p2 = skeleton.placements.find((p) => p.sourcePath === '/device-b/dumpstate.txt')!;
    expect(p1.oldPaneId).toBe('old-1');
    expect(p2.oldPaneId).toBe('old-2');
    expect(p1.newPaneId).toBe(skeleton.paneIdMap.get('old-1'));
    expect(p2.newPaneId).toBe(skeleton.paneIdMap.get('old-2'));
    expect(p1.newPaneId).not.toBe(p2.newPaneId);
  });

  it('carries dashboard and analysis tabs over directly (fresh tab id, same pane)', () => {
    const saved = leaf('old-1', [tab('d1', 'dashboard'), tab('a1', 'analysis')]);
    const skeleton = rebuildTreeSkeleton(saved)!;

    const [pane] = allPanes(skeleton.tree);
    expect(pane.tabs.map((t) => t.type).sort()).toEqual(['analysis', 'dashboard']);
    // Fresh tab ids — not copies of the saved ones.
    expect(pane.tabs.some((t) => t.id === 'd1')).toBe(false);
    expect(pane.tabs.some((t) => t.id === 'a1')).toBe(false);
    expect(pane.activeTabId).toBe(pane.tabs[0].id);
    // No placement recorded for carried-over types — they're already placed.
    expect(skeleton.placements).toHaveLength(0);
  });

  it('drops editor tabs from the rebuilt leaf but records a placement for them (matched by filePath, mirroring logviewer)', () => {
    const saved = leaf('old-1', [editorTab('e1', '/notes/scratch.md')]);
    const skeleton = rebuildTreeSkeleton(saved)!;

    const [pane] = allPanes(skeleton.tree);
    // Not copied into the skeleton — content is replayed separately via
    // buildEditorTabEvents (LtwEditorTab.content), not this structural tree.
    expect(pane.tabs).toHaveLength(0);

    expect(skeleton.placements).toHaveLength(1);
    expect(skeleton.placements[0]).toMatchObject({
      type: 'editor',
      oldPaneId: 'old-1',
      newPaneId: skeleton.paneIdMap.get('old-1'),
      sourcePath: '/notes/scratch.md',
    });
  });

  it('records a null-sourcePath placement for an untitled (never-saved) editor tab', () => {
    const saved = leaf('old-1', [editorTab('e1', null)]);
    const skeleton = rebuildTreeSkeleton(saved)!;

    expect(skeleton.placements).toHaveLength(1);
    expect(skeleton.placements[0].sourcePath).toBeNull();
  });

  it('covers every CenterTabType exhaustively (compile-time guard doc: TAB_RESTORE_STRATEGY)', () => {
    // logviewer + editor -> placement (dropped, recorded); dashboard + analysis -> carryOver (kept).
    const saved = leaf('old-1', [
      logviewerTab('lv', '/a.log'),
      editorTab('ed', '/b.md'),
      tab('db', 'dashboard'),
      tab('an', 'analysis'),
    ]);
    const skeleton = rebuildTreeSkeleton(saved)!;

    const [pane] = allPanes(skeleton.tree);
    expect(pane.tabs.map((t) => t.type).sort()).toEqual(['analysis', 'dashboard']);
    expect(skeleton.placements.map((p) => p.type).sort()).toEqual(['editor', 'logviewer']);
  });

  it('a single-leaf (unsplit) saved tree rebuilds to a single fresh empty leaf', () => {
    const saved = leaf('old-1', [logviewerTab('t1', '/a.log')]);
    const skeleton = rebuildTreeSkeleton(saved)!;

    expect(skeleton.tree.type).toBe('leaf');
    if (skeleton.tree.type !== 'leaf') throw new Error('unreachable');
    expect(skeleton.tree.pane.id).not.toBe('old-1');
    expect(skeleton.tree.pane.tabs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createPaneResolver
// ---------------------------------------------------------------------------

describe('createPaneResolver', () => {
  it('resolves a session to its remapped pane by stable sourcePath, even though every pane id changed', () => {
    const saved = split(
      'horizontal',
      leaf('old-1', [logviewerTab('t1', '/device-a/dumpstate.txt')]),
      leaf('old-2', [logviewerTab('t2', '/device-b/dumpstate.txt')]),
    );
    const skeleton = rebuildTreeSkeleton(saved)!;
    const resolver = createPaneResolver(skeleton);

    const target = resolver.resolve({ sourcePath: '/device-b/dumpstate.txt' });
    expect(target).toBe(skeleton.paneIdMap.get('old-2'));
    expect(target).not.toBe('old-2');
  });

  it('is case/separator insensitive when matching sourcePath (normalizePath)', () => {
    const saved = leaf('old-1', [logviewerTab('t1', 'C:\\Logs\\Device\\dumpstate.txt')]);
    const skeleton = rebuildTreeSkeleton(saved)!;
    const resolver = createPaneResolver(skeleton);

    expect(resolver.bySourcePath('c:/logs/device/dumpstate.txt')).toBe(skeleton.paneIdMap.get('old-1'));
  });

  it('falls back to the old-pane-id remap when there is no sourcePath match', () => {
    const saved = leaf('old-1', [logviewerTab('t1', null)]); // e.g. an ADB stream tab
    const skeleton = rebuildTreeSkeleton(saved)!;
    const resolver = createPaneResolver(skeleton);

    expect(resolver.resolve({ sourcePath: '/unrelated.log', oldPaneId: 'old-1' })).toBe(skeleton.paneIdMap.get('old-1'));
  });

  it('returns null when neither a sourcePath nor an old-pane-id match exists', () => {
    const saved = leaf('old-1', [logviewerTab('t1', '/a.log')]);
    const skeleton = rebuildTreeSkeleton(saved)!;
    const resolver = createPaneResolver(skeleton);

    expect(resolver.resolve({ sourcePath: '/never-saved.log', oldPaneId: 'never-existed' })).toBeNull();
  });

  it('claims a placement at most once — a second load for the same sourcePath does not double-match', () => {
    const saved = leaf('old-1', [logviewerTab('t1', '/a.log')]);
    const skeleton = rebuildTreeSkeleton(saved)!;
    const resolver = createPaneResolver(skeleton);

    expect(resolver.bySourcePath('/a.log')).toBe(skeleton.paneIdMap.get('old-1'));
    expect(resolver.bySourcePath('/a.log')).toBeNull();
  });

  it('resolves an editor tab to its remapped pane by filePath, via type: "editor"', () => {
    const saved = split(
      'horizontal',
      leaf('old-1', [logviewerTab('t1', '/shared-name.txt')]),
      leaf('old-2', [editorTab('e1', '/shared-name.txt')]),
    );
    const skeleton = rebuildTreeSkeleton(saved)!;
    const resolver = createPaneResolver(skeleton);

    // Same path, different tab types — must not cross-match: the editor tab
    // resolves to its own pane, not the logviewer's, and vice versa.
    expect(resolver.resolve({ sourcePath: '/shared-name.txt', type: 'editor' })).toBe(skeleton.paneIdMap.get('old-2'));
    expect(resolver.resolve({ sourcePath: '/shared-name.txt', type: 'logviewer' })).toBe(skeleton.paneIdMap.get('old-1'));
  });

  it('an editor tab with no known filePath (untitled) has no sourcePath to match on', () => {
    const saved = leaf('old-1', [editorTab('e1', null)]);
    const skeleton = rebuildTreeSkeleton(saved)!;
    const resolver = createPaneResolver(skeleton);

    expect(resolver.bySourcePath(null, 'editor')).toBeNull();
    expect(resolver.resolve({ sourcePath: null, type: 'editor' })).toBeNull();
  });
});
