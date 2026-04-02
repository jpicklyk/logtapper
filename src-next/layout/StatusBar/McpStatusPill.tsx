import React from 'react';
import { useMcpStatus } from '../../hooks';
import type { McpConnState } from '../../hooks';
import styles from './McpStatusPill.module.css';

const DOT_CLASS: Record<McpConnState, string> = {
  connected: styles.dotConnected,
  ready: styles.dotReady,
  offline: styles.dotOffline,
  checking: styles.dotOffline,
  disabled: styles.dotDisabled,
};

export const McpStatusPill = React.memo(function McpStatusPill() {
  const { connState, label, running, port } = useMcpStatus();
  const tip = running
    ? `MCP Bridge: ${label} - 127.0.0.1:${port}`
    : `MCP Bridge: ${label}`;

  return (
    <div className={styles.pill} title={tip}>
      <span className={styles.mcpLabel}>MCP</span>
      <span className={[styles.dot, DOT_CLASS[connState]].filter(Boolean).join(' ')} />
      <span className={styles.stateLabel}>{label}</span>
    </div>
  );
});
