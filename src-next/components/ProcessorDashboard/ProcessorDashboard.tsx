import React, { useState, useMemo, useCallback } from 'react';
import { ChevronRight } from 'lucide-react';
import type { PipelineRunSummary, ProcessorSummary } from '../../bridge/types';
import { resolveChainProcessors, groupProcessorsByPack } from '../../bridge/types';
import {
  useSession,
  useProcessors,
  usePacks,
  useActiveProcessorIds,
  useNavigationActions,
  useSessionPipelineResults,
} from '../../context';
import { dominantTypeAccent } from '../../ui';
import { useProcessorDetail } from './useProcessorDetail';
import { ProcessorDetailView } from './ProcessorDetailView';
import styles from './ProcessorDashboard.module.css';

// ── Main component ───────────────────────────────────────────────────────────

const ProcessorDashboard = React.memo(function ProcessorDashboard() {
  const session = useSession();
  const processors = useProcessors();
  const activeProcessorIds = useActiveProcessorIds(session?.sessionId ?? null);
  const { results: lastResults, runCount } = useSessionPipelineResults();
  const { jumpToLine } = useNavigationActions();
  const packs = usePacks();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const sessionId = session?.sessionId ?? null;

  // Target the jump at this dashboard's session — with two sessions open in
  // split panes, an untargeted jump would move both viewers.
  const jumpToSessionLine = useCallback((lineNum: number) => {
    jumpToLine(lineNum, undefined, sessionId ?? undefined);
  }, [jumpToLine, sessionId]);

  const activeProcessors = useMemo(
    () => resolveChainProcessors(activeProcessorIds, processors),
    [activeProcessorIds, processors],
  );

  // Group processors by pack (bare-ID join — packId on ProcessorSummary
  // is not reliably populated for marketplace processors)
  const { packGroups, standaloneProcessors } = useMemo(
    () => groupProcessorsByPack(activeProcessors, packs),
    [activeProcessors, packs],
  );

  // Plain function — toggleGroup is only used via inline arrow on a plain button,
  // so useCallback provides no memo benefit here.
  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const selected = selectedId ?? activeProcessors[0]?.id ?? null;
  const selectedProc = activeProcessors.find((p) => p.id === selected) ?? null;

  const summaryMap = useMemo(() => {
    const map = new Map<string, PipelineRunSummary>();
    for (const r of lastResults as PipelineRunSummary[]) map.set(r.processorId, r);
    return map;
  }, [lastResults]);

  const getSummary = (id: string) => summaryMap.get(id);

  const detail = useProcessorDetail({
    selectedId: selected,
    sessionId,
    runCount,
    processorType: selectedProc?.processorType ?? null,
  });

  if (activeProcessors.length === 0) {
    return (
      <div className={styles.empty}>
        <span>No active processors.</span>
        <span className={styles.emptySub}>
          Add processors to the pipeline chain and run it.
        </span>
      </div>
    );
  }

  const totalMatches = (lastResults as PipelineRunSummary[]).reduce(
    (n, r) => n + r.matchedLines,
    0,
  );

  // Processors the backend excluded from the run. Surfacing the count is the
  // whole point of the skip rows: without it, a pack whose kernel half cannot
  // apply to a Logcat session just reports zeros with no explanation.
  const skippedSummaries = (lastResults as PipelineRunSummary[]).filter((r) => r.skipped);
  const skippedSourceType = skippedSummaries[0]?.skipped?.actual;

  const renderProcRow = (p: ProcessorSummary) => {
    const s = getSummary(p.id);
    const isSelected = p.id === selected;
    const notRun = !s;
    // A skipped processor never executed, so it is neither "ran and matched
    // nothing" nor "not run yet" — it gets its own state. The backend decides
    // this; the row only renders the reason it sent.
    const skipped = s?.skipped;
    const zeroMatches = s && !skipped && s.matchedLines === 0;
    const rowClass = [
      styles.procRow,
      isSelected && styles.procRowActive,
      notRun && styles.procRowNotRun,
      skipped && styles.procRowSkipped,
      zeroMatches && styles.procRowZeroMatches,
    ].filter(Boolean).join(' ');
    return (
      <button
        key={p.id}
        className={rowClass}
        onClick={() => {
          setSelectedId(p.id);
        }}
        title={skipped ? `Not applicable to ${skipped.actual} source — this processor declares ${skipped.declared.join(', ')}` : undefined}
      >
        <span className={styles.procRowName}>{p.name}</span>
        {skipped ? (
          <span className={`${styles.procRowStats} ${styles.procRowStatsSkipped}`}>
            n/a
          </span>
        ) : s ? (
          <span className={styles.procRowStats}>
            {s.matchedLines > 0
              ? s.matchedLines.toLocaleString()
              : s.emissionCount > 0
                ? `${s.emissionCount.toLocaleString()} ev`
                : '0'}
          </span>
        ) : (
          <span className={`${styles.procRowStats} ${styles.procRowStatsDim}`}>--</span>
        )}
      </button>
    );
  };

  return (
    <div className={styles.layout}>
      {/* Left: processor list */}
      <div className={styles.procList}>
        <div className={styles.procListHeader}>
          {runCount > 0
            ? `${activeProcessors.length} processor${activeProcessors.length !== 1 ? 's' : ''} . ${totalMatches.toLocaleString()} matches`
            : `${activeProcessors.length} processor${activeProcessors.length !== 1 ? 's' : ''}`}
        </div>
        {skippedSummaries.length > 0 && (
          <div className={styles.skipNotice}>
            {skippedSummaries.length} not applicable to this {skippedSourceType} source
          </div>
        )}
        {packGroups.map((group) => {
          const isCollapsed = collapsedGroups.has(group.pack.id);
          const groupMatches = group.processors.reduce((n, p) => {
            const s = getSummary(p.id);
            return n + (s?.matchedLines ?? 0);
          }, 0);
          const accentColor = dominantTypeAccent(group.processors);
          return (
            <div key={group.pack.id} className={styles.packGroup}>
              <button
                className={styles.packHeader}
                onClick={() => toggleGroup(group.pack.id)}
              >
                <div
                  className={styles.packAccent}
                  style={{ '--pack-accent': accentColor } as React.CSSProperties}
                />
                <span className={styles.packName}>{group.pack.name}</span>
                {isCollapsed && runCount > 0 && (
                  <span className={styles.packStats}>{groupMatches.toLocaleString()}</span>
                )}
                <ChevronRight
                  size={10}
                  className={`${styles.packChevron} ${isCollapsed ? '' : styles.packChevronOpen}`}
                />
              </button>
              {!isCollapsed && (
                <div className={styles.packProcessors}>
                  {group.processors.map((p) => renderProcRow(p))}
                </div>
              )}
            </div>
          );
        })}
        {standaloneProcessors.length > 0 && packGroups.length > 0 && (
          <div className={styles.standaloneSep} />
        )}
        {standaloneProcessors.map((p) => renderProcRow(p))}
      </div>

      {/* Right: detail panel */}
      {selected && (
        <ProcessorDetailView
          detail={detail}
          selectedProc={selectedProc}
          summary={selected ? getSummary(selected) : undefined}
          runCount={runCount}
          jumpToLine={jumpToSessionLine}
          selectedId={selected}
        />
      )}
    </div>
  );
});

export default ProcessorDashboard;
