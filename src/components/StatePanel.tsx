import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import type { StateSnapshot } from '../bridge/types';

interface TrackerState {
  trackerId: string;
  trackerName: string;
  snapshot: StateSnapshot | null;
  loading: boolean;
}

function FieldValue({ value, initialized }: { value: unknown; initialized: boolean }) {
  if (!initialized) {
    return <span className="sf-unknown">unknown</span>;
  }
  if (value === null || value === undefined || value === '') {
    return <span className="sf-empty">(empty)</span>;
  }
  if (typeof value === 'boolean') {
    return (
      <span className={`sf-bool ${value ? 'sf-bool-true' : 'sf-bool-false'}`}>
        {value ? 'TRUE' : 'FALSE'}
      </span>
    );
  }
  if (typeof value === 'number') {
    return <span className="sf-num">{String(value)}</span>;
  }
  const str = String(value);
  return <span className="sf-str" title={str}>{str}</span>;
}

export default function StatePanel() {
  const { viewer, pipeline, stateTracker, selectedLineNum } = useAppContext();
  const [trackerStates, setTrackerStates] = useState<TrackerState[]>([]);

  // True once we've completed at least one successful fetch for the current
  // session. While true, subsequent fetches update silently (no loading flash).
  const hasDataRef = useRef(false);

  const activeTrackers = pipeline.processors.filter(
    (p) => p.processorType === 'state_tracker' && pipeline.activeProcessorIds.has(p.id),
  );

  useEffect(() => {
    if (!viewer.session || activeTrackers.length === 0) {
      setTrackerStates([]);
      hasDataRef.current = false;
      return;
    }
    const sessionId = viewer.session.sessionId;
    const lineNum = selectedLineNum ?? 0;

    // Only show skeleton loading rows on the VERY FIRST fetch (no data yet).
    // All subsequent fetches — including the high-frequency ticks from streaming
    // runCount increments — happen silently so the UI never flickers.
    if (!hasDataRef.current) {
      setTrackerStates(
        activeTrackers.map((t) => ({
          trackerId: t.id,
          trackerName: t.name,
          snapshot: null,
          loading: true,
        })),
      );
    }

    Promise.allSettled(
      activeTrackers.map((t) =>
        stateTracker.getSnapshot(sessionId, t.id, lineNum).then((snap) => ({
          trackerId: t.id,
          trackerName: t.name,
          snapshot: snap,
          loading: false,
        })),
      ),
    ).then((results) => {
      const next: TrackerState[] = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        return {
          trackerId: activeTrackers[i].id,
          trackerName: activeTrackers[i].name,
          snapshot: null,
          loading: false,
        };
      });

      hasDataRef.current = true;

      // Bail out entirely if the snapshots haven't changed — prevents React
      // from re-rendering the panel on every streaming batch tick.
      setTrackerStates((prev) => {
        if (
          prev.length === next.length &&
          prev.every((p, i) =>
            JSON.stringify(p.snapshot) === JSON.stringify(next[i].snapshot)
          )
        ) {
          return prev; // same reference → React skips the re-render
        }
        return next;
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLineNum, pipeline.runCount, viewer.session]);

  if (activeTrackers.length === 0) {
    return (
      <div className="state-panel-empty">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" className="state-panel-empty-icon">
          <rect x="2" y="3" width="20" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.1"/>
          <path d="M7 8h4M7 12h6M7 16h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
          <circle cx="17" cy="8" r="2" stroke="currentColor" strokeWidth="1.1"/>
          <circle cx="17" cy="8" r="0.5" fill="currentColor"/>
        </svg>
        <span>No active state trackers</span>
        <span className="state-panel-hint">Enable a StateTracker and run the pipeline</span>
      </div>
    );
  }

  const lineLabel = selectedLineNum != null ? `${(selectedLineNum + 1).toLocaleString()}` : '—';

  return (
    <div className="state-panel">
      {/* Header */}
      <div className="state-panel-header">
        <span className="state-panel-header-label">Device State</span>
        <span className="state-panel-line-badge">
          <span className="state-panel-line-dot" />
          {lineLabel}
        </span>
      </div>

      {/* Tracker cards */}
      {trackerStates.map((ts) => {
        const isChanged = !!(stateTracker.transitionsByLine[selectedLineNum ?? -1]?.includes(ts.trackerId));
        const totalTransitions = Object.values(stateTracker.transitionsByLine)
          .filter((ids) => ids.includes(ts.trackerId)).length;

        return (
          <div
            key={ts.trackerId}
            className={`state-tracker-card${isChanged ? ' state-tracker-changed' : ''}`}
          >
            {/* Card header */}
            <div className="state-tracker-header">
              <span className="state-tracker-name">{ts.trackerName}</span>
              <div className="state-tracker-header-right">
                {totalTransitions > 0 && (
                  <span className="state-tracker-badge" title={`${totalTransitions} transitions in log`}>
                    {totalTransitions}
                  </span>
                )}
                {isChanged && <span className="state-tracker-pulse" />}
              </div>
            </div>

            {/* Skeleton loading — only on first fetch */}
            {ts.loading && (
              <div className="state-skel-rows">
                {[55, 40, 65].map((w, i) => (
                  <div key={i} className="state-skel-row">
                    <div className="state-skel-key" style={{ width: `${w}%` }} />
                    <div className="state-skel-val" style={{ width: `${100 - w - 15}%` }} />
                  </div>
                ))}
              </div>
            )}

            {/* No data */}
            {!ts.loading && !ts.snapshot && (
              <div className="state-tracker-no-data">Run the pipeline to see state</div>
            )}

            {/* Field grid */}
            {!ts.loading && ts.snapshot && (() => {
              const initializedSet = new Set(ts.snapshot.initializedFields);
              return (
                <div className="state-fields-grid">
                  {Object.entries(ts.snapshot.fields).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => (
                    <div
                      key={key}
                      className={`state-field-row${isChanged ? ' state-field-changed' : ''}`}
                    >
                      <span className="state-field-key">{key}</span>
                      <FieldValue value={val} initialized={initializedSet.has(key)} />
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        );
      })}
    </div>
  );
}
