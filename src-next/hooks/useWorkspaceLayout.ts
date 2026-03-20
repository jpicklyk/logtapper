import { useCallback, useEffect, useRef, useState } from 'react';
import { isBugreportLike } from '../bridge/types';
import { storageRemove } from '../utils';
import { bus } from '../events/bus';
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
} from './workspace';
import type { CenterTabType } from './workspace';

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
    setRightPaneWidth((prev) => clamp(prev - delta, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH));
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

  const centerTreeRef = useRef(centerTree.centerTree);
  centerTreeRef.current = centerTree.centerTree;

  const openCenterTabRef = useRef(centerTree.openCenterTab);
  openCenterTabRef.current = centerTree.openCenterTab;

  useEffect(() => {
    const onSessionFocused = (e: { paneId: string | null }) => {
      setActiveLogPaneId(e.paneId);
      // When focus moves to a pane, mark its active logviewer tab as focused.
      // Prefer the active tab; fall back to the first logviewer tab in the pane.
      if (e.paneId) {
        const leaf = findLeafByPaneId(centerTreeRef.current, e.paneId);
        if (leaf) {
          const active = leaf.pane.tabs.find((t) => t.id === leaf.pane.activeTabId);
          if (active?.type === 'logviewer') {
            setFocusedLogviewerTabId(active.id);
          } else {
            const firstLogviewer = leaf.pane.tabs.find((t) => t.type === 'logviewer');
            setFocusedLogviewerTabId(firstLogviewer?.id ?? null);
          }
        }
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
    setActiveLogPaneId,
    focusLogviewerTab,
    focusedActiveTabType: activeTab?.type ?? null,
    focusedLogviewerTabId,
  } satisfies WorkspaceLayoutState;
}
