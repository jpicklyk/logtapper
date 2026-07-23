import { useEffect, useRef } from 'react';
import { bus } from '../events/bus';
import { performAutoSave } from './workspace/workspacePersistence';
import { createAutoSaveGate } from './workspace/autoSaveGate';
import type { LtwEditorTab } from '../bridge/types';

const AUTO_SAVE_DEBOUNCE_MS = 3000;

export interface AutoSavePayload {
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

    const handler = () => {
      // A restore emits a burst of tracked mutations as it loads each session.
      // Saving then would rewrite what was just read, and a partial restore
      // would overwrite the good .ltw with the partial state.
      if (gate.isSuppressed()) return;
      cancelPending();
      timer = setTimeout(() => {
        timer = null;
        const payload = buildPayloadRef.current();
        if (!payload) return;
        performAutoSave(payload).catch((e: unknown) =>
          console.warn('[useWorkspaceAutoSave] Auto-save failed:', e),
        );
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
