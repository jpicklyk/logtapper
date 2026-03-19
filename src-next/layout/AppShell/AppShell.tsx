import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  Activity,
  Bookmark,
  PenLine,
  Clock,
  Zap,
  Eye,
  Cpu,
  Store,
  Settings,
} from 'lucide-react';
import { ToolBar } from '../ToolBar';
import { ToolPane } from '../ToolPane';
import { CenterArea } from '../CenterArea';
import { StatusBar } from '../StatusBar';
import { Header } from '../../components/Header';
import { LeftPane } from '../../components/LeftPane';
import { RightPane } from '../../components/RightPane';
import { BottomPane } from '../../components/BottomPane';
import { PaneContent } from '../../components/PaneContent';
import { SettingsPanel } from '../../components/SettingsPanel';
import { useSettings, useAnonymizerConfig, useToast, useAnalysisToast, useWorkspaceRestoreToast, useFileShortcuts } from '../../hooks';
import { useCacheManager } from '../../cache';
import { Toast } from '../../ui';
import { findTabAcrossTree, allPanes } from '../../hooks/workspace/splitTreeHelpers';
import { usePendingUpdateCount, useViewerActions } from '../../context';
import type {
  WorkspaceLayoutState,
  LeftPaneTab,
  BottomTabType,
  DropZone,
} from '../../hooks';
import styles from './AppShell.module.css';

interface AppShellProps {
  workspace: WorkspaceLayoutState;
}

// -- Static toolbar item definitions --

const LEFT_TOP_ITEMS = [
  { id: 'info', icon: FileText, label: 'Info' },
  { id: 'state', icon: Activity, label: 'State' },
  { id: 'bookmarks', icon: Bookmark, label: 'Bookmarks' },
  { id: 'analysis', icon: PenLine, label: 'Analysis' },
];

const LEFT_BOTTOM_ITEMS = [
  { id: 'timeline', icon: Clock, label: 'Timeline' },
  { id: 'correlations', icon: Zap, label: 'Correlations' },
  { id: 'watches', icon: Eye, label: 'Watches' },
];

const RIGHT_BOTTOM_ITEMS = [
  { id: 'settings', icon: Settings, label: 'Settings' },
];

