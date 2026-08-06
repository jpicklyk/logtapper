import React from 'react';
import type { ArtifactAttribution } from './analysisAttribution';
import styles from './SourceChips.module.css';

interface Props {
  attribution: ArtifactAttribution;
}

/**
 * Non-interactive row of source chips summarizing which sessions an
 * analysis artifact's line references resolve against — one chip per
 * resolved session (with a `×N` suffix when it has more than one
 * reference), plus a warning-styled chip for unresolved references.
 * Shared between AnalysisList's cards and AnalysisReader's title area.
 */
const SourceChips = React.memo(function SourceChips({ attribution }: Props) {
  if (attribution.resolved.length === 0 && attribution.unresolvedCount === 0) {
    return null;
  }

  return (
    <div className={styles.chipRow}>
      {attribution.resolved.map((r) => (
        <span key={r.sessionId} className={styles.chip} title={r.label}>
          {r.label}
          {r.refCount > 1 && <span className={styles.chipCount}>{'×'}{r.refCount}</span>}
        </span>
      ))}
      {attribution.unresolvedCount > 0 && (
        <span
          className={styles.chipWarning}
          title={`${attribution.unresolvedCount} reference${attribution.unresolvedCount !== 1 ? 's' : ''} to a source that isn't open`}
        >
          {attribution.unresolvedCount} unresolved
        </span>
      )}
    </div>
  );
});

export default SourceChips;
