import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { CenterTabType } from './workspace/workspaceTypes';

/** Payload shape from the Rust backend (snake_case from serde) */
interface LtsEditorTabEvent {
  label: string;
  content: string;
  view_mode: string;
  word_wrap: boolean;
  file_path: string | null;
}

type OpenCenterTab = (
  type: CenterTabType,
  label?: string,
  filePath?: string,
  editorState?: { content: string; viewMode: string; wordWrap: boolean },
) => void;

/**
 * Listens for 'lts-editor-tabs' event and restores editor tabs on .lts import.
 */
export function useEditorTabRestore(openCenterTab: OpenCenterTab): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    listen<LtsEditorTabEvent[]>('lts-editor-tabs', (event) => {
      if (cancelled) return;
      for (const tab of event.payload) {
        openCenterTab('editor', tab.label, tab.file_path ?? undefined, {
          content: tab.content,
          viewMode: tab.view_mode,
          wordWrap: tab.word_wrap,
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
