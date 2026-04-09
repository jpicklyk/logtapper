// @vitest-environment jsdom
/**
 * Tests for useAnonymizerConfig hook.
 *
 * Primary focus: mutation callbacks must not call IPC (setAnonymizerConfig)
 * inside a setState updater. The IPC call must happen after the state update,
 * exactly once per mutation — not duplicated by StrictMode's double-invoke of
 * updater functions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock the bridge commands before importing the hook
// ---------------------------------------------------------------------------
vi.mock('../bridge/commands', () => ({
  getAnonymizerConfig: vi.fn(),
  setAnonymizerConfig: vi.fn(),
}));

import { useAnonymizerConfig } from './useAnonymizerConfig';
import { getAnonymizerConfig, setAnonymizerConfig } from '../bridge/commands';
import type { AnonymizerConfig, DetectorEntry } from '../bridge/types';

const mockGetConfig = getAnonymizerConfig as ReturnType<typeof vi.fn>;
const mockSetConfig = setAnonymizerConfig as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDetector(overrides: Partial<DetectorEntry> = {}): DetectorEntry {
  return {
    id: 'email',
    label: 'Email',
    tier: 'tier1',
    fpHint: 'low',
    enabled: true,
    patterns: [
      { label: 'Standard email', regex: '[^@]+@[^@]+', builtin: true, enabled: true },
      { label: 'Loose email', regex: '\\w+@\\w+', builtin: false, enabled: true },
    ],
    ...overrides,
  };
}

function makeConfig(detectors: DetectorEntry[] = [makeDetector()]): AnonymizerConfig {
  return { detectors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the hook and wait for initial load to complete. */
async function renderLoaded(config: AnonymizerConfig = makeConfig()) {
  mockGetConfig.mockResolvedValue(config);
  mockSetConfig.mockResolvedValue(undefined);

  const result = renderHook(() => useAnonymizerConfig());

  // Wait for the initial load effect to resolve
  await waitFor(() => {
    expect(result.result.current.loading).toBe(false);
  });

  // Clear the mock call count from initial load
  mockSetConfig.mockClear();

  return result;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReset();
  mockSetConfig.mockReset();
});

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------

describe('initial load', () => {
  it('fetches config on mount and sets loading to false', async () => {
    const config = makeConfig();
    mockGetConfig.mockResolvedValue(config);

    const { result } = renderHook(() => useAnonymizerConfig());

    expect(result.current.loading).toBe(true);
    expect(result.current.config).toBeNull();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.config).toEqual(config);
    expect(mockGetConfig).toHaveBeenCalledTimes(1);
  });

  it('handles load error gracefully', async () => {
    mockGetConfig.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useAnonymizerConfig());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.config).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// IPC-outside-updater invariant
//
// Each mutation callback must call setAnonymizerConfig exactly once, OUTSIDE
// the setState updater. If the IPC were inside the updater, React StrictMode
// would invoke it twice.
// ---------------------------------------------------------------------------

describe('IPC called exactly once per mutation (not inside setState updater)', () => {
  it('toggleDetector calls setAnonymizerConfig once', async () => {
    const { result } = await renderLoaded();

    act(() => {
      result.current.toggleDetector('email', false);
    });

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const sentConfig = mockSetConfig.mock.calls[0][0] as AnonymizerConfig;
    expect(sentConfig.detectors[0].enabled).toBe(false);
  });

  it('togglePattern calls setAnonymizerConfig once', async () => {
    const { result } = await renderLoaded();

    act(() => {
      result.current.togglePattern('email', 0, false);
    });

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const sentConfig = mockSetConfig.mock.calls[0][0] as AnonymizerConfig;
    expect(sentConfig.detectors[0].patterns[0].enabled).toBe(false);
  });

  it('addPatternToDetector calls setAnonymizerConfig once', async () => {
    const { result } = await renderLoaded();

    act(() => {
      result.current.addPatternToDetector('email', 'New pat', '.*');
    });

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const sentConfig = mockSetConfig.mock.calls[0][0] as AnonymizerConfig;
    expect(sentConfig.detectors[0].patterns).toHaveLength(3);
  });

  it('removePattern calls setAnonymizerConfig once', async () => {
    const { result } = await renderLoaded();

    act(() => {
      result.current.removePattern('email', 1);
    });

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const sentConfig = mockSetConfig.mock.calls[0][0] as AnonymizerConfig;
    expect(sentConfig.detectors[0].patterns).toHaveLength(1);
  });

  it('addCustomDetector calls setAnonymizerConfig once', async () => {
    const { result } = await renderLoaded();

    act(() => {
      result.current.addCustomDetector('Custom', '\\d+');
    });

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const sentConfig = mockSetConfig.mock.calls[0][0] as AnonymizerConfig;
    expect(sentConfig.detectors).toHaveLength(2);
  });

  it('removeCustomDetector calls setAnonymizerConfig once', async () => {
    const customDetector = makeDetector({ id: 'custom_1', label: 'Custom' });
    const { result } = await renderLoaded(makeConfig([makeDetector(), customDetector]));

    act(() => {
      result.current.removeCustomDetector('custom_1');
    });

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const sentConfig = mockSetConfig.mock.calls[0][0] as AnonymizerConfig;
    expect(sentConfig.detectors).toHaveLength(1);
    expect(sentConfig.detectors[0].id).toBe('email');
  });
});

// ---------------------------------------------------------------------------
// Mutation correctness
// ---------------------------------------------------------------------------

describe('mutation correctness', () => {
  it('toggleDetector updates config state', async () => {
    const { result } = await renderLoaded();

    act(() => {
      result.current.toggleDetector('email', false);
    });

    expect(result.current.config?.detectors[0].enabled).toBe(false);
  });

  it('togglePattern updates specific pattern', async () => {
    const { result } = await renderLoaded();

    act(() => {
      result.current.togglePattern('email', 1, false);
    });

    expect(result.current.config?.detectors[0].patterns[1].enabled).toBe(false);
    expect(result.current.config?.detectors[0].patterns[0].enabled).toBe(true);
  });

  it('removeCustomDetector does not remove builtin detectors', async () => {
    const { result } = await renderLoaded();

    act(() => {
      result.current.removeCustomDetector('email');
    });

    // Builtin 'email' should still be present
    expect(result.current.config?.detectors).toHaveLength(1);
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it('updateConfig sets config and calls IPC', async () => {
    const { result } = await renderLoaded();
    const newConfig = makeConfig([makeDetector({ enabled: false })]);

    await act(async () => {
      await result.current.updateConfig(newConfig);
    });

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    expect(mockSetConfig).toHaveBeenCalledWith(newConfig);
    expect(result.current.config).toEqual(newConfig);
  });

  it('IPC config matches local state after mutation', async () => {
    const { result } = await renderLoaded();

    act(() => {
      result.current.toggleDetector('email', false);
    });

    // The config sent to IPC should match the local state
    const sentConfig = mockSetConfig.mock.calls[0][0] as AnonymizerConfig;
    expect(sentConfig).toEqual(result.current.config);
  });
});
