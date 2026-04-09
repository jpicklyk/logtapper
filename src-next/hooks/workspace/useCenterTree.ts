import { useCallback, useEffect, useRef, useState } from 'react';
import { bus } from '../../events/bus';
import type { CenterTabType, BottomTabType, CenterPane, DropZone, SplitNode } from './workspaceTypes';
import { TAB_LABELS } from './workspaceTypes';
import {
  makeTab,
  nextEditorLabel,
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
import { LS_FILEPATH_PREFIX } from '../../components/EditorTab';
import { storageSet } from '../../utils';
import { applySessionLoading, applySessionLoaded } from './sessionTreeOps';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseCenterTreeOptions {
  activeLogPaneIdRef: React.RefObject<string | null>;
  paneSessionMapRef: React.MutableRefObject<Map<string, string>>;
  activateSessionForPane: (paneId: string, sessionId: string) => void;
  openBottomPane: (tab: BottomTabType) => void;
}

export interface CenterTreeHandle {
  centerTree: SplitNode;
  /** Synchronous ref — always reflects the latest tree, even mid-batch before React re-renders. */
  treeRef: React.RefObject<SplitNode>;
  reorderTab: (paneId: string, fromIndex: number, toIndex: number) => void;
  closeTab: (tabId: string, paneId: string) => void;
  setActiveTab: (tabId: string, paneId: string) => void;
  addCenterTab: (paneId: string, type: CenterTabType, label?: string) => void;
  resizeSplit: (splitNodeId: string, ratio: number) => void;
  renameTab: (tabId: string, label: string) => void;
  setTabUnsaved: (tabId: string, isDirty: boolean) => void;
  openCenterTab: (type: CenterTabType, label?: string, filePath?: string) => void;
  dropTabOnPane: (tabId: string, fromPaneId: string, toPaneId: string, zone: DropZone) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCenterTree(
  options: UseCenterTreeOptions,
  savedCenterTree: SplitNode,
): CenterTreeHandle {
  const { activeLogPaneIdRef, paneSessionMapRef, activateSessionForPane, openBottomPane } = options;

  const [centerTree, setCenterTree] = useState<SplitNode>(savedCenterTree);
  const treeRef = useRef<SplitNode>(centerTree);

  // Authoritative tab->session map. The workspace is the sole owner of tab
  // identity (creates/destroys tabs), so it is the right place to track this.
  const tabSessionMapRef = useRef<Map<string, string>>(new Map());

  // Sync treeRef during render — direct assignment is safe for refs (no side effects).
  // This ensures the ref reflects committed state on the same render, unlike useEffect
  // which fires one render late (L1 fix).
  treeRef.current = centerTree;

  // ---------------------------------------------------------------------------
  // Tree updater
  // ---------------------------------------------------------------------------

  const updateTree = useCallback((fn: (prev: SplitNode) => SplitNode) => {
    // Capture the next value outside the updater so we can write to treeRef after
    // setCenterTree — not inside the updater. StrictMode calls updaters twice and
    // discards the first result; writing treeRef inside would leave it briefly holding
    // the discarded value (L7 fix). The render-time assignment treeRef.current = centerTree
    // (L1 fix) also covers this, but we write here too for synchronous reads within
    // the same event flush, before the next render.
    let next: SplitNode | undefined;
    setCenterTree((prev) => {
      next = fn(prev);
      return next;
    });
    if (next !== undefined) treeRef.current = next;
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
        const effectiveLabel = label ?? (type === 'editor' ? nextEditorLabel(tree) : undefined);
        const tab = makeTab(type, effectiveLabel);
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

  const setTabUnsaved = useCallback((tabId: string, isDirty: boolean) => {
    // Bail before setState to avoid a tree walk inside the updater on every call.
    const found = findTabAcrossTree(treeRef.current, tabId);
    if (!found) return;
    const currentTab = found.pane.tabs.find((t) => t.id === tabId);
    if (currentTab?.unsaved === isDirty) return;
    updateTree((tree) =>
      updateLeaf(tree, found.pane.id, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((t) => (t.id === tabId ? { ...t, unsaved: isDirty } : t)),
      })),
    );
  }, [updateTree]);

  const openCenterTab = useCallback((type: CenterTabType, label?: string, filePath?: string) => {
    updateTree((tree) => {
      // 1. If a tab of this type already exists (and no filePath — reuse tab), activate it
      if (!filePath) {
        const existing = findTabByType(tree, type);
        if (existing) {
          if (existing.pane.activeTabId === existing.tab.id) return tree;
          return updateLeaf(tree, existing.pane.id, (pane) => ({
            ...pane,
            activeTabId: existing.tab.id,
          }));
        }
      }

      // 2. Add to the focused pane (or first leaf as fallback)
      const focPaneId = activeLogPaneIdRef.current;
      const target = (focPaneId ? findLeafByPaneId(tree, focPaneId) : null) ?? firstLeaf(tree);
      const tab = makeTab(type, label);

      // Pre-seed localStorage with the file path so EditorTab picks it up on mount.
      if (filePath) {
        storageSet(LS_FILEPATH_PREFIX + tab.id, filePath);
      }

      return updateLeaf(tree, target.pane.id, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, tab],
        activeTabId: tab.id,
      }));
    });
  }, [updateTree, activeLogPaneIdRef]);

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
                                   tabId: string; isNewTab?: boolean; previousSessionId?: string; readOnly?: boolean }) => {
      // Compute result using treeRef.current (synchronously current committed state)
      // outside the setState updater. This avoids the L10 pattern where result is
      // computed inside the updater and StrictMode calls it twice — the bus.emit would
      // fire after the second (kept) run, but the result variable would have been
      // assigned twice, making the code fragile and misleading.
      const result = applySessionLoaded(treeRef.current, e, paneSessionMapRef.current);
      setCenterTree(() => result.tree);
      treeRef.current = result.tree;

      // Side effects run after setCenterTree with the result computed above.
      tabSessionMapRef.current.set(e.tabId, e.sessionId);
      if (result.tabIdToDelete) tabSessionMapRef.current.delete(result.tabIdToDelete);
      if (result.emitTabActivated) bus.emit('layout:logviewer-tab-activated', result.emitTabActivated);
      if (result.emitPaneRemap) bus.emit('layout:pane-session-remap', result.emitPaneRemap);
    };

    const onPipelineCompleted = (e: { sessionId: string; hasReporters: boolean; hasTrackers: boolean; hasCorrelators: boolean }) => {
      if (e.hasReporters) {
        // Compute the next tree from treeRef.current outside the updater to avoid
        // writing treeRef inside the updater (StrictMode double-call issue, L7 pattern).
        const prev = treeRef.current;
        const existing = findTabByType(prev, 'dashboard');
        let next: SplitNode;
        if (existing) {
          if (existing.pane.activeTabId === existing.tab.id) {
            // Nothing to do — dashboard tab already active
            next = prev;
          } else {
            next = updateLeaf(prev, existing.pane.id, (pane) => ({
              ...pane,
              activeTabId: existing.tab.id,
            }));
          }
        } else {
          // Place the dashboard tab in the pane that owns the completed session,
          // falling back to the first leaf if the pane can't be found.
          const sessionPane = allPanes(prev).find(
            (p) => paneSessionMapRef.current.get(p.id) === e.sessionId,
          );
          const target = (sessionPane && findLeafByPaneId(prev, sessionPane.id)) ?? firstLeaf(prev);
          const tab = makeTab('dashboard');
          next = updateLeaf(prev, target.pane.id, (pane) => ({
            ...pane,
            tabs: [...pane.tabs, tab],
            activeTabId: tab.id,
          }));
        }
        if (next !== prev) {
          treeRef.current = next;
          setCenterTree(() => next);
        }
      }
      if (e.hasTrackers) {
        openBottomPane('timeline');
      }
    };

    const onSessionClosed = (e: { paneId: string; tabId?: string }) => {
      // Reset the closed tab's label so the stale filename doesn't persist in
      // localStorage and reappear after a refresh.
      // When a tabId is provided, target that specific tab. If the tab was already
      // removed from the tree (normal tab-close path), the find returns undefined
      // and this becomes a no-op — preventing the remaining tab from being renamed.
      // Computed outside the updater (L7 pattern — avoid treeRef write inside updater).
      const prev = treeRef.current;
      const leaf = findLeafByPaneId(prev, e.paneId);
      if (!leaf) return;
      const logviewerTab = e.tabId
        ? leaf.pane.tabs.find((t) => t.id === e.tabId)
        : leaf.pane.tabs.find((t) => t.type === 'logviewer');
      if (!logviewerTab || logviewerTab.label === TAB_LABELS.logviewer) return;
      const next = updateLeaf(prev, e.paneId, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((t) =>
          t.id === logviewerTab.id ? { ...t, label: TAB_LABELS.logviewer } : t,
        ),
      }));
      treeRef.current = next;
      setCenterTree(() => next);
    };

    // Create a placeholder tab immediately when a file load starts so the user
    // sees feedback while the backend decompresses/indexes the file.
    // Computed outside the updater (L7 pattern — avoid treeRef write inside updater).
    const onSessionLoading = (e: { paneId: string; tabId: string; label: string; isNewTab: boolean }) => {
      const next = applySessionLoading(treeRef.current, e);
      treeRef.current = next;
      setCenterTree(() => next);
    };

    // When a live capture is saved, register the file path so the tab
    // survives app restart via the startup restore in useFileSession.
    const onStreamSaved = (e: { sessionId: string; path: string }) => {
      // Reverse-lookup tabId from tabSessionMap (tabId → sessionId).
      for (const [tabId, sid] of tabSessionMapRef.current.entries()) {
        if (sid === e.sessionId) {
          const tabPaths = JSON.parse(localStorage.getItem('logtapper_tab_paths') ?? '{}');
          tabPaths[tabId] = e.path;
          localStorage.setItem('logtapper_tab_paths', JSON.stringify(tabPaths));
          break;
        }
      }
    };

    bus.on('session:loading', onSessionLoading);
    bus.on('session:loaded', onSessionLoaded);
    bus.on('session:closed', onSessionClosed);
    bus.on('pipeline:completed', onPipelineCompleted);
    bus.on('stream:saved', onStreamSaved);
    return () => {
      bus.off('session:loading', onSessionLoading);
      bus.off('session:loaded', onSessionLoaded);
      bus.off('session:closed', onSessionClosed);
      bus.off('pipeline:completed', onPipelineCompleted);
      bus.off('stream:saved', onStreamSaved);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    centerTree,
    /** Synchronous ref — always reflects the latest tree, even mid-batch before React re-renders. */
    treeRef,
    reorderTab,
    closeTab,
    setActiveTab,
    addCenterTab,
    resizeSplit,
    renameTab,
    setTabUnsaved,
    openCenterTab,
    dropTabOnPane,
  };
}
