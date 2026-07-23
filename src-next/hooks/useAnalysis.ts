import { useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { AnalysisArtifact } from '../bridge/types';
import { listAnalyses, getAnalysis } from '../bridge/commands';
import { onAnalysisUpdate } from '../bridge/events';
import { bus } from '../events/bus';

export interface AnalysisState {
  artifacts: AnalysisArtifact[];
  loading: boolean;
}

export function useAnalysis(sessionId: string | null) {
  const [state, setState] = useState<AnalysisState>({
    artifacts: [],
    loading: false,
  });
  const currentSessionId = useRef<string | null>(null);

  // Load analyses when session changes
  useEffect(() => {
    if (!sessionId) {
      setState({ artifacts: [], loading: false });
      currentSessionId.current = null;
      return;
    }

    currentSessionId.current = sessionId;
    setState((prev) => ({ ...prev, loading: true }));

    listAnalyses(sessionId)
      .then((artifacts) => {
        if (currentSessionId.current === sessionId) {
          setState({ artifacts, loading: false });
        }
      })
      .catch(() => {
        if (currentSessionId.current === sessionId) {
          setState({ artifacts: [], loading: false });
        }
      });
  }, [sessionId]);

  // Subscribe to analysis-update events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onAnalysisUpdate((payload) => {
      if (cancelled) return;

      // Durability signal — deliberately before the focused-session guard.
      //
      // An analysis published over the MCP bridge is written straight into
      // AppState by the bridge handler; nothing in the frontend action surface
      // runs, so neither markDirty nor workspace:mutated fires for it. The
      // publish also frequently targets a session that is not the focused one,
      // so emitting after the guard would miss it entirely.
      //
      // This is how a published analysis was lost: the workspace auto-save had
      // not run in fifteen days despite an active investigation. Interim fix —
      // the durable answer is a backend-side flush trigger, so that any future
      // non-frontend writer is covered by construction.
      bus.emit('workspace:mutated');

      if (payload.sessionId !== currentSessionId.current) return;

      if (payload.action === 'deleted') {
        setState((prev) => ({
          ...prev,
          artifacts: prev.artifacts.filter((a) => a.id !== payload.artifactId),
        }));
        return;
      }

      // For published/updated, re-fetch from backend to get full data
      if (!currentSessionId.current) return;
      getAnalysis(currentSessionId.current, payload.artifactId)
        .then((artifact) => {
          setState((prev) => {
            const exists = prev.artifacts.some((a) => a.id === artifact.id);
            if (exists) {
              return {
                ...prev,
                artifacts: prev.artifacts.map((a) => (a.id === artifact.id ? artifact : a)),
              };
            }
            return { ...prev, artifacts: [...prev.artifacts, artifact] };
          });
        })
        .catch(() => {
          // ignore fetch errors
        });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return {
    artifacts: state.artifacts,
    analysisLoading: state.loading,
  };
}
