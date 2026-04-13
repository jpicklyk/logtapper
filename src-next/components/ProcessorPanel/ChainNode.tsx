import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { PipelineRunSummary, PipelineProgress } from '../../bridge/types';
import { Button } from '../../ui';
import { PROC_TYPE_ACCENT, getProcTypeMeta as _getProcTypeMeta } from '../../ui';
import { PINNED_TAIL_IDS } from '../../context';
import styles from './ProcessorPanel.module.css';
import badgeCss from '../../ui/processorBadge.module.css';

// ── Type metadata ────────────────────────────────────────────────────────────

/** Resolves [label, cssClass] — wraps the shared helper with CSS module lookup. */
function getProcTypeMeta(type: string): [string, string] {
  const [label, classKey] = _getProcTypeMeta(type);
  return [label, badgeCss[classKey as keyof typeof badgeCss] ?? ''];
}

// PII anonymizer is the only transformer — show a dedicated badge instead
// of the generic "Transformer" label.
const PII_TYPE_META: [string, string] = [
  'PII',
  badgeCss['typeTransformer' as keyof typeof badgeCss] ?? '',
];

// ── SVG Icons ────────────────────────────────────────────────────────────────

const DragHandleSvg = (
  <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
    <circle cx="3" cy="2.5" r="1.2" fill="currentColor" />
    <circle cx="7" cy="2.5" r="1.2" fill="currentColor" />
    <circle cx="3" cy="7" r="1.2" fill="currentColor" />
    <circle cx="7" cy="7" r="1.2" fill="currentColor" />
    <circle cx="3" cy="11.5" r="1.2" fill="currentColor" />
    <circle cx="7" cy="11.5" r="1.2" fill="currentColor" />
  </svg>
);

