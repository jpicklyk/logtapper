import { createContext, useContext, useMemo, useReducer, useCallback, useEffect, type ReactNode } from 'react';
import type { LoadResult } from '../bridge/types';
import { bus } from '../events/bus';

export interface IndexingProgress {
  linesIndexed: number;
  totalLines: number;
  percent: number;
  done: boolean;
}

export interface FilterState {
  streamFilter: string;
  timeFilterStart: string;
  timeFilterEnd: string;
  filterScanning: boolean;
  filteredLineNums: number[] | null;
  filterParseError: string | null;
  sectionFilteredLineNums: number[] | null;
}

const DEFAULT_FILTER_STATE: FilterState = {
  streamFilter: '',
  timeFilterStart: '',
  timeFilterEnd: '',
  filterScanning: false,
  filteredLineNums: null,
  filterParseError: null,
  sectionFilteredLineNums: null,
};

// ── State ─────────────────────────────────────────────────────────────────────

interface SessionState {
  sessions: Map<string, LoadResult>;
  paneSessionMap: Map<string, string>;
  loadingPaneIds: Set<string>;
  errorByPane: Map<string, string | null>;
  indexingProgressBySession: Map<string, IndexingProgress | null>;
  filterStateBySession: Map<string, FilterState>;
  streamingSessionIds: Set<string>;
  activeLogPaneId: string | null;
  activePaneId: string | null;
}

const initialState: SessionState = {
  sessions: new Map(),
  paneSessionMap: new Map(),
  loadingPaneIds: new Set(),
  errorByPane: new Map(),
  indexingProgressBySession: new Map(),
  filterStateBySession: new Map(),
  streamingSessionIds: new Set(),
  activeLogPaneId: null,
  activePaneId: null,
};

// ── Actions ───────────────────────────────────────────────────────────────────

type SessionAction =
  | { type: 'session:registered'; paneId: string; result: LoadResult }
  | { type: 'session:unregistered'; paneId: string }
  | { type: 'session:updated'; sessionId: string; updater: (prev: LoadResult) => LoadResult }
  | { type: 'session:terminated'; sessionId: string }
  | { type: 'pane:loading'; paneId: string; loading: boolean }
  | { type: 'pane:error'; paneId: string; error: string | null }
  | { type: 'pane:session-activated'; paneId: string; sessionId: string }
  | { type: 'indexing:progress'; sessionId: string; progress: IndexingProgress | null }
  | { type: 'streaming:changed'; sessionId: string; streaming: boolean }
  | { type: 'pane:focused'; paneId: string | null }
  | { type: 'pane:activated'; paneId: string }
  | { type: 'filter:updated'; sessionId: string; patch: Partial<FilterState> }
  | { type: 'filter:reset'; sessionId: string }
  | { type: 'filter:append-matches'; sessionId: string; lineNums: number[] };

