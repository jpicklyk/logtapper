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

  // Track pending bus handlers so cleanup can remove them on unmount
  const pendingBusHandlerRef = useRef<((e: { sessionId: string }) => void) | null>(null);
  const pendingLoadedHandlerRef = useRef<((e: { sourceType: string; paneId: string }) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    listen<WorkspaceRestoredPayload>('workspace-restored', (event) => {
      if (cancelled) return;
      const { sessionId, activeProcessorIds, disabledProcessorIds } = event.payload;
      if (!activeProcessorIds || activeProcessorIds.length === 0) return;

      // Filter to only installed processors
      const installedIds = new Set(processorsRef.current.map((p) => p.id));
      const validActive = activeProcessorIds.filter((id) => installedIds.has(id));
      const validDisabled = (disabledProcessorIds ?? []).filter((id) => installedIds.has(id));
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

      // Clean up any previous pending handler before registering a new one
      if (pendingBusHandlerRef.current) {
        bus.off('session:indexing-complete', pendingBusHandlerRef.current);
      }
      const handler = (e: { sessionId: string }) => {
        if (e.sessionId === sessionId) {
          bus.off('session:indexing-complete', handler);
          pendingBusHandlerRef.current = null;
          if (!cancelled) autoRun();
        }
      };
      pendingBusHandlerRef.current = handler;
      bus.on('session:indexing-complete', handler);

      // For files that are already fully indexed (isIndexing was false in
      // LoadResult), session:indexing-complete will never fire. Use
      // session:loaded as a fallback — it fires after the session is
      // registered in context and indexing status is known.
      const loadedHandler = (_e: { sourceType: string; paneId: string }) => {
        bus.off('session:loaded', loadedHandler);
        pendingLoadedHandlerRef.current = null;
        // Small delay to let the session context settle
        setTimeout(() => {
          if (cancelled) return;
          if (!getIsIndexingRef.current(sessionId)) {
            // Already indexed — indexing-complete won't fire, so run now
            bus.off('session:indexing-complete', handler);
            pendingBusHandlerRef.current = null;
            autoRun();
          }
          // else: still indexing — indexing-complete handler will fire later
        }, 100);
      };
      pendingLoadedHandlerRef.current = loadedHandler;
      bus.on('session:loaded', loadedHandler);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      // Clean up any pending bus listeners
      if (pendingBusHandlerRef.current) {
        bus.off('session:indexing-complete', pendingBusHandlerRef.current);
        pendingBusHandlerRef.current = null;
      }
      if (pendingLoadedHandlerRef.current) {
        bus.off('session:loaded', pendingLoadedHandlerRef.current);
        pendingLoadedHandlerRef.current = null;
      }
    };
  }, [dispatch]);
}
