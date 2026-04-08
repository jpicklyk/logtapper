import { useCallback, useEffect, useRef, useState } from 'react';
import { isBugreportLike } from '../bridge/types';
import { storageRemove } from '../utils';
import { bus } from '../events/bus';
import type { AppEvents } from '../events/events';
import { useTogglePane } from './useTogglePane';
import { useSessionContext } from '../context/SessionContext';
import {
  useCenterTree,
  useLayoutPreset,
  loadPersistedState,
  savePersistedState,
  defaultTree,
  clamp,
  MIN_LEFT_WIDTH, MAX_LEFT_WIDTH, DEFAULT_LEFT_WIDTH,
  MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH, DEFAULT_RIGHT_WIDTH,
  MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT, DEFAULT_BOTTOM_HEIGHT,
  COMPACT_LEFT_WIDTH,
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

import type { LeftPaneTab, RightPaneTab, BottomTabType, WorkspaceLayoutState } from './workspace';

export { getStoredFirstPaneId, getStoredLogviewerTabs } from './workspace';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWorkspaceLayout() {
  // Load persisted state once on mount
  const saved = useRef(loadPersistedState()).current;

  // Left pane
  const [leftPaneWidth, setLeftPaneWidth] = useState(saved.leftPaneWidth ?? DEFAULT_LEFT_WIDTH);
  const [leftPaneTab, setLeftPaneTabRaw] = useState<LeftPaneTab>(saved.leftPaneTab ?? 'info');

  // Focus tracking — synced from session:focused bus event
  const [activeLogPaneId, setActiveLogPaneId] = useState<string | null>(null);
  const activeLogPaneIdRef = useRef<string | null>(activeLogPaneId);
  activeLogPaneIdRef.current = activeLogPaneId;

  // The specific logviewer tab showing the focus marker (blue underline).
  // Updated when a logviewer tab is activated or when focus moves to a new pane.
  const [focusedLogviewerTabId, setFocusedLogviewerTabId] = useState<string | null>(null);

  const focusLogviewerTab = useCallback((tabId: string, paneId: string) => {
    setActiveLogPaneId(paneId);
    setFocusedLogviewerTabId(tabId);
  }, []);

  // paneSessionMap from SessionContext
  const { paneSessionMap, activateSessionForPane } = useSessionContext();
  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;

  // Right pane
  const rightPane = useTogglePane<RightPaneTab>(
    saved.rightPaneVisible ?? false,
    saved.rightPaneTab ?? 'processors',
  );
  const [rightPaneWidth, setRightPaneWidth] = useState(saved.rightPaneWidth ?? DEFAULT_RIGHT_WIDTH);

  // Bottom pane
  const bottomPane = useTogglePane<BottomTabType>(
    saved.bottomPaneVisible ?? false,
    saved.bottomPaneTab ?? 'timeline',
  );
  const [bottomPaneHeight, setBottomPaneHeight] = useState(saved.bottomPaneHeight ?? DEFAULT_BOTTOM_HEIGHT);

  // ---------------------------------------------------------------------------
  // Sub-hooks
  // ---------------------------------------------------------------------------

  const centerTree = useCenterTree(
    {
      activeLogPaneIdRef,
      paneSessionMapRef,
      activateSessionForPane,
      openBottomPane: bottomPane.open,
    },
    saved.centerTree ?? defaultTree(),
  );

  const rightSetVisible = rightPane.setVisible;
  const bottomSetVisible = bottomPane.setVisible;

  const { containerRef, preset } = useLayoutPreset({
    onEnterCompact: useCallback(() => {
      setLeftPaneWidth(COMPACT_LEFT_WIDTH);
      rightSetVisible(false);
      bottomSetVisible(false);
    }, [rightSetVisible, bottomSetVisible]),
    onLeaveCompact: useCallback(() => {
      const restored = loadPersistedState();
      setLeftPaneWidth(restored.leftPaneWidth ?? DEFAULT_LEFT_WIDTH);
    }, []),
  });

  // ---------------------------------------------------------------------------
  // Left pane actions
  // ---------------------------------------------------------------------------

  const setLeftPaneTab = setLeftPaneTabRaw;

  const resizeLeftPane = useCallback((delta: number) => {
    setLeftPaneWidth((prev) => clamp(prev + delta, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH));
  }, []);

  // ---------------------------------------------------------------------------
  // Right / Bottom pane resize
  // ---------------------------------------------------------------------------

  const resizeRightPane = useCallback((delta: number) => {
    setRightPaneWidth((prev) => clamp(prev + delta, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH));
  }, []);

  const resizeBottomPane = useCallback((delta: number) => {
    setBottomPaneHeight((prev) => clamp(prev + delta, MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT));
  }, []);

  // ---------------------------------------------------------------------------
  // Persistence effect (skip in compact — transient viewport state)
  // ---------------------------------------------------------------------------

  const presetRef = useRef(preset);
  presetRef.current = preset;

  useEffect(() => {
    if (presetRef.current === 'compact') return;
    savePersistedState({
      centerTree: centerTree.centerTree,
      leftPaneWidth,
      leftPaneTab,
      rightPaneVisible: rightPane.visible,
      rightPaneWidth,
      rightPaneTab: rightPane.tab,
      bottomPaneVisible: bottomPane.visible,
      bottomPaneHeight,
      bottomPaneTab: bottomPane.tab,
    });
  }, [centerTree.centerTree, leftPaneWidth, leftPaneTab, rightPane.visible, rightPaneWidth, rightPane.tab, bottomPane.visible, bottomPaneHeight, bottomPane.tab]);

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
      if (!e.paneId) {
        setActiveLogPaneId(null);
        return;
      }
      // Stale event for a pane removed by workspace reset + remap — ignore.
      if (!findLeafByPaneId(centerTreeSyncRef.current, e.paneId)) return;
      setActiveLogPaneId(e.paneId);
      const tabId = resolveFocusedTab(centerTreeSyncRef.current, e.paneId);
      if (tabId !== null) {
        setFocusedLogviewerTabId(tabId);
      }
    };

    // Left-pane side-effect of session:loaded — set info tab for Bugreport sources.
    // (Tree mutations for session:loaded are handled inside useCenterTree.)
    const onSessionLoaded = (e: { sourceType: string; paneId: string }) => {
      if (isBugreportLike(e.sourceType) && e.paneId === activeLogPaneIdRef.current) {
        setLeftPaneTabRaw('info');
      }
    };

    const onOpenTab = (e: AppEvents['layout:open-tab']) => {
      openCenterTabRef.current(e.type as CenterTabType, e.label, e.filePath, e.editorState);
    };

    const onWorkspaceReset = () => {
      centerTree.clearTree();
      setActiveLogPaneId(null);
      setFocusedLogviewerTabId(null);
    };

    const onRestoreLayout = ({ layout }: { layout: unknown }) => {
      // Write the saved layout blob to localStorage so loadPersistedState
      // can sanitize and validate it, then apply each value to state setters.
      savePersistedState(layout as PersistedState);
      const restored = loadPersistedState();
      if (restored.leftPaneWidth !== undefined) setLeftPaneWidth(restored.leftPaneWidth);
      if (restored.leftPaneTab !== undefined) setLeftPaneTabRaw(restored.leftPaneTab);
      if (restored.rightPaneVisible !== undefined) rightPane.setVisible(restored.rightPaneVisible);
      if (restored.rightPaneWidth !== undefined) setRightPaneWidth(restored.rightPaneWidth);
      if (restored.rightPaneTab !== undefined) rightPane.setTab(restored.rightPaneTab);
      if (restored.bottomPaneVisible !== undefined) bottomPane.setVisible(restored.bottomPaneVisible);
      if (restored.bottomPaneHeight !== undefined) setBottomPaneHeight(restored.bottomPaneHeight);
      if (restored.bottomPaneTab !== undefined) bottomPane.setTab(restored.bottomPaneTab);
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
    leftPaneWidth,
    leftPaneTab,
    setLeftPaneTab,
    resizeLeftPane,

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
    activeLogPaneId,
    setActiveLogPaneId,
    focusLogviewerTab,
    focusedActiveTabType: activeTab?.type ?? null,
    focusedLogviewerTabId,
  } satisfies WorkspaceLayoutState;
}
