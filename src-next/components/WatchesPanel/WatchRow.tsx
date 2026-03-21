import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X } from 'lucide-react';
import type { WatchInfo } from '../../bridge/types';
import { CriteriaChips } from './CriteriaChips';
import clsx from 'clsx';
import styles from './WatchesPanel.module.css';

interface WatchRowProps {
  watch: WatchInfo;
  onCancel: (watchId: string) => void;
}

export const WatchRow = React.memo(function WatchRow({ watch, onCancel }: WatchRowProps) {
  const prevCountRef = useRef(watch.totalMatches);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (watch.totalMatches > prevCountRef.current) {
      setFlashing(true);
      const timer = setTimeout(() => setFlashing(false), 600);
      prevCountRef.current = watch.totalMatches;
      return () => clearTimeout(timer);
    }
    prevCountRef.current = watch.totalMatches;
  }, [watch.totalMatches]);

  const handleCancel = useCallback(() => {
    onCancel(watch.watchId);
  }, [onCancel, watch.watchId]);

  return (
    <div className={clsx(styles.watchRow, !watch.active && styles.watchRowCancelled)}>
      <span
        className={clsx(
          styles.statusDot,
          watch.active ? styles.statusDotActive : styles.statusDotCancelled,
        )}
      />
      <CriteriaChips criteria={watch.criteria} />
      <span
        className={clsx(styles.matchCount, flashing && styles.matchCountFlash)}
      >
        {watch.totalMatches.toLocaleString()}
      </span>
      {watch.active && (
        <button
          className={styles.cancelBtn}
          onClick={handleCancel}
          title="Cancel watch"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
});
