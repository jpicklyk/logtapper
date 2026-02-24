import React from 'react';
import { LogViewer } from '../LogViewer';
import { ProcessorDashboard } from '../ProcessorDashboard';
import { ScratchPad } from '../ScratchPad';
import { useSession, useIsStreaming, useIsLoading } from '../../context';
import { useLogViewerActions } from './useLogViewerActions';
import styles from './PaneContent.module.css';

export interface PaneTab {
  id: string;
  type: 'logviewer' | 'dashboard' | 'scratch' | 'editor';
}

export interface Pane {
  id: string;
  tabs: PaneTab[];
  activeTabId: string;
}

interface Props {
  pane: Pane;
}

const PaneContent = React.memo(function PaneContent({ pane }: Props) {
  const session = useSession();
  useIsStreaming();
  const isLoading = useIsLoading();
  const { fetchLines } = useLogViewerActions();

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);

  if (!activeTab) {
    return (
      <div className={styles.dropZone}>
        <div className={styles.dropZoneContent}>
          <p className={styles.dropZoneIcon}>Open a log file</p>
          <p>Drag a log file here or click Open Log File</p>
          <p className={styles.dropZoneHint}>
            Supports logcat, kernel (dmesg), bugreport, and dumpstate files
          </p>
        </div>
      </div>
    );
  }

  switch (activeTab.type) {
    case 'logviewer':
      if (!session && !isLoading) {
        return (
          <div className={styles.dropZone}>
            <div className={styles.dropZoneContent}>
              <p className={styles.dropZoneIcon}>Open a log file</p>
              <p>Drag a log file here or click Open Log File</p>
              <p className={styles.dropZoneHint}>
                Supports logcat, kernel (dmesg), bugreport, and dumpstate files
              </p>
            </div>
          </div>
        );
      }
      return (
        <div className={styles.logviewerPane}>
          <LogViewer
            paneId={pane.id}
            fetchLines={fetchLines}
          />
        </div>
      );

    case 'dashboard':
      return session ? (
        <ProcessorDashboard />
      ) : (
        <div className={styles.placeholder}>Open a log file to see the dashboard.</div>
      );

    case 'scratch':
    case 'editor':
      return <ScratchPad />;

    default:
      return null;
  }
});

export default PaneContent;
