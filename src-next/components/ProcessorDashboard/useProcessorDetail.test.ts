// @vitest-environment jsdom
/**
 * Tests for useProcessorDetail hook.
 *
 * Primary focus: async effects must use cancelled flags so that rapid
 * processor switching does not allow stale responses to overwrite current state.
 * This mirrors the pattern already used for state tracker and correlator effects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { MatchedLine } from '../../bridge/types';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the hook
// ---------------------------------------------------------------------------

const mockGetVars = vi.fn<(sid: string, pid: string) => Promise<Record<string, unknown>>>();

vi.mock('../../hooks', () => ({
  usePipeline: () => ({ getVars: mockGetVars }),
  useCorrelatorResult: () => ({ result: null, loading: false, error: null }),
}));

vi.mock('../../bridge/commands', () => ({
  getMatchedLines: vi.fn().mockResolvedValue([]),
  getPiiMappings: vi.fn(),
  getStateTransitions: vi.fn().mockResolvedValue([]),
  getStateAtLine: vi.fn().mockResolvedValue(null),
  getCorrelatorEvents: vi.fn().mockResolvedValue(null),
}));

import { useProcessorDetail } from './useProcessorDetail';
import { getPiiMappings } from '../../bridge/commands';

const mockGetPiiMappings = getPiiMappings as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a deferred promise whose resolution we control manually. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BASE_PROPS = {
  selectedId: 'proc-A',
  sessionId: 'sess-1',
  runCount: 1,
  processorType: 'reporter' as string | null,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVars.mockResolvedValue({});
  mockGetPiiMappings.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// Race protection: getVars
// ---------------------------------------------------------------------------

describe('getVars race protection', () => {
  it('discards stale getVars response when selectedId changes before resolution', async () => {
    const deferredA = deferred<Record<string, unknown>>();
    const deferredB = deferred<Record<string, unknown>>();

    // First render: proc-A — getVars returns a pending promise
    mockGetVars.mockReturnValueOnce(deferredA.promise);
    const { result, rerender } = renderHook(
      (props) => useProcessorDetail(props),
      { initialProps: BASE_PROPS },
    );

    // Switch to proc-B before A resolves
    mockGetVars.mockReturnValueOnce(deferredB.promise);
    rerender({ ...BASE_PROPS, selectedId: 'proc-B' });

    // Resolve A (stale) — should be discarded
    await act(async () => { deferredA.resolve({ stale: true }); });

    // vars should NOT contain the stale data
    expect(result.current.vars).not.toEqual({ stale: true });

    // Resolve B (current) — should be applied
    await act(async () => { deferredB.resolve({ current: true }); });

    await waitFor(() => {
      expect(result.current.vars).toEqual({ current: true });
    });
  });
});

// ---------------------------------------------------------------------------
// piiMappings reset on processor switch
// ---------------------------------------------------------------------------

describe('piiMappings reset on processor switch', () => {
  it('clears piiMappings when switching away from __pii_anonymizer', async () => {
    const piiProps = { ...BASE_PROPS, selectedId: '__pii_anonymizer' };

    mockGetPiiMappings.mockResolvedValueOnce({ token1: 'secret1' });
    const { result, rerender } = renderHook(
      (props) => useProcessorDetail(props),
      { initialProps: piiProps },
    );

    // Wait for PII mappings to populate
    await waitFor(() => {
      expect(result.current.piiMappings).toEqual({ token1: 'secret1' });
    });

    // Switch to a different processor
    rerender({ ...BASE_PROPS, selectedId: 'other-proc' });

    // piiMappings should be cleared
    expect(result.current.piiMappings).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Race protection: getPiiMappings
// ---------------------------------------------------------------------------

describe('getPiiMappings race protection', () => {
  it('discards stale PII mappings when selectedId changes away and back', async () => {
    const deferredFirst = deferred<Record<string, string>>();
    const deferredSecond = deferred<Record<string, string>>();

    const piiProps = { ...BASE_PROPS, selectedId: '__pii_anonymizer' };

    // First render: PII anonymizer selected — getPiiMappings returns pending
    mockGetPiiMappings.mockReturnValueOnce(deferredFirst.promise);
    const { result, rerender } = renderHook(
      (props) => useProcessorDetail(props),
      { initialProps: piiProps },
    );

    // Switch away (clears condition) then back — triggers a new fetch
    rerender({ ...BASE_PROPS, selectedId: 'other-proc' });
    mockGetPiiMappings.mockReturnValueOnce(deferredSecond.promise);
    rerender(piiProps);

    // Resolve the first (stale) fetch
    await act(async () => { deferredFirst.resolve({ stale_token: 'STALE' }); });

    // Should NOT have the stale mappings
    expect(result.current.piiMappings).not.toEqual({ stale_token: 'STALE' });

    // Resolve the second (current) fetch
    await act(async () => { deferredSecond.resolve({ current_token: 'CURRENT' }); });

    await waitFor(() => {
      expect(result.current.piiMappings).toEqual({ current_token: 'CURRENT' });
    });
  });
});

// ---------------------------------------------------------------------------
// Race protection: fetchMatches sequence counter
// ---------------------------------------------------------------------------

describe('fetchMatches race protection', () => {
  it('discards stale fetchMatches response when selectedId changes before resolution', async () => {
    const { getMatchedLines } = await import('../../bridge/commands');
    const mockGetMatchedLines = getMatchedLines as ReturnType<typeof vi.fn>;

    const deferredA = deferred<MatchedLine[]>();
    const deferredB = deferred<MatchedLine[]>();

    // First render: proc-A
    mockGetMatchedLines.mockReturnValueOnce(deferredA.promise);
    const { result, rerender } = renderHook(
      (props) => useProcessorDetail(props),
      { initialProps: BASE_PROPS },
    );

    // Toggle matches on — triggers fetchMatches for proc-A
    await act(async () => { result.current.handleToggleMatches(); });

    // Switch to proc-B before A resolves
    mockGetMatchedLines.mockReturnValueOnce(deferredB.promise);
    rerender({ ...BASE_PROPS, selectedId: 'proc-B' });

    // Toggle matches on for proc-B
    await act(async () => { result.current.handleToggleMatches(); });

    // Resolve A (stale) — should be discarded by sequence counter
    const staleMatches: MatchedLine[] = [{ lineNum: 10, raw: 'stale' }];
    await act(async () => { deferredA.resolve(staleMatches); });

    expect(result.current.matchedLines).not.toEqual(staleMatches);

    // Resolve B (current) — should be applied
    const currentMatches: MatchedLine[] = [{ lineNum: 20, raw: 'current' }];
    await act(async () => { deferredB.resolve(currentMatches); });

    await waitFor(() => {
      expect(result.current.matchedLines).toEqual(currentMatches);
    });
  });

  it('discards in-flight fetchMatches when selectedId changes without a follow-up toggle', async () => {
    // Covers the gap where the reset effect does NOT bump fetchSeqRef:
    // proc-A fetch is in flight → selectedId changes (reset fires) → proc-A
    // response resolves → must be discarded even though proc-B never called
    // fetchMatches yet.
    const { getMatchedLines } = await import('../../bridge/commands');
    const mockGetMatchedLines = getMatchedLines as ReturnType<typeof vi.fn>;

    const deferredA = deferred<MatchedLine[]>();

    // First render: proc-A, matches visible
    mockGetMatchedLines.mockReturnValueOnce(deferredA.promise);
    const { result, rerender } = renderHook(
      (props) => useProcessorDetail(props),
      { initialProps: BASE_PROPS },
    );

    // Toggle matches on — in-flight fetch for proc-A
    await act(async () => { result.current.handleToggleMatches(); });

    // Switch to proc-B — reset effect fires; no new fetchMatches triggered
    rerender({ ...BASE_PROPS, selectedId: 'proc-B' });

    // proc-A response arrives late
    const staleMatches: MatchedLine[] = [{ lineNum: 99, raw: 'proc-a-stale' }];
    await act(async () => { deferredA.resolve(staleMatches); });

    // matchedLines must remain empty (reset cleared it; stale response discarded)
    expect(result.current.matchedLines).toEqual([]);
    // showMatches was reset by the selectedId change
    expect(result.current.showMatches).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// showMatchesRef: streaming refetch reads current value
// ---------------------------------------------------------------------------

describe('streaming refetch reads current showMatches via ref', () => {
  it('calls fetchMatches when showMatches is toggled on before runCount increments', async () => {
    const { getMatchedLines } = await import('../../bridge/commands');
    const mockGetMatchedLines = getMatchedLines as ReturnType<typeof vi.fn>;
    mockGetMatchedLines.mockResolvedValue([]);

    const { result, rerender } = renderHook(
      (props) => useProcessorDetail(props),
      { initialProps: BASE_PROPS },
    );

    // Toggle matches on
    await act(async () => { result.current.handleToggleMatches(); });
    expect(result.current.showMatches).toBe(true);

    // Clear call count after the initial toggle fetch
    mockGetMatchedLines.mockClear();
    mockGetMatchedLines.mockResolvedValue([]);

    // Increment runCount — streaming refetch should fire because showMatchesRef.current is true
    rerender({ ...BASE_PROPS, runCount: 2 });

    await waitFor(() => {
      expect(mockGetMatchedLines).toHaveBeenCalledWith('sess-1', 'proc-A');
    });
  });
});
