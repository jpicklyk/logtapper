import { useCallback, useEffect, useRef } from 'react';
import { isBugreportLike } from '../bridge/types';
import { storageRemove } from '../utils';
import { bus } from '../events/bus';
import type { AppEvents } from '../events/events';
import { useSessionCoreCtx, useSessionPaneCtx } from '../context/SessionContext';
import {
  useCenterTree,
  useLayoutPreset,
  usePanelDimensions,
  useFocusTracking,
  loadPersistedState,
  savePersistedState,
  defaultTree,
  COMPACT_LEFT_WIDTH,
  DEFAULT_LEFT_WIDTH,
  STORAGE_KEY,
  findLeafByPaneId,
  type PersistedState,
} from './workspace';
import type { CenterTabType } from './workspace';
import { resolveFocusedTab } from './workspace/sessionTreeOps';

// ---------------------------------------------------------------------------
// Re-exports — public API surface (call sites import from here or hooks/index)
// ---------------------------------------------------------------------------

export type {
  CenterTabType,
  BottomTabType,
  LeftPaneTab,
  RightPaneTab,
  LayoutPreset,
  DropZone,
  Tab,
  CenterPane,
  SplitNode,
  WorkspaceLayoutState,
} from './workspace';

import type { WorkspaceLayoutState } from './workspace';

