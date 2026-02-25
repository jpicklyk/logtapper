import { useCallback, useEffect, useRef, useState } from 'react';
import { bus } from '../events/bus';
import { useTogglePane } from './useTogglePane';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CenterTabType = 'logviewer' | 'dashboard' | 'scratch' | 'editor';
export type BottomTabType = 'timeline' | 'correlations' | 'search-results' | 'watches' | 'filter-results';
export type LeftPaneTab = 'info' | 'state' | 'bookmarks' | 'analysis';
export type RightPaneTab = 'processors' | 'marketplace';
export type LayoutPreset = 'compact' | 'standard' | 'wide';
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface Tab {
  id: string;
  type: CenterTabType;
  label: string;
  closable: boolean;
}

export interface CenterPane {
  id: string;
  tabs: Tab[];
  activeTabId: string;
}

export type SplitNode =
  | { type: 'leaf'; id: string; pane: CenterPane }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; children: [SplitNode, SplitNode]; ratio: number };

export interface WorkspaceLayoutState {
  // Left pane
  leftPaneWidth: number;
  leftPaneTab: LeftPaneTab;
  setLeftPaneTab: (tab: LeftPaneTab) => void;
  resizeLeftPane: (delta: number) => void;

  // Center area
  centerTree: SplitNode;
  splitHorizontal: (tabId: string, paneId: string) => void;
  splitVertical: (tabId: string, paneId: string) => void;
  moveTab: (tabId: string, fromPaneId: string, toPaneId: string) => void;
  reorderTab: (paneId: string, fromIndex: number, toIndex: number) => void;
  closeTab: (tabId: string, paneId: string) => void;
  setActiveTab: (tabId: string, paneId: string) => void;
  addCenterTab: (paneId: string, type: CenterTabType, label?: string) => void;
  resizeSplit: (splitNodeId: string, ratio: number) => void;
  renameTab: (tabId: string, label: string) => void;
  openCenterTab: (type: CenterTabType, label?: string) => void;
  dropTabOnPane: (tabId: string, fromPaneId: string, toPaneId: string, zone: DropZone) => void;

  // Right pane
  rightPaneVisible: boolean;
  rightPaneWidth: number;
  rightPaneTab: RightPaneTab;
  toggleRightPane: (tab?: RightPaneTab) => void;
  resizeRightPane: (delta: number) => void;

  // Bottom pane
  bottomPaneVisible: boolean;
  bottomPaneHeight: number;
  bottomPaneTab: BottomTabType;
  toggleBottomPane: (tab?: BottomTabType) => void;
  resizeBottomPane: (delta: number) => void;
  openBottomTab: (tab: BottomTabType) => void;

  // General
  preset: LayoutPreset;
  containerRef: React.RefObject<HTMLDivElement>;
  resetLayout: () => void;

  // Focus tracking — updated directly on every tab/pane activation (no bus event)
  focusedPaneId: string | null;
  setFocusedPaneId: (paneId: string) => void;
  /** Active tab type in the focused pane, or null if no pane is focused. */
  focusedActiveTabType: CenterTabType | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_LEFT_WIDTH = 140;
const MAX_LEFT_WIDTH = 420;
const DEFAULT_LEFT_WIDTH = 220;

const MIN_RIGHT_WIDTH = 220;
const MAX_RIGHT_WIDTH = 600;
const DEFAULT_RIGHT_WIDTH = 300;

const MIN_BOTTOM_HEIGHT = 100;
const MAX_BOTTOM_HEIGHT = 500;
const DEFAULT_BOTTOM_HEIGHT = 200;

const COMPACT_LEFT_WIDTH = 40;

const STORAGE_KEY = 'logtapper_workspace_v1';

const VALID_CENTER_TYPES = new Set<string>(['logviewer', 'dashboard', 'scratch', 'editor']);
const VALID_BOTTOM_TYPES = new Set<string>(['timeline', 'correlations', 'search-results', 'watches', 'filter-results']);
const VALID_LEFT_TABS = new Set<string>(['info', 'state', 'bookmarks', 'analysis']);
const VALID_RIGHT_TABS = new Set<string>(['processors', 'marketplace']);

const TAB_LABELS: Record<CenterTabType, string> = {
  logviewer: 'Log',
  dashboard: 'Dashboard',
  scratch: 'Scratch',
  editor: 'Editor',
};

// ---------------------------------------------------------------------------
// Tree helpers (pure functions)
// ---------------------------------------------------------------------------

/**
 * Reads the persisted workspace tree and returns the first center pane ID.
 * Used by useLogViewer's startup restore so the session is registered under
 * the real pane ID, not the 'primary' fallback.
 */
export function getStoredFirstPaneId(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { centerTree?: SplitNode };
    const tree = parsed?.centerTree;
    if (!tree) return null;
    function firstPaneId(node: SplitNode): string | null {
      if (node.type === 'leaf') return node.pane.id;
      return firstPaneId(node.children[0]);
    }
    return firstPaneId(tree);
  } catch {
    return null;
  }
}

