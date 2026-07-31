import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { SearchQuery, SearchSummary, SearchProgress } from '../bridge/types';
import { searchLogs } from '../bridge/commands';
import { onSearchProgress } from '../bridge/events';
import { useActionsContext } from './ActionsContext';

// ---------------------------------------------------------------------------
// Value types — split so action consumers never re-render on query changes
// ---------------------------------------------------------------------------

export interface PaneSearchState {
  search: SearchQuery | null;
  searchSummary: SearchSummary | null;
  currentMatchIndex: number;
}

export interface PaneSearchActions {
  /** Run a search against this pane's session, or clear it with null. */
  setSearch: (query: SearchQuery | null) => void;
  /** Advance to the next (1) or previous (-1) match within this pane. */
  jumpToMatch: (direction: 1 | -1) => void;
  /**
   * Publish the pane's currently visible line numbers (filter ∩ section).
   * Match navigation is scoped to these. Null means "no filter — all lines".
   */
  setEffectiveLineNums: (lineNums: number[] | null) => void;
}

const EMPTY_STATE: PaneSearchState = {
  search: null,
  searchSummary: null,
  currentMatchIndex: 0,
};

const NOOP_ACTIONS: PaneSearchActions = {
  setSearch: () => {},
  jumpToMatch: () => {},
  setEffectiveLineNums: () => {},
};

const PaneSearchStateCtx = createContext<PaneSearchState>(EMPTY_STATE);
const PaneSearchActionsCtx = createContext<PaneSearchActions>(NOOP_ACTIONS);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface Props {
  /** Pane this search belongs to — scroll targets are addressed to it. */
  paneId: string | null;
  /** Session the query runs against. */
  sessionId: string | null;
  children: ReactNode;
}

/**
 * Per-pane search state and execution.
 *
 * One provider per pane, so two panes hold two independent queries. The backend
 * search itself is issued here (rather than in a global hook) because the query,
 * its progress stream, and its result summary are all pane-scoped.
 *
 * Scrolling stays global: `jumpToLine(lineNum, paneId)` already targets a single
 * pane via `ScrollCtx.jumpPaneId`, so this provider reuses it rather than
 * introducing a second scroll mechanism.
 */
