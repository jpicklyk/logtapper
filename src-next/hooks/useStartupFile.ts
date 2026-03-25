import { useEffect } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { useViewerActions } from '../context';
import { getStartupFile } from '../bridge/commands';
import { onOpenFile } from '../bridge/events';

/**
 * Opens a file passed via CLI args at launch (e.g. double-click file association)
 * and listens for open-file events while the app is running (single-instance redirect, macOS).
 */
export function useStartupFile() {
  const { loadFile } = useViewerActions();

  // CLI arg — consumed once on mount. Safe with StrictMode: .take() returns null on second call.
  useEffect(() => {
    getStartupFile().then((path) => {
      if (path) loadFile(path);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persistent listener for files opened while app is running.
  // Uses the async listener pattern for StrictMode safety.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    onOpenFile((path) => {
      if (cancelled) return;
      loadFile(path);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadFile]);
}
