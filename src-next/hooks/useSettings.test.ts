/**
 * Tests for loadSettings() in useSettings.ts.
 *
 * loadSettings() is a pure function that reads from localStorage via
 * storageGetJSON / storageSetJSON. We mock those utilities so no real
 * localStorage access occurs during tests.
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

import { loadSettings, SETTING_DEFAULTS } from './useSettings';
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
