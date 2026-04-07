import { useState, useCallback, useRef } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useWorkspaceContext } from '../context/WorkspaceContext';
import { exportAllSessions } from '../bridge/commands';
import type { LtsEditorTabPayload } from '../bridge/types';
import { bus } from '../events/bus';
import { basename } from '../utils';
import { storageGet } from '../utils';
import { allPanes } from './workspace/splitTreeHelpers';
import { LS_CONTENT_PREFIX, LS_MODE_PREFIX, LS_WRAP_PREFIX, LS_FILEPATH_PREFIX } from '../components/EditorTab';

// Re-use the same localStorage key as useWorkspaceLayout
const STORAGE_KEY = 'logtapper_workspace_v1';

/** Derive a workspace display name from an .lts file path. */
export function workspaceNameFromPath(path: string): string {
  return basename(path).replace(/\.lts$/i, '');
}

export type SavePromptChoice = 'save' | 'discard' | 'cancel';

export interface WorkspaceActions {
  /** Create a fresh empty workspace. Prompts to save if dirty. */
  newWorkspace: () => void;
  /** Open a workspace from an .lts file. Prompts to save if dirty. */
  openWorkspace: (path?: string) => void;
  /** Save the current workspace to its filePath (or prompt Save As if none). */
  saveWorkspace: () => Promise<void>;
  /** Save the current workspace to a new .lts path. */
  saveWorkspaceAs: () => Promise<void>;
  /** Whether the save prompt dialog should be shown. */
  showSavePrompt: boolean;
  /** The pending action waiting for the save prompt result. */
  handleSavePromptResult: (choice: SavePromptChoice) => void;
}

/**
 * Workspace lifecycle orchestration.
 *
 * Manages new/open/save/saveAs actions with dirty-check prompts.
 * Wired into ActionsContext via HookWiring.
 */
export function useWorkspace(
  closeAllSessions: () => Promise<void>,
  loadFile: (path: string) => Promise<void>,
): WorkspaceActions {
  const { identity, markClean, resetIdentity } = useWorkspaceContext();

  const identityRef = useRef(identity);
  identityRef.current = identity;

  // Save prompt state
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const pendingActionRef = useRef<'new' | 'open' | null>(null);
  const pendingOpenPathRef = useRef<string | null>(null);

  // --- Internal helpers ---

  const collectEditorTabs = useCallback((): LtsEditorTabPayload[] => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { centerTree?: import('./workspace/workspaceTypes').SplitNode };
      if (!parsed?.centerTree) return [];
      const tabs: LtsEditorTabPayload[] = [];
      for (const pane of allPanes(parsed.centerTree)) {
        for (const tab of pane.tabs) {
          if (tab.type !== 'editor') continue;
          tabs.push({
            label: tab.label,
            content: storageGet(LS_CONTENT_PREFIX + tab.id),
            viewMode: (storageGet(LS_MODE_PREFIX + tab.id) || 'editor') as LtsEditorTabPayload['viewMode'],
            wordWrap: storageGet(LS_WRAP_PREFIX + tab.id) === 'true',
            filePath: storageGet(LS_FILEPATH_PREFIX + tab.id) || null,
          });
        }
      }
      return tabs;
    } catch {
      return [];
    }
  }, []);

  const doSave = useCallback(async (destPath: string) => {
    const editorTabs = collectEditorTabs();
    await exportAllSessions({
      destPath,
      includeBookmarks: true,
      includeAnalyses: true,
      includeProcessors: true,
      editorTabs,
    });
    markClean(workspaceNameFromPath(destPath), destPath);
  }, [collectEditorTabs, markClean]);

  const doReset = useCallback(async () => {
    bus.emit('workspace:before-reset', undefined);
    await closeAllSessions();
    resetIdentity();
    bus.emit('workspace:reset', undefined);
  }, [closeAllSessions, resetIdentity]);

  const doOpen = useCallback(async (path: string) => {
    bus.emit('workspace:before-reset', undefined);
    await closeAllSessions();
    resetIdentity();
    // loadFile handles .lts import (multi-session restore)
    await loadFile(path);
    const name = workspaceNameFromPath(path);
    markClean(name, path);
    bus.emit('workspace:opened', { name, filePath: path });
  }, [closeAllSessions, resetIdentity, loadFile, markClean]);

  // --- Prompt flow ---

  const executePendingAction = useCallback(async () => {
    const action = pendingActionRef.current;
    const openPath = pendingOpenPathRef.current;
    pendingActionRef.current = null;
    pendingOpenPathRef.current = null;

    if (action === 'new') {
      await doReset();
    } else if (action === 'open' && openPath) {
      await doOpen(openPath);
    }
  }, [doReset, doOpen]);

  const handleSavePromptResult = useCallback(async (choice: SavePromptChoice) => {
    setShowSavePrompt(false);
    if (choice === 'cancel') {
      pendingActionRef.current = null;
      pendingOpenPathRef.current = null;
      return;
    }
    if (choice === 'save') {
      const id = identityRef.current;
      if (id.filePath) {
        await doSave(id.filePath);
      } else {
        const destPath = await save({
          filters: [{ name: 'LogTapper Session', extensions: ['lts'] }],
        });
        if (typeof destPath !== 'string') {
          // User cancelled the save dialog — abort the pending action
          pendingActionRef.current = null;
          pendingOpenPathRef.current = null;
          return;
        }
        await doSave(destPath);
      }
    }
    // choice === 'discard' or save completed — execute pending action
    await executePendingAction();
  }, [doSave, executePendingAction]);

  // --- Public actions ---

  const newWorkspace = useCallback(() => {
    if (identityRef.current.dirty) {
      pendingActionRef.current = 'new';
      pendingOpenPathRef.current = null;
      setShowSavePrompt(true);
      return;
    }
    doReset();
  }, [doReset]);

  const openWorkspace = useCallback(async (path?: string) => {
    let resolvedPath = path;
    if (!resolvedPath) {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'LogTapper Session', extensions: ['lts'] }],
      });
      if (typeof selected !== 'string') return;
      resolvedPath = selected;
    }

    if (identityRef.current.dirty) {
      pendingActionRef.current = 'open';
      pendingOpenPathRef.current = resolvedPath;
      setShowSavePrompt(true);
      return;
    }
    await doOpen(resolvedPath);
  }, [doOpen]);

  const saveWorkspace = useCallback(async () => {
    const id = identityRef.current;
    if (id.filePath) {
      await doSave(id.filePath);
    } else {
      // No filePath — redirect to Save As
      const destPath = await save({
        filters: [{ name: 'LogTapper Session', extensions: ['lts'] }],
      });
      if (typeof destPath === 'string') {
        await doSave(destPath);
      }
    }
  }, [doSave]);

  const saveWorkspaceAs = useCallback(async () => {
    const destPath = await save({
      filters: [{ name: 'LogTapper Session', extensions: ['lts'] }],
    });
    if (typeof destPath === 'string') {
      await doSave(destPath);
    }
  }, [doSave]);

  return {
    newWorkspace,
    openWorkspace,
    saveWorkspace,
    saveWorkspaceAs,
    showSavePrompt,
    handleSavePromptResult,
  };
}
