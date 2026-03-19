import { useEffect } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';
import type { ToastItem } from '../ui';

let toastCounter = 0;

interface WorkspaceRestoredPayload {
  sessionId: string;
  bookmarkCount: number;
  analysisCount: number;
}

/**
 * Listens for `workspace-restored` Tauri events and shows a toast
 * summarizing how many bookmarks/analyses were restored.
 */
export function useWorkspaceRestoreToast(addToast: (toast: ToastItem) => void) {
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    listen<WorkspaceRestoredPayload>('workspace-restored', (event) => {
      if (cancelled) return;
      const { bookmarkCount, analysisCount } = event.payload;
      const parts: string[] = [];
      if (bookmarkCount > 0) parts.push(`${bookmarkCount} bookmark${bookmarkCount !== 1 ? 's' : ''}`);
      if (analysisCount > 0) parts.push(`${analysisCount} analysis artifact${analysisCount !== 1 ? 's' : ''}`);
      if (parts.length === 0) return;

      addToast({
        id: `workspace-restore-${++toastCounter}`,
        title: 'Workspace restored',
        message: `Restored ${parts.join(' and ')}`,
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addToast]);
}
