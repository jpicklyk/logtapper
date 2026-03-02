import React, { useCallback } from 'react';
import type { SourceReference } from '../../bridge/types';
import styles from './AnalysisReader.module.css';

interface Props {
  reference: SourceReference;
  onJump: (lineNum: number) => void;
}

const LineReference = React.memo(function LineReference({ reference, onJump }: Props) {
  const handleClick = useCallback(() => {
    onJump(reference.lineNumber);
  }, [reference.lineNumber, onJump]);

  const lineText = reference.endLine != null
    ? `L${reference.lineNumber}\u2013${reference.endLine}`
    : `L${reference.lineNumber}`;

  const isAnchor = reference.highlightType === 'Anchor';

  return (
    <button
      className={`${styles.lineRef} ${isAnchor ? styles.lineRefAnchor : ''}`}
      onClick={handleClick}
      type="button"
      title={reference.label}
    >
      <span className={styles.lineRefNum}>{lineText}</span>
      <span className={styles.lineRefLabel}>{reference.label}</span>
    </button>
  );
});

export default LineReference;
