import React, { useCallback } from 'react';
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

  const activeBottomId = workspace.bottomPaneVisible ? workspace.bottomPaneTab : null;
  const activeRightId = workspace.rightPaneVisible ? workspace.rightPaneTab : null;

  return (
    <div
      className={styles.shell}
      style={{ '--left-pane-width': `${workspace.leftPaneWidth}px` } as React.CSSProperties}
    >
      <div className={styles.header}>
        <Header />
      </div>

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

      <div className={styles.rtoolbar}>
        <ToolBar
          topItems={rightTopItems}
          activeTopId={activeRightId}
          activeBottomId={null}
          onTopToggle={handleRightTopToggle}
          position="right"
        />
      </div>

      {settingsOpen && (
        <SettingsPanel
          settings={settingsHook.settings}
          onUpdate={settingsHook.updateSetting}
          onReset={settingsHook.resetSettings}
          onClose={closeSettings}
          anonymizerConfig={anonymizerConfig}
        />
      )}

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

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
});
