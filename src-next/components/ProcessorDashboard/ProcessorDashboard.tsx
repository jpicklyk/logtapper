import React, { useState, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import type { PipelineRunSummary, ProcessorSummary } from '../../bridge/types';
import { getBareId } from '../../bridge/types';
import {
  useSession,
  useProcessors,
  usePacks,
  useActiveProcessorIds,
  useViewerActions,
  useSessionPipelineResults,
} from '../../context';
import { PROC_TYPE_ACCENT } from '../../ui';
import { useProcessorDetail } from './useProcessorDetail';
import { ProcessorDetailView } from './ProcessorDetailView';
import type { DashboardPackGroup } from './utils';
import styles from './ProcessorDashboard.module.css';

// ── Main component ───────────────────────────────────────────────────────────

const ProcessorDashboard = React.memo(function ProcessorDashboard() {
  const session = useSession();
  const processors = useProcessors();
  const activeProcessorIds = useActiveProcessorIds();
  const { results: lastResults, runCount } = useSessionPipelineResults();
  const { jumpToLine } = useViewerActions();
  const packs = usePacks();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const sessionId = session?.sessionId ?? null;

  const activeProcessors = useMemo(
    () =>
      activeProcessorIds
        .map((id) => processors.find((p) => p.id === id))
        .filter(Boolean) as NonNullable<(typeof processors)[0]>[],
    [activeProcessorIds, processors],
  );

  // Group processors by pack (bare-ID join — packId on ProcessorSummary
  // is not reliably populated for marketplace processors)
  const { packGroups, standaloneProcessors } = useMemo(() => {
    const groups: DashboardPackGroup[] = [];
    const assigned = new Set<string>();

    for (const pack of packs) {
      const packProcs = activeProcessors.filter((p) =>
        pack.processorIds.includes(getBareId(p.id)),
      );
      if (packProcs.length > 0) {
        groups.push({ packId: pack.id, packName: pack.name, processors: packProcs });
        for (const p of packProcs) assigned.add(p.id);
      }
    }

    const standalone = activeProcessors.filter((p) => !assigned.has(p.id));
    return { packGroups: groups, standaloneProcessors: standalone };
  }, [activeProcessors, packs]);

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

  const renderProcRow = (p: ProcessorSummary) => {
    const s = getSummary(p.id);
    const isSelected = p.id === selected;
    const notRun = !s;
    const zeroMatches = s && s.matchedLines === 0;
    const rowClass = [
      styles.procRow,
      isSelected && styles.procRowActive,
      notRun && styles.procRowNotRun,
      zeroMatches && styles.procRowZeroMatches,
    ].filter(Boolean).join(' ');
    return (
      <button
        key={p.id}
        className={rowClass}
        onClick={() => {
          setSelectedId(p.id);
        }}
      >
        <span className={styles.procRowName}>{p.name}</span>
        {s ? (
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
        {packGroups.map((group) => {
          const isCollapsed = collapsedGroups.has(group.packId);
          const groupMatches = group.processors.reduce((n, p) => {
            const s = getSummary(p.id);
            return n + (s?.matchedLines ?? 0);
          }, 0);
          // Use the most common processor type's accent color for the pack
          const typeCounts = new Map<ProcessorSummary['processorType'], number>();
          for (const p of group.processors) {
            typeCounts.set(p.processorType, (typeCounts.get(p.processorType) ?? 0) + 1);
          }
          let dominantType: ProcessorSummary['processorType'] = group.processors[0]?.processorType ?? 'reporter';
          let maxCount = 0;
          for (const [type, count] of typeCounts) {
            if (count > maxCount) { maxCount = count; dominantType = type; }
          }
          const accentColor = PROC_TYPE_ACCENT[dominantType] ?? 'var(--proc-reporter)';
          return (
            <div key={group.packId} className={styles.packGroup}>
              <button
                className={styles.packHeader}
                onClick={() => toggleGroup(group.packId)}
              >
                <div
                  className={styles.packAccent}
                  style={{ '--pack-accent': accentColor } as React.CSSProperties}
                />
                <span className={styles.packName}>{group.packName}</span>
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
          jumpToLine={jumpToLine}
          selectedId={selected}
        />
      )}
    </div>
  );
});

export default ProcessorDashboard;
