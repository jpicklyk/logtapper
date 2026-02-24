import React from 'react';
import styles from './ProgressOverlay.module.css';

interface ProgressOverlayProps {
  visible: boolean;
  current: number;
  total: number;
  label?: string;
}

export const ProgressOverlay = React.memo<ProgressOverlayProps>(
  function ProgressOverlay({ visible, current, total, label }) {
    if (!visible) return null;

    const pct = total > 0 ? Math.round((current / total) * 100) : 0;

    return (
      <div className={styles.overlay}>
        <div className={styles.card}>
          <div className={styles.message}>{label ?? 'Loading...'}</div>
          <div className={styles.barWrap}>
            <div className={styles.barFill} style={{ width: `${pct}%` }} />
          </div>
          <div className={styles.pct}>{pct}%</div>
        </div>
      </div>
    );
  },
);
