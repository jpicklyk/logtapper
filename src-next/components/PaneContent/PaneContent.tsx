import React, { useCallback } from 'react';
import { FileText } from 'lucide-react';
import { LogViewer } from '../LogViewer';
import { ProcessorDashboard } from '../ProcessorDashboard';
import { ScratchPad } from '../ScratchPad';
import { StreamFilterBar } from '../StreamFilterBar';
import { useSessionForPane, useIsLoadingForPane, useViewerActions, useStreamFilter } from '../../context';
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
  // Use the pane's own session, not the global focused session.
  const session = useSessionForPane(pane.id);
  const isLoading = useIsLoadingForPane(pane.id);
  const { setFocusedPane, setStreamFilter, cancelStreamFilter } = useViewerActions();
  const { fetchLines } = useLogViewerActions(pane.id);
  const { value: filterValue, scanning: filterScanning, filteredLineNums, parseError: filterParseError } = useStreamFilter(pane.id);

  const handlePaneFocus = useCallback(() => {
    setFocusedPane(pane.id);
  }, [pane.id, setFocusedPane]);

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);

  if (!activeTab) {
    return (
      <div onClick={handlePaneFocus} onFocus={handlePaneFocus} style={{ height: '100%' }}>
        <EmptyDropZone />
      </div>
    );
  }

  switch (activeTab.type) {
    case 'logviewer':
      if (!session && !isLoading) {
        return (
          <div onClick={handlePaneFocus} onFocus={handlePaneFocus} style={{ height: '100%' }}>
            <EmptyDropZone />
          </div>
        );
      }
      return (
        <div className={styles.logviewerPane} onClick={handlePaneFocus} onFocus={handlePaneFocus}>
          {session && (
            <StreamFilterBar
              value={filterValue}
              onCommit={setStreamFilter}
              onCancel={cancelStreamFilter}
              matchCount={filteredLineNums?.length ?? null}
              totalLines={session.totalLines}
              parseError={filterParseError}
              scanning={filterScanning}
            />
          )}
          <LogViewer
            paneId={pane.id}
            fetchLines={fetchLines}
            lineNumbers={filteredLineNums ?? undefined}
          />
        </div>
      );

    case 'dashboard':
      return session ? (
        <div onClick={handlePaneFocus} onFocus={handlePaneFocus} style={{ height: '100%' }}>
          <ProcessorDashboard />
        </div>
      ) : (
        <div className={styles.placeholder} onClick={handlePaneFocus} onFocus={handlePaneFocus}>
          Open a log file to see the dashboard.
        </div>
      );

    case 'scratch':
    case 'editor':
      return <ScratchPad />;

    default:
      return null;
  }
});

export default PaneContent;
