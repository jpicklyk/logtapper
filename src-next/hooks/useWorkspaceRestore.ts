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

  // Track pending bus handler so cleanup can remove it on unmount
  const pendingBusHandlerRef = useRef<((e: { sessionId: string }) => void) | null>(null);

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

      // Auto-run: defer if still indexing, otherwise run immediately
      const autoRun = () => { runRef.current(sessionId).catch(() => {}); };

      if (getIsIndexingRef.current(sessionId)) {
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
      } else {
        autoRun();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      // Clean up any pending bus listener for indexing-complete
      if (pendingBusHandlerRef.current) {
        bus.off('session:indexing-complete', pendingBusHandlerRef.current);
        pendingBusHandlerRef.current = null;
      }
    };
  }, [dispatch]);
}
