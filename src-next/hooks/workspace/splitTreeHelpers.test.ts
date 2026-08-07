import { describe, it, expect } from 'vitest';
import { collapseEmptyLeaves, allPanes } from './splitTreeHelpers';
import type { SplitNode, Tab } from './workspaceTypes';

function tab(id: string): Tab {
  return { id, type: 'logviewer', label: 'log', closable: true };
}

function leaf(id: string, tabs: Tab[] = []): SplitNode {
  return { type: 'leaf', id: `leaf-${id}`, pane: { id, tabs, activeTabId: tabs[0]?.id ?? '' } };
}

function split(left: SplitNode, right: SplitNode): SplitNode {
  return { type: 'split', id: 'split', direction: 'horizontal', children: [left, right], ratio: 0.5 };
}

describe('collapseEmptyLeaves', () => {
  it('collapses a pane whose only session failed to load, leaving its sibling as the whole tree', () => {
    const tree = split(leaf('p1', []), leaf('p2', [tab('t1')]));

    const next = collapseEmptyLeaves(tree);

    expect(next.type).toBe('leaf');
    if (next.type !== 'leaf') throw new Error('unreachable');
    expect(next.pane.id).toBe('p2');
  });

  it('leaves a tree with no empty panes unchanged (same reference)', () => {
    const tree = split(leaf('p1', [tab('t1')]), leaf('p2', [tab('t2')]));

    expect(collapseEmptyLeaves(tree)).toBe(tree);
  });

  it('keeps the root leaf even when empty — the valid default state, not a dead pane', () => {
    const tree = leaf('p1', []);

    expect(collapseEmptyLeaves(tree)).toBe(tree);
  });

  it('collapses a nested chain of empty leaves in one pass', () => {
    const tree = split(
      split(leaf('p1', []), leaf('p2', [tab('t1')])),
      leaf('p3', []),
    );

    const next = collapseEmptyLeaves(tree);

    // p1 (empty) collapses into p2 at the inner split; p3 (empty) collapses
    // away entirely at the outer split, leaving just p2's leaf.
    expect(next.type).toBe('leaf');
    if (next.type !== 'leaf') throw new Error('unreachable');
    expect(next.pane.id).toBe('p2');
  });

  it('when both siblings are empty, keeps one (deterministic, not both)', () => {
    const tree = split(leaf('p1', []), leaf('p2', []));

    const next = collapseEmptyLeaves(tree);

    expect(allPanes(next)).toHaveLength(1);
  });
});
