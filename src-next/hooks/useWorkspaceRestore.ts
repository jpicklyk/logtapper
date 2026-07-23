import React, { useEffect, useRef } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';
import type { PipelineAction } from '../context/PipelineContext';
import type { ProcessorSummary } from '../bridge/types';
import type { WorkspaceRestoredPayload } from '../bridge/types';
import { setSessionPipelineMeta } from '../bridge/commands';
import { bus } from '../events/bus';

/**
 * Listens for `workspace-restored` Tauri events. For every source it restores
 * the pipeline chain (`chain:restore` + backend meta push + `hasRestoredRef`).
 *
 * Auto-run ownership is split by the payload's `source` tag (see
 * `emit_workspace_restored`):
 *  - `source: "workspace"` (from `restore_workspace_session`, the `.ltw` path) →
 *    the restore core owns the auto-run; this hook schedules nothing.
 *  - `source: "lts"` (from `load_lts_file_inner`) → this hook owns the auto-run,
 *    for both direct `.lts` opens and `.lts` sessions embedded in a `.ltw` (the
 *    core deliberately skips those). It routes through the SAME shared
 *    `autoRunScheduler` so the run-now/await-indexing decision and the strict
 *    one-shot-per-session-id swallow are identical to the `.ltw` path.
 *
 * The `.lts` session's `isIndexing` arrives on `session:loaded`, which fires
 * AFTER this `workspace-restored` on the `.lts` path (the backend emits
 * `workspace-restored` mid-`load_log_file`, before the frontend emits
 * `session:loaded` once the invoke resolves). Registering the scoped
 * `session:loaded` one-shot here is therefore in time — there is no
 * registration-after-event dead path like the one the `.ltw` path had — and it
 * also guarantees the session is frontend-registered before the run. The chain
 * is passed to the scheduler explicitly (from the payload, filtered to installed
 * processors) so the run never depends on `chain:restore` having propagated to
 * `pipelineChainRef` this same tick.
 */
export function useWorkspaceRestore(
  dispatch: React.Dispatch<PipelineAction>,
  processors: ProcessorSummary[],
  hasRestoredRef: React.MutableRefObject<boolean>,
  scheduleAutoRun: (sessionId: string, isIndexing: boolean | undefined, chain: string[], disabled: string[]) => void,
): void {
  const processorsRef = useRef(processors);
  processorsRef.current = processors;
  const scheduleAutoRunRef = useRef(scheduleAutoRun);
  scheduleAutoRunRef.current = scheduleAutoRun;

  // Scoped session:loaded one-shots for `.lts`-backed sessions awaiting their
  // isIndexing flag, keyed by sessionId so multi-session `.lts` restores don't
  // clobber each other.
  const pendingLoadedRef = useRef(new Map<string, (e: { sessionId: string; isIndexing?: boolean }) => void>());

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    const pendingLoaded = pendingLoadedRef.current;

    listen<WorkspaceRestoredPayload>('workspace-restored', (event) => {
      if (cancelled) return;
      const { sessionId, activeProcessorIds, disabledProcessorIds, source } = event.payload;
      if (!activeProcessorIds || activeProcessorIds.length === 0) return;

      // Filter to only installed processors, allowing session-scoped .lts processors through.
      const installedIds = new Set(processorsRef.current.map((p) => p.id));
      const validActive = activeProcessorIds.filter((id) => installedIds.has(id) || id.includes('@lts-'));
      const validDisabled = (disabledProcessorIds ?? []).filter((id) => installedIds.has(id) || id.includes('@lts-'));
      if (validActive.length === 0) return;

      // Signal that a workspace restore set the chain (prevents localStorage override)
      hasRestoredRef.current = true;

      // Override chain with workspace-saved state (all sources — drives the UI).
      dispatch({ type: 'chain:restore', chain: validActive, disabledChainIds: validDisabled });

      // Push to backend so subsequent saves capture the restored chain
      setSessionPipelineMeta(sessionId, validActive, validDisabled).catch(() => {});

      // Auto-run only for the `.lts` path; the core owns `source: "workspace"`.
      // A missing/legacy `source` defaults to core-owned (no schedule here).
      if (source !== 'lts') return;

      const existing = pendingLoaded.get(sessionId);
      if (existing) {
        bus.off('session:loaded', existing);
        pendingLoaded.delete(sessionId);
      }
      const onLoaded = (e: { sessionId: string; isIndexing?: boolean }) => {
        if (e.sessionId !== sessionId) return;
        bus.off('session:loaded', onLoaded);
        pendingLoaded.delete(sessionId);
        if (cancelled) return;
        scheduleAutoRunRef.current(sessionId, e.isIndexing, validActive, validDisabled);
      };
      pendingLoaded.set(sessionId, onLoaded);
      bus.on('session:loaded', onLoaded);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      pendingLoaded.forEach((h) => bus.off('session:loaded', h));
      pendingLoaded.clear();
    };
  }, [dispatch]);
}