export function PaneSearchProvider({ paneId, sessionId, children }: Props) {
  const [state, setState] = useState<PaneSearchState>(EMPTY_STATE);
  const { jumpToLine } = useActionsContext();

  // Refs keep the action callbacks stable — they never re-create on state change.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const paneIdRef = useRef(paneId);
  paneIdRef.current = paneId;
  const jumpToLineRef = useRef(jumpToLine);
  jumpToLineRef.current = jumpToLine;
  // Mirrors `state` during render so jumpToMatch can read the current match
  // summary synchronously, outside the setState updater (U13 fix below).
  const stateRef = useRef(state);
  stateRef.current = state;
  const effectiveLineNumsRef = useRef<number[] | null>(null);
  const progressUnlistenRef = useRef<UnlistenFn | null>(null);
  /** Guards against a stale in-flight search resolving over a newer one. */
  const searchSeqRef = useRef(0);

  const setEffectiveLineNums = useCallback((lineNums: number[] | null) => {
    effectiveLineNumsRef.current = lineNums;
  }, []);

  const setSearch = useCallback((query: SearchQuery | null) => {
    const sid = sessionIdRef.current;
    const seq = ++searchSeqRef.current;

    progressUnlistenRef.current?.();
    progressUnlistenRef.current = null;

    setState({ search: query, searchSummary: null, currentMatchIndex: 0 });

    if (!sid || !query) return;

    const accumulated: number[] = [];
    let jumpedToFirst = false;
    let cancelled = false;

    onSearchProgress((payload: SearchProgress) => {
      // Ignore other sessions, and any progress from a superseded search.
      if (cancelled || payload.sessionId !== sid || seq !== searchSeqRef.current) return;

      if (payload.newMatches.length > 0) {
        accumulated.push(...payload.newMatches);
        const snapshot = [...accumulated];
        setState((prev) => ({
          ...prev,
          searchSummary: {
            totalMatches: payload.matchedSoFar,
            matchLineNums: snapshot,
            byLevel: prev.searchSummary?.byLevel ?? {},
            byTag: prev.searchSummary?.byTag ?? {},
          },
        }));
        if (!jumpedToFirst) {
          jumpedToFirst = true;
          jumpToLineRef.current(snapshot[0], paneIdRef.current ?? undefined);
        }
      }

      if (payload.done) {
        progressUnlistenRef.current?.();
        progressUnlistenRef.current = null;
      }
    }).then((unlisten) => {
      // The search may already have been superseded while the listener was
      // being registered — unregister immediately if so (StrictMode-safe).
      if (cancelled || seq !== searchSeqRef.current) unlisten();
      else progressUnlistenRef.current = unlisten;
    });

    searchLogs(sid, query)
      .then((summary) => {
        if (seq !== searchSeqRef.current) return;
        setState((prev) => ({ ...prev, searchSummary: summary, currentMatchIndex: 0 }));
        if (summary.matchLineNums.length > 0 && !jumpedToFirst) {
          jumpToLineRef.current(summary.matchLineNums[0], paneIdRef.current ?? undefined);
        }
      })
      .catch((e) => {
        console.error('Search error:', e);
      })
      .finally(() => {
        // Only tear down if THIS search is still the current one. Without the
        // guard, a superseded search settling would unregister the successor's
        // live progress listener and kill its incremental results.
        if (seq !== searchSeqRef.current) return;
        cancelled = true;
        progressUnlistenRef.current?.();
        progressUnlistenRef.current = null;
      });
  }, []);

  // Clear this pane's search when its session changes. The pane provider is not
  // remounted on session switch, so without this the previous session's query,
  // match count, and match line numbers survive into the new session — and
  // match navigation would jump to line numbers from the old content.
  useEffect(() => {
    searchSeqRef.current++;
    progressUnlistenRef.current?.();
    progressUnlistenRef.current = null;
    effectiveLineNumsRef.current = null;
    setState(EMPTY_STATE);
  }, [sessionId]);

  // Unregister a still-pending progress listener if the pane unmounts.
  useEffect(() => () => {
    searchSeqRef.current++;
    progressUnlistenRef.current?.();
    progressUnlistenRef.current = null;
  }, []);

  const jumpToMatch = useCallback((direction: 1 | -1) => {
    // Compute the next match index from stateRef.current (synchronously current
    // committed state) BEFORE touching setState, so jumpToLine is called exactly
    // once at the top level rather than inside the setState updater — StrictMode
    // double-invokes updaters, which would fire the scroll side effect twice.
    const prev = stateRef.current;
    const summary = prev.searchSummary;
    if (!summary || summary.matchLineNums.length === 0) return;

    // Scope matches to this pane's visible lines (stream filter ∩ section
    // filter). Null means no filter is active and every match is navigable.
    const effective = effectiveLineNumsRef.current;
    const matches = effective
      ? summary.matchLineNums.filter((ln) => binaryIncludes(effective, ln))
      : summary.matchLineNums;

    if (matches.length === 0) return;

    const next = (prev.currentMatchIndex + direction + matches.length) % matches.length;
    jumpToLineRef.current(matches[next], paneIdRef.current ?? undefined);

    // Pure updater — only applies the pre-computed index, and only if state
    // hasn't moved on since we read it above (defensive bail against a race).
    setState((p) => (p === prev ? { ...p, currentMatchIndex: next } : p));
  }, []);

  const actions = useMemo<PaneSearchActions>(
    () => ({ setSearch, jumpToMatch, setEffectiveLineNums }),
    [setSearch, jumpToMatch, setEffectiveLineNums],
  );

  return (
    <PaneSearchStateCtx.Provider value={state}>
      <PaneSearchActionsCtx.Provider value={actions}>
        {children}
      </PaneSearchActionsCtx.Provider>
    </PaneSearchStateCtx.Provider>
  );
}

/** Binary search over a sorted ascending array. O(log n). */
function binaryIncludes(sorted: number[], target: number): boolean {
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

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Full search state for the enclosing pane. */
export function usePaneSearch(): { query: SearchQuery | null; summary: SearchSummary | null; matchIndex: number } {
  const { search, searchSummary, currentMatchIndex } = useContext(PaneSearchStateCtx);
  return useMemo(
    () => ({ query: search, summary: searchSummary, matchIndex: currentMatchIndex }),
    [search, searchSummary, currentMatchIndex],
  );
}

/** Just the query for the enclosing pane — the narrowest read. */
export function usePaneSearchQuery(): SearchQuery | null {
  return useContext(PaneSearchStateCtx).search;
}

/** Stable search actions for the enclosing pane. */
export function usePaneSearchActions(): PaneSearchActions {
  return useContext(PaneSearchActionsCtx);
}
