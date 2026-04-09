import React, { useCallback } from 'react';
import type { ProcessorSummary, PipelineRunSummary } from '../../bridge/types';
import styles from './PackGroup.module.css';
import ppStyles from './ProcessorPanel.module.css';
import badgeCss from '../../ui/processorBadge.module.css';
import { PROC_TYPE_ACCENT, getProcTypeMeta as _getProcTypeMeta } from '../../ui';
import { PINNED_TAIL_IDS } from '../../context/PipelineContext';

// ── SVG Icons (local copies to keep PackGroup self-contained) ─────────────────

const ChevronSvg = (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
    <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const RemoveSvg = (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
    <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const EyeSvg = (
  <svg width="12" height="10" viewBox="0 0 16 12" fill="none">
    <path d="M1 6s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="6" r="2" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

const EyeOffSvg = (
  <svg width="12" height="10" viewBox="0 0 16 12" fill="none">
    <path d="M1 6s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3 1l10 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

// Partial eye — some processors disabled
const EyePartialSvg = (
  <svg width="12" height="10" viewBox="0 0 16 12" fill="none">
    <path d="M1 6s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.3" strokeDasharray="3 2" />
    <circle cx="8" cy="6" r="2" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

// ── Helper ────────────────────────────────────────────────────────────────────

const PII_TYPE_META: [string, string] = [
  'PII',
  badgeCss['typeTransformer' as keyof typeof badgeCss] ?? '',
];

function getProcTypeMeta(type: string): [string, string] {
  const [label, classKey] = _getProcTypeMeta(type);
  return [label, badgeCss[classKey as keyof typeof badgeCss] ?? ''];
}

// ── ProcessorRow ──────────────────────────────────────────────────────────────

interface ProcessorRowProps {
  proc: ProcessorSummary;
  result?: PipelineRunSummary;
  disabled: boolean;
  running: boolean;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

const ProcessorRow = React.memo(function ProcessorRow({
  proc,
  result,
  disabled,
  running,
  onToggle,
  onRemove,
}: ProcessorRowProps) {
  const [typeLabel, typeBadgeClass] = (PINNED_TAIL_IDS.has(proc.id) ? PII_TYPE_META : null)
    ?? getProcTypeMeta(proc.processorType);

  const cls = `${styles.procRow}${disabled ? ` ${styles.procRowDisabled}` : ''}`;

  return (
    <div className={cls}>
      <div className={styles.procBody}>
        <span className={styles.procName}>{proc.name}</span>
        <div className={styles.procMeta}>
          <span className={`${badgeCss.typeBadge} ${typeBadgeClass}`}>{typeLabel}</span>
          {proc.builtin && <span className={ppStyles.builtinBadge}>built-in</span>}
        </div>
        {!running && result && (
          <div className={ppStyles.nodeStat}>
            {proc.processorType === 'state_tracker'
              ? `${result.matchedLines.toLocaleString()} transitions`
              : proc.processorType === 'transformer'
                ? 'PII anonymization active'
                : `${result.matchedLines.toLocaleString()} matched${result.emissionCount > 0 ? ` . ${result.emissionCount.toLocaleString()} emitted` : ''}`}
          </div>
        )}
      </div>
      <div className={styles.procActions}>
        <button
          className={`${ppStyles.toggleBtn}${disabled ? ` ${ppStyles.toggleBtnOff}` : ''}`}
          title={disabled ? 'Enable processor' : 'Disable processor'}
          onClick={(e) => { e.stopPropagation(); onToggle(proc.id); }}
        >
          {disabled ? EyeOffSvg : EyeSvg}
        </button>
        <button
          className={styles.procRemove}
          title="Remove from chain"
          onClick={(e) => { e.stopPropagation(); onRemove(proc.id); }}
        >
          {RemoveSvg}
        </button>
      </div>
    </div>
  );
});

// ── PackGroup ─────────────────────────────────────────────────────────────────

export interface PackGroupProps {
  packId: string;
  packName: string;
  processors: ProcessorSummary[];
  expanded: boolean;
  compact: boolean;
  /** Called with the packId when the header is clicked to expand/collapse. */
  onToggleExpand: (packId: string) => void;
  allEnabled: boolean;
  someDisabled: boolean;
  /** Called with the packId to toggle all processors in the pack enabled/disabled. */
  onTogglePackEnabled: (packId: string) => void;
  /** Called with the packId to remove all processors in the pack from the chain. */
  onRemovePack: (packId: string) => void;
  onToggleProcessor: (id: string) => void;
  onRemoveProcessor: (id: string) => void;
  disabledIds: Set<string>;
  resultsByProcessor: Map<string, PipelineRunSummary>;
  pipelineRunning: boolean;
}

const PackGroup = React.memo(function PackGroup({
  packId,
  packName,
  processors,
  expanded,
  compact,
  onToggleExpand,
  allEnabled,
  someDisabled,
  onTogglePackEnabled,
  onRemovePack,
  onToggleProcessor,
  onRemoveProcessor,
  disabledIds,
  resultsByProcessor,
  pipelineRunning,
}: PackGroupProps) {
  // Derive the accent color from the most common processor type in the pack.
  const packAccentColor = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of processors) {
      counts.set(p.processorType, (counts.get(p.processorType) ?? 0) + 1);
    }
    let dominant = 'reporter';
    let max = 0;
    for (const [type, count] of counts) {
      if (count > max) { max = count; dominant = type; }
    }
    return PROC_TYPE_ACCENT[dominant] ?? 'var(--accent)';
  }, [processors]);
  const handleRemovePack = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); onRemovePack(packId); },
    [onRemovePack, packId],
  );

  const handleTogglePack = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); onTogglePackEnabled(packId); },
    [onTogglePackEnabled, packId],
  );

  const handleToggleExpand = useCallback(
    () => onToggleExpand(packId),
    [onToggleExpand, packId],
  );

  const eyeIcon = allEnabled ? EyeSvg : someDisabled ? EyePartialSvg : EyeOffSvg;
  const eyeTitle = allEnabled
    ? 'Disable all in pack'
    : someDisabled
      ? 'Toggle pack enabled'
      : 'Enable all in pack';

  return (
    <div className={`${styles.packGroup}${compact ? ` ${styles.packGroupCompact}` : ''}`}>
      {/* Pack header */}
      <div className={styles.packHeader} onClick={handleToggleExpand} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggleExpand(); } }}
        style={{ '--pack-accent': packAccentColor } as React.CSSProperties}>
        <span className={styles.packAccent} />
        <span className={styles.packName}>{packName}</span>
        <span className={styles.packCount}>{processors.length}</span>
        <button
          className={`${styles.packEyeBtn}${!allEnabled ? ` ${styles.packEyeBtnOff}` : ''}`}
          title={eyeTitle}
          onClick={handleTogglePack}
        >
          {eyeIcon}
        </button>
        {!compact && (
          <button
            className={styles.packRemoveBtn}
            title="Remove pack from chain"
            onClick={handleRemovePack}
          >
            {RemoveSvg}
          </button>
        )}
        {!compact && (
          <span className={`${styles.chevron}${expanded ? ` ${styles.chevronExpanded}` : ''}`}>
            {ChevronSvg}
          </span>
        )}
      </div>

      {/* Expanded processor list — only in detailed mode */}
      {!compact && expanded && (
        <div className={styles.packProcessors}>
          {processors.map((proc) => (
            <ProcessorRow
              key={proc.id}
              proc={proc}
              result={resultsByProcessor.get(proc.id)}
              disabled={disabledIds.has(proc.id)}
              running={pipelineRunning}
              onToggle={onToggleProcessor}
              onRemove={onRemoveProcessor}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export default PackGroup;
