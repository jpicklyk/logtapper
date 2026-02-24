import React, { useCallback, useMemo } from 'react';
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
import type {
  WorkspaceLayoutState,
  CenterPane,
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

const LEFT_BOTTOM_ITEMS = [
  { id: 'timeline', icon: Clock, label: 'Timeline' },
  { id: 'correlations', icon: Zap, label: 'Correlations' },
  { id: 'watches', icon: Eye, label: 'Watches' },
];

const RIGHT_TOP_ITEMS = [
  { id: 'processors', icon: Cpu, label: 'Processors' },
  { id: 'marketplace', icon: Store, label: 'Marketplace' },
];

export const AppShell = React.memo(function AppShell({ workspace }: AppShellProps) {
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
    },
    [workspace.setActiveTab],
  );

  const handleTabClose = useCallback(
    (tabId: string, paneId: string) => {
      workspace.closeTab(tabId, paneId);
    },
    [workspace.closeTab],
  );

  const handleSplitResize = useCallback(
    (nodeId: string, ratio: number) => {
      workspace.resizeSplit(nodeId, ratio);
    },
    [workspace.resizeSplit],
  );

  const renderCenterContent = useCallback(
    (pane: CenterPane) => {
      return <PaneContent pane={pane} />;
    },
    [],
  );

  // -- Active bottom tab id for left toolbar bottom group --
  const activeBottomId = useMemo(() => {
    return workspace.bottomPaneVisible ? workspace.bottomPaneTab : null;
  }, [workspace.bottomPaneVisible, workspace.bottomPaneTab]);

  // -- Active right tab id --
  const activeRightId = useMemo(() => {
    return workspace.rightPaneVisible ? workspace.rightPaneTab : null;
  }, [workspace.rightPaneVisible, workspace.rightPaneTab]);

  return (
    <div className={styles.shell}>
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
          <LeftPane activeTab={workspace.leftPaneTab} />
        </ToolPane>
      </div>

      {/* Center area */}
      <div className={styles.center}>
        <CenterArea
          tree={workspace.centerTree}
          renderContent={renderCenterContent}
          onTabActivate={handleTabActivate}
          onTabClose={handleTabClose}
          onSplitResize={handleSplitResize}
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
          topItems={RIGHT_TOP_ITEMS}
          activeTopId={activeRightId}
          activeBottomId={null}
          onTopToggle={handleRightTopToggle}
          position="right"
        />
      </div>

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

      {/* Status bar */}
      <div className={styles.status}>
        <StatusBar />
      </div>
    </div>
  );
});
