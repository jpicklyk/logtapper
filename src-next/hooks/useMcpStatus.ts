import { useMemo, useSyncExternalStore } from 'react';
import { getMcpStatus } from '../bridge/commands';
import type { McpStatus } from '../bridge/types';
import { loadSettings } from './useSettings';

const MCP_ACTIVE_THRESHOLD_SECS = 30;
const MCP_POLL_INTERVAL_MS = 5_000;

export type McpConnState = 'checking' | 'offline' | 'ready' | 'connected' | 'disabled';

export interface McpStatusInfo {
  connState: McpConnState;
  label: string;
  running: boolean;
  port: number;
}

const MCP_CONN_LABELS: Record<McpConnState, string> = {
  checking: '...',
  offline: 'offline',
  ready: 'ready',
  connected: 'connected',
  disabled: 'disabled',
};

function deriveConnState(status: McpStatus | null): McpConnState {
  if (status === null) return 'checking';
  if (!status.running && !loadSettings().mcpBridgeEnabled) return 'disabled';
  if (!status.running) return 'offline';
  if (status.idleSecs === null) return 'ready';
  if (status.idleSecs <= MCP_ACTIVE_THRESHOLD_SECS) return 'connected';
  return 'ready';
}

// ── Module-level singleton polling ───────────────────────────────────────────
// Multiple components may call useMcpStatus(). The polling runs once regardless
// of how many consumers are mounted, via a subscribe/getSnapshot pattern.

let _status: McpStatus | null = null;
let _subscribers = 0;
let _intervalId: ReturnType<typeof setInterval> | null = null;
const _listeners = new Set<() => void>();

function _notify() {
  for (const fn of _listeners) fn();
}

function _statusChanged(a: McpStatus | null, b: McpStatus): boolean {
  return a === null || a.running !== b.running || a.port !== b.port || a.idleSecs !== b.idleSecs;
}

function _poll() {
  getMcpStatus()
    .then((s) => { if (_statusChanged(_status, s)) { _status = s; _notify(); } })
    .catch(() => {
      const fallback: McpStatus = { running: false, port: 40404, idleSecs: null };
      if (_statusChanged(_status, fallback)) { _status = fallback; _notify(); }
    });
}

function subscribe(onStoreChange: () => void): () => void {
  _listeners.add(onStoreChange);
  _subscribers++;
  if (_subscribers === 1) {
    _poll(); // immediate first fetch
    _intervalId = setInterval(_poll, MCP_POLL_INTERVAL_MS);
  }
  return () => {
    _listeners.delete(onStoreChange);
    _subscribers--;
    if (_subscribers === 0 && _intervalId !== null) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
  };
}

function getSnapshot(): McpStatus | null {
  return _status;
}

/**
 * Shared hook for MCP bridge status polling.
 * Uses a module-level singleton so multiple consumers share one polling interval.
 */
export function useMcpStatus(): McpStatusInfo {
  const status = useSyncExternalStore(subscribe, getSnapshot);
  const connState = deriveConnState(status);

  return useMemo(() => ({
    connState,
    label: MCP_CONN_LABELS[connState],
    running: connState !== 'offline' && connState !== 'checking' && connState !== 'disabled',
    port: status?.port ?? 40404,
  }), [connState, status?.port]);
}
