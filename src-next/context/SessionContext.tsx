import { createContext, useContext, useMemo, useReducer, useCallback, useEffect, type ReactNode } from 'react';
import type { LoadResult } from '../bridge/types';
import { bus } from '../events/bus';

export interface IndexingProgress {
  linesIndexed: number;
  totalLines: number;
  percent: number;
  done: boolean;
}

// ── State ─────────────────────────────────────────────────────────────────────

interface SessionState {
  sessions: Map<string, LoadResult>;
  paneSessionMap: Map<string, string>;
  loadingPaneIds: Set<string>;
  errorByPane: Map<string, string | null>;
  indexingProgressBySession: Map<string, IndexingProgress | null>;
  streamingSessionIds: Set<string>;
  focusedPaneId: string | null;
}

const initialState: SessionState = {
  sessions: new Map(),
  paneSessionMap: new Map(),
  loadingPaneIds: new Set(),
  errorByPane: new Map(),
  indexingProgressBySession: new Map(),
  streamingSessionIds: new Set(),
  focusedPaneId: null,
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
  | { type: 'pane:focused'; paneId: string | null };

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
      let { sessions, indexingProgressBySession, streamingSessionIds } = state;
      if (sessionId && ![...paneSessionMap.values()].includes(sessionId)) {
        sessions = new Map(sessions);
        sessions.delete(sessionId);
        indexingProgressBySession = new Map(indexingProgressBySession);
        indexingProgressBySession.delete(sessionId);
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

      return { ...state, sessions, paneSessionMap, indexingProgressBySession, streamingSessionIds, loadingPaneIds, errorByPane };
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
      const streamingSessionIds = state.streamingSessionIds.has(action.sessionId)
        ? new Set([...state.streamingSessionIds].filter(id => id !== action.sessionId))
        : state.streamingSessionIds;
      return { ...state, sessions, indexingProgressBySession, streamingSessionIds };
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
      if (state.focusedPaneId === action.paneId) return state;
      return { ...state, focusedPaneId: action.paneId };

    default:
      return state;
  }
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface SessionContextValue {
  // State (read via selector hooks — see selectors.ts)
  sessions: Map<string, LoadResult>;
  paneSessionMap: Map<string, string>;
  loadingPaneIds: Set<string>;
  errorByPane: Map<string, string | null>;
  indexingProgressBySession: Map<string, IndexingProgress | null>;
  streamingSessionIds: Set<string>;
  focusedPaneId: string | null;

  // Named operations (stable refs — dispatch never changes)
  registerSession: (paneId: string, result: LoadResult) => void;
  unregisterSession: (paneId: string) => void;
  updateSession: (sessionId: string, updater: (prev: LoadResult) => LoadResult) => void;
  /** Remove session data for a specific session (by ID). Use when closing a non-active logviewer tab. */
  terminateSession: (sessionId: string) => void;
  setLoadingPane: (paneId: string, loading: boolean) => void;
  setErrorPane: (paneId: string, error: string | null) => void;
  /** Swap the active session for a pane (for logviewer tab switching). Does not register new session data. */
  activateSessionForPane: (paneId: string, sessionId: string) => void;
  setIndexingProgress: (sessionId: string, progress: IndexingProgress | null) => void;
  setStreamingSession: (sessionId: string, streaming: boolean) => void;
}

// ── Provider ──────────────────────────────────────────────────────────────────

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);

  // Focus changes flow through the bus so WorkspaceLayout and SessionContext
  // both update from a single emission point.
  useEffect(() => {
    const handler = (e: { paneId: string | null }) => {
      dispatch({ type: 'pane:focused', paneId: e.paneId });
    };
    bus.on('session:focused', handler);
    return () => { bus.off('session:focused', handler); };
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

  const value = useMemo<SessionContextValue>(
    () => ({
      ...state,
      registerSession,
      unregisterSession,
      updateSession,
      terminateSession,
      setLoadingPane,
      setErrorPane,
      activateSessionForPane,
      setIndexingProgress,
      setStreamingSession,
    }),
    // Named methods are stable; the only thing that triggers a new context value is state changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSessionContext(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSessionContext must be used within a SessionProvider');
  }
  return ctx;
}
