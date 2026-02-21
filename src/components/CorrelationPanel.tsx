import { useEffect, useState, useCallback } from 'react';
import { getCorrelatorEvents } from '../bridge/commands';
import type { CorrelationEvent } from '../bridge/types';

interface Props {
  sessionId: string;
  correlatorId: string;
  correlatorName: string;
  /** Called when user clicks on a line number to jump to it. */
  onJumpToLine?: (lineNum: number) => void;
  /** Refresh key — increment to force a re-fetch. */
  refreshKey?: number;
}

export default function CorrelationPanel({
  sessionId,
  correlatorId,
  correlatorName,
  onJumpToLine,
  refreshKey = 0,
}: Props) {
  const [events, setEvents] = useState<CorrelationEvent[]>([]);
  const [guidance, setGuidance] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getCorrelatorEvents(sessionId, correlatorId);
      setGuidance(result.guidance);
      setEvents(result.events);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, correlatorId]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents, refreshKey]);

  if (loading && events.length === 0) {
    return <div className="corr-panel corr-panel--empty">Loading…</div>;
  }

  if (error) {
    return <div className="corr-panel corr-panel--error">Error: {error}</div>;
  }

  if (events.length === 0) {
    return (
      <div className="corr-panel corr-panel--empty">
        <span className="corr-empty-icon">🔗</span>
        <span>No correlations found</span>
        <span className="corr-empty-sub">Run the pipeline to detect cross-event patterns.</span>
      </div>
    );
  }

  return (
    <div className="corr-panel">
      <div className="corr-panel-header">
        <span className="corr-panel-title">{correlatorName}</span>
        <span className="corr-event-count">{events.length} event{events.length !== 1 ? 's' : ''}</span>
      </div>

      {guidance && (
        <div className="corr-guidance">
          <span className="corr-guidance-icon">💡</span>
          <p className="corr-guidance-text">{guidance}</p>
        </div>
      )}

      <div className="corr-event-list">
        {events.map((evt, idx) => (
          <div
            key={idx}
            className={`corr-event${expandedIdx === idx ? ' corr-event--expanded' : ''}`}
          >
            {/* Header row */}
            <div className="corr-event-header" onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}>
              <div className="corr-event-line">
                <button
                  className="corr-line-link"
                  title={`Jump to line ${evt.triggerLineNum}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onJumpToLine?.(evt.triggerLineNum);
                  }}
                >
                  #{evt.triggerLineNum}
                </button>
                <span className="corr-source-badge">{evt.triggerSourceId}</span>
              </div>
              <div className="corr-event-msg">{evt.message}</div>
              <div className="corr-expand-icon">
                {expandedIdx === idx ? '▲' : '▼'}
              </div>
            </div>

            {/* Expanded detail */}
            {expandedIdx === idx && (
              <div className="corr-event-detail">

                {/* Trigger raw line */}
                <div className="corr-section">
                  <div className="corr-section-label">
                    <span className="corr-source-badge">{evt.triggerSourceId}</span>
                    line #{evt.triggerLineNum}
                  </div>
                  <div className="corr-raw-line">{evt.triggerRawLine}</div>
                </div>

                {/* Matched source records */}
                {Object.entries(evt.matchedSources).map(([sourceId, records]) => (
                  <div className="corr-section" key={sourceId}>
                    <div className="corr-section-label">
                      <span className="corr-source-badge">{sourceId}</span>
                      {records.length} match{records.length !== 1 ? 'es' : ''} in window
                    </div>
                    {records.slice(-3).map((rec, ri) => (
                      <div className="corr-match-block" key={ri}>
                        <button
                          className="corr-line-link"
                          title={`Jump to line ${rec.lineNum}`}
                          onClick={() => onJumpToLine?.(rec.lineNum)}
                        >
                          #{rec.lineNum}
                        </button>
                        <div className="corr-raw-line">{rec.rawLine}</div>
                        {Object.keys(rec.fields).length > 0 && (
                          <div className="corr-field-pills">
                            {Object.entries(rec.fields).map(([k, v]) => (
                              <span key={k} className="corr-field-pill">
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
}
