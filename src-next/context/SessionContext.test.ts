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

const A = 'session-a';
const B = 'session-b';

function reduce(state: SessionState, ...actions: SessionAction[]): SessionState {
  return actions.reduce(sessionReducer, state);
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
