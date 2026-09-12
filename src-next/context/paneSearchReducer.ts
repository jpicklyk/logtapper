import type { SearchQuery, SearchSummary } from '../bridge/types';

/**
 * Pure state-transition helpers behind `PaneSearchContext`'s `useState` calls,
 * extracted so the per-pane search logic is testable in the node vitest
 * environment without mounting React (see `paneSearchReducer.test.ts`).
 *
 * Each `PaneSearchProvider` instance owns its own `PaneSearchState` object —
 * isolation between panes comes from that (one provider per pane, no shared
 * module-level state here), not from any key/id threaded through these pure
 * functions. Because every function below is pure (takes its previous state
 * explicitly, returns a new state, touches nothing external), calling them
 * with two independently-held state objects can never let one pane's search
 * leak into another's — there is no shared mutable structure for it to leak
 * through.
 */
export interface PaneSearchState {
  search: SearchQuery | null;
  searchSummary: SearchSummary | null;
  currentMatchIndex: number;
}

export const EMPTY_PANE_SEARCH_STATE: PaneSearchState = {
  search: null,
  searchSummary: null,
  currentMatchIndex: 0,
};

/** New search issued (or cleared, with `query: null`) — resets summary and match index. */
export function startSearch(query: SearchQuery | null): PaneSearchState {
  return { search: query, searchSummary: null, currentMatchIndex: 0 };
}

/** An incremental `search-progress` batch arrived — merge the accumulated matches so far. */
export function applySearchProgress(
  prev: PaneSearchState,
  matchedSoFar: number,
  matchLineNums: number[],
): PaneSearchState {
  return {
    ...prev,
    searchSummary: {
      totalMatches: matchedSoFar,
      matchLineNums,
      byLevel: prev.searchSummary?.byLevel ?? {},
      byTag: prev.searchSummary?.byTag ?? {},
    },
  };
}

/** The backend's final `SearchSummary` resolved — replaces the summary and resets match index. */
export function applySearchSummary(prev: PaneSearchState, summary: SearchSummary): PaneSearchState {
  return { ...prev, searchSummary: summary, currentMatchIndex: 0 };
}

/** Binary search over a sorted ascending array. O(log n). */
export function binaryIncludes(sorted: number[], target: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] === target) return true;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

export interface JumpTarget {
  /** Line number to scroll the pane to. */
  lineNum: number;
  /** `currentMatchIndex` to commit once the scroll has been issued. */
  nextIndex: number;
}

/**
 * Pure computation behind `jumpToMatch`: given the pane's current search
 * state, a navigation direction, and the pane's effective (filter ∩ section)
 * line numbers, returns the line to scroll to and the match index to commit —
 * or `null` when there is nothing to navigate to (no summary yet, no matches
 * at all, or no matches survive the effective-lines filter).
 *
 * Deliberately side-effect-free: the caller (`PaneSearchContext`) is
 * responsible for calling `jumpToLine` and committing `nextIndex` via
 * `setState` — see the U13 doc comment there for why that split matters under
 * StrictMode.
 */
export function computeJumpTarget(
  state: PaneSearchState,
  direction: 1 | -1,
  effectiveLineNums: number[] | null,
): JumpTarget | null {
  const summary = state.searchSummary;
  if (!summary || summary.matchLineNums.length === 0) return null;

  const matches = effectiveLineNums
    ? summary.matchLineNums.filter((ln) => binaryIncludes(effectiveLineNums, ln))
    : summary.matchLineNums;
  if (matches.length === 0) return null;

  const nextIndex = (state.currentMatchIndex + direction + matches.length) % matches.length;
  return { lineNum: matches[nextIndex], nextIndex };
}