// ── Reducer ───────────────────────────────────────────────────────────────────

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'session:registered': {
      const sessions = new Map(state.sessions).set(action.result.sessionId, action.result);
      // paneSessionMap is NOT updated here — call activateSessionForPane separately.
      // This prevents new-tab loads from overwriting the pane's currently active session.
      return { ...state, sessions };
    }

    case 'session:unregistered': {
      const paneSessionMap = new Map(state.paneSessionMap);
      const sessionId = paneSessionMap.get(action.paneId);
      paneSessionMap.delete(action.paneId);

      // Session-level cleanup — only when no other pane references the session
      let { sessions, indexingProgressBySession, filterStateBySession, streamingSessionIds } = state;
      if (sessionId && ![...paneSessionMap.values()].includes(sessionId)) {
        sessions = new Map(sessions);
        sessions.delete(sessionId);
        indexingProgressBySession = new Map(indexingProgressBySession);
        indexingProgressBySession.delete(sessionId);
        filterStateBySession = new Map(filterStateBySession);
        filterStateBySession.delete(sessionId);
        if (streamingSessionIds.has(sessionId)) {
          streamingSessionIds = new Set(streamingSessionIds);
          streamingSessionIds.delete(sessionId);
        }
      }

      // Pane-level cleanup
      let { loadingPaneIds, errorByPane } = state;
      if (loadingPaneIds.has(action.paneId)) {
        loadingPaneIds = new Set(loadingPaneIds);
        loadingPaneIds.delete(action.paneId);
      }
      if (errorByPane.has(action.paneId)) {
        errorByPane = new Map(errorByPane);
        errorByPane.delete(action.paneId);
      }

      return { ...state, sessions, paneSessionMap, indexingProgressBySession, filterStateBySession, streamingSessionIds, loadingPaneIds, errorByPane };
    }

    case 'session:updated': {
      const existing = state.sessions.get(action.sessionId);
      if (!existing) return state;
      const updated = action.updater(existing);
      if (updated === existing) return state;
      return { ...state, sessions: new Map(state.sessions).set(action.sessionId, updated) };
    }

    case 'session:terminated': {
      if (!state.sessions.has(action.sessionId)) return state;
      const sessions = new Map(state.sessions);
      sessions.delete(action.sessionId);
      const indexingProgressBySession = new Map(state.indexingProgressBySession);
      indexingProgressBySession.delete(action.sessionId);
      const filterStateBySession = new Map(state.filterStateBySession);
      filterStateBySession.delete(action.sessionId);
      const streamingSessionIds = state.streamingSessionIds.has(action.sessionId)
        ? new Set([...state.streamingSessionIds].filter(id => id !== action.sessionId))
        : state.streamingSessionIds;
      return { ...state, sessions, indexingProgressBySession, filterStateBySession, streamingSessionIds };
    }

    case 'pane:session-activated': {
      if (state.paneSessionMap.get(action.paneId) === action.sessionId) return state;
      if (!state.sessions.has(action.sessionId)) return state;
      const paneSessionMap = new Map(state.paneSessionMap).set(action.paneId, action.sessionId);
      return { ...state, paneSessionMap };
    }

    case 'pane:loading': {
      const has = state.loadingPaneIds.has(action.paneId);
      if (action.loading === has) return state;
      const loadingPaneIds = new Set(state.loadingPaneIds);
      if (action.loading) loadingPaneIds.add(action.paneId); else loadingPaneIds.delete(action.paneId);
      return { ...state, loadingPaneIds };
    }

    case 'pane:error': {
      const current = state.errorByPane.get(action.paneId);
      if (current === action.error) return state;
      const errorByPane = new Map(state.errorByPane);
      if (action.error === null) errorByPane.delete(action.paneId); else errorByPane.set(action.paneId, action.error);
      return { ...state, errorByPane };
    }

    case 'indexing:progress': {
      const indexingProgressBySession = new Map(state.indexingProgressBySession);
      indexingProgressBySession.set(action.sessionId, action.progress);
      return { ...state, indexingProgressBySession };
    }

    case 'streaming:changed': {
      const has = state.streamingSessionIds.has(action.sessionId);
      if (action.streaming === has) return state;
      const streamingSessionIds = new Set(state.streamingSessionIds);
      if (action.streaming) streamingSessionIds.add(action.sessionId); else streamingSessionIds.delete(action.sessionId);
      return { ...state, streamingSessionIds };
    }

    case 'pane:focused':
      if (state.activeLogPaneId === action.paneId && state.activePaneId === action.paneId) return state;
      return { ...state, activeLogPaneId: action.paneId, activePaneId: action.paneId };

    case 'pane:activated':
      if (state.activePaneId === action.paneId) return state;
      return { ...state, activePaneId: action.paneId };

    case 'filter:updated': {
      const current = state.filterStateBySession.get(action.sessionId) ?? DEFAULT_FILTER_STATE;
      const updated = { ...current, ...action.patch };
      return { ...state, filterStateBySession: new Map(state.filterStateBySession).set(action.sessionId, updated) };
    }

    case 'filter:reset': {
      if (!state.filterStateBySession.has(action.sessionId)) return state;
      const filterStateBySession = new Map(state.filterStateBySession);
      filterStateBySession.delete(action.sessionId);
      return { ...state, filterStateBySession };
    }

    case 'filter:append-matches': {
      if (!action.lineNums.length) return state;
      const current = state.filterStateBySession.get(action.sessionId) ?? DEFAULT_FILTER_STATE;
      const prev = current.filteredLineNums ?? [];
      return {
        ...state,
        filterStateBySession: new Map(state.filterStateBySession).set(action.sessionId, {
          ...current,
          filteredLineNums: [...prev, ...action.lineNums],
        }),
      };
    }

    default:
      return state;
  }
}

