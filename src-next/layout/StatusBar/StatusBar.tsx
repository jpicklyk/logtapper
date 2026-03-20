import React from 'react';
import clsx from 'clsx';
import { useSessionForPane, useIsStreamingForPane } from '../../context';
import styles from './StatusBar.module.css';

interface StatusBarProps {
  activeLogPaneId: string | null;
}

export const StatusBar = React.memo(function StatusBar({ activeLogPaneId }: StatusBarProps) {
  const session = useSessionForPane(activeLogPaneId);
  const isStreaming = useIsStreamingForPane(activeLogPaneId);

  const filePath = session?.filePath ?? null;
  const lineCount = session?.totalLines ?? null;

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        {isStreaming && (
          <span className={styles.streaming}>
            <span className={styles.dot} />
            LIVE
          </span>
        )}
        {filePath && (
          <span className={clsx(styles.item, styles.filePath)} title={filePath}>
            {filePath}
          </span>
        )}
        {lineCount != null && (
          <span className={styles.item}>
            {lineCount.toLocaleString()} lines
          </span>
        )}
      </div>
      <div className={styles.right}>
      </div>
    </div>
  );
});
