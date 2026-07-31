// @vitest-environment jsdom
/**
 * U8 — loading/error state must be per-key (`${sessionId}:${processorId}`),
 * not a single shared flag. Before the fix, two concurrent fetchCharts calls
 * for different processors shared one `loading`/`error` boolean — whichever
 * call finished first cleared `loading` globally even while the other was
 * still in flight, and a later error could stomp an unrelated success.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../bridge/commands', () => ({
  getChartData: vi.fn(),
}));

import { useChartData } from './useChartData';
import { getChartData } from '../bridge/commands';
import type { ChartData } from '../bridge/types';

const mockGetChartData = getChartData as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGetChartData.mockReset();
});

describe('[U8] useChartData per-key loading/error state', () => {
  it('a fast fetch completing does not clear loading for a still-in-flight fetch', async () => {
    let resolveSlow!: (data: ChartData[]) => void;
    const slow = new Promise<ChartData[]>((resolve) => { resolveSlow = resolve; });

    mockGetChartData.mockImplementation((_sessionId: string, processorId: string) => {
      if (processorId === 'slow-proc') return slow;
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useChartData());

    // Kick off the slow fetch first, then a fast one for a different processor.
    act(() => {
      void result.current.fetchCharts('sess1', 'slow-proc');
    });
    await act(async () => {
      await result.current.fetchCharts('sess1', 'fast-proc');
    });

    // The fast fetch finishing must not clear the slow fetch's loading flag.
    expect(result.current.isLoading('sess1', 'slow-proc')).toBe(true);
    expect(result.current.isLoading('sess1', 'fast-proc')).toBe(false);

    await act(async () => {
      resolveSlow([]);
      await slow;
    });

    await waitFor(() => {
      expect(result.current.isLoading('sess1', 'slow-proc')).toBe(false);
    });
  });

  it('an error for one processor does not surface under a different processor key', async () => {
    mockGetChartData.mockImplementation((_sessionId: string, processorId: string) => {
      if (processorId === 'bad-proc') return Promise.reject(new Error('boom'));
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useChartData());

    await act(async () => {
      await result.current.fetchCharts('sess1', 'bad-proc');
    });
    await act(async () => {
      await result.current.fetchCharts('sess1', 'good-proc');
    });

    expect(result.current.getError('sess1', 'bad-proc')).toContain('boom');
    expect(result.current.getError('sess1', 'good-proc')).toBeNull();
  });

  it('clearSessionCharts drops loading/error entries for that session only', async () => {
    mockGetChartData.mockImplementation(() => Promise.reject(new Error('fail')));

    const { result } = renderHook(() => useChartData());

    await act(async () => {
      await result.current.fetchCharts('sess1', 'procA');
      await result.current.fetchCharts('sess2', 'procA');
    });

    expect(result.current.getError('sess1', 'procA')).not.toBeNull();
    expect(result.current.getError('sess2', 'procA')).not.toBeNull();

    act(() => {
      result.current.clearSessionCharts('sess1');
    });

    expect(result.current.getError('sess1', 'procA')).toBeNull();
    expect(result.current.getError('sess2', 'procA')).not.toBeNull();
  });
});