// ── Sub-context value types ─────────────────────────────────────────────────

interface SessionCoreValue {
  sessions: Map<string, LoadResult>;
  paneSessionMap: Map<string, string>;
  loadingPaneIds: Set<string>;
  errorByPane: Map<string, string | null>;
  streamingSessionIds: Set<string>;
  registerSession: (paneId: string, result: LoadResult) => void;
  unregisterSession: (paneId: string) => void;
  updateSession: (sessionId: string, updater: (prev: LoadResult) => LoadResult) => void;
  terminateSession: (sessionId: string) => void;
  setLoadingPane: (paneId: string, loading: boolean) => void;
  setErrorPane: (paneId: string, error: string | null) => void;
  activateSessionForPane: (paneId: string, sessionId: string) => void;
  setStreamingSession: (sessionId: string, streaming: boolean) => void;
}

interface SessionPaneValue {
  activeLogPaneId: string | null;
  activePaneId: string | null;
}

interface SessionProgressValue {
  indexingProgressBySession: Map<string, IndexingProgress | null>;
  filterStateBySession: Map<string, FilterState>;
  setIndexingProgress: (sessionId: string, progress: IndexingProgress | null) => void;
  setSessionFilter: (sessionId: string, patch: Partial<FilterState>) => void;
  resetSessionFilter: (sessionId: string) => void;
  appendSessionFilterMatches: (sessionId: string, lineNums: number[]) => void;
}

// ── Public interface (facade) ───────────────────────────────────────────────

export interface SessionContextValue extends SessionCoreValue, SessionPaneValue, SessionProgressValue {}

// ── Three internal sub-contexts (not exported from barrel) ──────────────────

