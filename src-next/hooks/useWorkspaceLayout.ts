import { useCallback, useEffect, useRef, useState } from 'react';
import { isBugreportLike } from '../bridge/types';
import { storageRemove } from '../utils';
import { bus } from '../events/bus';
import { useTogglePane } from './useTogglePane';
import { useSessionContext, useSessionPaneCtx } from '../context/SessionContext';
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

  // Focus tracking — activeLogPaneId is the canonical value from SessionContext
  // (updated via session:focused bus event). We keep a ref for synchronous reads
  // inside useCenterTree and event handlers without subscribing to the broader
  // SessionContext updates from this hook.
  const { activeLogPaneId } = useSessionPaneCtx();
  const activeLogPaneIdRef = useRef<string | null>(activeLogPaneId);
  activeLogPaneIdRef.current = activeLogPaneId;

  // paneSessionMap from SessionContext
  const { paneSessionMap, activateSessionForPane } = useSessionContext();
  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;

  // The specific logviewer tab showing the focus marker (blue underline).
  // Updated when a logviewer tab is activated or when focus moves to a new pane.
  const [focusedLogviewerTabId, setFocusedLogviewerTabId] = useState<string | null>(null);

  const focusLogviewerTab = useCallback((tabId: string, paneId: string) => {
    // Emit session:focused so SessionContext (the canonical owner) updates.
    // Look up sessionId via ref (avoids stale closure, keeps callback stable).
    const sessionId = paneSessionMapRef.current.get(paneId) ?? null;
    bus.emit('session:focused', { sessionId, paneId });
    setFocusedLogviewerTabId(tabId);
  }, []);

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
      // activeLogPaneId is owned by SessionContext — no local state to update here.
      // Only update the focused tab marker (blue underline) which is layout-local.
      if (e.paneId) {
        setFocusedLogviewerTabId(resolveFocusedTab(centerTreeSyncRef.current, e.paneId));
      }
    };

    // Left-pane side-effect of session:loaded — set info tab for Bugreport sources.
    // (Tree mutations for session:loaded are handled inside useCenterTree.)
    const onSessionLoaded = (e: { sourceType: string; paneId: string }) => {
      if (isBugreportLike(e.sourceType) && e.paneId === activeLogPaneIdRef.current) {
        setLeftPaneTabRaw('info');
      }
    };

    const onOpenTab = (e: { type: string; label?: string; filePath?: string }) => {
      openCenterTabRef.current(e.type as CenterTabType, e.label, e.filePath);
    };

    bus.on('session:focused', onSessionFocused);
    bus.on('session:loaded', onSessionLoaded);
    bus.on('layout:open-tab', onOpenTab);
    return () => {
      bus.off('session:focused', onSessionFocused);
      bus.off('session:loaded', onSessionLoaded);
      bus.off('layout:open-tab', onOpenTab);
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
    focusLogviewerTab,
    focusedActiveTabType: activeTab?.type ?? null,
    focusedLogviewerTabId,
  } satisfies WorkspaceLayoutState;
}
