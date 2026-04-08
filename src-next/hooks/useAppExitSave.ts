import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { autoSaveWorkspace, saveWorkspaceV4, saveAppState } from '../bridge/commands';
import type { AppStateFile } from '../bridge/types';
import type { AutoSavePayload } from './useWorkspaceAutoSave';

/**
 * Intercepts window close to perform a v4 workspace auto-save before
 * allowing the window to close.
 *
 * Uses the StrictMode-safe async listener pattern from CLAUDE.md:
 * cancelled flag + conditional unlisten handles double-mount in dev mode.
 *
 * A `closingRef` guard prevents re-entrance — `destroy()` is used after
 * save to bypass the close-requested event entirely (requires the
 * `core:window:allow-destroy` capability).
 *
 * @param buildAutoSavePayload - Returns the auto-save payload, or null if
 *   there is no active workspace to save.
 * @param getAppStatePayload - Returns the AppStateFile to persist the
 *   workspace list on exit.
 */
export function useAppExitSave(
  buildAutoSavePayload: () => AutoSavePayload | null,
  getAppStatePayload: () => AppStateFile,
): void {
  const buildPayloadRef = useRef(buildAutoSavePayload);
  buildPayloadRef.current = buildAutoSavePayload;
  const getAppStateRef = useRef(getAppStatePayload);
  getAppStateRef.current = getAppStatePayload;
  const closingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    getCurrentWindow().onCloseRequested(async (event) => {
      if (cancelled || closingRef.current) return;
      closingRef.current = true;
      event.preventDefault();

      try {
        // Save workspace state (route to existing .ltw or app_data_dir)
        const payload = buildPayloadRef.current();
        if (payload) {
          const { workspaceName, filePath, editorTabs, layout, pipelineChain, disabledChainIds } = payload;
          if (filePath) {
            await saveWorkspaceV4({ destPath: filePath, workspaceName, editorTabs, layout, pipelineChain, disabledChainIds });
          } else {
            await autoSaveWorkspace({ workspaceName, editorTabs, layout, pipelineChain, disabledChainIds });
          }
        }
        // Persist workspace list
        const appState = getAppStateRef.current();
        await saveAppState(appState);
      } catch (e) {
        console.warn('[useAppExitSave] Save failed on exit:', e);
      }

      // destroy() bypasses onCloseRequested — no re-entrance
      await getCurrentWindow().destroy();
    }).then((fn) => {
      if (cancelled) fn(); // cleanup already ran → immediately unregister
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
