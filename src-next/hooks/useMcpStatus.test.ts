/**
 * Tests for pure helper functions extracted from useMcpStatus.
 *
 * - statusChanged  — determines whether a new McpStatus differs from the cached one
 * - deriveConnState — maps an McpStatus + mcpBridgeEnabled flag to a McpConnState label
 *
 * deriveConnState used to call loadSettings() itself (a localStorage read +
 * migration scan) on every render (U20) — it is now a pure function that takes
 * mcpBridgeEnabled as a parameter, sourced by the caller from its own reactive
 * settings state. Neither function renders a hook; both are tested as plain
 * functions.
 */
import { describe, it, expect } from 'vitest';
import { statusChanged, deriveConnState } from './useMcpStatus';

// ---------------------------------------------------------------------------
// statusChanged
// ---------------------------------------------------------------------------

describe('statusChanged', () => {
  it('returns true when previous status is null', () => {
    expect(statusChanged(null, { running: true, port: 40404, idleSecs: null })).toBe(true);
  });

  it('returns false when running, port, and idleSecs are all equal', () => {
    const a = { running: true, port: 40404, idleSecs: 5 };
    const b = { running: true, port: 40404, idleSecs: 5 };
    expect(statusChanged(a, b)).toBe(false);
  });

  it('returns true when running differs', () => {
    const a = { running: true, port: 40404, idleSecs: null };
    const b = { running: false, port: 40404, idleSecs: null };
    expect(statusChanged(a, b)).toBe(true);
  });

  it('returns true when port differs', () => {
    const a = { running: true, port: 40404, idleSecs: null };
    const b = { running: true, port: 9999, idleSecs: null };
    expect(statusChanged(a, b)).toBe(true);
  });

  it('returns true when idleSecs differs (number vs number)', () => {
    const a = { running: true, port: 40404, idleSecs: 10 };
    const b = { running: true, port: 40404, idleSecs: 20 };
    expect(statusChanged(a, b)).toBe(true);
  });

  it('returns true when idleSecs differs (null vs number)', () => {
    const a = { running: true, port: 40404, idleSecs: null };
    const b = { running: true, port: 40404, idleSecs: 5 };
    expect(statusChanged(a, b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveConnState
// ---------------------------------------------------------------------------

describe('deriveConnState', () => {
  it('returns "checking" when status is null', () => {
    expect(deriveConnState(null, false)).toBe('checking');
  });

  it('returns "disabled" when not running and mcpBridgeEnabled is false', () => {
    expect(deriveConnState({ running: false, port: 40404, idleSecs: null }, false)).toBe('disabled');
  });

  it('returns "offline" when not running and mcpBridgeEnabled is true', () => {
    expect(deriveConnState({ running: false, port: 40404, idleSecs: null }, true)).toBe('offline');
  });

  it('returns "ready" when running and idleSecs is null (never connected)', () => {
    expect(deriveConnState({ running: true, port: 40404, idleSecs: null }, false)).toBe('ready');
  });

  it('returns "connected" when running and idleSecs is 10 (below threshold)', () => {
    expect(deriveConnState({ running: true, port: 40404, idleSecs: 10 }, false)).toBe('connected');
  });

  it('returns "connected" when running and idleSecs is 30 (at threshold boundary)', () => {
    expect(deriveConnState({ running: true, port: 40404, idleSecs: 30 }, false)).toBe('connected');
  });

  it('returns "ready" when running and idleSecs is 31 (above threshold)', () => {
    expect(deriveConnState({ running: true, port: 40404, idleSecs: 31 }, false)).toBe('ready');
  });
});
