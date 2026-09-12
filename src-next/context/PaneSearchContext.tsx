import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { SearchQuery, SearchSummary, SearchProgress } from '../bridge/types';
import { searchLogs } from '../bridge/commands';
import { onSearchProgress } from '../bridge/events';
import { useActionsContext } from './ActionsContext';
import {
  EMPTY_PANE_SEARCH_STATE,
  startSearch,
  applySearchProgress,
  applySearchSummary,
  computeJumpTarget,
  type PaneSearchState,
} from './paneSearchReducer';

// Re-exported for existing external type-only imports (barrel + callers keep
// importing `PaneSearchState` from this module, not the internal reducer file).
export type { PaneSearchState };

// ---------------------------------------------------------------------------
// Value types — split so action consumers never re-render on query changes
// ---------------------------------------------------------------------------

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

const EMPTY_STATE: PaneSearchState = EMPTY_PANE_SEARCH_STATE;

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

    setState(startSearch(query));

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
        setState((prev) => applySearchProgress(prev, payload.matchedSoFar, snapshot));
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
        setState((prev) => applySearchSummary(prev, summary));
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
  //
  // Deliberately does NOT touch effectiveLineNumsRef. React flushes child
  // effects before parent effects within a commit, and PaneContent (a
  // descendant of this provider) owns publishing effectiveLineNumsRef via its
  // own effect keyed on [effectiveLineNums, sessionId] — so on a session
  // switch, PaneContent's effect has already run and published the NEW
  // session's scoped lines by the time this effect fires. If this effect also
  // nulled the ref, it would clobber that fresher same-commit publish and
  // jumpToMatch could navigate outside the filtered set until the next
  // re-render. PaneContent's effect is unconditional on sessionId, so the ref
  // is never left holding a stale value from the previous session.
  useEffect(() => {
    searchSeqRef.current++;
    progressUnlistenRef.current?.();
    progressUnlistenRef.current = null;
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
    // The actual computation (filtering matches to this pane's effective lines,
    // wrapping the index) is pure and lives in `computeJumpTarget`.
    const prev = stateRef.current;
    const target = computeJumpTarget(prev, direction, effectiveLineNumsRef.current);
    if (!target) return;

    jumpToLineRef.current(target.lineNum, paneIdRef.current ?? undefined);

    // Pure updater — only applies the pre-computed index, and only if state
    // hasn't moved on since we read it above (defensive bail against a race).
    setState((p) => (p === prev ? { ...p, currentMatchIndex: target.nextIndex } : p));
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
