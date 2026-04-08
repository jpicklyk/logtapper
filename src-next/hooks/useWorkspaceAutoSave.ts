import { useEffect, useRef } from 'react';
import { bus } from '../events/bus';
import { autoSaveWorkspace, saveWorkspaceV4 } from '../bridge/commands';
import type { AutoSaveWorkspaceOptions } from '../bridge/commands';
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
 * This prevents data loss on bookmark/analysis mutations when the app crashes.
 *
 * Design notes:
 * - Uses refs for all mutable state to avoid causing re-renders.
 * - `buildAutoSavePayload` is always read via ref so the effect never needs to
 *   be recreated when workspace state changes (the callback is recreated by the
 *   caller but captured via ref here).
 * - Saves to existing filePath via saveWorkspaceV4 (no markClean), or falls
 *   back to autoSaveWorkspace (app_data_dir) for unsaved workspaces.
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

        const { workspaceName, filePath, editorTabs, layout, pipelineChain, disabledChainIds } = payload;

        if (filePath) {
          // Workspace has a known .ltw path — save there without markClean.
          saveWorkspaceV4({
            destPath: filePath,
            workspaceName,
            editorTabs,
            layout,
            pipelineChain,
            disabledChainIds,
          }).catch((e: unknown) =>
            console.warn('[useWorkspaceAutoSave] Auto-save to path failed:', e),
          );
        } else {
          // No .ltw path yet — save to app_data_dir via auto_save_workspace.
          const options: AutoSaveWorkspaceOptions = {
            workspaceName,
            editorTabs,
            layout,
            pipelineChain,
            disabledChainIds,
          };
          autoSaveWorkspace(options).catch((e: unknown) =>
            console.warn('[useWorkspaceAutoSave] Auto-save failed:', e),
          );
        }
      }, AUTO_SAVE_DEBOUNCE_MS);
    };

    bus.on('workspace:mutated', handler);
    return () => {
      bus.off('workspace:mutated', handler);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
