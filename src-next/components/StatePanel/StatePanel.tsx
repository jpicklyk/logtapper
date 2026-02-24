import React, { useEffect, useRef, useState, useMemo } from 'react';
import type { StateSnapshot, ProcessorSummary } from '../../bridge/types';
import {
  useSession,
  useProcessors,
  usePipelineChain,
  usePipelineResults,
  useTrackerTransitions,
} from '../../context';
import { useStateTracker } from '../../hooks';
import styles from './StatePanel.module.css';

interface TrackerState {
  trackerId: string;
  trackerName: string;
  snapshot: StateSnapshot | null;
  loading: boolean;
}

// selectedLineNum is local to the viewer pane. We use null (latest) for now
// since the new architecture doesn't hoist selectedLineNum to context.
// TODO: wire selectedLineNum via a dedicated selector once available.

const FieldValue = React.memo(function FieldValue({
  value,
  initialized,
}: {
  value: unknown;
  initialized: boolean;
}) {
  if (!initialized) {
    return <span className={styles.unknown}>unknown</span>;
  }
  if (value === null || value === undefined || value === '') {
    return <span className={styles.emptyVal}>(empty)</span>;
  }
  if (typeof value === 'boolean') {
    return (
      <span className={value ? styles.boolTrue : styles.boolFalse}>
        {value ? 'TRUE' : 'FALSE'}
      </span>
    );
  }
  if (typeof value === 'number') {
    return <span className={styles.numVal}>{String(value)}</span>;
  }
  const str = String(value);
  return (
    <span className={styles.strVal} title={str}>
      {str}
    </span>
  );
});

const StatePanel = React.memo(function StatePanel() {
  const session = useSession();
  const processors = useProcessors();
  const pipelineChain = usePipelineChain();
  const { runCount } = usePipelineResults();
  useTrackerTransitions();
  const stateTracker = useStateTracker();
  const [trackerStates, setTrackerStates] = useState<TrackerState[]>([]);
  const hasDataRef = useRef(false);

  const activeTrackers = useMemo<ProcessorSummary[]>(() => {
    return pipelineChain
      .map((id) => processors.find((p) => p.id === id))
      .filter(
        (p): p is ProcessorSummary =>
          p != null && p.processorType === 'state_tracker',
      );
  }, [pipelineChain, processors]);

  useEffect(() => {
    if (!session || activeTrackers.length === 0) {
      setTrackerStates([]);
      hasDataRef.current = false;
      return;
    }

    const sessionId = session.sessionId;
    const lineNum = Number.MAX_SAFE_INTEGER; // Show latest state

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

      setTrackerStates((prev) => {
        if (
          prev.length === next.length &&
          prev.every(
            (p, i) =>
              JSON.stringify(p.snapshot) === JSON.stringify(next[i].snapshot),
          )
        ) {
          return prev;
        }
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, runCount, activeTrackers.length]);

  if (activeTrackers.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyLabel}>No active state trackers</span>
        <span className={styles.emptyHint}>
          Enable a StateTracker and run the pipeline
        </span>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>Device State</span>
      </div>

      {trackerStates.map((ts) => (
        <div key={ts.trackerId} className={styles.card}>
          <div className={styles.cardHeader}>
            <span className={styles.cardName}>{ts.trackerName}</span>
          </div>

          {ts.loading && (
            <div className={styles.skelRows}>
              {[55, 40, 65].map((w, i) => (
                <div key={i} className={styles.skelRow}>
                  <div className={styles.skelKey} style={{ width: `${w}%` }} />
                  <div
                    className={styles.skelVal}
                    style={{ width: `${100 - w - 15}%` }}
                  />
                </div>
              ))}
            </div>
          )}

          {!ts.loading && !ts.snapshot && (
            <div className={styles.noData}>
              Run the pipeline to see state
            </div>
          )}

          {!ts.loading &&
            ts.snapshot &&
            (() => {
              const initializedSet = new Set(ts.snapshot.initializedFields);
              return (
                <div className={styles.fieldsGrid}>
                  {Object.entries(ts.snapshot.fields)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, val]) => (
                      <div key={key} className={styles.fieldRow}>
                        <span className={styles.fieldKey}>{key}</span>
                        <FieldValue
                          value={val}
                          initialized={initializedSet.has(key)}
                        />
                      </div>
                    ))}
                </div>
              );
            })()}
        </div>
      ))}
    </div>
  );
});

export default StatePanel;
