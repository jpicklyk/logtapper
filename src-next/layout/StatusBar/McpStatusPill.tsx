import React from 'react';
import { useMcpStatus, useSettings, useActivityFeed } from '../../hooks';
import type { McpConnState } from '../../hooks';
import type { ActivityEntry } from '../../bridge/types';
import styles from './McpStatusPill.module.css';

const DOT_CLASS: Record<McpConnState, string> = {
  connected: styles.dotConnected,
  ready: styles.dotReady,
  offline: styles.dotOffline,
  checking: styles.dotOffline,
  disabled: styles.dotDisabled,
};

/** `session.open by claude - opened dumpstate.txt` — who did what, most recently. */
function describeActivity(entry: ActivityEntry): string {
  const who = entry.caller.kind === 'agent' ? entry.caller.client : 'you';
  return `${entry.action} by ${who} - ${entry.summary}`;
}

export const McpStatusPill = React.memo(function McpStatusPill() {
  const { settings } = useSettings();
  const { connState, label, running, port } = useMcpStatus(settings.mcpBridgeEnabled);
  // The shared UI + agent journal. Surfaced here only as a count and a last
  // action; the feed proper is the UI redesign's to build.
  const { count, latest } = useActivityFeed();

  const lines = [
    running ? `MCP Bridge: ${label} - 127.0.0.1:${port}` : `MCP Bridge: ${label}`,
  ];
  if (latest) {
    lines.push(`${count} recent action${count === 1 ? '' : 's'}`);
    lines.push(`Last: ${describeActivity(latest)}`);
  }

  return (
    <div className={styles.pill} title={lines.join('\n')}>
      <span className={styles.mcpLabel}>MCP</span>
      <span className={[styles.dot, DOT_CLASS[connState]].filter(Boolean).join(' ')} />
      <span className={styles.stateLabel}>{label}</span>
    </div>
  );
});
