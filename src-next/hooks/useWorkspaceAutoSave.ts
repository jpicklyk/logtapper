import { useEffect, useRef } from 'react';
import { bus } from '../events/bus';
import { performAutoSave } from './workspace/workspacePersistence';
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

    const handler = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const payload = buildPayloadRef.current();
        if (!payload) return;
        performAutoSave(payload).catch((e: unknown) =>
          console.warn('[useWorkspaceAutoSave] Auto-save failed:', e),
        );
      }, AUTO_SAVE_DEBOUNCE_MS);
    };

    bus.on('workspace:mutated', handler);
    return () => {
      bus.off('workspace:mutated', handler);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
