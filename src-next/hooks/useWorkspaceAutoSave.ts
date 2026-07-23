import { useEffect, useRef } from 'react';
import { bus } from '../events/bus';
import { performAutoSave } from './workspace/workspacePersistence';
import { createAutoSaveGate } from './workspace/autoSaveGate';
import { syncWorkspaceEnvelope } from '../bridge/commands';
import type { LtwEditorTab } from '../bridge/types';

const AUTO_SAVE_DEBOUNCE_MS = 3000;

export interface AutoSavePayload {
  workspaceId: string;
  workspaceName: string;
  filePath: string | null;
  editorTabs: LtwEditorTab[];
  layout: unknown | null;
  pipelineChain: string[];
  disabledChainIds: string[];
}

/**
 * Debounced auto-save hook that listens to `workspace:mutated` events and
 * saves the workspace after 3 seconds of inactivity.
 *
 * Prevents data loss on bookmark/analysis mutations if the app crashes.
 * Uses refs for all mutable state to avoid causing re-renders.
 */
export function useWorkspaceAutoSave(
  buildAutoSavePayload: () => AutoSavePayload | null,
): void {
  const buildPayloadRef = useRef(buildAutoSavePayload);
  buildPayloadRef.current = buildAutoSavePayload;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const gate = createAutoSaveGate();

    const cancelPending = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    // Defined outside the setTimeout callback below on purpose: the
    // `no-side-effects-in-updater` lint rule treats any `set[A-Z]…` call
    // (including `setTimeout`) as a setState updater, so a `bus.emit` lexically
    // inside the timer arrow would be flagged. Hoisting keeps the emit clean.
    const runAutoSave = () => {
      const payload = buildPayloadRef.current();
      if (!payload) return;
      // Belt-and-braces: refresh the backend envelope on every debounced tick so
      // it stays fresh independent of the save command's own caching (and would
      // still fire if this path ever early-returned before saving). Lightweight —
      // no file I/O, just a cache refresh.
      syncWorkspaceEnvelope({
        workspaceId: payload.workspaceId,
        workspaceName: payload.workspaceName,
        ltwPath: payload.filePath,
        editorTabs: payload.editorTabs,
        layout: payload.layout,
        pipelineChain: payload.pipelineChain,
        disabledChainIds: payload.disabledChainIds,
      }).catch((e: unknown) => console.warn('[useWorkspaceAutoSave] Envelope sync failed:', e));
      performAutoSave(payload)
        .then((savedPath) => {
          // A non-null path means the workspace had no explicit .ltw and was
          // auto-saved to the app-data dir. Announce it so WorkspaceContext can
          // record the recovery path + timestamp onto the entry (previously
          // this return was discarded, leaving the entry's filePath null).
          if (savedPath) {
            bus.emit('workspace:auto-saved', {
              workspaceId: payload.workspaceId,
              path: savedPath,
              savedAt: Date.now(),
            });
          }
        })
        .catch((e: unknown) =>
          console.warn('[useWorkspaceAutoSave] Auto-save failed:', e),
        );
    };

    const handler = () => {
      // A restore emits a burst of tracked mutations as it loads each session.
      // Saving then would rewrite what was just read, and a partial restore
      // would overwrite the good .ltw with the partial state.
      if (gate.isSuppressed()) return;
      cancelPending();
      timer = setTimeout(() => {
        timer = null;
        runAutoSave();
      }, AUTO_SAVE_DEBOUNCE_MS);
    };

    const onRestoreBegin = () => {
      gate.beginRestore();
      // Drop anything already scheduled — it was queued against pre-restore
      // state and would fire mid-restore.
      cancelPending();
    };
    const onRestoreEnd = () => gate.endRestore();

    bus.on('workspace:mutated', handler);
    bus.on('workspace:restore-begin', onRestoreBegin);
    bus.on('workspace:restore-end', onRestoreEnd);
    return () => {
      bus.off('workspace:mutated', handler);
      bus.off('workspace:restore-begin', onRestoreBegin);
      bus.off('workspace:restore-end', onRestoreEnd);
      gate.reset();
      cancelPending();
    };
  }, []);
}
