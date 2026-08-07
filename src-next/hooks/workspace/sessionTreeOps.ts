/**
 * Pure functions for session tab lifecycle operations on the workspace tree.
 *
 * Extracted from useCenterTree's bus event handlers so they can be tested
 * directly without React or Tauri dependencies. useCenterTree imports these
 * and wires in the side effects (bus.emit, tabSessionMapRef, setState).
 */
import type { SplitNode, Tab } from './workspaceTypes';
import type { AppEvents } from '../../events/events';
import { findLeafByPaneId, findLeafByPanePredicate, findTabByType, firstLeaf, removeLeaf, updateLeaf } from './splitTreeHelpers';

// ---------------------------------------------------------------------------
// Event types — aliased from AppEvents where possible
// ---------------------------------------------------------------------------

export type SessionLoadingEvent = AppEvents['session:loading'];

// session:loaded uses SourceType in AppEvents but the pure function only needs
// string, so we define a widened interface to avoid coupling to bridge/types.
export interface SessionLoadedEvent {
  sourceName: string;
  paneId: string;
  sourceType: string;
  sessionId: string;
  tabId: string;
  isNewTab?: boolean;
  previousSessionId?: string;
  readOnly?: boolean;
  /** See `Tab.sourcePath` — stashed onto the created/updated tab for
   *  same-name disambiguation. */
  sourcePath?: string | null;
  /** See `Tab.sourceTotalLines` — snapshot at load time. */
  totalLines?: number;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SessionLoadedResult {
  tree: SplitNode;
  tabIdToDelete: string | null;
  emitTabActivated: { tabId: string; paneId: string; sessionId: string } | null;
  emitPaneRemap: { originalPaneId: string; actualPaneId: string; sessionId: string } | null;
}

// ---------------------------------------------------------------------------
// applySessionLoading — create placeholder tab for loading feedback
// ---------------------------------------------------------------------------

/**
 * Apply the session:loading tree mutation. Returns the updated tree, or the
 * same reference if no change was needed (paneId not found).
 */
export function applySessionLoading(tree: SplitNode, e: SessionLoadingEvent): SplitNode {
  const targetLeaf = findLeafByPaneId(tree, e.paneId);
  if (!targetLeaf) return tree;

  if (targetLeaf.pane.tabs.some((t) => t.id === e.tabId)) {
    return updateLeaf(tree, e.paneId, (pane) => ({
      ...pane,
      tabs: pane.tabs.map((t) =>
        t.id === e.tabId ? { ...t, label: e.label } : t,
      ),
      activeTabId: e.tabId,
    }));
  }

  const existingLogviewerTab = targetLeaf.pane.tabs.find((t) => t.type === 'logviewer');

  if (e.isNewTab && existingLogviewerTab) {
    const tab: Tab = { id: e.tabId, type: 'logviewer', label: e.label, closable: true };
    return updateLeaf(tree, e.paneId, (pane) => ({
      ...pane,
      tabs: [...pane.tabs, tab],
      activeTabId: e.tabId,
    }));
  }

  if (existingLogviewerTab) {
    return updateLeaf(tree, e.paneId, (pane) => ({
      ...pane,
      tabs: pane.tabs.map((t) =>
        t.id === existingLogviewerTab.id ? { ...t, id: e.tabId, label: e.label } : t,
      ),
      activeTabId: e.tabId,
    }));
  }

  const tab: Tab = { id: e.tabId, type: 'logviewer', label: e.label, closable: true };
  return updateLeaf(tree, e.paneId, (pane) => ({
    ...pane,
    tabs: [...pane.tabs, tab],
    activeTabId: e.tabId,
  }));
}

// ---------------------------------------------------------------------------
// applySessionLoaded — bind session to tab, compute side-effect payloads
// ---------------------------------------------------------------------------

/**
 * Pre-compute which tab mapping to delete and which bus events to emit,
 * then apply the tree mutation. Returns everything the caller needs to
 * perform the side effects (tabSessionMap update, bus.emit).
 *
 * @param tree            Current tree state
 * @param e               The session:loaded event payload
 * @param paneSessionMap  Read-only view of paneId→sessionId (for fallback occupancy check)
 */
export function applySessionLoaded(
  tree: SplitNode,
  e: SessionLoadedEvent,
  paneSessionMap: ReadonlyMap<string, string>,
): SessionLoadedResult {
  let tabIdToDelete: string | null = null;
  let emitTabActivated: SessionLoadedResult['emitTabActivated'] = null;
  let emitPaneRemap: SessionLoadedResult['emitPaneRemap'] = null;
  let nextTree = tree;

  const targetLeaf = findLeafByPaneId(tree, e.paneId);
  if (targetLeaf) {
    const existingLogviewerTab = targetLeaf.pane.tabs.find((t) => t.type === 'logviewer');

    // Pre-computation: determine which tab mapping to delete and events to emit
    if (e.isNewTab && existingLogviewerTab && e.previousSessionId) {
      // Adding a second tab alongside an existing one. The existing tab keeps
      // its ID and mapping; only the new tab needs to be activated.
      emitTabActivated = { tabId: e.tabId, paneId: e.paneId, sessionId: e.sessionId };
    } else if (existingLogviewerTab && existingLogviewerTab.id !== e.tabId) {
      // Skip when the tab already has e.tabId (session:loading renamed it early).
      tabIdToDelete = existingLogviewerTab.id;
    }

    // Tree mutation
    const existingTabById = targetLeaf.pane.tabs.find((t) => t.id === e.tabId);
    if (existingTabById) {
      // Tab already exists (startup restore or session:loading already created it)
      // — just update its label, don't add a duplicate.
      nextTree = updateLeaf(tree, e.paneId, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((t) =>
          t.id === e.tabId
            ? { ...t, label: e.sourceName, readOnly: e.readOnly, sourcePath: e.sourcePath, sourceTotalLines: e.totalLines }
            : t,
        ),
      }));
    } else if (e.isNewTab && existingLogviewerTab && e.previousSessionId) {
      const newTab: Tab = {
        id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true, readOnly: e.readOnly,
        sourcePath: e.sourcePath, sourceTotalLines: e.totalLines,
      };
      nextTree = updateLeaf(tree, e.paneId, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, newTab],
        activeTabId: e.tabId,
      }));
    } else if (existingLogviewerTab) {
      nextTree = updateLeaf(tree, e.paneId, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((t) =>
          t.id === existingLogviewerTab.id
            ? { ...t, id: e.tabId, label: e.sourceName, readOnly: e.readOnly, sourcePath: e.sourcePath, sourceTotalLines: e.totalLines }
            : t,
        ),
        activeTabId: e.tabId,
      }));
    } else {
      const tab: Tab = {
        id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true, readOnly: e.readOnly,
        sourcePath: e.sourcePath, sourceTotalLines: e.totalLines,
      };
      nextTree = updateLeaf(tree, e.paneId, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, tab],
        activeTabId: tab.id,
      }));
    }
  } else {
    // paneId not found — fall back to an existing unoccupied logviewer pane or firstLeaf.
    const existing = findTabByType(tree, 'logviewer');
    if (existing && !paneSessionMap.has(existing.pane.id)) {
      if (existing.pane.id !== e.paneId) {
        emitPaneRemap = { originalPaneId: e.paneId, actualPaneId: existing.pane.id, sessionId: e.sessionId };
      }
      // Skip when the tab already has e.tabId (session:loading renamed it early).
      if (existing.tab.id !== e.tabId) tabIdToDelete = existing.tab.id;

      nextTree = updateLeaf(tree, existing.pane.id, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((t) =>
          t.id === existing.tab.id
            ? { ...t, id: e.tabId, label: e.sourceName, readOnly: e.readOnly, sourcePath: e.sourcePath, sourceTotalLines: e.totalLines }
            : t,
        ),
        activeTabId: e.tabId,
      }));
    } else {
      // Prefer an UNOCCUPIED leaf anywhere in the tree — mirrors the
      // occupancy check the existing-logviewer-tab branch above already
      // applies (`!paneSessionMap.has(existing.pane.id)`). Before this fix,
      // firstLeaf(tree) was taken unconditionally here, so a load whose
      // paneId doesn't resolve to a live leaf (stale/non-leaf effective
      // pane id — see restoreCore.ts's validation) could land on a pane
      // ANOTHER load already legitimately claimed, pushing a second tab
      // into it and driving an unguarded pane-remap that steals the
      // occupant's paneSessionMap binding. Only fall back to firstLeaf's
      // pane (even though occupied) when literally every leaf is occupied —
      // there is nowhere else left to place it.
      const target = findLeafByPanePredicate(tree, (p) => !paneSessionMap.has(p.id)) ?? firstLeaf(tree);
      if (target.pane.id !== e.paneId) {
        emitPaneRemap = { originalPaneId: e.paneId, actualPaneId: target.pane.id, sessionId: e.sessionId };
      }

      const tab: Tab = {
        id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true, readOnly: e.readOnly,
        sourcePath: e.sourcePath, sourceTotalLines: e.totalLines,
      };
      nextTree = updateLeaf(tree, target.pane.id, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, tab],
        activeTabId: tab.id,
      }));
    }
  }

  return { tree: nextTree, tabIdToDelete, emitTabActivated, emitPaneRemap };
}

