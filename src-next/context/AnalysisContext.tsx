import { createContext, useContext, useReducer, useEffect, useMemo, type ReactNode } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { AnalysisArtifact } from '../bridge/types';
import { listAnalyses, getAnalysis } from '../bridge/commands';
import { onAnalysisUpdate } from '../bridge/events';
import { bus } from '../events';

// ── State ─────────────────────────────────────────────────────────────────────

interface AnalysisState {
  artifacts: AnalysisArtifact[];
  loading: boolean;
}

const initialState: AnalysisState = {
  artifacts: [],
  loading: false,
};

// ── Actions ───────────────────────────────────────────────────────────────────

type AnalysisAction =
  | { type: 'analyses:loading' }
  | { type: 'analyses:loaded'; artifacts: AnalysisArtifact[] }
  | { type: 'analyses:loaded-error' }
  | { type: 'analyses:deleted'; artifactId: string }
  | { type: 'analyses:upserted'; artifact: AnalysisArtifact };

// ── Reducer ───────────────────────────────────────────────────────────────────

function analysisReducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  switch (action.type) {
    case 'analyses:loading':
      return { ...state, loading: true };
    case 'analyses:loaded':
      return { ...state, loading: false, artifacts: action.artifacts };
    case 'analyses:loaded-error':
      return { ...state, loading: false };
    case 'analyses:deleted': {
      const next = state.artifacts.filter((a) => a.id !== action.artifactId);
      if (next.length === state.artifacts.length) return state;
      return { ...state, artifacts: next };
    }
    case 'analyses:upserted': {
      const exists = state.artifacts.some((a) => a.id === action.artifact.id);
      const artifacts = exists
        ? state.artifacts.map((a) => (a.id === action.artifact.id ? action.artifact : a))
        : [...state.artifacts, action.artifact];
      return { ...state, artifacts };
    }
    default:
      return state;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

export interface AnalysisContextValue {
  artifacts: AnalysisArtifact[];
  loading: boolean;
}

const AnalysisContext = createContext<AnalysisContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * Workspace-owned analysis store. Analyses are no longer per-session — they
 * live on the workspace and reference zero or more sessions via
 * `SourceReference.sessionId`. Mounted inside `SessionProvider` (so it tears
 * down with the workspace) but outside `HookWiring`, since it reads nothing
 * from session state.
 */
export function AnalysisProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(analysisReducer, initialState);

  // Load the full workspace analyses list on mount.
  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'analyses:loading' });
    listAnalyses()
      .then((artifacts) => { if (!cancelled) dispatch({ type: 'analyses:loaded', artifacts }); })
      .catch(() => { if (!cancelled) dispatch({ type: 'analyses:loaded-error' }); });
    return () => { cancelled = true; };
  }, []);

  // Subscribe to analysis-update events (StrictMode-safe — see src-next/CLAUDE.md).
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onAnalysisUpdate((payload) => {
      if (cancelled) return;

      // Durability signal — deliberately unconditional and first, before any
      // branch below. An analysis mutated over the MCP bridge is written
      // straight into AppState by the bridge handler; nothing in the frontend
      // action surface runs for it, so this is what schedules the envelope
      // push that keeps the backend's autosave cache current. See
      // context/CLAUDE.md's "Backend-originated mutations" section.
      bus.emit('workspace:mutated', { source: 'artifact' });

      if (payload.action === 'deleted') {
        dispatch({ type: 'analyses:deleted', artifactId: payload.artifactId });
        return;
      }

      if (payload.action === 'restored') {
        listAnalyses()
          .then((artifacts) => { if (!cancelled) dispatch({ type: 'analyses:loaded', artifacts }); })
          .catch(() => { /* best-effort re-list */ });
        return;
      }

      // 'published' | 'updated' — fetch the full artifact and upsert it.
      getAnalysis(payload.artifactId)
        .then((artifact) => { if (!cancelled) dispatch({ type: 'analyses:upserted', artifact }); })
        .catch(() => { /* ignore fetch errors */ });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const value = useMemo<AnalysisContextValue>(
    () => ({ artifacts: state.artifacts, loading: state.loading }),
    [state.artifacts, state.loading],
  );

  return (
    <AnalysisContext.Provider value={value}>
      {children}
    </AnalysisContext.Provider>
  );
}

export function useAnalysisContext(): AnalysisContextValue {
  const ctx = useContext(AnalysisContext);
  if (!ctx) {
    throw new Error('useAnalysisContext must be used within an AnalysisProvider');
  }
  return ctx;
}

// @visibleForTesting
export { analysisReducer, initialState };
