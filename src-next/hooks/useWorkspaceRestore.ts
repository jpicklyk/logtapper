import React, { useEffect, useRef } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';
import type { PipelineAction } from '../context/PipelineContext';
import type { ProcessorSummary } from '../bridge/types';
import type { WorkspaceRestoredPayload } from '../bridge/types';
import { setSessionPipelineMeta } from '../bridge/commands';
import { bus } from '../events/bus';

/**
 * Listens for `workspace-restored` Tauri events and restores the pipeline chain.
 * When active processors are present, dispatches `chain:restore` to PipelineContext
 * and auto-runs the pipeline (deferred until indexing completes if still indexing).
 *
 * `hasRestoredRef` is owned by usePipeline and set to `true` here so loadProcessors
 * can skip the localStorage chain override when a workspace restore already set it.
 *
 * Handlers are keyed by sessionId so that multi-session .lts restores do not
 * clobber each other — each session gets its own independent handler pair.
 */
export function useWorkspaceRestore(
  dispatch: React.Dispatch<PipelineAction>,
  processors: ProcessorSummary[],
  run: (sessionId: string) => Promise<void>,
  getIsIndexing: (sessionId: string) => boolean,
  hasRestoredRef: React.MutableRefObject<boolean>,
): void {
  const processorsRef = useRef(processors);
  processorsRef.current = processors;
  const runRef = useRef(run);
  runRef.current = run;
  const getIsIndexingRef = useRef(getIsIndexing);
  getIsIndexingRef.current = getIsIndexing;

  // Maps keyed by sessionId so multi-session .lts restores don't clobber each other
  const pendingIndexingHandlersRef = useRef(new Map<string, (e: { sessionId: string }) => void>());
  const pendingLoadedHandlersRef = useRef(new Map<string, (e: any) => void>());

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    listen<WorkspaceRestoredPayload>('workspace-restored', (event) => {
      if (cancelled) return;
      const { sessionId, activeProcessorIds, disabledProcessorIds } = event.payload;
      if (!activeProcessorIds || activeProcessorIds.length === 0) return;

      // Filter to only installed processors, allowing session-scoped .lts processors through.
      const installedIds = new Set(processorsRef.current.map((p) => p.id));
      const validActive = activeProcessorIds.filter((id) => installedIds.has(id) || id.includes('@lts-'));
      const validDisabled = (disabledProcessorIds ?? []).filter((id) => installedIds.has(id) || id.includes('@lts-'));
      if (validActive.length === 0) return;

      // Signal that a workspace restore set the chain (prevents localStorage override)
      hasRestoredRef.current = true;

      // Override chain with workspace-saved state
      dispatch({ type: 'chain:restore', chain: validActive, disabledChainIds: validDisabled });

      // Push to backend so subsequent saves capture the restored chain
      setSessionPipelineMeta(sessionId, validActive, validDisabled).catch(() => {});

      // Auto-run: always subscribe to indexing-complete as the primary trigger,
      // since workspace-restored fires during load_log_file before the session
      // is registered in the frontend context (getIsIndexing can't resolve it yet).
      // Also attempt an immediate run if the session is already fully indexed
      // (small files that complete before this event is delivered).
      const autoRun = () => { runRef.current(sessionId).catch(() => {}); };

      // Remove any existing handlers for this sessionId before registering new ones
      const existingIndexingHandler = pendingIndexingHandlersRef.current.get(sessionId);
      if (existingIndexingHandler) {
        bus.off('session:indexing-complete', existingIndexingHandler);
        pendingIndexingHandlersRef.current.delete(sessionId);
      }
      const existingLoadedHandler = pendingLoadedHandlersRef.current.get(sessionId);
      if (existingLoadedHandler) {
        bus.off('session:loaded', existingLoadedHandler);
        pendingLoadedHandlersRef.current.delete(sessionId);
      }

      const handler = (e: { sessionId: string }) => {
        if (e.sessionId === sessionId) {
          bus.off('session:indexing-complete', handler);
          pendingIndexingHandlersRef.current.delete(sessionId);
          // Also remove the loaded handler since indexing-complete fired
          const lh = pendingLoadedHandlersRef.current.get(sessionId);
          if (lh) {
            bus.off('session:loaded', lh);
            pendingLoadedHandlersRef.current.delete(sessionId);
          }
          if (!cancelled) autoRun();
        }
      };
      pendingIndexingHandlersRef.current.set(sessionId, handler);
      bus.on('session:indexing-complete', handler);

      // For files that are already fully indexed (isIndexing was false in
      // LoadResult), session:indexing-complete will never fire. Use
      // session:loaded as a fallback — it fires after the session is
      // registered in context and indexing status is known.
      const loadedHandler = (e: { sessionId: string; sourceType: string; paneId: string }) => {
        // Scope to the specific sessionId — don't act on other sessions' load events
        if (e.sessionId !== sessionId) return;
        bus.off('session:loaded', loadedHandler);
        pendingLoadedHandlersRef.current.delete(sessionId);
        // Small delay to let the session context settle
        setTimeout(() => {
          if (cancelled) return;
          if (!getIsIndexingRef.current(sessionId)) {
            // Already indexed — indexing-complete won't fire, so run now
            bus.off('session:indexing-complete', handler);
            pendingIndexingHandlersRef.current.delete(sessionId);
            autoRun();
          }
          // else: still indexing — indexing-complete handler will fire later
        }, 100);
      };
      pendingLoadedHandlersRef.current.set(sessionId, loadedHandler);
      bus.on('session:loaded', loadedHandler);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      // Clean up all pending bus listeners across all sessions
      pendingIndexingHandlersRef.current.forEach((h) => bus.off('session:indexing-complete', h));
      pendingIndexingHandlersRef.current.clear();
      pendingLoadedHandlersRef.current.forEach((h) => bus.off('session:loaded', h));
      pendingLoadedHandlersRef.current.clear();
    };
  }, [dispatch]);
}