export const AppShell = React.memo(function AppShell({ workspace }: AppShellProps) {
  const settingsHook = useSettings();
  const anonymizerConfig = useAnonymizerConfig();
  const cacheManager = useCacheManager();
  const { toasts, addToast, dismissToast } = useToast();
  useAnalysisToast(addToast);
  useWorkspaceRestoreToast(addToast);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const updateBadgeCount = usePendingUpdateCount();
  const { openFileDialog, openInEditorDialog, saveFile, saveFileAs, exportSession } = useViewerActions();
  useFileShortcuts({ openFileDialog, openInEditorDialog, saveFile, saveFileAs, exportSession });

  const rightTopItems = useMemo(
    () => [
      { id: 'processors', icon: Cpu, label: 'Processors' },
      { id: 'marketplace', icon: Store, label: 'Marketplace', badge: updateBadgeCount > 0 ? updateBadgeCount : undefined },
    ],
    [updateBadgeCount],
  );

  const centerTreeRef = useRef(workspace.centerTree);
  centerTreeRef.current = workspace.centerTree;

  // -- Portal mount points --
  // Map pane.id → the mount div inside each LeafPane.
  // PaneContent components are rendered here (AppShell level) and portaled in,
  // so structural tree changes (1→2 panes, 2→1) never unmount them.
  const contentRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [, forcePortals] = useReducer((x: number) => x + 1, 0);

  const handleContentRef = useCallback((paneId: string, el: HTMLDivElement | null) => {
    if (el) {
      contentRefsRef.current.set(paneId, el);
      // Only trigger re-render when a mount div becomes available (el !== null).
      // Skipping forcePortals on null prevents PaneContent from unmounting during
      // React StrictMode's cleanup→remount cycle, which caused an apparent
      // performance regression (file reload on every initial mount).
      // The portal stays pointed at the now-detached div until the next natural
      // re-render (triggered by the subsequent el !== null callback) updates it.
      forcePortals();
    } else {
      contentRefsRef.current.delete(paneId);
    }
  }, []);

  const currentPanes = useMemo(
    () => allPanes(workspace.centerTree),
    [workspace.centerTree],
  );

  // Sync fileCacheBudget setting → CacheManager whenever it changes
  useEffect(() => {
    cacheManager.setTotalBudget(settingsHook.settings.fileCacheBudget);
  }, [cacheManager, settingsHook.settings.fileCacheBudget]);

  // -- Left toolbar handlers --
  const handleLeftTopToggle = useCallback(
    (id: string) => {
      workspace.setLeftPaneTab(id as LeftPaneTab);
    },
    [workspace.setLeftPaneTab],
  );

  const handleLeftBottomToggle = useCallback(
    (id: string) => {
      workspace.toggleBottomPane(id as BottomTabType);
    },
    [workspace.toggleBottomPane],
  );

  // -- Right toolbar handler --
  const handleRightTopToggle = useCallback(
    (id: string) => {
      workspace.toggleRightPane(id as 'processors' | 'marketplace');
    },
    [workspace.toggleRightPane],
  );

  const handleRightBottomToggle = useCallback((id: string) => {
    if (id === 'settings') setSettingsOpen(true);
  }, []);

  // -- Resize handlers --
  const handleLeftResize = useCallback(
    (delta: number) => {
      workspace.resizeLeftPane(delta);
    },
    [workspace.resizeLeftPane],
  );

  const handleRightResize = useCallback(
    (delta: number) => {
      workspace.resizeRightPane(delta);
    },
    [workspace.resizeRightPane],
  );

  const handleBottomResize = useCallback(
    (delta: number) => {
      workspace.resizeBottomPane(delta);
    },
    [workspace.resizeBottomPane],
  );

  // -- Center area callbacks --
  const handleTabActivate = useCallback(
    (tabId: string, paneId: string) => {
      workspace.setActiveTab(tabId, paneId);
      // Only move focus when activating a logviewer tab — utility tabs
      // (dashboard, editor) display data for the already-focused session
      // and should not steal the focus marker from the logviewer tab.
      const found = findTabAcrossTree(centerTreeRef.current, tabId);
      if (found?.tab.type === 'logviewer') {
        workspace.focusLogviewerTab(tabId, paneId);
      }
    },
    [workspace.setActiveTab, workspace.focusLogviewerTab],
  );

  const handleTabClose = useCallback(
    (tabId: string, paneId: string) => {
      workspace.closeTab(tabId, paneId);
    },
    [workspace.closeTab],
  );

  const handleTabAdd = useCallback(
    (paneId: string) => {
      workspace.addCenterTab(paneId, 'editor');
    },
    [workspace.addCenterTab],
  );

  const handleSplitResize = useCallback(
    (nodeId: string, ratio: number) => {
      workspace.resizeSplit(nodeId, ratio);
    },
    [workspace.resizeSplit],
  );

  const handleTabDrop = useCallback(
    (tabId: string, fromPaneId: string, toPaneId: string, zone: DropZone) => {
      workspace.dropTabOnPane(tabId, fromPaneId, toPaneId, zone);
    },
    [workspace.dropTabOnPane],
  );

  const handleTabRename = useCallback(
    (tabId: string, newLabel: string) => {
      workspace.renameTab(tabId, newLabel);
    },
    [workspace.renameTab],
  );

  const handleTabReorder = useCallback(
    (paneId: string, fromIndex: number, toIndex: number) => {
      workspace.reorderTab(paneId, fromIndex, toIndex);
    },
    [workspace.reorderTab],
  );

  // renderCenterContent removed — pane content is now rendered as portals below.

  // -- Active bottom tab id for left toolbar bottom group --
  const activeBottomId = useMemo(() => {
    return workspace.bottomPaneVisible ? workspace.bottomPaneTab : null;
  }, [workspace.bottomPaneVisible, workspace.bottomPaneTab]);

  // -- Active right tab id --
  const activeRightId = useMemo(() => {
    return workspace.rightPaneVisible ? workspace.rightPaneTab : null;
  }, [workspace.rightPaneVisible, workspace.rightPaneTab]);

  return (
    <div
      className={styles.shell}
      style={{ '--left-pane-width': `${workspace.leftPaneWidth}px` } as React.CSSProperties}
    >
      {/* Header */}
      <div className={styles.header}>
        <Header />
      </div>

      {/* Left toolbar */}
      <div className={styles.ltoolbar}>
        <ToolBar
          topItems={LEFT_TOP_ITEMS}
          bottomItems={LEFT_BOTTOM_ITEMS}
          activeTopId={workspace.leftPaneTab}
          activeBottomId={activeBottomId}
          onTopToggle={handleLeftTopToggle}
          onBottomToggle={handleLeftBottomToggle}
          position="left"
        />
      </div>

      {/* Left pane */}
      <div className={styles.left}>
        <ToolPane
          position="left"
          visible={true}
          size={workspace.leftPaneWidth}
          onResize={handleLeftResize}
        >
          <LeftPane
            activeTab={workspace.leftPaneTab}
            displayPaneId={workspace.focusedActiveTabType === 'logviewer' ? workspace.focusedPaneId : null}
          />
        </ToolPane>
      </div>

      {/* Center area */}
      <div className={styles.center}>
        <CenterArea
          tree={workspace.centerTree}
          focusedLogviewerTabId={workspace.focusedLogviewerTabId}
          onContentRef={handleContentRef}
          onTabActivate={handleTabActivate}
          onTabClose={handleTabClose}
          onTabAdd={handleTabAdd}
          onTabRename={handleTabRename}
          onSplitResize={handleSplitResize}
          onTabDrop={handleTabDrop}
          onTabReorder={handleTabReorder}
        />
      </div>

      {/* Right pane */}
      <div className={styles.right}>
        <ToolPane
          position="right"
          visible={workspace.rightPaneVisible}
          size={workspace.rightPaneWidth}
          onResize={handleRightResize}
        >
          <RightPane activeTab={workspace.rightPaneTab} />
        </ToolPane>
      </div>

      {/* Right toolbar */}
      <div className={styles.rtoolbar}>
        <ToolBar
          topItems={rightTopItems}
          bottomItems={RIGHT_BOTTOM_ITEMS}
          activeTopId={activeRightId}
          activeBottomId={null}
          onTopToggle={handleRightTopToggle}
          onBottomToggle={handleRightBottomToggle}
          position="right"
        />
      </div>

      {/* Settings modal */}
      {settingsOpen && (
        <SettingsPanel
          settings={settingsHook.settings}
          onUpdate={settingsHook.updateSetting}
          onReset={settingsHook.resetSettings}
          onClose={() => setSettingsOpen(false)}
          anonymizerConfig={anonymizerConfig}
        />
      )}

      {/* Bottom pane */}
      <div className={styles.bottom}>
        <ToolPane
          position="bottom"
          visible={workspace.bottomPaneVisible}
          size={workspace.bottomPaneHeight}
          onResize={handleBottomResize}
        >
          <BottomPane activeTab={workspace.bottomPaneTab} />
        </ToolPane>
      </div>

      {/* Status bar: only show session info when a log-backed tab is active */}
      <div className={styles.status}>
        <StatusBar
          focusedPaneId={
            workspace.focusedActiveTabType === 'logviewer' ? workspace.focusedPaneId : null
          }
        />
      </div>

      {/* Pane content portals — rendered here (AppShell level) so structural
          tree changes (1↔2 panes, split/collapse) never unmount PaneContent or
          LogViewer. Each portal injects its content into the matching LeafPane's
          paneContentMount div via the ref registered by handleContentRef. */}
      {currentPanes.map((pane) => {
        const container = contentRefsRef.current.get(pane.id);
        if (!container) return null;
        return createPortal(
          <PaneContent
            pane={pane}
            onDirtyChanged={workspace.setTabUnsaved}
            onFilePathChanged={workspace.renameTab}
          />,
          container,
          pane.id,
        );
      })}

      {/* Toast notifications (e.g. MCP-published analyses) */}
      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
});