export { getStoredFirstPaneId, getStoredLogviewerTabs } from './workspace';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWorkspaceLayout() {
  // Load persisted state once on mount
  const saved = useRef(loadPersistedState()).current;

  // Focus tracking — activeLogPaneId is the canonical value from SessionContext
  // (updated via session:focused bus event). We keep a ref for synchronous reads
  // inside useCenterTree and event handlers without subscribing to the broader
  // SessionContext updates from this hook.
  const { activeLogPaneId } = useSessionPaneCtx();
  const activeLogPaneIdRef = useRef<string | null>(activeLogPaneId);
  activeLogPaneIdRef.current = activeLogPaneId;

  // paneSessionMap from SessionContext
  const { paneSessionMap, activateSessionForPane } = useSessionCoreCtx();
  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;

  // ---------------------------------------------------------------------------
  // Sub-hooks
  // ---------------------------------------------------------------------------

  const panels = usePanelDimensions(saved);
  const focus = useFocusTracking(paneSessionMapRef);

  const centerTree = useCenterTree(
    {
      activeLogPaneIdRef,
      paneSessionMapRef,
      activateSessionForPane,
      openBottomPane: panels.bottomPane.open,
    },
    saved.centerTree ?? defaultTree(),
  );

  const setLeftPaneWidth = panels.setLeftPaneWidth;
  const rightSetVisible = panels.rightPane.setVisible;
  const bottomSetVisible = panels.bottomPane.setVisible;

  const { containerRef, preset } = useLayoutPreset({
    onEnterCompact: useCallback(() => {
      setLeftPaneWidth(COMPACT_LEFT_WIDTH);
      rightSetVisible(false);
      bottomSetVisible(false);
    }, [setLeftPaneWidth, rightSetVisible, bottomSetVisible]),
    onLeaveCompact: useCallback(() => {
      const restored = loadPersistedState();
      setLeftPaneWidth(restored.leftPaneWidth ?? DEFAULT_LEFT_WIDTH);
    }, [setLeftPaneWidth]),
  });

  // ---------------------------------------------------------------------------
  // Persistence effect (skip in compact — transient viewport state)
  // ---------------------------------------------------------------------------

  const presetRef = useRef(preset);
  presetRef.current = preset;

  useEffect(() => {
    if (presetRef.current === 'compact') return;
    savePersistedState({
      centerTree: centerTree.centerTree,
      leftPaneWidth: panels.leftPaneWidth,
      leftPaneTab: panels.leftPaneTab,
      rightPaneVisible: panels.rightPane.visible,
      rightPaneWidth: panels.rightPaneWidth,
      rightPaneTab: panels.rightPane.tab,
      bottomPaneVisible: panels.bottomPane.visible,
      bottomPaneHeight: panels.bottomPaneHeight,
      bottomPaneTab: panels.bottomPane.tab,
    });
  }, [centerTree.centerTree, panels.leftPaneWidth, panels.leftPaneTab, panels.rightPane.visible, panels.rightPaneWidth, panels.rightPane.tab, panels.bottomPane.visible, panels.bottomPaneHeight, panels.bottomPane.tab]);

  // ---------------------------------------------------------------------------
  // Event bus subscriptions (cross-cutting — not owned by any sub-hook)
  // ---------------------------------------------------------------------------

  // Use the synchronous treeRef from useCenterTree — it's updated inside
  // setCenterTree updaters, so it reflects the latest tree even before React
  // re-renders. The old centerTreeRef was stale during session:focused events
  // that fire synchronously after session:loaded (which queues the tree update).
  const centerTreeSyncRef = centerTree.treeRef;

  const openCenterTabRef = useRef(centerTree.openCenterTab);
  openCenterTabRef.current = centerTree.openCenterTab;

  useEffect(() => {
    const onSessionFocused = (e: { paneId: string | null }) => {
      // activeLogPaneId is owned by SessionContext — no local state to update here.
      // Only update the focused tab marker (blue underline) which is layout-local.
      if (e.paneId) {
        focus.setFocusedLogviewerTabId(resolveFocusedTab(centerTreeSyncRef.current, e.paneId));
      }
    };

    // Left-pane side-effect of session:loaded — set info tab for Bugreport sources.
    // (Tree mutations for session:loaded are handled inside useCenterTree.)
    const onSessionLoaded = (e: { sourceType: string; paneId: string }) => {
      if (isBugreportLike(e.sourceType) && e.paneId === activeLogPaneIdRef.current) {
        panels.setLeftPaneTab('info');
      }
    };

    const onOpenTab = (e: AppEvents['layout:open-tab']) => {
      openCenterTabRef.current(e.type as CenterTabType, e.label, e.filePath, e.editorState);
    };

    const onWorkspaceReset = () => {
      centerTree.clearTree();
      bus.emit('session:focused', { sessionId: null, paneId: null });
      focus.setFocusedLogviewerTabId(null);
    };

    const onRestoreLayout = ({ layout }: { layout: unknown }) => {
      // Write the saved layout blob to localStorage so loadPersistedState
      // can sanitize and validate it, then apply each value to state setters.
      savePersistedState(layout as PersistedState);
      const restored = loadPersistedState();
      if (restored.leftPaneWidth !== undefined) panels.setLeftPaneWidth(restored.leftPaneWidth);
      if (restored.leftPaneTab !== undefined) panels.setLeftPaneTab(restored.leftPaneTab);
      if (restored.rightPaneVisible !== undefined) panels.rightPane.setVisible(restored.rightPaneVisible);
      if (restored.rightPaneWidth !== undefined) panels.setRightPaneWidth(restored.rightPaneWidth);
      if (restored.rightPaneTab !== undefined) panels.rightPane.setTab(restored.rightPaneTab);
      if (restored.bottomPaneVisible !== undefined) panels.bottomPane.setVisible(restored.bottomPaneVisible);
      if (restored.bottomPaneHeight !== undefined) panels.setBottomPaneHeight(restored.bottomPaneHeight);
      if (restored.bottomPaneTab !== undefined) panels.bottomPane.setTab(restored.bottomPaneTab);
      // Center tree is intentionally not restored here: it was already rebuilt
      // by the session loading process and the saved IDs would be stale.
    };

    bus.on('session:focused', onSessionFocused);
    bus.on('session:loaded', onSessionLoaded);
    bus.on('layout:open-tab', onOpenTab);
    bus.on('workspace:reset', onWorkspaceReset);
    bus.on('workspace:restore-layout', onRestoreLayout);
    return () => {
      bus.off('session:focused', onSessionFocused);
      bus.off('session:loaded', onSessionLoaded);
      bus.off('layout:open-tab', onOpenTab);
      bus.off('workspace:reset', onWorkspaceReset);
      bus.off('workspace:restore-layout', onRestoreLayout);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // General
  // ---------------------------------------------------------------------------

  const resetLayout = useCallback(() => {
    storageRemove(STORAGE_KEY);
    window.location.reload();
  }, []);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  const leaf = activeLogPaneId ? findLeafByPaneId(centerTree.centerTree, activeLogPaneId) : null;
  const activeTab = leaf?.pane.tabs.find((t) => t.id === leaf.pane.activeTabId);

  return {
    // Left pane
    leftPaneWidth: panels.leftPaneWidth,
    leftPaneTab: panels.leftPaneTab,
    setLeftPaneTab: panels.setLeftPaneTab,
    resizeLeftPane: panels.resizeLeftPane,

    // Center area (from useCenterTree)
    centerTree: centerTree.centerTree,
    reorderTab: centerTree.reorderTab,
    closeTab: centerTree.closeTab,
    setActiveTab: centerTree.setActiveTab,
    addCenterTab: centerTree.addCenterTab,
    resizeSplit: centerTree.resizeSplit,
    renameTab: centerTree.renameTab,
    setTabUnsaved: centerTree.setTabUnsaved,
    openCenterTab: centerTree.openCenterTab,
    dropTabOnPane: centerTree.dropTabOnPane,
    clearTree: centerTree.clearTree,

    // Right pane
    rightPaneVisible: panels.rightPane.visible,
    rightPaneWidth: panels.rightPaneWidth,
    rightPaneTab: panels.rightPane.tab,
    toggleRightPane: panels.rightPane.toggle,
    resizeRightPane: panels.resizeRightPane,

    // Bottom pane
    bottomPaneVisible: panels.bottomPane.visible,
    bottomPaneHeight: panels.bottomPaneHeight,
    bottomPaneTab: panels.bottomPane.tab,
    toggleBottomPane: panels.bottomPane.toggle,
    resizeBottomPane: panels.resizeBottomPane,
    openBottomTab: panels.bottomPane.open,

    // General
    preset,
    containerRef,
    resetLayout,

    // Focus tracking
    activeLogPaneId,
    focusLogviewerTab: focus.focusLogviewerTab,
    focusedActiveTabType: activeTab?.type ?? null,
    focusedLogviewerTabId: focus.focusedLogviewerTabId,
  } satisfies WorkspaceLayoutState;
}
