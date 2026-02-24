import React from 'react';
import clsx from 'clsx';
import styles from './StatusBar.module.css';

interface StatusBarProps {
  sessionName?: string;
  lineCount?: number;
  isStreaming?: boolean;
  mcpConnected?: boolean;
  selectedLine?: number | null;
}

export const StatusBar = React.memo(function StatusBar({
  sessionName,
  lineCount,
  isStreaming,
  mcpConnected,
  selectedLine,
}: StatusBarProps) {
  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        {isStreaming && (
          <span className={styles.streaming}>
            <span className={styles.dot} />
            LIVE
          </span>
        )}
        {sessionName && (
          <span className={styles.item}>{sessionName}</span>
        )}
        {lineCount != null && (
          <span className={styles.item}>
            {lineCount.toLocaleString()} lines
          </span>
        )}
      </div>
      <div className={styles.right}>
        {mcpConnected != null && (
          <span className={clsx(styles.item, mcpConnected ? styles.connected : styles.disconnected)}>
            MCP {mcpConnected ? 'Connected' : 'Disconnected'}
          </span>
        )}
        {selectedLine != null && (
          <span className={styles.item}>Ln {selectedLine}</span>
        )}
      </div>
    </div>
  );
});
