import React from 'react';
import clsx from 'clsx';
import { useFocusedSession, useIsStreaming } from '../../context';
import styles from './StatusBar.module.css';

export const StatusBar = React.memo(function StatusBar() {
  const session = useFocusedSession();
  const isStreaming = useIsStreaming();

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