function makeTab(type: CenterTabType, label?: string): Tab {
  return {
    id: crypto.randomUUID(),
    type,
    label: label ?? TAB_LABELS[type],
    closable: true,
  };
}

function makeLeaf(tabs: Tab[] = []): SplitNode {
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

function defaultTree(): SplitNode {
  // Start with a single empty leaf (no tabs). Logviewer tab is created on session:loaded.
  return makeLeaf([]);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/** Find a leaf node whose pane has the given id. */
function findLeafByPaneId(tree: SplitNode, paneId: string): (SplitNode & { type: 'leaf' }) | null {
  if (tree.type === 'leaf') {
    return tree.pane.id === paneId ? tree : null;
  }
  return findLeafByPaneId(tree.children[0], paneId) ?? findLeafByPaneId(tree.children[1], paneId);
}

/** Immutably update a leaf's pane by paneId. Returns same reference if paneId not found. */
function updateLeaf(tree: SplitNode, paneId: string, fn: (pane: CenterPane) => CenterPane): SplitNode {
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
function removeLeaf(tree: SplitNode, paneId: string): SplitNode | null {
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
function replaceNode(tree: SplitNode, nodeId: string, newNode: SplitNode): SplitNode {
  if (tree.id === nodeId) return newNode;
  if (tree.type === 'leaf') return tree;
  const left = replaceNode(tree.children[0], nodeId, newNode);
  const right = replaceNode(tree.children[1], nodeId, newNode);
  if (left === tree.children[0] && right === tree.children[1]) return tree;
  return { ...tree, children: [left, right] };
}

/** Collect all CenterPanes from leaves. */
function allPanes(tree: SplitNode): CenterPane[] {
  if (tree.type === 'leaf') return [tree.pane];
  return [...allPanes(tree.children[0]), ...allPanes(tree.children[1])];
}

/** Find the first leaf (depth-first, left-first). */
function firstLeaf(tree: SplitNode): SplitNode & { type: 'leaf' } {
  if (tree.type === 'leaf') return tree;
  return firstLeaf(tree.children[0]);
}

/** Find a tab across all panes by tabId. */
function findTabAcrossTree(tree: SplitNode, tabId: string): { pane: CenterPane; tab: Tab } | null {
  for (const pane of allPanes(tree)) {
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (tab) return { pane, tab };
  }
  return null;
}

/** Find an existing tab by type across all panes. */
function findTabByType(tree: SplitNode, type: CenterTabType): { pane: CenterPane; tab: Tab } | null {
  for (const pane of allPanes(tree)) {
    const tab = pane.tabs.find((t) => t.type === type);
    if (tab) return { pane, tab };
  }
  return null;
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

interface PersistedState {
  centerTree: SplitNode;
  leftPaneWidth: number;
  leftPaneTab: LeftPaneTab;
  rightPaneVisible: boolean;
  rightPaneWidth: number;
  rightPaneTab: RightPaneTab;
  bottomPaneVisible: boolean;
  bottomPaneHeight: number;
  bottomPaneTab: BottomTabType;
}

/** Sanitize a tree restored from localStorage. Strip unknown tab types, flatten corrupt nodes. */
function sanitizeTree(node: SplitNode): SplitNode | null {
  if (!node || typeof node !== 'object') return null;

  if (node.type === 'leaf') {
    if (!node.pane || !Array.isArray(node.pane.tabs)) return null;
    const tabs = node.pane.tabs
      .filter((t) => VALID_CENTER_TYPES.has(t.type))
      .map((t) => ({ ...t, closable: true }));
    // Empty panes are valid (the default state is an empty leaf)
    const activeTabId = tabs.find((t) => t.id === node.pane.activeTabId)
      ? node.pane.activeTabId
      : (tabs[0]?.id ?? '');
    return { ...node, pane: { ...node.pane, tabs, activeTabId } };
  }

  if (node.type === 'split') {
    if (!Array.isArray(node.children) || node.children.length !== 2) return null;
    const left = sanitizeTree(node.children[0]);
    const right = sanitizeTree(node.children[1]);
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) return left;
    const ratio = typeof node.ratio === 'number' ? clamp(node.ratio, 0.1, 0.9) : 0.5;
    const direction = node.direction === 'vertical' ? 'vertical' : 'horizontal';
    return { ...node, children: [left, right], ratio, direction };
  }

  return null;
}

function loadPersistedState(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedState;
    const result: Partial<PersistedState> = {};

    if (parsed.centerTree) {
      const sanitized = sanitizeTree(parsed.centerTree);
      if (sanitized) result.centerTree = sanitized;
    }
    if (typeof parsed.leftPaneWidth === 'number') {
      result.leftPaneWidth = clamp(parsed.leftPaneWidth, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH);
    }
    if (typeof parsed.leftPaneTab === 'string' && VALID_LEFT_TABS.has(parsed.leftPaneTab)) {
      result.leftPaneTab = parsed.leftPaneTab;
    }
    if (typeof parsed.rightPaneVisible === 'boolean') {
      result.rightPaneVisible = parsed.rightPaneVisible;
    }
    if (typeof parsed.rightPaneWidth === 'number') {
      result.rightPaneWidth = clamp(parsed.rightPaneWidth, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH);
    }
    if (typeof parsed.rightPaneTab === 'string' && VALID_RIGHT_TABS.has(parsed.rightPaneTab)) {
      result.rightPaneTab = parsed.rightPaneTab as RightPaneTab;
    }
    if (typeof parsed.bottomPaneVisible === 'boolean') {
      result.bottomPaneVisible = parsed.bottomPaneVisible;
    }
    if (typeof parsed.bottomPaneHeight === 'number') {
      result.bottomPaneHeight = clamp(parsed.bottomPaneHeight, MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT);
    }
    if (typeof parsed.bottomPaneTab === 'string' && VALID_BOTTOM_TYPES.has(parsed.bottomPaneTab)) {
      result.bottomPaneTab = parsed.bottomPaneTab as BottomTabType;
    }
    return result;
  } catch {
    return {};
  }
}

function savePersistedState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* storage full */ }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWorkspaceLayout(): WorkspaceLayoutState {
  const containerRef = useRef<HTMLDivElement>(null!);
  const [preset, setPreset] = useState<LayoutPreset>('standard');
  const presetRef = useRef<LayoutPreset>('standard');

  // Load persisted state once on mount
  const saved = useRef(loadPersistedState()).current;

  // Left pane
  const [leftPaneWidth, setLeftPaneWidth] = useState(saved.leftPaneWidth ?? DEFAULT_LEFT_WIDTH);
  const [leftPaneTab, setLeftPaneTabRaw] = useState<LeftPaneTab>(saved.leftPaneTab ?? 'info');

  // Focus tracking — synced from session:focused bus event
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);

  // Center tree
  const [centerTree, setCenterTree] = useState<SplitNode>(() => saved.centerTree ?? defaultTree());
  const treeRef = useRef<SplitNode>(centerTree);

  // Right pane
  const rightPane = useTogglePane<RightPaneTab>(saved.rightPaneVisible ?? false, saved.rightPaneTab ?? 'processors');
  const [rightPaneWidth, setRightPaneWidth] = useState(saved.rightPaneWidth ?? DEFAULT_RIGHT_WIDTH);

  // Bottom pane
  const bottomPane = useTogglePane<BottomTabType>(saved.bottomPaneVisible ?? false, saved.bottomPaneTab ?? 'timeline');
  const [bottomPaneHeight, setBottomPaneHeight] = useState(saved.bottomPaneHeight ?? DEFAULT_BOTTOM_HEIGHT);

  // Keep treeRef in sync
  useEffect(() => { treeRef.current = centerTree; }, [centerTree]);

  // Persist on changes (skip compact mode — it's a transient viewport state)
  useEffect(() => {
    if (presetRef.current === 'compact') return;
    savePersistedState({
      centerTree,
      leftPaneWidth,
      leftPaneTab,
      rightPaneVisible: rightPane.visible,
      rightPaneWidth,
      rightPaneTab: rightPane.tab,
      bottomPaneVisible: bottomPane.visible,
      bottomPaneHeight,
      bottomPaneTab: bottomPane.tab,
    });
  }, [centerTree, leftPaneWidth, leftPaneTab, rightPane.visible, rightPaneWidth, rightPane.tab, bottomPane.visible, bottomPaneHeight, bottomPane.tab]);

  // ---------------------------------------------------------------------------
  // ResizeObserver — preset detection
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w === 0) return;
      const next: LayoutPreset = w < 900 ? 'compact' : w < 1800 ? 'standard' : 'wide';
      if (next !== presetRef.current) {
        const prev = presetRef.current;
        presetRef.current = next;
        setPreset(next);

        if (next === 'compact') {
          // Collapse to icon strip, hide side/bottom panels
          setLeftPaneWidth(COMPACT_LEFT_WIDTH);
          rightPane.setVisible(false);
          bottomPane.setVisible(false);
        } else if (prev === 'compact') {
          // Leaving compact — restore persisted widths
          const restored = loadPersistedState();
          setLeftPaneWidth(restored.leftPaneWidth ?? DEFAULT_LEFT_WIDTH);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------------------
  // Tree updater
  // ---------------------------------------------------------------------------

  const updateTree = useCallback((fn: (prev: SplitNode) => SplitNode) => {
    setCenterTree((prev) => {
      const next = fn(prev);
      treeRef.current = next;
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Left pane actions
  // ---------------------------------------------------------------------------

  const setLeftPaneTab = useCallback((tab: LeftPaneTab) => {
    setLeftPaneTabRaw(tab);
  }, []);

  const resizeLeftPane = useCallback((delta: number) => {
    setLeftPaneWidth((prev) => clamp(prev + delta, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH));
  }, []);

  // ---------------------------------------------------------------------------
  // Center tree operations
  // ---------------------------------------------------------------------------

  const splitHorizontal = useCallback((tabId: string, paneId: string) => {
    updateTree((tree) => {
      const leaf = findLeafByPaneId(tree, paneId);
      if (!leaf) return tree;
      const tab = leaf.pane.tabs.find((t) => t.id === tabId);
      if (!tab) return tree;

      // Remove tab from existing pane
      const remainingTabs = leaf.pane.tabs.filter((t) => t.id !== tabId);
      const updatedPane: CenterPane = {
        ...leaf.pane,
        tabs: remainingTabs,
        activeTabId: remainingTabs.length > 0
          ? (leaf.pane.activeTabId === tabId ? remainingTabs[0].id : leaf.pane.activeTabId)
          : '',
      };

      // New pane with the moved tab
      const newPane: CenterPane = {
        id: crypto.randomUUID(),
        tabs: [tab],
        activeTabId: tab.id,
      };

      const leftLeaf: SplitNode = { type: 'leaf', id: leaf.id, pane: updatedPane };
      const rightLeaf: SplitNode = { type: 'leaf', id: crypto.randomUUID(), pane: newPane };

      const splitNode: SplitNode = {
        type: 'split',
        id: crypto.randomUUID(),
        direction: 'horizontal',
        children: [leftLeaf, rightLeaf],
        ratio: 0.5,
      };

      return replaceNode(tree, leaf.id, splitNode);
    });
  }, [updateTree]);

  const splitVertical = useCallback((tabId: string, paneId: string) => {
    updateTree((tree) => {
      const leaf = findLeafByPaneId(tree, paneId);
      if (!leaf) return tree;
      const tab = leaf.pane.tabs.find((t) => t.id === tabId);
      if (!tab) return tree;

      const remainingTabs = leaf.pane.tabs.filter((t) => t.id !== tabId);
      const updatedPane: CenterPane = {
        ...leaf.pane,
        tabs: remainingTabs,
        activeTabId: remainingTabs.length > 0
          ? (leaf.pane.activeTabId === tabId ? remainingTabs[0].id : leaf.pane.activeTabId)
          : '',
      };

      const newPane: CenterPane = {
        id: crypto.randomUUID(),
        tabs: [tab],
        activeTabId: tab.id,
      };

      const topLeaf: SplitNode = { type: 'leaf', id: leaf.id, pane: updatedPane };
      const bottomLeaf: SplitNode = { type: 'leaf', id: crypto.randomUUID(), pane: newPane };

      const splitNode: SplitNode = {
        type: 'split',
        id: crypto.randomUUID(),
        direction: 'vertical',
        children: [topLeaf, bottomLeaf],
        ratio: 0.5,
      };

      return replaceNode(tree, leaf.id, splitNode);
    });
  }, [updateTree]);

  const moveTab = useCallback((tabId: string, fromPaneId: string, toPaneId: string) => {
    if (fromPaneId === toPaneId) return;
    updateTree((tree) => {
      const fromLeaf = findLeafByPaneId(tree, fromPaneId);
      const toLeaf = findLeafByPaneId(tree, toPaneId);
      if (!fromLeaf || !toLeaf) return tree;
      const tab = fromLeaf.pane.tabs.find((t) => t.id === tabId);
      if (!tab) return tree;

      // Remove from source
      const remainingTabs = fromLeaf.pane.tabs.filter((t) => t.id !== tabId);
      let updated = updateLeaf(tree, fromPaneId, (pane) => ({
        ...pane,
        tabs: remainingTabs,
        activeTabId: remainingTabs.length > 0
          ? (pane.activeTabId === tabId ? remainingTabs[0].id : pane.activeTabId)
          : '',
      }));

      // Add to target
      updated = updateLeaf(updated, toPaneId, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, tab],
        activeTabId: tab.id,
      }));

      // Collapse empty source leaf
      if (remainingTabs.length === 0) {
        const collapsed = removeLeaf(updated, fromPaneId);
        if (collapsed) return collapsed;
      }

      return updated;
    });
  }, [updateTree]);

  const reorderTab = useCallback((paneId: string, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    updateTree((tree) =>
      updateLeaf(tree, paneId, (pane) => {
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= pane.tabs.length || toIndex >= pane.tabs.length) return pane;
        const tabs = [...pane.tabs];
        const [moved] = tabs.splice(fromIndex, 1);
        tabs.splice(toIndex, 0, moved);
        return { ...pane, tabs };
      }),
    );
  }, [updateTree]);

  const closeTab = useCallback((tabId: string, paneId: string) => {
    // Notify session layer before mutating the tree, so it can close the backend
    // session and clear the file restore key (LS_LAST_FILE).
    const closingTab = findLeafByPaneId(treeRef.current, paneId)
      ?.pane.tabs.find((t) => t.id === tabId);
    if (closingTab?.type === 'logviewer') {
      bus.emit('layout:logviewer-tab-closed', { paneId });
    }

    updateTree((tree) => {
      const leaf = findLeafByPaneId(tree, paneId);
      if (!leaf) return tree;
      const tab = leaf.pane.tabs.find((t) => t.id === tabId);
      if (!tab) return tree;

      const remainingTabs = leaf.pane.tabs.filter((t) => t.id !== tabId);

      if (remainingTabs.length === 0) {
        // Last tab — try to collapse this leaf (return sibling)
        const collapsed = removeLeaf(tree, paneId);
        if (collapsed) return collapsed;
        // Root leaf — keep it but empty
        return updateLeaf(tree, paneId, () => ({
          id: leaf.pane.id,
          tabs: [],
          activeTabId: '',
        }));
      }

      return updateLeaf(tree, paneId, (pane) => ({
        ...pane,
        tabs: remainingTabs,
        activeTabId: pane.activeTabId === tabId ? remainingTabs[0].id : pane.activeTabId,
      }));
    });
  }, [updateTree]);

  const setActiveTab = useCallback((tabId: string, paneId: string) => {
    updateTree((tree) =>
      updateLeaf(tree, paneId, (pane) =>
        pane.activeTabId === tabId ? pane : { ...pane, activeTabId: tabId },
      ),
    );
  }, [updateTree]);

  const addCenterTab = useCallback((paneId: string, type: CenterTabType, label?: string) => {
    updateTree((tree) =>
      updateLeaf(tree, paneId, (pane) => {
        const tab = makeTab(type, label);
        return { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id };
      }),
    );
  }, [updateTree]);

  const resizeSplit = useCallback((splitNodeId: string, ratio: number) => {
    const clamped = clamp(ratio, 0.1, 0.9);
    updateTree((tree) => {
      function visit(node: SplitNode): SplitNode {
        if (node.id === splitNodeId && node.type === 'split') {
          return node.ratio === clamped ? node : { ...node, ratio: clamped };
        }
        if (node.type === 'split') {
          const left = visit(node.children[0]);
          const right = visit(node.children[1]);
          if (left === node.children[0] && right === node.children[1]) return node;
          return { ...node, children: [left, right] };
        }
        return node;
      }
      return visit(tree);
    });
  }, [updateTree]);

  const renameTab = useCallback((tabId: string, label: string) => {
    updateTree((tree) => {
      const found = findTabAcrossTree(tree, tabId);
      if (!found) return tree;
      return updateLeaf(tree, found.pane.id, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((t) => (t.id === tabId ? { ...t, label } : t)),
      }));
    });
  }, [updateTree]);

  const openCenterTab = useCallback((type: CenterTabType, label?: string) => {
    updateTree((tree) => {
      // 1. If a tab of this type already exists, activate it
      const existing = findTabByType(tree, type);
      if (existing) {
        if (existing.pane.activeTabId === existing.tab.id) return tree;
        return updateLeaf(tree, existing.pane.id, (pane) => ({
          ...pane,
          activeTabId: existing.tab.id,
        }));
      }

      // 2. Add to the first leaf pane (focused pane)
      const target = firstLeaf(tree);
      const tab = makeTab(type, label);
      return updateLeaf(tree, target.pane.id, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, tab],
        activeTabId: tab.id,
      }));
    });
  }, [updateTree]);

  const dropTabOnPane = useCallback((
    tabId: string,
    fromPaneId: string,
    toPaneId: string,
    zone: DropZone,
  ) => {
    updateTree((tree) => {
      const fromLeaf = findLeafByPaneId(tree, fromPaneId);
      if (!fromLeaf) return tree;
      const tab = fromLeaf.pane.tabs.find((t) => t.id === tabId);
      if (!tab) return tree;

      if (fromPaneId === toPaneId && zone === 'center') return tree;

      const remainingTabs = fromLeaf.pane.tabs.filter((t) => t.id !== tabId);

      // Splitting off the last tab of a pane onto itself = no-op
      if (fromPaneId === toPaneId && remainingTabs.length === 0) return tree;

      // Remove tab from source
      let updated: SplitNode;
      if (remainingTabs.length === 0) {
        const collapsed = removeLeaf(tree, fromPaneId);
        updated = collapsed ?? tree;
      } else {
        updated = updateLeaf(tree, fromPaneId, (pane) => ({
          ...pane,
          tabs: remainingTabs,
          activeTabId: pane.activeTabId === tabId ? remainingTabs[0].id : pane.activeTabId,
        }));
      }

      if (zone === 'center') {
        return updateLeaf(updated, toPaneId, (pane) => ({
          ...pane,
          tabs: [...pane.tabs, tab],
          activeTabId: tab.id,
        }));
      }

      const toLeaf = findLeafByPaneId(updated, toPaneId);
      if (!toLeaf) {
        const target = firstLeaf(updated);
        return updateLeaf(updated, target.pane.id, (pane) => ({
          ...pane,
          tabs: [...pane.tabs, tab],
          activeTabId: tab.id,
        }));
      }

      const newPane: CenterPane = { id: crypto.randomUUID(), tabs: [tab], activeTabId: tab.id };
      const direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
      const newFirst = zone === 'left' || zone === 'top';
      const newLeafNode: SplitNode = { type: 'leaf', id: crypto.randomUUID(), pane: newPane };
      const existingLeafNode: SplitNode = { ...toLeaf };

      const splitNode: SplitNode = {
        type: 'split',
        id: crypto.randomUUID(),
        direction,
        children: newFirst ? [newLeafNode, existingLeafNode] : [existingLeafNode, newLeafNode],
        ratio: 0.5,
      };

      return replaceNode(updated, toLeaf.id, splitNode);
    });
  }, [updateTree]);

  // ---------------------------------------------------------------------------
  // Right pane actions
  // ---------------------------------------------------------------------------

  const resizeRightPane = useCallback((delta: number) => {
    // Right panel: drag handle at left edge. Dragging left (negative delta) = panel grows wider.
    setRightPaneWidth((prev) => clamp(prev - delta, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH));
  }, []);

  // ---------------------------------------------------------------------------
  // Bottom pane actions
  // ---------------------------------------------------------------------------

  const resizeBottomPane = useCallback((delta: number) => {
    setBottomPaneHeight((prev) => clamp(prev + delta, MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT));
  }, []);

  // ---------------------------------------------------------------------------
  // General
  // ---------------------------------------------------------------------------

  const resetLayout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  }, []);

  // ---------------------------------------------------------------------------
  // Event bus subscriptions
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const onSessionFocused = (e: { paneId: string | null }) => {
      setFocusedPaneId(e.paneId);
    };

    const onSessionLoaded = (e: { sourceName: string; paneId: string; sourceType: string }) => {
      if (e.sourceType === 'Bugreport') {
        setLeftPaneTabRaw('info');
      }
      setCenterTree((prev) => {
        // Look for an existing logviewer tab in the target pane first.
        const targetLeaf = findLeafByPaneId(prev, e.paneId);
        if (targetLeaf) {
          const existingInPane = targetLeaf.pane.tabs.find((t) => t.type === 'logviewer');
          if (existingInPane) {
            // Rename the existing tab in this pane
            const next = updateLeaf(prev, e.paneId, (pane) => ({
              ...pane,
              tabs: pane.tabs.map((t) =>
                t.id === existingInPane.id ? { ...t, label: e.sourceName } : t,
              ),
              activeTabId: existingInPane.id,
            }));
            treeRef.current = next;
            return next;
          }
          // Target pane exists but has no logviewer tab — add one
          const tab = makeTab('logviewer', e.sourceName);
          const next = updateLeaf(prev, e.paneId, (pane) => ({
            ...pane,
            tabs: [...pane.tabs, tab],
            activeTabId: tab.id,
          }));
          treeRef.current = next;
          return next;
        }

        // paneId not found in tree — fall back to first pane.
        // This handles startup restore where paneId is 'primary' (not yet in tree).
        const existing = findTabByType(prev, 'logviewer');
        if (existing) {
          const next = updateLeaf(prev, existing.pane.id, (pane) => ({
            ...pane,
            tabs: pane.tabs.map((t) =>
              t.id === existing.tab.id ? { ...t, label: e.sourceName } : t,
            ),
          }));
          treeRef.current = next;
          return next;
        }
        const target = firstLeaf(prev);
        const tab = makeTab('logviewer', e.sourceName);
        const next = updateLeaf(prev, target.pane.id, (pane) => ({
          ...pane,
          tabs: [...pane.tabs, tab],
          activeTabId: tab.id,
        }));
        treeRef.current = next;
        return next;
      });
    };

    const onPipelineCompleted = (e: { hasReporters: boolean; hasTrackers: boolean; hasCorrelators: boolean }) => {
      if (e.hasReporters) {
        setCenterTree((prev) => {
          const existing = findTabByType(prev, 'dashboard');
          if (existing) {
            if (existing.pane.activeTabId === existing.tab.id) return prev;
            const next = updateLeaf(prev, existing.pane.id, (pane) => ({
              ...pane,
              activeTabId: existing.tab.id,
            }));
            treeRef.current = next;
            return next;
          }
          const target = firstLeaf(prev);
          const tab = makeTab('dashboard');
          const next = updateLeaf(prev, target.pane.id, (pane) => ({
            ...pane,
            tabs: [...pane.tabs, tab],
            activeTabId: tab.id,
          }));
          treeRef.current = next;
          return next;
        });
      }
      if (e.hasTrackers) {
        bottomPane.open('timeline');
      }
      if (e.hasCorrelators) {
        bottomPane.open('correlations');
      }
    };

    const onSessionClosed = (e: { sourceType: string; paneId: string }) => {
      if (e.sourceType === 'Bugreport') {
        setLeftPaneTabRaw('state');
      }
      // Reset the logviewer tab label in the closed pane so the stale filename
      // doesn't persist in localStorage and reappear after a refresh.
      setCenterTree((prev) => {
        const leaf = findLeafByPaneId(prev, e.paneId);
        if (!leaf) return prev;
        const logviewerTab = leaf.pane.tabs.find((t) => t.type === 'logviewer');
        if (!logviewerTab || logviewerTab.label === TAB_LABELS.logviewer) return prev;
        const next = updateLeaf(prev, e.paneId, (pane) => ({
          ...pane,
          tabs: pane.tabs.map((t) =>
            t.id === logviewerTab.id ? { ...t, label: TAB_LABELS.logviewer } : t,
          ),
        }));
        treeRef.current = next;
        return next;
      });
    };

    bus.on('session:focused', onSessionFocused);
    bus.on('session:loaded', onSessionLoaded);
    bus.on('session:closed', onSessionClosed);
    bus.on('pipeline:completed', onPipelineCompleted);
    return () => {
      bus.off('session:focused', onSessionFocused);
      bus.off('session:loaded', onSessionLoaded);
      bus.off('session:closed', onSessionClosed);
      bus.off('pipeline:completed', onPipelineCompleted);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    // Left pane
    leftPaneWidth,
    leftPaneTab,
    setLeftPaneTab,
    resizeLeftPane,

    // Center area
    centerTree,
    splitHorizontal,
    splitVertical,
    moveTab,
    reorderTab,
    closeTab,
    setActiveTab,
    addCenterTab,
    resizeSplit,
    renameTab,
    openCenterTab,
    dropTabOnPane,

    // Right pane
    rightPaneVisible: rightPane.visible,
    rightPaneWidth,
    rightPaneTab: rightPane.tab,
    toggleRightPane: rightPane.toggle,
    resizeRightPane,

    // Bottom pane
    bottomPaneVisible: bottomPane.visible,
    bottomPaneHeight,
    bottomPaneTab: bottomPane.tab,
    toggleBottomPane: bottomPane.toggle,
    resizeBottomPane,
    openBottomTab: bottomPane.open,

    // General
    preset,
    containerRef,
    resetLayout,

    // Focus tracking
    focusedPaneId,
    setFocusedPaneId,
    focusedActiveTabType: (() => {
      if (!focusedPaneId) return null;
      const leaf = findLeafByPaneId(centerTree, focusedPaneId);
      if (!leaf) return null;
      const activeTab = leaf.pane.tabs.find((t) => t.id === leaf.pane.activeTabId);
      return activeTab?.type ?? null;
    })(),
  };
}
