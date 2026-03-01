import { useCallback, useEffect, useRef, useState } from 'react';
import { bus } from '../../events/bus';
import type { CenterTabType, BottomTabType, CenterPane, DropZone, SplitNode, Tab } from './workspaceTypes';
import { TAB_LABELS } from './workspaceTypes';
import {
  makeTab,
  clamp,
  findLeafByPaneId,
  updateLeaf,
  removeLeaf,
  replaceNode,
  allPanes,
  firstLeaf,
  findTabAcrossTree,
  findTabByType,
} from './splitTreeHelpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseCenterTreeOptions {
  focusedPaneIdRef: React.RefObject<string | null>;
  paneSessionMapRef: React.MutableRefObject<Map<string, string>>;
  activateSessionForPane: (paneId: string, sessionId: string) => void;
  openBottomPane: (tab: BottomTabType) => void;
}

export interface CenterTreeHandle {
  centerTree: SplitNode;
  reorderTab: (paneId: string, fromIndex: number, toIndex: number) => void;
  closeTab: (tabId: string, paneId: string) => void;
  setActiveTab: (tabId: string, paneId: string) => void;
  addCenterTab: (paneId: string, type: CenterTabType, label?: string) => void;
  resizeSplit: (splitNodeId: string, ratio: number) => void;
  renameTab: (tabId: string, label: string) => void;
  openCenterTab: (type: CenterTabType, label?: string) => void;
  dropTabOnPane: (tabId: string, fromPaneId: string, toPaneId: string, zone: DropZone) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCenterTree(
  options: UseCenterTreeOptions,
  savedCenterTree: SplitNode,
): CenterTreeHandle {
  const { focusedPaneIdRef, paneSessionMapRef, activateSessionForPane, openBottomPane } = options;

  const [centerTree, setCenterTree] = useState<SplitNode>(savedCenterTree);
  const treeRef = useRef<SplitNode>(centerTree);

  // Authoritative tab->session map. The workspace is the sole owner of tab
  // identity (creates/destroys tabs), so it is the right place to track this.
  const tabSessionMapRef = useRef<Map<string, string>>(new Map());

  // Keep treeRef in sync
  useEffect(() => { treeRef.current = centerTree; }, [centerTree]);

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
  // Center tree operations
  // ---------------------------------------------------------------------------

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
    const leaf = findLeafByPaneId(treeRef.current, paneId);
    const closingTab = leaf?.pane.tabs.find((t) => t.id === tabId);
    const isActiveTab = leaf?.pane.activeTabId === tabId;

    // Notify session layer before mutating the tree, so it can close the backend
    // session and clear the file restore key (LS_LAST_FILE).
    if (closingTab?.type === 'logviewer') {
      const sessionId = tabSessionMapRef.current.get(tabId) ?? '';
      tabSessionMapRef.current.delete(tabId);
      bus.emit('layout:logviewer-tab-closed', { tabId, paneId, sessionId });
    }

    updateTree((tree) => {
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
    });

    // If the closed tab was active and the next active tab is a logviewer, activate its session.
    if (closingTab?.type === 'logviewer' && isActiveTab && leaf) {
      const remainingTabs = leaf.pane.tabs.filter((t) => t.id !== tabId);
      const nextTab = remainingTabs[0];
      if (nextTab?.type === 'logviewer') {
        const nextSessionId = tabSessionMapRef.current.get(nextTab.id) ?? '';
        bus.emit('layout:logviewer-tab-activated', { tabId: nextTab.id, paneId, sessionId: nextSessionId });
      }
    }
  }, [updateTree]);

  const setActiveTab = useCallback((tabId: string, paneId: string) => {
    // Check current state before mutating so we can emit the right event.
    const leaf = findLeafByPaneId(treeRef.current, paneId);
    const tab = leaf?.pane.tabs.find((t) => t.id === tabId);
    const alreadyActive = leaf?.pane.activeTabId === tabId;

    updateTree((tree) =>
      updateLeaf(tree, paneId, (pane) =>
        pane.activeTabId === tabId ? pane : { ...pane, activeTabId: tabId },
      ),
    );

    // Notify session layer so it can swap paneSessionMap to the newly active session.
    if (tab?.type === 'logviewer' && !alreadyActive) {
      const sessionId = tabSessionMapRef.current.get(tabId) ?? '';
      bus.emit('layout:logviewer-tab-activated', { tabId, paneId, sessionId });
    }
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

      // 2. Add to the focused pane (or first leaf as fallback)
      const focPaneId = focusedPaneIdRef.current;
      const target = (focPaneId ? findLeafByPaneId(tree, focPaneId) : null) ?? firstLeaf(tree);
      const tab = makeTab(type, label);
      return updateLeaf(tree, target.pane.id, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, tab],
        activeTabId: tab.id,
      }));
    });
  }, [updateTree, focusedPaneIdRef]);

  const dropTabOnPane = useCallback((
    tabId: string,
    fromPaneId: string,
    toPaneId: string,
    zone: DropZone,
  ) => {
    // Determine the destination pane ID up front so we can emit after updateTree.
    // For split zones (left/right/top/bottom) a new pane is created; for 'center'
    // the tab moves into the existing toPaneId.
    const newPaneId = crypto.randomUUID();
    let landingPaneId = zone === 'center' ? toPaneId : newPaneId;

    // Capture source pane state BEFORE updateTree so we can emit the correct
    // re-activation event for the remaining tab in the source pane.
    // When the active tab is dragged out, paneSessionMap still points to that
    // departed session — we must activate the now-visible remaining tab.
    const preFromLeaf = findLeafByPaneId(treeRef.current, fromPaneId);
    const movedTabWasActive = preFromLeaf?.pane.activeTabId === tabId;
    const remainingFromTabs = (preFromLeaf?.pane.tabs ?? []).filter((t) => t.id !== tabId);
    const isSamePaneNoOp = fromPaneId === toPaneId && zone === 'center';
    const newActiveFromTab =
      !isSamePaneNoOp && movedTabWasActive && remainingFromTabs.length > 0
        ? remainingFromTabs[0]
        : null;

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
        landingPaneId = target.pane.id;
        return updateLeaf(updated, target.pane.id, (pane) => ({
          ...pane,
          tabs: [...pane.tabs, tab],
          activeTabId: tab.id,
        }));
      }

      const newPane: CenterPane = { id: newPaneId, tabs: [tab], activeTabId: tab.id };
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
    const movedTab = preFromLeaf?.pane.tabs.find((t) => t.id === tabId);
    if (movedTab?.type === 'logviewer') {
      const sessionId = tabSessionMapRef.current.get(tabId) ?? '';
      bus.emit('layout:logviewer-tab-activated', { tabId, paneId: landingPaneId, sessionId, reason: 'drag' });
    }

    // If the moved tab was the active tab in the source pane, the remaining tab
    // becomes visible but paneSessionMap still points to the departed session.
    // Update the pane's active session directly — no bus event, no activation
    // side-effects (cache check, viewer reset, jump). The user moved one tab;
    // the remaining tab just inherits its pane without any reload machinery.
    if (newActiveFromTab?.type === 'logviewer') {
      const fromSessionId = tabSessionMapRef.current.get(newActiveFromTab.id) ?? '';
      if (fromSessionId) activateSessionForPane(fromPaneId, fromSessionId);
    }
  }, [updateTree, activateSessionForPane]);

  // ---------------------------------------------------------------------------
  // Event bus subscriptions
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const onSessionLoaded = (e: { sourceName: string; paneId: string; sourceType: string; sessionId: string;
                                   tabId: string; isNewTab?: boolean; previousSessionId?: string }) => {
      // Pre-compute which bus events to emit based on the CURRENT tree before
      // calling setCenterTree. React StrictMode calls state updater functions twice
      // to detect side effects — any bus.emit inside an updater would double-fire,
      // producing duplicate logviewer-tab-activated events that
      // cascade into double state resets, double backend fetches, and apparent reloads.
      const preTree = treeRef.current;
      let tabIdToDelete: string | null = null;
      let emitTabActivated: { tabId: string; paneId: string; sessionId: string } | null = null;
      let emitPaneRemap: { originalPaneId: string; actualPaneId: string; sessionId: string } | null = null;

      const preTargetLeaf = findLeafByPaneId(preTree, e.paneId);
      if (preTargetLeaf) {
        const existingLogviewerTab = preTargetLeaf.pane.tabs.find((t) => t.type === 'logviewer');
        if (e.isNewTab && existingLogviewerTab && e.previousSessionId) {
          // Adding a second tab alongside an existing one. The existing tab keeps
          // its ID and mapping; only the new tab needs to be activated.
          emitTabActivated = { tabId: e.tabId, paneId: e.paneId, sessionId: e.sessionId };
        } else if (existingLogviewerTab) {
          // Replacing (or renaming) the existing logviewer tab — clean up old mapping.
          tabIdToDelete = existingLogviewerTab.id;
        }
        // else: no existing logviewer tab — just insert, no old mapping to delete.
      } else {
        const existing = findTabByType(preTree, 'logviewer');
        if (existing && !paneSessionMapRef.current.has(existing.pane.id)) {
          if (existing.pane.id !== e.paneId) {
            emitPaneRemap = { originalPaneId: e.paneId, actualPaneId: existing.pane.id, sessionId: e.sessionId };
          }
          // Reusing an unoccupied logviewer tab — its old mapping is stale.
          tabIdToDelete = existing.tab.id;
        } else {
          const target = firstLeaf(preTree);
          if (target.pane.id !== e.paneId) {
            emitPaneRemap = { originalPaneId: e.paneId, actualPaneId: target.pane.id, sessionId: e.sessionId };
          }
        }
      }

      // Pure tree updater — no side effects, safe for StrictMode double-invocation.
      setCenterTree((prev) => {
        const targetLeaf = findLeafByPaneId(prev, e.paneId);
        if (targetLeaf) {
          const existingLogviewerTab = targetLeaf.pane.tabs.find((t) => t.type === 'logviewer');

          if (e.isNewTab && existingLogviewerTab && e.previousSessionId) {
            // A second file is opening alongside an existing one — add new tab.
            const newTab: Tab = { id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true };
            const next = updateLeaf(prev, e.paneId, (pane) => ({
              ...pane,
              tabs: [...pane.tabs, newTab],
              activeTabId: e.tabId,
            }));
            treeRef.current = next;
            return next;
          }

          if (existingLogviewerTab) {
            // Replacing (or renaming) the single logviewer tab — update label and ID.
            const next = updateLeaf(prev, e.paneId, (pane) => ({
              ...pane,
              tabs: pane.tabs.map((t) =>
                t.id === existingLogviewerTab.id ? { ...t, id: e.tabId, label: e.sourceName } : t,
              ),
              activeTabId: e.tabId,
            }));
            treeRef.current = next;
            return next;
          }

          // Pane exists but has no logviewer tab yet — add one.
          const tab: Tab = { id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true };
          const next = updateLeaf(prev, e.paneId, (pane) => ({
            ...pane,
            tabs: [...pane.tabs, tab],
            activeTabId: tab.id,
          }));
          treeRef.current = next;
          return next;
        }

        // paneId not found in tree — fall back to first pane.
        // This handles startup restore where paneId is 'primary' (not yet in tree),
        // or first-run where localStorage hasn't been written yet.
        // Only reuse an existing logviewer pane if it is NOT already occupied by
        // another session — otherwise we'd clobber a live session's tab label.
        const existing = findTabByType(prev, 'logviewer');
        if (existing && !paneSessionMapRef.current.has(existing.pane.id)) {
          const next = updateLeaf(prev, existing.pane.id, (pane) => ({
            ...pane,
            tabs: pane.tabs.map((t) =>
              t.id === existing.tab.id ? { ...t, id: e.tabId, label: e.sourceName } : t,
            ),
            activeTabId: e.tabId,
          }));
          treeRef.current = next;
          return next;
        }
        const target = firstLeaf(prev);
        const tab: Tab = { id: e.tabId, type: 'logviewer', label: e.sourceName, closable: true };
        const next = updateLeaf(prev, target.pane.id, (pane) => ({
          ...pane,
          tabs: [...pane.tabs, tab],
          activeTabId: tab.id,
        }));
        treeRef.current = next;
        return next;
      });

      // Maintain the workspace-owned tab->session map. Always set the new mapping;
      // delete the old tab ID if we replaced an existing logviewer tab.
      tabSessionMapRef.current.set(e.tabId, e.sessionId);
      if (tabIdToDelete) tabSessionMapRef.current.delete(tabIdToDelete);

      // Emit bus events AFTER the state update, outside the updater.
      // This is the only correct place — updaters must be pure (no side effects).
      if (emitTabActivated) bus.emit('layout:logviewer-tab-activated', emitTabActivated);
      if (emitPaneRemap) bus.emit('layout:pane-session-remap', emitPaneRemap);
    };

    const onPipelineCompleted = (e: { sessionId: string; hasReporters: boolean; hasTrackers: boolean; hasCorrelators: boolean }) => {
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
          // Place the dashboard tab in the pane that owns the completed session,
          // falling back to the first leaf if the pane can't be found.
          const sessionPane = allPanes(prev).find(
            (p) => paneSessionMapRef.current.get(p.id) === e.sessionId,
          );
          const target = (sessionPane && findLeafByPaneId(prev, sessionPane.id)) ?? firstLeaf(prev);
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
        openBottomPane('timeline');
      }
      if (e.hasCorrelators) {
        openBottomPane('correlations');
      }
    };

    const onSessionClosed = (e: { paneId: string; tabId?: string }) => {
      // Reset the closed tab's label so the stale filename doesn't persist in
      // localStorage and reappear after a refresh.
      // When a tabId is provided, target that specific tab. If the tab was already
      // removed from the tree (normal tab-close path), the find returns undefined
      // and this becomes a no-op — preventing the remaining tab from being renamed.
      setCenterTree((prev) => {
        const leaf = findLeafByPaneId(prev, e.paneId);
        if (!leaf) return prev;
        const logviewerTab = e.tabId
          ? leaf.pane.tabs.find((t) => t.id === e.tabId)
          : leaf.pane.tabs.find((t) => t.type === 'logviewer');
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

    bus.on('session:loaded', onSessionLoaded);
    bus.on('session:closed', onSessionClosed);
    bus.on('pipeline:completed', onPipelineCompleted);
    return () => {
      bus.off('session:loaded', onSessionLoaded);
      bus.off('session:closed', onSessionClosed);
      bus.off('pipeline:completed', onPipelineCompleted);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    centerTree,
    reorderTab,
    closeTab,
    setActiveTab,
    addCenterTab,
    resizeSplit,
    renameTab,
    openCenterTab,
    dropTabOnPane,
  };
}
