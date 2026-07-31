/**
 * Tests for the session reducer's per-session filter state.
 *
 * `timeFilterLineNums` used to live in a single hook-global `useState` in
 * `useFilterScan` while every other filter field (`streamFilter`,
 * `filteredLineNums`, `sectionFilteredLineNums`, ...) was already per-session
 * state in `filterStateBySession`. Switching the focused tab left session A's
 * time-filter result lines applied while session B was displayed. These tests
 * pin the fix: `timeFilterLineNums` now lives in `FilterState` alongside the
 * other filter fields and is isolated, cleared, and reset the same way.
 *
 * White-box: the reducer is pure, so it is imported and driven directly rather
 * than simulated. No DOM — vitest runs these in the node environment.
 */
import { describe, it, expect } from 'vitest';
import { sessionReducer, initialState, type SessionState, type SessionAction } from './SessionContext';
import type { LoadResult } from '../bridge/types';

const A = 'session-a';
const B = 'session-b';

function reduce(state: SessionState, ...actions: SessionAction[]): SessionState {
  return actions.reduce(sessionReducer, state);
}

function loadResult(sessionId: string): LoadResult {
  return {
    sessionId,
    sourceId: sessionId,
    sourceName: sessionId,
    filePath: null,
    totalLines: 0,
    fileSize: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    sourceType: 'Unknown',
    isStreaming: false,
    isIndexing: false,
    hasCrlf: false,
    encoding: 'UTF-8',
  };
}

function registerAction(sessionId: string): SessionAction {
  return { type: 'session:registered', paneId: `pane-${sessionId}`, result: loadResult(sessionId) };
}

describe('filter:updated — timeFilterLineNums isolation', () => {
  it('keeps one session\'s time-filter result lines out of another session', () => {
    const state = reduce(
      initialState,
      { type: 'filter:updated', sessionId: A, patch: { timeFilterLineNums: [1, 2, 3] } },
      { type: 'filter:updated', sessionId: B, patch: { timeFilterLineNums: [9, 10] } },
    );

    expect(state.filterStateBySession.get(A)!.timeFilterLineNums).toEqual([1, 2, 3]);
    expect(state.filterStateBySession.get(B)!.timeFilterLineNums).toEqual([9, 10]);
  });

  it('defaults to null for a session with no filter state yet', () => {
    expect(initialState.filterStateBySession.get(A)).toBeUndefined();
  });

  it('merges into existing filter state without clobbering other fields', () => {
    const state = reduce(
      initialState,
      { type: 'filter:updated', sessionId: A, patch: { streamFilter: 'tag:Activity' } },
      { type: 'filter:updated', sessionId: A, patch: { timeFilterLineNums: [5] } },
    );

    expect(state.filterStateBySession.get(A)!.streamFilter).toBe('tag:Activity');
    expect(state.filterStateBySession.get(A)!.timeFilterLineNums).toEqual([5]);
  });

  it('clears timeFilterLineNums on the target session only', () => {
    const state = reduce(
      initialState,
      { type: 'filter:updated', sessionId: A, patch: { timeFilterLineNums: [1, 2] } },
      { type: 'filter:updated', sessionId: B, patch: { timeFilterLineNums: [3, 4] } },
      { type: 'filter:updated', sessionId: A, patch: { timeFilterLineNums: null } },
    );

    expect(state.filterStateBySession.get(A)!.timeFilterLineNums).toBeNull();
    expect(state.filterStateBySession.get(B)!.timeFilterLineNums).toEqual([3, 4]);
  });
});

describe('filter:reset — clears the whole per-session filter entry', () => {
  it('drops timeFilterLineNums along with the rest of the session\'s filter state', () => {
    const state = reduce(
      initialState,
      { type: 'filter:updated', sessionId: A, patch: { timeFilterLineNums: [1, 2], streamFilter: 'level:E' } },
      { type: 'filter:reset', sessionId: A },
    );

    expect(state.filterStateBySession.has(A)).toBe(false);
  });

  it('leaves other sessions\' time-filter results untouched', () => {
    const state = reduce(
      initialState,
      { type: 'filter:updated', sessionId: A, patch: { timeFilterLineNums: [1, 2] } },
      { type: 'filter:updated', sessionId: B, patch: { timeFilterLineNums: [3, 4] } },
      { type: 'filter:reset', sessionId: A },
    );

    expect(state.filterStateBySession.has(A)).toBe(false);
    expect(state.filterStateBySession.get(B)!.timeFilterLineNums).toEqual([3, 4]);
  });
});

/**
 * U60 — the 'indexing:progress' reducer case used to unconditionally
 * `.set()`, so clearing progress stored `null` instead of deleting the key,
 * and a late event for a closed/unknown session recreated an orphan entry
 * nothing would ever clean up.
 */
describe('indexing:progress — key lifecycle', () => {
  it('deletes the map entry when progress is cleared to null, rather than storing null', () => {
    const progress = { linesIndexed: 10, totalLines: 100, percent: 10, done: false };
    const state = reduce(
      initialState,
      registerAction(A),
      { type: 'indexing:progress', sessionId: A, progress },
      { type: 'indexing:progress', sessionId: A, progress: null },
    );

    expect(state.indexingProgressBySession.has(A)).toBe(false);
  });

  it('ignores a progress event for a sessionId not present in state.sessions', () => {
    const progress = { linesIndexed: 1, totalLines: 10, percent: 10, done: false };
    const state = reduce(
      initialState,
      { type: 'indexing:progress', sessionId: 'unknown-session', progress },
    );

    expect(state.indexingProgressBySession.has('unknown-session')).toBe(false);
  });

  it('ignores a late null-clear for a session that already closed', () => {
    const progress = { linesIndexed: 1, totalLines: 10, percent: 10, done: false };
    const registered = reduce(
      initialState,
      registerAction(A),
      { type: 'indexing:progress', sessionId: A, progress },
    );
    // Session closes — removed from state.sessions.
    const closed = reduce(registered, { type: 'session:terminated', sessionId: A });
    expect(closed.indexingProgressBySession.has(A)).toBe(false);

    // A stale null-clear arrives after close — must be a true no-op (same
    // reference returned, not just an equivalent empty map).
    const afterLateEvent = reduce(closed, { type: 'indexing:progress', sessionId: A, progress: null });
    expect(afterLateEvent).toBe(closed);
  });

  it('bails out with the same state reference when clearing an already-cleared entry', () => {
    const state = reduce(initialState, registerAction(A));
    const afterNoopClear = reduce(state, { type: 'indexing:progress', sessionId: A, progress: null });

    expect(afterNoopClear).toBe(state);
  });

  it('sets progress for a registered session normally', () => {
    const progress = { linesIndexed: 50, totalLines: 100, percent: 50, done: false };
    const state = reduce(
      initialState,
      registerAction(A),
      { type: 'indexing:progress', sessionId: A, progress },
    );

    expect(state.indexingProgressBySession.get(A)).toEqual(progress);
  });

  it('keeps two sessions\' progress isolated', () => {
    const progressA = { linesIndexed: 1, totalLines: 10, percent: 10, done: false };
    const progressB = { linesIndexed: 5, totalLines: 10, percent: 50, done: false };
    const state = reduce(
      initialState,
      registerAction(A),
      registerAction(B),
      { type: 'indexing:progress', sessionId: A, progress: progressA },
      { type: 'indexing:progress', sessionId: B, progress: progressB },
    );

    expect(state.indexingProgressBySession.get(A)).toEqual(progressA);
    expect(state.indexingProgressBySession.get(B)).toEqual(progressB);
  });
});
