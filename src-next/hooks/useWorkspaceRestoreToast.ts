import { useEffect, useRef } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';
import type { ToastItem } from '../ui';
import type { WorkspaceRestoredPayload } from '../bridge/types';

let toastCounter = 0;

/**
 * Listens for `workspace-restored` Tauri events and shows a toast
 * summarizing how many bookmarks/analyses were restored.
 *
 * Multiple events (e.g. multi-session .lts import) are debounced into a
 * single aggregated toast using a 500ms window.
 */
export function useWorkspaceRestoreToast(addToast: (toast: ToastItem) => void) {
  const accRef = useRef({ bookmarkCount: 0, analysisCount: 0, procCount: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    const flush = () => {
      timerRef.current = null;
      if (cancelled) return;
      const { bookmarkCount, analysisCount, procCount } = accRef.current;
      accRef.current = { bookmarkCount: 0, analysisCount: 0, procCount: 0 };

      const parts: string[] = [];
      if (bookmarkCount > 0) parts.push(`${bookmarkCount} bookmark${bookmarkCount !== 1 ? 's' : ''}`);
      if (analysisCount > 0) parts.push(`${analysisCount} analysis artifact${analysisCount !== 1 ? 's' : ''}`);
      if (procCount > 0) parts.push(`pipeline (${procCount} processor${procCount !== 1 ? 's' : ''})`);
      if (parts.length === 0) return;

      addToast({
        id: `workspace-restore-${++toastCounter}`,
        title: 'Workspace restored',
        message: `Restored ${parts.join(' and ')}`,
      });
    };

    listen<WorkspaceRestoredPayload>('workspace-restored', (event) => {
      if (cancelled) return;
      const { bookmarkCount, analysisCount, activeProcessorIds } = event.payload;
      const procCount = (activeProcessorIds ?? []).length;

      // Accumulate counts across rapid successive events (multi-session .lts)
      accRef.current.bookmarkCount += bookmarkCount;
      accRef.current.analysisCount += analysisCount;
      accRef.current.procCount += procCount;

      // Start a debounce timer if one isn't already pending
      if (timerRef.current === null) {
        timerRef.current = setTimeout(flush, 500);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [addToast]);
}
