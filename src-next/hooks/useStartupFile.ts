import { useEffect, useRef } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { useFileActions, useWorkspaceActions } from '../context';
import { onOpenFile } from '../bridge/events';
import { consumeStartupFile } from './workspace/startupFile';

function isLtsFile(path: string): boolean {
  return path.toLowerCase().endsWith('.lts');
}

/**
 * Opens a file passed via CLI args at launch (e.g. double-click file association)
 * and listens for open-file events while the app is running (single-instance redirect, macOS).
 *
 * .lts files are routed through openWorkspace() (full workspace restore).
 * All other files are routed through loadFile() (add to current workspace).
 */
export function useStartupFile() {
  const { loadFile } = useFileActions();
  const { openWorkspace } = useWorkspaceActions();

  // Ref so the persistent listener always calls the latest callbacks.
  const actionsRef = useRef({ loadFile, openWorkspace });
  actionsRef.current = { loadFile, openWorkspace };

  // CLI arg — consumed once on mount. Shared (memoised) with useStartupRestore so
  // the backend `.take()` is read once and both hooks observe the same value:
  // this hook loads the file; the orchestrator skips its `.ltw` gate.
  useEffect(() => {
    consumeStartupFile().then((path) => {
      if (!path) return;
      const a = actionsRef.current;
      if (isLtsFile(path)) a.openWorkspace(path);
      else a.loadFile(path);
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
      const a = actionsRef.current;
      if (isLtsFile(path)) a.openWorkspace(path);
      else a.loadFile(path);
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
