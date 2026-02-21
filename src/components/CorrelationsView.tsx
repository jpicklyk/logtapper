import { useAppContext } from '../context/AppContext';
import CorrelationPanel from './CorrelationPanel';

/**
 * Center-pane tab content for the Correlations tab.
 * Shows one CorrelationPanel per active correlator processor in the pipeline chain.
 */
export default function CorrelationsView() {
  const { viewer, pipeline } = useAppContext();

  const sessionId = viewer.session?.sessionId ?? '';

  // All correlators that are currently in the active pipeline chain.
  const activeCorrelators = pipeline.processors.filter(
    (p) => p.processorType === 'correlator' && pipeline.activeProcessorIds.has(p.id),
  );

  if (!viewer.session) {
    return (
      <div className="corr-view-placeholder">
        <span className="corr-empty-icon">🔗</span>
        <span>Open a log file to use correlators.</span>
      </div>
    );
  }

  if (activeCorrelators.length === 0) {
    return (
      <div className="corr-view-placeholder">
        <span className="corr-empty-icon">🔗</span>
        <span>No correlators in the pipeline chain.</span>
        <span className="corr-empty-sub">
          Add a correlator processor and run the pipeline to detect cross-event patterns.
        </span>
      </div>
    );
  }

  return (
    <div className="corr-view">
      {activeCorrelators.map((proc) => (
        <CorrelationPanel
          key={proc.id}
          sessionId={sessionId}
          correlatorId={proc.id}
          correlatorName={proc.name}
          onJumpToLine={viewer.jumpToLine}
          refreshKey={pipeline.runCount}
        />
      ))}
    </div>
  );
}
