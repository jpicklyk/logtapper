/**
 * Tests for loadSettings() and the module-level settings store in useSettings.ts.
 *
 * loadSettings() is a pure function that reads from localStorage via
 * storageGetJSON / storageSetJSON. We mock those utilities so no real
 * localStorage access occurs during tests.
 *
 * The store (subscribeSettings / getSettingsSnapshot / updateSetting) is the
 * useSyncExternalStore backing for useSettings — tested white-box here because
 * the vitest environment is node, so hooks cannot be rendered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';

// Mock the utils module before importing the module under test.
vi.mock('../utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils')>();
  return {
    ...original,
    storageGetJSON: vi.fn(() => ({})),
    storageSetJSON: vi.fn(),
    storageRemove: vi.fn(),
  };
});

import {
  loadSettings,
  SETTING_DEFAULTS,
  subscribeSettings,
  getSettingsSnapshot,
  updateSetting,
  resetSettings,
} from './useSettings';
import { storageGetJSON, storageSetJSON } from '../utils';

const mockStorageGetJSON = storageGetJSON as unknown as MockInstance;
const mockStorageSetJSON = storageSetJSON as unknown as MockInstance;

beforeEach(() => {
  // Default: nothing stored in localStorage.
  mockStorageGetJSON.mockReturnValue({});
  mockStorageSetJSON.mockReset();
});

// ---------------------------------------------------------------------------
// loadSettings
// ---------------------------------------------------------------------------

describe('loadSettings', () => {
  it('returns SETTING_DEFAULTS when nothing is stored', () => {
    mockStorageGetJSON.mockReturnValue({});
    const result = loadSettings();
    expect(result).toEqual(SETTING_DEFAULTS);
    expect(result.mcpBridgeEnabled).toBe(false);
  });

  it('merges stored partial settings correctly — mcpBridgeEnabled: true', () => {
    mockStorageGetJSON.mockReturnValue({ mcpBridgeEnabled: true });
    const result = loadSettings();
    expect(result.mcpBridgeEnabled).toBe(true);
    // Other defaults remain intact.
    expect(result.streamBackendLineMax).toBe(SETTING_DEFAULTS.streamBackendLineMax);
    expect(result.fileCacheBudget).toBe(SETTING_DEFAULTS.fileCacheBudget);
    expect(result.autoReconnectStream).toBe(SETTING_DEFAULTS.autoReconnectStream);
  });

  it('preserves unknown (forward-compat) keys from stored settings', () => {
    // Simulate a future setting that does not exist in SETTING_DEFAULTS.
    mockStorageGetJSON.mockReturnValue({ unknownFutureKey: 'some-value' });
    const result = loadSettings() as unknown as Record<string, unknown>;
    expect(result['unknownFutureKey']).toBe('some-value');
  });
});

// ---------------------------------------------------------------------------
// Module-level store — the useSyncExternalStore backing for useSettings
// ---------------------------------------------------------------------------

describe('settings store', () => {
  beforeEach(() => {
    resetSettings();
    mockStorageSetJSON.mockReset();
  });

  it('returns a referentially stable snapshot between updates', () => {
    const a = getSettingsSnapshot();
    const b = getSettingsSnapshot();
    expect(a).toBe(b);
  });

  it('replaces the snapshot reference on update so consumers re-render', () => {
    const before = getSettingsSnapshot();
    updateSetting('fileCacheBudget', 999_000);
    const after = getSettingsSnapshot();
    expect(after).not.toBe(before);
    expect(after.fileCacheBudget).toBe(999_000);
    // Untouched keys carry over.
    expect(after.streamBackendLineMax).toBe(SETTING_DEFAULTS.streamBackendLineMax);
  });

  it('notifies every subscriber on update — all consumers share one snapshot', () => {
    const seenA: number[] = [];
    const seenB: number[] = [];
    const unsubA = subscribeSettings(() => seenA.push(getSettingsSnapshot().fileCacheBudget));
    const unsubB = subscribeSettings(() => seenB.push(getSettingsSnapshot().fileCacheBudget));

    updateSetting('fileCacheBudget', 111_000);
    updateSetting('fileCacheBudget', 222_000);

    expect(seenA).toEqual([111_000, 222_000]);
    expect(seenB).toEqual([111_000, 222_000]);

    unsubA();
    unsubB();
  });

  it('stops notifying after unsubscribe', () => {
    let calls = 0;
    const unsub = subscribeSettings(() => { calls++; });
    updateSetting('autoReconnectStream', false);
    expect(calls).toBe(1);
    unsub();
    updateSetting('autoReconnectStream', true);
    expect(calls).toBe(1);
  });

  it('persists the whole settings object to localStorage on update', () => {
    updateSetting('mcpBridgeEnabled', true);
    expect(mockStorageSetJSON).toHaveBeenCalledWith(
      'logtapper_settings',
      expect.objectContaining({ mcpBridgeEnabled: true }),
    );
  });

  it('resetSettings restores defaults and notifies subscribers', () => {
    updateSetting('fileCacheBudget', 1);
    let notified = 0;
    const unsub = subscribeSettings(() => { notified++; });
    resetSettings();
    expect(notified).toBe(1);
    expect(getSettingsSnapshot()).toEqual(SETTING_DEFAULTS);
    unsub();
  });
});
