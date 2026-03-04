import type { CenterTabType, CenterPane, SplitNode, Tab } from './workspaceTypes';
import { TAB_LABELS } from './workspaceTypes';

export function makeTab(type: CenterTabType, label?: string): Tab {
  return {
    id: crypto.randomUUID(),
    type,
    label: label ?? TAB_LABELS[type],
    closable: true,
  };
}

export function makeLeaf(tabs: Tab[] = []): SplitNode {
  return {
    type: 'leaf',
    id: crypto.randomUUID(),
    pane: {
      id: crypto.randomUUID(),
      tabs,
      activeTabId: tabs[0]?.id ?? '',
    },
  };
}

export function defaultTree(): SplitNode {
  // Start with a single empty leaf (no tabs). Logviewer tab is created on session:loaded.
  return makeLeaf([]);
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/** Find a leaf node whose pane has the given id. */
export function findLeafByPaneId(tree: SplitNode, paneId: string): (SplitNode & { type: 'leaf' }) | null {
  if (tree.type === 'leaf') {
    return tree.pane.id === paneId ? tree : null;
  }
  return findLeafByPaneId(tree.children[0], paneId) ?? findLeafByPaneId(tree.children[1], paneId);
}

/** Immutably update a leaf's pane by paneId. Returns same reference if paneId not found. */
export function updateLeaf(tree: SplitNode, paneId: string, fn: (pane: CenterPane) => CenterPane): SplitNode {
  if (tree.type === 'leaf') {
    if (tree.pane.id === paneId) {
      return { ...tree, pane: fn(tree.pane) };
    }
    return tree;
  }
  const left = updateLeaf(tree.children[0], paneId, fn);
  const right = updateLeaf(tree.children[1], paneId, fn);
  if (left === tree.children[0] && right === tree.children[1]) return tree;
  return { ...tree, children: [left, right] };
}

/**
 * Remove a leaf by paneId — collapse the parent split, returning the remaining sibling.
 * Returns null only if the tree IS the leaf being removed (root leaf).
 */
export function removeLeaf(tree: SplitNode, paneId: string): SplitNode | null {
  if (tree.type === 'leaf') {
    return tree.pane.id === paneId ? null : tree;
  }
  const leftResult = removeLeaf(tree.children[0], paneId);
  const rightResult = removeLeaf(tree.children[1], paneId);

  // Left child was the removed leaf -> collapse, return right sibling
  if (leftResult === null) return tree.children[1];
  // Right child was the removed leaf -> collapse, return left sibling
  if (rightResult === null) return tree.children[0];

  // Deeper descendant may have been removed
  if (leftResult !== tree.children[0] || rightResult !== tree.children[1]) {
    return { ...tree, children: [leftResult, rightResult] };
  }
  return tree;
}

/** Replace any node by its id. */
export function replaceNode(tree: SplitNode, nodeId: string, newNode: SplitNode): SplitNode {
  if (tree.id === nodeId) return newNode;
  if (tree.type === 'leaf') return tree;
  const left = replaceNode(tree.children[0], nodeId, newNode);
  const right = replaceNode(tree.children[1], nodeId, newNode);
  if (left === tree.children[0] && right === tree.children[1]) return tree;
  return { ...tree, children: [left, right] };
}

/** Collect all CenterPanes from leaves. */
export function allPanes(tree: SplitNode): CenterPane[] {
  if (tree.type === 'leaf') return [tree.pane];
  return [...allPanes(tree.children[0]), ...allPanes(tree.children[1])];
}

/** Find the first leaf (depth-first, left-first). */
export function firstLeaf(tree: SplitNode): SplitNode & { type: 'leaf' } {
  if (tree.type === 'leaf') return tree;
  return firstLeaf(tree.children[0]);
}

/** Find a tab across all panes by tabId. */
export function findTabAcrossTree(tree: SplitNode, tabId: string): { pane: CenterPane; tab: Tab } | null {
  for (const pane of allPanes(tree)) {
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (tab) return { pane, tab };
  }
  return null;
}

/** Find an existing tab by type across all panes. */
export function findTabByType(tree: SplitNode, type: CenterTabType): { pane: CenterPane; tab: Tab } | null {
  for (const pane of allPanes(tree)) {
    const tab = pane.tabs.find((t) => t.type === type);
    if (tab) return { pane, tab };
  }
  return null;
}
