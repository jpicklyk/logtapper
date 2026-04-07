import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { AnalysisArtifact, AnalysisSection } from '../bridge/types';
import {
  publishAnalysis,
  updateAnalysis,
  listAnalyses,
  getAnalysis,
  deleteAnalysis,
} from '../bridge/commands';
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

  const publish = useCallback(
    async (title: string, sections: AnalysisSection[]) => {
      if (!sessionId) return null;
      const art = await publishAnalysis(sessionId, title, sections);
      // Notify toast hook so it can suppress the toast for this local publish
      if (art) {
        bus.emit('analysis:published-local', { artifactId: art.id });
        bus.emit('workspace:mutated', undefined);
      }
      return art;
    },
    [sessionId],
  );

  const update = useCallback(
    async (artifactId: string, title?: string, sections?: AnalysisSection[]) => {
      if (!sessionId) return null;
      const art = await updateAnalysis(sessionId, artifactId, title, sections);
      if (art) bus.emit('workspace:mutated', undefined);
      return art;
    },
    [sessionId],
  );

  const remove = useCallback(
    async (artifactId: string) => {
      if (!sessionId) return;
      await deleteAnalysis(sessionId, artifactId);
      bus.emit('workspace:mutated', undefined);
    },
    [sessionId],
  );

  return {
    artifacts: state.artifacts,
    analysisLoading: state.loading,
    publishAnalysis: publish,
    updateAnalysis: update,
    deleteAnalysis: remove,
  };
}
