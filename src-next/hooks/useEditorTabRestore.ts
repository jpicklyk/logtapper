import { useEffect, useRef } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { onLtsEditorTabs } from '../bridge/events';
import type { WorkspaceLayoutState, SplitNode } from './workspace/workspaceTypes';
import { allPanes } from './workspace';

/** Returns a Set of labels for currently open editor tabs. */
function getOpenEditorLabels(tree: SplitNode): Set<string> {
  const labels = new Set<string>();
  for (const pane of allPanes(tree)) {
    for (const tab of pane.tabs) {
      if (tab.type === 'editor') labels.add(tab.label);
    }
  }
  return labels;
}

/**
 * Listens for 'lts-editor-tabs' event and restores editor tabs on .lts import.
 * Skips tabs whose label already exists (prevents duplicates on hot reload).
 *
 * Dedup reads the live `centerTree` (via a ref kept in sync on every render)
 * rather than the persisted localStorage layout snapshot. That snapshot is
 * deliberately not written by useWorkspaceLayout in the compact preset, which
 * silently broke dedup there, and even outside compact it lags one write
 * behind the actual tree — so a tab opened in the same tick as an .lts import
 * could still be missed.
 */
export function useEditorTabRestore(
  openCenterTab: WorkspaceLayoutState['openCenterTab'],
  centerTree: SplitNode,
): void {
  // Synchronous render-time sync — safe for refs, no side effects. Lets the
  // listener (registered once, below) always read the current tree without
  // re-subscribing to the Tauri event on every tree change.
  const centerTreeRef = useRef(centerTree);
  centerTreeRef.current = centerTree;

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onLtsEditorTabs((payload) => {
      if (cancelled) return;
      const existing = getOpenEditorLabels(centerTreeRef.current);
      for (const tab of payload) {
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
