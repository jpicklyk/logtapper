import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { saveAppState } from '../bridge/commands';
import { performAutoSave } from './workspace/workspacePersistence';
import type { AppStateFile } from '../bridge/types';
import type { AutoSavePayload } from './useWorkspaceAutoSave';

/**
 * Intercepts window close to perform a v4 workspace auto-save before
 * allowing the window to close.
 *
 * Uses the StrictMode-safe async listener pattern from CLAUDE.md.
 * A `closingRef` guard prevents re-entrance — `destroy()` is used after
 * save to bypass the close-requested event entirely (requires the
 * `core:window:allow-destroy` capability).
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
        const payload = buildPayloadRef.current();
        const appState = getAppStateRef.current();
        await Promise.all([
          payload ? performAutoSave(payload) : Promise.resolve(null),
          saveAppState(appState),
        ]);
      } catch (e) {
        console.warn('[useAppExitSave] Save failed on exit:', e);
      }

      // destroy() bypasses onCloseRequested — no re-entrance
      await getCurrentWindow().destroy();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