const LockSvg = (
  <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
    <rect x="2" y="5.5" width="6" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M3 5.5V3.5a2 2 0 014 0v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const RemoveSvg = (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
    <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// Eye icon (enabled)
const EyeSvg = (
  <svg width="12" height="10" viewBox="0 0 16 12" fill="none">
    <path d="M1 6s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="6" r="2" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

// Eye-off icon (disabled)
const EyeOffSvg = (
  <svg width="12" height="10" viewBox="0 0 16 12" fill="none">
    <path d="M1 6s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3 1l10 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

// ── ChainConnector ───────────────────────────────────────────────────────────

export const ChainConnector = React.memo(function ChainConnector({
  isActive,
  compact,
}: {
  isActive: boolean;
  compact: boolean;
}) {
  const cls = `${styles.connector}${isActive ? ` ${styles.connectorActive}` : ''}${compact ? ` ${styles.connectorCompact}` : ''}`;
  return (
    <div className={cls}>
      <div className={styles.connectorDot} />
      <div className={styles.connectorDot} />
      <div className={styles.connectorDot} />
    </div>
  );
});

// ── StatLine ─────────────────────────────────────────────────────────────────

function StatLine({
  processorType,
  result,
  progress,
  running,
}: {
  processorType: string;
  result?: PipelineRunSummary;
  progress?: PipelineProgress;
  running: boolean;
}) {
  if (running && progress) {
    return (
      <div className={styles.nodeStat}>
        <div className={styles.nodeProgress}>
          <div className={styles.nodeProgressFill} style={{ width: `${progress.percent.toFixed(0)}%` }} />
          <div className={styles.progressShimmer} />
        </div>
      </div>
    );
  }
  if (!result) return null;

  if (processorType === 'state_tracker') {
    return <div className={styles.nodeStat}>{result.matchedLines.toLocaleString()} transitions</div>;
  }
  if (processorType === 'transformer') {
    return <div className={styles.nodeStat}>PII anonymization active</div>;
  }
  return (
    <div className={styles.nodeStat}>
      {result.matchedLines.toLocaleString()} matched
      {result.emissionCount > 0 && ` . ${result.emissionCount.toLocaleString()} emitted`}
    </div>
  );
}

/** Format a compact stat string from a result. */
function compactStatText(result?: PipelineRunSummary): string {
  if (!result) return '';
  return result.matchedLines.toLocaleString();
}

// ── Toggle button ────────────────────────────────────────────────────────────

function ToggleEnabledBtn({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`${styles.toggleBtn}${disabled ? ` ${styles.toggleBtnOff}` : ''}`}
      title={disabled ? 'Enable processor' : 'Disable processor'}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {disabled ? EyeOffSvg : EyeSvg}
    </button>
  );
}

// ── ChainNode ────────────────────────────────────────────────────────────────

export interface ChainNodeProps {
  id: string;
  name: string;
  processorType: string;
  builtin: boolean;
  result?: PipelineRunSummary;
  progress?: PipelineProgress;
  running: boolean;
  compact: boolean;
  disabled: boolean;
  onRemove: (id: string) => void;
  onToggleEnabled: (id: string) => void;
}

export const ChainNode = React.memo(function ChainNode({
  id,
  name,
  processorType,
  builtin,
  result,
  progress,
  running,
  compact,
  disabled,
  onRemove,
  onToggleEnabled,
}: ChainNodeProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const accentColor = PROC_TYPE_ACCENT[processorType] ?? 'var(--proc-reporter)';

  if (compact) {
    const style: React.CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.5 : 1,
      '--proc-accent': accentColor,
    } as React.CSSProperties;

    const cls = `${styles.chainNodeCompact}${isDragging ? ` ${styles.chainNodeDragging}` : ''}${disabled ? ` ${styles.nodeDisabled}` : ''}`;

    return (
      <div ref={setNodeRef} style={style} className={cls} {...attributes} {...listeners}>
        <div className={styles.compactDot} />
        <span className={styles.compactName}>{name}</span>
        {result && <span className={styles.compactStat}>{compactStatText(result)}</span>}
        <ToggleEnabledBtn disabled={disabled} onClick={() => onToggleEnabled(id)} />
        <Button variant="ghost" size="sm" className={styles.nodeRemove} title="Remove from chain" onClick={(e) => { e.stopPropagation(); onRemove(id); }}>
          {RemoveSvg}
        </Button>
      </div>
    );
  }

  // Detailed mode
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    '--proc-accent': accentColor,
  } as React.CSSProperties;

  const [typeLabel, typeBadgeClass] = (PINNED_TAIL_IDS.has(id) ? PII_TYPE_META : null)
    ?? getProcTypeMeta(processorType);

  const cls = `${styles.chainNode}${isDragging ? ` ${styles.chainNodeDragging}` : ''}${disabled ? ` ${styles.nodeDisabled}` : ''}`;

  return (
    <div ref={setNodeRef} style={style} className={cls}>
      <div className={styles.nodeHandle} {...attributes} {...listeners} title="Drag to reorder">
        {DragHandleSvg}
      </div>
      <div className={styles.nodeAccent} />
      <div className={styles.nodeBody}>
        <div className={styles.nodeName}>{name}</div>
        <div className={styles.nodeMeta}>
          <span className={`${badgeCss.typeBadge} ${typeBadgeClass}`}>{typeLabel}</span>
          {builtin && <span className={styles.builtinBadge}>built-in</span>}
        </div>
        <StatLine processorType={processorType} result={result} progress={progress} running={running} />
      </div>
      <div className={styles.nodeActions}>
        <ToggleEnabledBtn disabled={disabled} onClick={() => onToggleEnabled(id)} />
      </div>
      <Button variant="ghost" size="sm" className={styles.nodeRemove} title="Remove from chain" onClick={() => onRemove(id)}>
        {RemoveSvg}
      </Button>
    </div>
  );
});

// ── PinnedChainNode ──────────────────────────────────────────────────────────

export const PinnedChainNode = React.memo(function PinnedChainNode({
  id,
  name,
  processorType,
  builtin,
  result,
  progress,
  running,
  compact,
  disabled,
  onRemove,
  onToggleEnabled,
}: ChainNodeProps) {
  const accentColor = PROC_TYPE_ACCENT[processorType] ?? 'var(--proc-reporter)';

  if (compact) {
    const style: React.CSSProperties = {
      '--proc-accent': accentColor,
    } as React.CSSProperties;

    const cls = `${styles.chainNodeCompact} ${styles.chainNodePinned}${disabled ? ` ${styles.nodeDisabled}` : ''}`;

    return (
      <div style={style} className={cls}>
        <span className={styles.compactLock}>{LockSvg}</span>
        <div className={styles.compactDot} />
        <span className={styles.compactName}>{name}</span>
        {result && <span className={styles.compactStat}>{compactStatText(result)}</span>}
        <ToggleEnabledBtn disabled={disabled} onClick={() => onToggleEnabled(id)} />
        <Button variant="ghost" size="sm" className={styles.nodeRemove} title="Remove from chain" onClick={(e) => { e.stopPropagation(); onRemove(id); }}>
          {RemoveSvg}
        </Button>
      </div>
    );
  }

  // Detailed mode
  const style: React.CSSProperties = {
    '--proc-accent': accentColor,
  } as React.CSSProperties;

  const [typeLabel, typeBadgeClass] = (PINNED_TAIL_IDS.has(id) ? PII_TYPE_META : null)
    ?? getProcTypeMeta(processorType);

  const cls = `${styles.chainNode} ${styles.chainNodePinned}${disabled ? ` ${styles.nodeDisabled}` : ''}`;

  return (
    <>
      <div className={styles.outputGateSep}>
        <span className={styles.outputGateLabel}>output gate</span>
      </div>
      <div style={style} className={cls}>
        <div className={`${styles.nodeHandle} ${styles.nodeHandleLocked}`} title="Pinned to end">
          {LockSvg}
        </div>
        <div className={styles.nodeAccent} />
        <div className={styles.nodeBody}>
          <div className={styles.nodeName}>{name}</div>
          <div className={styles.nodeMeta}>
            <span className={`${badgeCss.typeBadge} ${typeBadgeClass}`}>{typeLabel}</span>
            {builtin && <span className={styles.builtinBadge}>built-in</span>}
          </div>
          <StatLine processorType={processorType} result={result} progress={progress} running={running} />
        </div>
        <div className={styles.nodeActions}>
          <ToggleEnabledBtn disabled={disabled} onClick={() => onToggleEnabled(id)} />
        </div>
        <button className={styles.nodeRemove} title="Remove from chain" onClick={() => onRemove(id)}>
          {RemoveSvg}
        </button>
      </div>
    </>
  );
});
