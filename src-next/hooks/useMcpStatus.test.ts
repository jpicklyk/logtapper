/**
 * Tests for pure helper functions extracted from useMcpStatus.
 *
 * - statusChanged  — determines whether a new McpStatus differs from the cached one
 * - deriveConnState — maps an McpStatus to a McpConnState label
 *
 * Neither function renders a hook; both are tested as plain functions.
 * deriveConnState calls loadSettings(), so we mock the useSettings module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';

// Mock useSettings before importing the module under test so that
// loadSettings() never touches localStorage during tests.
vi.mock('./useSettings', async (importOriginal) => {
  const original = await importOriginal<typeof import('./useSettings')>();
  return {
    ...original,
    loadSettings: vi.fn(() => ({ ...original.SETTING_DEFAULTS })),
  };
});

import { statusChanged, deriveConnState } from './useMcpStatus';
import { loadSettings } from './useSettings';
import { SETTING_DEFAULTS } from './useSettings';

const mockLoadSettings = loadSettings as MockInstance;

beforeEach(() => {
  // Reset to default settings (mcpBridgeEnabled: false) before each test.
  mockLoadSettings.mockReturnValue({ ...SETTING_DEFAULTS });
});

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
    expect(deriveConnState(null)).toBe('checking');
  });

  it('returns "disabled" when not running and mcpBridgeEnabled is false', () => {
    mockLoadSettings.mockReturnValue({ ...SETTING_DEFAULTS, mcpBridgeEnabled: false });
    expect(deriveConnState({ running: false, port: 40404, idleSecs: null })).toBe('disabled');
  });

  it('returns "offline" when not running and mcpBridgeEnabled is true', () => {
    mockLoadSettings.mockReturnValue({ ...SETTING_DEFAULTS, mcpBridgeEnabled: true });
    expect(deriveConnState({ running: false, port: 40404, idleSecs: null })).toBe('offline');
  });

  it('returns "ready" when running and idleSecs is null (never connected)', () => {
    expect(deriveConnState({ running: true, port: 40404, idleSecs: null })).toBe('ready');
  });

  it('returns "connected" when running and idleSecs is 10 (below threshold)', () => {
    expect(deriveConnState({ running: true, port: 40404, idleSecs: 10 })).toBe('connected');
  });

  it('returns "connected" when running and idleSecs is 30 (at threshold boundary)', () => {
    expect(deriveConnState({ running: true, port: 40404, idleSecs: 30 })).toBe('connected');
  });

  it('returns "ready" when running and idleSecs is 31 (above threshold)', () => {
    expect(deriveConnState({ running: true, port: 40404, idleSecs: 31 })).toBe('ready');
  });
});
