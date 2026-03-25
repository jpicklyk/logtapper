/**
 * Pure functions for session tab lifecycle operations on the workspace tree.
 *
 * Extracted from useCenterTree's bus event handlers so they can be tested
 * directly without React or Tauri dependencies. useCenterTree imports these
 * and wires in the side effects (bus.emit, tabSessionMapRef, setState).
 */
import type { SplitNode, Tab } from './workspaceTypes';
import type { AppEvents } from '../../events/events';
import { findLeafByPaneId, findTabByType, firstLeaf, updateLeaf } from './splitTreeHelpers';

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
          t.id === e.tabId ? { ...t, label: e.sourceName, readOnly: e.readOnly } : t,
        ),
      }));
    } else if (e.isNewTab && existingLogviewerTab && e.previousSessionId) {
      const newTab: Tab = { id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true, readOnly: e.readOnly };
      nextTree = updateLeaf(tree, e.paneId, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, newTab],
        activeTabId: e.tabId,
      }));
    } else if (existingLogviewerTab) {
      nextTree = updateLeaf(tree, e.paneId, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((t) =>
          t.id === existingLogviewerTab.id ? { ...t, id: e.tabId, label: e.sourceName, readOnly: e.readOnly } : t,
        ),
        activeTabId: e.tabId,
      }));
    } else {
      const tab: Tab = { id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true, readOnly: e.readOnly };
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
          t.id === existing.tab.id ? { ...t, id: e.tabId, label: e.sourceName, readOnly: e.readOnly } : t,
        ),
        activeTabId: e.tabId,
      }));
    } else {
      const target = firstLeaf(tree);
      if (target.pane.id !== e.paneId) {
        emitPaneRemap = { originalPaneId: e.paneId, actualPaneId: target.pane.id, sessionId: e.sessionId };
      }

      const tab: Tab = { id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true, readOnly: e.readOnly };
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
