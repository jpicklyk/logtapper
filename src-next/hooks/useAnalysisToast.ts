import { useEffect, useRef } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { onAnalysisUpdate } from '../bridge/events';
import { getAnalysis } from '../bridge/commands';
import { bus } from '../events/bus';
import type { ToastItem } from '../ui';

let toastCounter = 0;

/**
 * Subscribes directly to the Tauri `analysis-update` event at AppShell level
 * so it runs regardless of whether the Analysis panel is open. Shows a toast
 * for externally-published analyses (e.g. via MCP bridge).
 *
 * Local publishes are tracked via the `analysis:published-local` bus event
 * (emitted by useAnalysis) so they don't trigger a toast.
 */
export function useAnalysisToast(addToast: (toast: ToastItem) => void) {
  /** IDs published by the local UI — skip toasting these. */
  const localIdsRef = useRef<Set<string>>(new Set());

  // Track local publishes via bus event
  useEffect(() => {
    const handler = (payload: { artifactId: string }) => {
      localIdsRef.current.add(payload.artifactId);
    };
    bus.on('analysis:published-local', handler);
    return () => {
      bus.off('analysis:published-local', handler);
    };
  }, []);

  // Subscribe to Tauri analysis-update event (StrictMode-safe async pattern)
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onAnalysisUpdate((payload) => {
      if (cancelled) return;
      if (payload.action !== 'published') return;

      // If locally published, consume and skip
      if (localIdsRef.current.has(payload.artifactId)) {
        localIdsRef.current.delete(payload.artifactId);
        return;
      }

      // External publish — fetch title then show toast
      getAnalysis(payload.sessionId, payload.artifactId)
        .then((artifact) => {
          if (cancelled) return;
          const id = `analysis-toast-${++toastCounter}`;
          addToast({
            id,
            title: 'New Analysis',
            message: artifact.title,
            onClick: () => {
              bus.emit('analysis:open', { artifactId: artifact.id });
              bus.emit('layout:open-tab', { type: 'analysis' });
            },
          });

          // Also emit bus event for any other interested subscribers
          bus.emit('analysis:published-external', {
            artifactId: artifact.id,
            title: artifact.title,
            sessionId: payload.sessionId,
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
  }, [addToast]);
}
