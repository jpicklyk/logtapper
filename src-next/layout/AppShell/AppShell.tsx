import React, { useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  Activity,
  Bookmark,
  PenLine,
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
import { Toast } from '../../ui';
import { useAppShellSetup } from './useAppShellSetup';
import { useToolbarItems } from './useToolbarItems';
import { useCenterPortals } from './useCenterPortals';
import type {
  WorkspaceLayoutState,
  LeftPaneTab,
  BottomTabType,
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

const RIGHT_BOTTOM_ITEMS: { id: string; icon: React.ComponentType<{ size?: number | string }>; label: string }[] = [];

export const AppShell = React.memo(function AppShell({ workspace }: AppShellProps) {
  const { settingsHook, anonymizerConfig, settingsOpen, closeSettings, toasts, dismissToast } =
    useAppShellSetup({ openCenterTab: workspace.openCenterTab });

  const { leftBottomItems, rightTopItems } = useToolbarItems({
    bottomPaneVisible: workspace.bottomPaneVisible,
    bottomPaneTab: workspace.bottomPaneTab,
  });

  const { contentRefsRef, handleContentRef, currentPanes, handleTabActivate, handleTabAdd } =
    useCenterPortals({
      centerTree: workspace.centerTree,
      setActiveTab: workspace.setActiveTab,
      focusLogviewerTab: workspace.focusLogviewerTab,
      addCenterTab: workspace.addCenterTab,
    });

  // Destructure stable callbacks from workspace so PaneContent's React.memo
  // compares the actual function refs (stable useCallback refs from useCenterTree)
  // rather than fields of a freshly-created workspace object.
  // renameTab and setTabUnsaved are useCallback([]) — they never change.
  const { setTabUnsaved, renameTab } = workspace;

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

  const handleRightBottomToggle = useCallback((_id: string) => {
    // No right-bottom items currently — settings moved to Header
  }, []);

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
          bottomItems={leftBottomItems}
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
          onResize={workspace.resizeLeftPane}
        >
          <LeftPane
            activeTab={workspace.leftPaneTab}
            displayPaneId={workspace.activeLogPaneId}
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
          onTabClose={workspace.closeTab}
          onTabAdd={handleTabAdd}
          onTabRename={workspace.renameTab}
          onSplitResize={workspace.resizeSplit}
          onTabDrop={workspace.dropTabOnPane}
          onTabReorder={workspace.reorderTab}
        />
      </div>

      {/* Right pane */}
      <div className={styles.right}>
        <ToolPane
          position="right"
          visible={workspace.rightPaneVisible}
          size={workspace.rightPaneWidth}
          onResize={workspace.resizeRightPane}
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
          onClose={closeSettings}
          anonymizerConfig={anonymizerConfig}
        />
      )}

      {/* Bottom pane */}
      <div className={styles.bottom}>
        <ToolPane
          position="bottom"
          visible={workspace.bottomPaneVisible}
          size={workspace.bottomPaneHeight}
          onResize={workspace.resizeBottomPane}
        >
          <BottomPane activeTab={workspace.bottomPaneTab} />
        </ToolPane>
      </div>

      {/* Status bar: always show info for the last-focused log pane */}
      <div className={styles.status}>
        <StatusBar activeLogPaneId={workspace.activeLogPaneId} />
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
            onDirtyChanged={setTabUnsaved}
            onFilePathChanged={renameTab}
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
