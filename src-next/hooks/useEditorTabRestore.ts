import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { LtsEditorTabPayload } from '../bridge/types';
import type { WorkspaceLayoutState } from './workspace/workspaceTypes';

/**
 * Listens for 'lts-editor-tabs' event and restores editor tabs on .lts import.
 */
export function useEditorTabRestore(openCenterTab: WorkspaceLayoutState['openCenterTab']): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    listen<LtsEditorTabPayload[]>('lts-editor-tabs', (event) => {
      if (cancelled) return;
      for (const tab of event.payload) {
        openCenterTab('editor', tab.label, tab.filePath ?? undefined, {
          content: tab.content,
          viewMode: tab.viewMode,
          wordWrap: tab.wordWrap,
        });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openCenterTab]);
}
