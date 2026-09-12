/**
 * Coverage for the pure state-transition helpers behind `PaneSearchContext` —
 * extracted so per-pane search behavior, including isolation between panes,
 * is testable in vitest's node environment without mounting React (see
 * `src-next/context/CLAUDE.md` and the item this pins: no automated coverage
 * existed for per-pane search isolation because the React suite runs in node,
 * not jsdom).
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_PANE_SEARCH_STATE,
  startSearch,
  applySearchProgress,
  applySearchSummary,
  computeJumpTarget,
  binaryIncludes,
  type PaneSearchState,
} from './paneSearchReducer';
import type { SearchQuery, SearchSummary } from '../bridge/types';

function query(text: string): SearchQuery {
  return {
    text, isRegex: false, caseSensitive: false, withinProcessor: null,
    minLevel: null, tags: null, startTime: null, endTime: null,
  };
}

function summary(matchLineNums: number[], totalMatches = matchLineNums.length): SearchSummary {
  return { totalMatches, matchLineNums, byLevel: {}, byTag: {} };
}

describe('startSearch', () => {
  it('resets summary and match index for a new query', () => {
    const state = startSearch(query('error'));
    expect(state).toEqual({ search: query('error'), searchSummary: null, currentMatchIndex: 0 });
  });

  it('clears the search entirely with a null query', () => {
    const state = startSearch(null);
    expect(state).toEqual(EMPTY_PANE_SEARCH_STATE);
  });
});

describe('applySearchProgress', () => {
  it('merges accumulated matches, preserving existing byLevel/byTag', () => {
    const prev: PaneSearchState = {
      search: query('x'),
      searchSummary: { totalMatches: 1, matchLineNums: [5], byLevel: { ERROR: 1 }, byTag: { net: 1 } },
      currentMatchIndex: 0,
    };
    const next = applySearchProgress(prev, 2, [5, 9]);
    expect(next.searchSummary).toEqual({
      totalMatches: 2, matchLineNums: [5, 9], byLevel: { ERROR: 1 }, byTag: { net: 1 },
    });
  });

  it('defaults byLevel/byTag to {} when there is no prior summary', () => {
    const prev = startSearch(query('x'));
    const next = applySearchProgress(prev, 1, [5]);
    expect(next.searchSummary).toEqual({ totalMatches: 1, matchLineNums: [5], byLevel: {}, byTag: {} });
  });

  it('does not mutate the previous state object', () => {
    const prev = startSearch(query('x'));
    const frozen = JSON.parse(JSON.stringify(prev));
    applySearchProgress(prev, 1, [5]);
    expect(prev).toEqual(frozen);
  });
});

describe('applySearchSummary', () => {
  it('replaces the summary and resets currentMatchIndex to 0', () => {
    const prev: PaneSearchState = { search: query('x'), searchSummary: summary([1, 2]), currentMatchIndex: 1 };
    const next = applySearchSummary(prev, summary([3, 4, 5]));
    expect(next).toEqual({ search: query('x'), searchSummary: summary([3, 4, 5]), currentMatchIndex: 0 });
  });
});

describe('binaryIncludes', () => {
  it('finds a present value', () => {
    expect(binaryIncludes([1, 3, 5, 7, 9], 7)).toBe(true);
  });
  it('reports an absent value as false', () => {
    expect(binaryIncludes([1, 3, 5, 7, 9], 4)).toBe(false);
  });
  it('handles an empty array', () => {
    expect(binaryIncludes([], 1)).toBe(false);
  });
});

describe('computeJumpTarget', () => {
  it('returns null when there is no search summary yet', () => {
    const state = startSearch(query('x'));
    expect(computeJumpTarget(state, 1, null)).toBeNull();
  });

  it('returns null when the summary has no matches', () => {
    const state: PaneSearchState = { search: query('x'), searchSummary: summary([]), currentMatchIndex: 0 };
    expect(computeJumpTarget(state, 1, null)).toBeNull();
  });

  it('advances forward with no effective-lines filter', () => {
    const state: PaneSearchState = { search: query('x'), searchSummary: summary([10, 20, 30]), currentMatchIndex: 0 };
    expect(computeJumpTarget(state, 1, null)).toEqual({ lineNum: 20, nextIndex: 1 });
  });

  it('wraps forward past the last match', () => {
    const state: PaneSearchState = { search: query('x'), searchSummary: summary([10, 20, 30]), currentMatchIndex: 2 };
    expect(computeJumpTarget(state, 1, null)).toEqual({ lineNum: 10, nextIndex: 0 });
  });

  it('wraps backward past the first match', () => {
    const state: PaneSearchState = { search: query('x'), searchSummary: summary([10, 20, 30]), currentMatchIndex: 0 };
    expect(computeJumpTarget(state, -1, null)).toEqual({ lineNum: 30, nextIndex: 2 });
  });

  it('scopes navigation to the effective (filtered) line numbers', () => {
    const state: PaneSearchState = {
      search: query('x'), searchSummary: summary([10, 20, 30, 40]), currentMatchIndex: 0,
    };
    // Only 10 and 30 survive the pane's current filter.
    expect(computeJumpTarget(state, 1, [10, 30])).toEqual({ lineNum: 30, nextIndex: 1 });
  });

  it('returns null when the effective-lines filter excludes every match', () => {
    const state: PaneSearchState = { search: query('x'), searchSummary: summary([10, 20]), currentMatchIndex: 0 };
    expect(computeJumpTarget(state, 1, [999])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-pane isolation: two independent state objects never cross-contaminate.
// ---------------------------------------------------------------------------

describe('per-pane search isolation', () => {
  it('applying a search to one pane leaves an independently-held pane-two state untouched', () => {
    let paneA: PaneSearchState = EMPTY_PANE_SEARCH_STATE;
    const paneB: PaneSearchState = EMPTY_PANE_SEARCH_STATE;

    paneA = startSearch(query('errors'));
    paneA = applySearchSummary(paneA, summary([1, 2, 3]));

    // Pane B never received any action — it must still be the pristine empty state.
    expect(paneB).toBe(EMPTY_PANE_SEARCH_STATE);
    expect(paneB.search).toBeNull();
    expect(paneB.searchSummary).toBeNull();

    // Pane A has its own independent query/summary.
    expect(paneA.search).toEqual(query('errors'));
    expect(paneA.searchSummary).toEqual(summary([1, 2, 3]));
  });

  it('two panes searching concurrently keep independent match indices', () => {
    let paneA: PaneSearchState = applySearchSummary(startSearch(query('a')), summary([1, 2, 3]));
    let paneB: PaneSearchState = applySearchSummary(startSearch(query('b')), summary([100, 200]));

    const targetA = computeJumpTarget(paneA, 1, null)!;
    paneA = { ...paneA, currentMatchIndex: targetA.nextIndex };

    const targetB = computeJumpTarget(paneB, -1, null)!;
    paneB = { ...paneB, currentMatchIndex: targetB.nextIndex };

    // Advancing pane A forward (0 -> 1) must not affect pane B's independent
    // backward wrap (0 -> 1, its last index) — same numeric index, produced by
    // fully independent state and a different direction, is a coincidence the
    // isolation must still hold up under.
    expect(paneA).toEqual({ search: query('a'), searchSummary: summary([1, 2, 3]), currentMatchIndex: 1 });
    expect(paneB).toEqual({ search: query('b'), searchSummary: summary([100, 200]), currentMatchIndex: 1 });
    expect(targetA.lineNum).toBe(2);
    expect(targetB.lineNum).toBe(200);

    // And each pane's summary/query remain distinct objects with distinct content.
    expect(paneA.searchSummary).not.toEqual(paneB.searchSummary);
    expect(paneA.search).not.toEqual(paneB.search);
  });
});
