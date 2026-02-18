import { useAppContext } from '../context/AppContext';
import type { Pane } from '../hooks/usePaneLayout';
import LogViewer from './LogViewer';
import ProcessorPanel from './ProcessorPanel';
import ProcessorDashboard from './ProcessorDashboard';
import ChatPanel from './ChatPanel';
import ProcessorMarketplace from './ProcessorMarketplace';
import FileInfoPanel from './FileInfoPanel';

interface Props {
  pane: Pane;
}

export default function PaneContent({ pane }: Props) {
  const {
    viewer,
    pipeline,
    claude,
    metadata,
    processorViewId,
    sections,
    activeSectionIndex,
    onViewProcessor,
  } = useAppContext();

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  if (!activeTab) return null;

  switch (activeTab.type) {
    case 'logviewer':
      if (!viewer.session && !viewer.loading) {
        return (
          <div className="drop-zone">
            <div className="drop-zone-content">
              <p className="drop-zone-icon">📂</p>
              <p>Drag a log file here or click <strong>Open Log File</strong></p>
              <p className="drop-zone-hint">
                Supports logcat, kernel (dmesg), bugreport, and dumpstate files
              </p>
            </div>
          </div>
        );
      }
      return (
        <LogViewer
          sessionId={viewer.session?.sessionId ?? ''}
          totalLines={viewer.session?.totalLines ?? 0}
          lineCache={viewer.lineCache}
          search={viewer.search ?? undefined}
          onFetchNeeded={viewer.handleFetchNeeded}
          onLineClick={viewer.jumpToLine}
          scrollToLine={viewer.scrollToLine}
          jumpSeq={viewer.jumpSeq}
          processorId={processorViewId ?? undefined}
        />
      );

    case 'processors':
      return (
        <ProcessorPanel
          pipeline={pipeline}
          sessionId={viewer.session?.sessionId ?? null}
        />
      );

    case 'dashboard':
      return viewer.session ? (
        <ProcessorDashboard
          pipeline={pipeline}
          sessionId={viewer.session.sessionId}
          onViewProcessor={onViewProcessor}
          onJumpToLine={viewer.jumpToLine}
        />
      ) : (
        <div className="pane-placeholder">Open a log file to see the dashboard.</div>
      );

    case 'chat':
      return (
        <ChatPanel
          claude={claude}
          sessionId={viewer.session?.sessionId ?? null}
          processorId={processorViewId}
        />
      );

    case 'marketplace':
      return <ProcessorMarketplace pipeline={pipeline} />;

    case 'fileinfo':
      return viewer.session ? (
        <FileInfoPanel
          session={viewer.session}
          sections={sections}
          onJumpToSection={viewer.jumpToLine}
          metadata={metadata}
          activeSectionIndex={activeSectionIndex}
          sectionJumpSeq={viewer.jumpSeq}
        />
      ) : (
        <div className="pane-placeholder">Open a log file to see file info.</div>
      );

    default:
      return null;
  }
}
