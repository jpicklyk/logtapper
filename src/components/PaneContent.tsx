import { useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import type { Pane } from '../hooks/usePaneLayout';
import LogViewer from './LogViewer';
import StreamFilterBar from './StreamFilterBar';
import ProcessorDashboard from './ProcessorDashboard';
import ScratchPad from './ScratchPad';
import StateTimeline from './StateTimeline';
import CorrelationsView from './CorrelationsView';

interface Props {
  pane: Pane;
}

export default function PaneContent({ pane }: Props) {
  const {
    viewer,
    pipeline,
    stateTracker,
    processorViewId,
    onViewProcessor,
    setSelectedLineNum,
  } = useAppContext();

  const handleLineClick = useCallback((lineNum: number) => {
    viewer.jumpToLine(lineNum);
    setSelectedLineNum(lineNum);
  }, [viewer, setSelectedLineNum]);

  const handleCopyAll = useCallback(() => {
    const cache = viewer.filterLineCache;
    const nums = viewer.filteredLineNums;
    if (!nums || cache.size === 0) return;
    const text = nums
      .map((n) => cache.get(n)?.raw ?? '')
      .filter(Boolean)
      .join('\n');
    navigator.clipboard.writeText(text).catch(console.error);
  }, [viewer.filterLineCache, viewer.filteredLineNums]);

  // Merge stream filter (filteredLineNums) and time range filter (timeFilterLineNums).
  // When both are active, show only lines that satisfy both (intersection).
  const sf = viewer.filteredLineNums;
  const tf = viewer.timeFilterLineNums;
  let effectiveLineNums: number[] | undefined;
  if (sf !== null && tf !== null) {
    const sfSet = new Set(sf);
    effectiveLineNums = tf.filter((n) => sfSet.has(n));
  } else if (sf !== null) {
    effectiveLineNums = sf;
  } else if (tf !== null) {
    effectiveLineNums = tf;
  } else {
    effectiveLineNums = undefined;
  }

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  if (!activeTab) {
    // No tabs — show the drop zone (same as empty logviewer)
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
        <div className="logviewer-pane">
          {viewer.session && (
            <StreamFilterBar
              value={viewer.streamFilter}
              onChange={viewer.setStreamFilter}
              matchCount={viewer.filteredLineNums?.length ?? null}
              totalCount={viewer.session?.totalLines ?? 0}
              parseError={viewer.filterParseError}
              scanning={viewer.filterScanning}
              onCopyAll={viewer.filteredLineNums ? handleCopyAll : undefined}
            />
          )}
          <LogViewer
            sessionId={viewer.session?.sessionId ?? ''}
            totalLines={viewer.session?.totalLines ?? 0}
            streamCache={viewer.streamCache}
            fetchLines={viewer.fetchLines}
            search={viewer.search ?? undefined}
            onLineClick={handleLineClick}
            scrollToLine={viewer.scrollToLine}
            jumpSeq={viewer.jumpSeq}
            processorId={processorViewId ?? undefined}
            isStreaming={viewer.isStreaming}
            lineNumbers={effectiveLineNums}
            filterLineCache={viewer.filterLineCache}
            transitionLineNums={stateTracker.allTransitionLineNums.size > 0 ? stateTracker.allTransitionLineNums : undefined}
            transitionsByLine={stateTracker.allTransitionLineNums.size > 0 ? stateTracker.transitionsByLine : undefined}
          />
          {viewer.indexingProgress !== null && (
            <div className="indexing-progress">
              <div
                className="indexing-progress-fill"
                style={{ width: `${Math.min(100, viewer.indexingProgress.percent)}%` }}
              />
            </div>
          )}
        </div>
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

    case 'scratch':
      return <ScratchPad />;

    case 'statetimeline':
      return <StateTimeline />;

    case 'correlations':
      return <CorrelationsView />;

    default:
      return null;
  }
}
