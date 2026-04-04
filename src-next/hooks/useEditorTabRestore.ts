import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { LtsEditorTabPayload } from '../bridge/types';
import type { WorkspaceLayoutState } from './workspace/workspaceTypes';
import { allPanes, STORAGE_KEY } from './workspace';
import { storageGetJSON } from '../utils';

/** Returns a Set of labels for currently open editor tabs. */
function getOpenEditorLabels(): Set<string> {
  const persisted = storageGetJSON<{ centerTree?: import('./workspace').SplitNode } | null>(STORAGE_KEY, null);
  if (!persisted?.centerTree) return new Set();
  const labels = new Set<string>();
  for (const pane of allPanes(persisted.centerTree)) {
    for (const tab of pane.tabs) {
      if (tab.type === 'editor') labels.add(tab.label);
    }
  }
  return labels;
}

/**
 * Listens for 'lts-editor-tabs' event and restores editor tabs on .lts import.
 * Skips tabs whose label already exists (prevents duplicates on hot reload).
 */
export function useEditorTabRestore(openCenterTab: WorkspaceLayoutState['openCenterTab']): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    listen<LtsEditorTabPayload[]>('lts-editor-tabs', (event) => {
      if (cancelled) return;
      const existing = getOpenEditorLabels();
      for (const tab of event.payload) {
        if (existing.has(tab.label)) continue;
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