// ---------------------------------------------------------------------------
// applyCloseTab — remove one tab from the tree, collapsing an emptied leaf
// ---------------------------------------------------------------------------

/**
 * Apply closeTab's tree mutation in isolation. Extracted so callers that need
 * to know the tree's shape AFTER a close — without waiting for React to
 * commit the corresponding setState — can compute it locally (see the
 * bridge-initiated close loop in useCenterTree, U10 fix), instead of assuming
 * treeRef.current updates synchronously between successive closeTab() calls.
 * Returns the same tree reference if paneId/tabId aren't found (no-op).
 */
export function applyCloseTab(tree: SplitNode, tabId: string, paneId: string): SplitNode {
  const treeLeaf = findLeafByPaneId(tree, paneId);
  if (!treeLeaf) return tree;
  const tab = treeLeaf.pane.tabs.find((t) => t.id === tabId);
  if (!tab) return tree;

  const remainingTabs = treeLeaf.pane.tabs.filter((t) => t.id !== tabId);

  if (remainingTabs.length === 0) {
    // Last tab — try to collapse this leaf (return sibling)
    const collapsed = removeLeaf(tree, paneId);
    if (collapsed) return collapsed;
    // Root leaf — keep it but empty
    return updateLeaf(tree, paneId, () => ({
      id: treeLeaf.pane.id,
      tabs: [],
      activeTabId: '',
    }));
  }

  return updateLeaf(tree, paneId, (pane) => ({
    ...pane,
    tabs: remainingTabs,
    activeTabId: pane.activeTabId === tabId ? remainingTabs[0].id : pane.activeTabId,
  }));
}

// ---------------------------------------------------------------------------
// resolveFocusedTab — determine which logviewer tab should show focus marker
// ---------------------------------------------------------------------------

/**
 * Given a pane, determine which logviewer tab should receive the focus marker.
 * Prefers the active tab if it's a logviewer; otherwise falls back to the first
 * logviewer tab in the pane. Returns null if no logviewer tab exists.
 */
export function resolveFocusedTab(tree: SplitNode, paneId: string): string | null {
  const leaf = findLeafByPaneId(tree, paneId);
  if (!leaf) return null;
  const active = leaf.pane.tabs.find((t) => t.id === leaf.pane.activeTabId);
  if (active?.type === 'logviewer') return active.id;
  const firstLogviewer = leaf.pane.tabs.find((t) => t.type === 'logviewer');
  return firstLogviewer?.id ?? null;
}
