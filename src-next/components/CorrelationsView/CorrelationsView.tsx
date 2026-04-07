import React, { useState, useCallback, useEffect, useRef } from 'react';
import { getCorrelatorEvents } from '../../bridge/commands';
import type { CorrelationEvent } from '../../bridge/types';
import {
  useSession,
  useProcessors,
  useActiveProcessorIds,
  useViewerActions,
  useSessionPipelineResults,
} from '../../context';
import css from './CorrelationsView.module.css';

/* ─── CorrelationPanel (internal) ─────────────────────────────────────────── */

interface PanelProps {
  sessionId: string;
  correlatorId: string;
  correlatorName: string;
  onJumpToLine?: (lineNum: number) => void;
  refreshKey: number;
}

const CorrelationPanel = React.memo(function CorrelationPanel({
  sessionId,
  correlatorId,
  correlatorName,
  onJumpToLine,
  refreshKey,
}: PanelProps) {
  const [events, setEvents] = useState<CorrelationEvent[]>([]);
  const [guidance, setGuidance] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const hasDataRef = useRef(false);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getCorrelatorEvents(sessionId, correlatorId);
      setGuidance(result.guidance);
      setEvents(result.events);
      hasDataRef.current = true;
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, correlatorId]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents, refreshKey]);

  if (loading && !hasDataRef.current) {
    return <div className={css.panelEmpty}>Loading...</div>;
  }

  if (error) {
    return <div className={css.panelError}>Error: {error}</div>;
  }

  if (events.length === 0) {
    return (
      <div className={css.panelEmpty}>
        <span>No correlations found</span>
        <span className={css.placeholderSub}>
          Run the pipeline to detect cross-event patterns.
        </span>
      </div>
    );
  }

  return (
    <div className={css.panel}>
      <div className={css.panelHeader}>
        <span className={css.panelTitle}>{correlatorName}</span>
        <span className={css.eventCount}>
          {events.length} event{events.length !== 1 ? 's' : ''}
        </span>
      </div>

      {guidance && (
        <div className={css.guidance}>
          <p className={css.guidanceText}>{guidance}</p>
        </div>
      )}

      <div className={css.eventList}>
        {events.map((evt, idx) => (
          <div key={idx} className={css.event}>
            <div
              className={css.eventHeader}
              onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
            >
              <div className={css.eventLine}>
                <button
                  className={css.lineLink}
                  title={`Jump to line ${evt.triggerLineNum}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onJumpToLine?.(evt.triggerLineNum);
                  }}
                >
                  #{evt.triggerLineNum}
                </button>
                <span className={css.sourceBadge}>{evt.triggerSourceId}</span>
              </div>
              <div className={css.eventMsg}>{evt.message}</div>
              <div className={css.expandIcon}>
                {expandedIdx === idx ? '\u25B2' : '\u25BC'}
              </div>
            </div>

            {expandedIdx === idx && (
              <div className={css.eventDetail}>
                {/* Trigger raw line */}
                <div className={css.section}>
                  <div className={css.sectionLabel}>
                    <span className={css.sourceBadge}>{evt.triggerSourceId}</span>
                    line #{evt.triggerLineNum}
                  </div>
                  <div className={css.rawLine}>{evt.triggerRawLine}</div>
                </div>

                {/* Matched source records */}
                {Object.entries(evt.matchedSources).map(([sourceId, records]) => (
                  <div className={css.section} key={sourceId}>
                    <div className={css.sectionLabel}>
                      <span className={css.sourceBadge}>{sourceId}</span>
                      {records.length} match{records.length !== 1 ? 'es' : ''} in window
                    </div>
                    {records.slice(-3).map((rec, ri) => (
                      <div className={css.matchBlock} key={ri}>
                        <button
                          className={css.lineLink}
                          title={`Jump to line ${rec.lineNum}`}
                          onClick={() => onJumpToLine?.(rec.lineNum)}
                        >
                          #{rec.lineNum}
                        </button>
                        <div className={css.rawLine}>{rec.rawLine}</div>
                        {Object.keys(rec.fields).length > 0 && (
                          <div className={css.fieldPills}>
                            {Object.entries(rec.fields).map(([k, v]) => (
                              <span key={k} className={css.fieldPill}>
                                {k}={String(v)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});

/* ─── CorrelationsView ────────────────────────────────────────────────────── */

const CorrelationsView = React.memo(function CorrelationsView() {
  const session = useSession();
  const processors = useProcessors();
  const activeProcessorIds = useActiveProcessorIds();
  const { runCount } = useSessionPipelineResults();
  const { jumpToLine } = useViewerActions();

  const sessionId = session?.sessionId ?? '';
  const activeIdSet = new Set(activeProcessorIds);

  const activeCorrelators = processors.filter(
    (p) => p.processorType === 'correlator' && activeIdSet.has(p.id),
  );

  if (!session) {
    return (
      <div className={css.placeholder}>
        <span>Open a log file to use correlators.</span>
      </div>
    );
  }

  if (activeCorrelators.length === 0) {
    return (
      <div className={css.placeholder}>
        <span>No correlators in the pipeline chain.</span>
        <span className={css.placeholderSub}>
          Add a correlator processor and run the pipeline to detect cross-event patterns.
        </span>
      </div>
    );
  }

  return (
    <div className={css.root}>
      {activeCorrelators.map((proc) => (
        <CorrelationPanel
          key={proc.id}
          sessionId={sessionId}
          correlatorId={proc.id}
          correlatorName={proc.name}
          onJumpToLine={jumpToLine}
          refreshKey={runCount}
        />
      ))}
    </div>
  );
});

export default CorrelationsView;
