import React, { useCallback } from 'react';
import type { SourceReference } from '../../bridge/types';
// Type-only, so the MarkdownSection <-> LineReference cycle is erased at compile time.
import type { ResolvedReference } from './MarkdownSection';
import styles from './AnalysisReader.module.css';

interface Props {
  /** Carries its own resolution info (`resolved` — whether `sessionId` maps to
   *  a currently-open session, so the reference can be jumped to — and
   *  `sourceLabel`), precomputed once by AnalysisReader. */
  reference: ResolvedReference;
  onJump: (reference: SourceReference) => void;
}

const LineReference = React.memo(function LineReference({ reference, onJump }: Props) {
  const { resolved, sourceLabel } = reference;
  const handleClick = useCallback(() => {
    if (!resolved) return;
    onJump(reference);
  }, [reference, resolved, onJump]);

  const lineText = reference.endLine != null
    ? `L${reference.lineNumber}–${reference.endLine}`
    : `L${reference.lineNumber}`;

  const isAnchor = reference.highlightType === 'Anchor';

  const title = resolved
    ? reference.label
    : "Source file is not open — this reference can't be resolved";

  return (
    <button
      className={`${styles.lineRef} ${isAnchor ? styles.lineRefAnchor : ''} ${!resolved ? styles.lineRefUnresolved : ''}`}
      onClick={handleClick}
      type="button"
      title={title}
      disabled={!resolved}
    >
      <span className={styles.lineRefNum}>{lineText}</span>
      <span className={styles.lineRefLabel}>{reference.label}</span>
      {resolved && sourceLabel && (
        <span className={styles.lineRefSource}>{sourceLabel}</span>
      )}
      {!resolved && (
        <span className={styles.lineRefWarning} aria-hidden="true">{'⚠'}</span>
      )}
    </button>
  );
});

export default LineReference;