const SessionCoreCtx = createContext<SessionCoreValue | null>(null);
const SessionPaneCtx = createContext<SessionPaneValue | null>(null);
const SessionProgressCtx = createContext<SessionProgressValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);

  // Focus changes flow through the bus so WorkspaceLayout and SessionContext
  // both update from a single emission point.
  useEffect(() => {
    const handler = (e: { paneId: string | null }) => {
      dispatch({ type: 'pane:focused', paneId: e.paneId });
    };
    const activatedHandler = (e: { paneId: string }) => {
      dispatch({ type: 'pane:activated', paneId: e.paneId });
    };
    bus.on('session:focused', handler);
    bus.on('pane:activated', activatedHandler);
    return () => {
      bus.off('session:focused', handler);
      bus.off('pane:activated', activatedHandler);
    };
  }, []); // dispatch is stable — no deps needed

  // Named operation wrappers — all stable (dispatch ref never changes)
  const registerSession = useCallback(
    (paneId: string, result: LoadResult) => dispatch({ type: 'session:registered', paneId, result }),
    [],
  );
  const unregisterSession = useCallback(
    (paneId: string) => dispatch({ type: 'session:unregistered', paneId }),
    [],
  );
  const updateSession = useCallback(
    (sessionId: string, updater: (prev: LoadResult) => LoadResult) =>
      dispatch({ type: 'session:updated', sessionId, updater }),
    [],
  );
  const setLoadingPane = useCallback(
    (paneId: string, loading: boolean) => dispatch({ type: 'pane:loading', paneId, loading }),
    [],
  );
  const setErrorPane = useCallback(
    (paneId: string, error: string | null) => dispatch({ type: 'pane:error', paneId, error }),
    [],
  );
  const setIndexingProgress = useCallback(
    (sessionId: string, progress: IndexingProgress | null) =>
      dispatch({ type: 'indexing:progress', sessionId, progress }),
    [],
  );
  const setStreamingSession = useCallback(
    (sessionId: string, streaming: boolean) => dispatch({ type: 'streaming:changed', sessionId, streaming }),
    [],
  );
  const terminateSession = useCallback(
    (sessionId: string) => dispatch({ type: 'session:terminated', sessionId }),
    [],
  );
  const activateSessionForPane = useCallback(
    (paneId: string, sessionId: string) => dispatch({ type: 'pane:session-activated', paneId, sessionId }),
    [],
  );
  const setSessionFilter = useCallback(
    (sessionId: string, patch: Partial<FilterState>) => dispatch({ type: 'filter:updated', sessionId, patch }),
    [],
  );
  const resetSessionFilter = useCallback(
    (sessionId: string) => dispatch({ type: 'filter:reset', sessionId }),
    [],
  );
  const appendSessionFilterMatches = useCallback(
    (sessionId: string, lineNums: number[]) => dispatch({ type: 'filter:append-matches', sessionId, lineNums }),
    [],
  );

  // ── Sub-context values (each with its own useMemo) ──────────────────────

  const coreValue = useMemo<SessionCoreValue>(
    () => ({
      sessions: state.sessions,
      paneSessionMap: state.paneSessionMap,
      loadingPaneIds: state.loadingPaneIds,
      errorByPane: state.errorByPane,
      streamingSessionIds: state.streamingSessionIds,
      registerSession,
      unregisterSession,
      updateSession,
      terminateSession,
      setLoadingPane,
      setErrorPane,
      activateSessionForPane,
      setStreamingSession,
    }),
    // Callbacks are stable (dispatch-based). Only state fields trigger new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.sessions, state.paneSessionMap, state.loadingPaneIds, state.errorByPane, state.streamingSessionIds],
  );

  const paneValue = useMemo<SessionPaneValue>(
    () => ({
      activeLogPaneId: state.activeLogPaneId,
      activePaneId: state.activePaneId,
    }),
    [state.activeLogPaneId, state.activePaneId],
  );

  const progressValue = useMemo<SessionProgressValue>(
    () => ({
      indexingProgressBySession: state.indexingProgressBySession,
      filterStateBySession: state.filterStateBySession,
      setIndexingProgress,
      setSessionFilter,
      resetSessionFilter,
      appendSessionFilterMatches,
    }),
    // Callbacks are stable (dispatch-based). Only state fields trigger new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.indexingProgressBySession, state.filterStateBySession],
  );

  return (
    <SessionCoreCtx.Provider value={coreValue}>
      <SessionPaneCtx.Provider value={paneValue}>
        <SessionProgressCtx.Provider value={progressValue}>
          {children}
        </SessionProgressCtx.Provider>
      </SessionPaneCtx.Provider>
    </SessionCoreCtx.Provider>
  );
}

// ── Narrow hooks (used by selectors.ts — not exported from barrel) ──────────

export function useSessionCoreCtx(): SessionCoreValue {
  const ctx = useContext(SessionCoreCtx);
  if (!ctx) throw new Error('useSessionCoreCtx must be used within SessionProvider');
  return ctx;
}

export function useSessionPaneCtx(): SessionPaneValue {
  const ctx = useContext(SessionPaneCtx);
  if (!ctx) throw new Error('useSessionPaneCtx must be used within SessionProvider');
  return ctx;
}

export function useSessionProgressCtx(): SessionProgressValue {
  const ctx = useContext(SessionProgressCtx);
  if (!ctx) throw new Error('useSessionProgressCtx must be used within SessionProvider');
  return ctx;
}

// ── Facade — reads all 3 sub-contexts, returns combined interface ───────────
// Used by domain hooks (useLogViewer, etc.) that need cross-context access.

export function useSessionContext(): SessionContextValue {
  const core = useSessionCoreCtx();
  const pane = useSessionPaneCtx();
  const progress = useSessionProgressCtx();
  return { ...core, ...pane, ...progress };
}
