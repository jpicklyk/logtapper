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
import { bus } from '../../events';
import type { AppEvents } from '../../events';
import styles from './StatePanel.module.css';

interface TrackerState {
  trackerId: string;
  trackerName: string;
  snapshot: StateSnapshot | null;
  loading: boolean;
}

const FieldValue = React.memo(function FieldValue({
  value,
  initialized,
}: {
  value: unknown;
  initialized: boolean;
}) {
  if (!initialized) {
    return <span className={styles.unknown}>--</span>;
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
    return <span className={`${styles.fieldVal} ${styles.numVal}`}>{String(value)}</span>;
  }
  const str = String(value);
  return (
    <span className={`${styles.fieldVal} ${styles.strVal}`} title={str}>
      {str}
    </span>
  );
});

/** Renders the field rows, splitting initialized fields from unknown ones
 *  with a dashed divider so the meaningful data reads first. */
const FieldsGrid = React.memo(function FieldsGrid({ snapshot }: { snapshot: StateSnapshot }) {
  const initializedSet = useMemo(() => new Set(snapshot.initializedFields), [snapshot.initializedFields]);

  const sorted = useMemo(() =>
    Object.entries(snapshot.fields).sort(([a], [b]) => a.localeCompare(b)),
    [snapshot.fields],
  );

  const known = sorted.filter(([k]) => initializedSet.has(k));
  const unknown = sorted.filter(([k]) => !initializedSet.has(k));

  return (
    <div className={styles.fieldsGrid}>
      {known.map(([key, val]) => (
        <div key={key} className={styles.fieldRow}>
          <span className={styles.fieldKey}>{key}</span>
          <span className={styles.fieldVal}>
            <FieldValue value={val} initialized />
          </span>
        </div>
      ))}
      {known.length > 0 && unknown.length > 0 && (
        <hr className={styles.unknownDivider} />
      )}
      {unknown.map(([key, val]) => (
        <div key={key} className={styles.fieldRowUnknown}>
          <span className={styles.fieldKey}>{key}</span>
          <span className={styles.fieldVal}>
            <FieldValue value={val} initialized={false} />
          </span>
        </div>
      ))}
    </div>
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

  const [selectedLine, setSelectedLine] = useState<number | null>(null);

  useEffect(() => {
    const handler = (ev: AppEvents['selection:changed']) => {
      if (ev.sessionId === session?.sessionId) {
        setSelectedLine(ev.anchor);
      } else {
        setSelectedLine(null);
      }
    };
    bus.on('selection:changed', handler);
    return () => { bus.off('selection:changed', handler); };
  }, [session?.sessionId]);

  const activeTrackers = useMemo<ProcessorSummary[]>(() => {
    return pipelineChain
      .map((id) => processors.find((p) => p.id === id))
      .filter(
        (p): p is ProcessorSummary =>
          p != null && p.processorType === 'state_tracker',
      );
  }, [pipelineChain, processors]);

  // Snapshot-mode results don't change with line selection — cache them and
  // only invalidate on pipeline re-run or session change.
  const snapshotCacheRef = useRef<Map<string, TrackerState>>(new Map());
  const lastRunCountRef = useRef<number>(-1);

  useEffect(() => {
    if (!session || activeTrackers.length === 0) {
      setTrackerStates([]);
      hasDataRef.current = false;
      snapshotCacheRef.current.clear();
      lastRunCountRef.current = -1;
      return;
    }

    // Invalidate snapshot cache when pipeline re-runs.
    if (runCount !== lastRunCountRef.current) {
      snapshotCacheRef.current.clear();
      lastRunCountRef.current = runCount;
    }

    const sessionId = session.sessionId;
    const lineNum = selectedLine ?? Number.MAX_SAFE_INTEGER;

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
      activeTrackers.map((t) => {
        const isSnap = t.trackerMode === 'snapshot';
        const cached = snapshotCacheRef.current.get(t.id);
        if (isSnap && cached?.snapshot && hasDataRef.current) {
          return Promise.resolve(cached);
        }
        return stateTracker.getSnapshot(sessionId, t.id, lineNum).then((snap) => {
          const entry: TrackerState = {
            trackerId: t.id,
            trackerName: t.name,
            snapshot: snap,
            loading: false,
          };
          if (isSnap) snapshotCacheRef.current.set(t.id, entry);
          return entry;
        });
      }),
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
              p.snapshot === next[i].snapshot ||
              JSON.stringify(p.snapshot) === JSON.stringify(next[i].snapshot),
          )
        ) {
          return prev;
        }
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, runCount, activeTrackers.length, selectedLine]);

  const trackerMeta = useMemo(() => {
    const map = new Map<string, ProcessorSummary>();
    for (const t of activeTrackers) map.set(t.id, t);
    return map;
  }, [activeTrackers]);

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

      {trackerStates.map((ts) => {
        const meta = trackerMeta.get(ts.trackerId);
        const mode = meta?.trackerMode;
        // Sections from the definition, falling back to source types from schema.
        const sources = meta?.trackerSections?.length
          ? meta.trackerSections
          : (ts.snapshot?.sourceSections?.length
              ? ts.snapshot.sourceSections
              : (meta?.sourceTypes ?? []));

        return (
          <div key={ts.trackerId} className={styles.card}>
            <div className={styles.cardTop}>
              <span className={styles.cardName}>{ts.trackerName}</span>
              {mode && (
                <span className={styles.modeTag}>
                  {mode === 'snapshot' ? 'snapshot' : 'time-series'}
                </span>
              )}
            </div>

            {sources.length > 0 && (
              <div className={styles.sourceBar}>
                {sources.map((s) => (
                  <span key={s} className={styles.sourceChip}>{s}</span>
                ))}
              </div>
            )}

            {/* Body: fields or loading/empty state */}
            <div className={styles.cardBody}>
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

              {!ts.loading && ts.snapshot && (
                <FieldsGrid snapshot={ts.snapshot} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});

export default StatePanel;
