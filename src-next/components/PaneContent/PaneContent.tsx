import React from 'react';
import { FileText } from 'lucide-react';
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

function EmptyDropZone() {
  return (
    <div className={styles.dropZone}>
      <div className={styles.dropZoneContent}>
        <div className={styles.dropZoneIcon}>
          <FileText size={48} strokeWidth={1} />
        </div>
        <div className={styles.dropZoneHeading}>Open a log file</div>
        <div className={styles.dropZoneSubtext}>
          Drag a log file here or click Open Log File
        </div>
        <div className={styles.dropZoneHint}>
          Supports logcat, kernel (dmesg), bugreport, and dumpstate files
        </div>
      </div>
    </div>
  );
}

const PaneContent = React.memo(function PaneContent({ pane }: Props) {
  const session = useSession();
  useIsStreaming();
  const isLoading = useIsLoading();
  const { fetchLines } = useLogViewerActions();

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);

  if (!activeTab) {
    return <EmptyDropZone />;
  }

  switch (activeTab.type) {
    case 'logviewer':
      if (!session && !isLoading) {
        return <EmptyDropZone />;
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
