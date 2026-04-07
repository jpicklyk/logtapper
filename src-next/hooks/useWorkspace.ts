import { useState, useCallback, useRef } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useWorkspaceContext } from '../context/WorkspaceContext';
import { saveWorkspaceV4, autoSaveWorkspace, loadWorkspaceV4, saveAppState } from '../bridge/commands';
import type { WorkspaceIdentity } from '../bridge/workspaceTypes';
import { bus } from '../events/bus';
import { basename, storageGetJSON } from '../utils';
import { collectEditorTabs } from './workspace/workspacePersistence';
import { STORAGE_KEY } from './workspace/workspaceTypes';

/** Derive a workspace display name from a file path. */
export function workspaceNameFromPath(path: string): string {
  return basename(path).replace(/\.(ltw|lts)$/i, '');
}

export type SavePromptChoice = 'save' | 'discard' | 'cancel';

export interface WorkspaceActions {
  /** Create a new empty workspace and make it active. */
  newWorkspace: () => void;
  /** Open a workspace from an .ltw file and add to the list. */
  openWorkspace: (path?: string) => void;
  /** Save the active workspace to its .ltw path (or prompt Save As). */
  saveWorkspace: () => Promise<void>;
  /** Save the active workspace to a new .ltw path. */
  saveWorkspaceAs: () => Promise<void>;
  /** Close the active workspace. Prompts to save if dirty. */
  closeWorkspace: () => void;
  /** Switch to a different workspace by ID. Auto-saves the current one. */
  switchWorkspace: (targetId: string) => void;
  /** Whether the save prompt dialog should be shown. */
  showSavePrompt: boolean;
  /** The pending action waiting for the save prompt result. */
  handleSavePromptResult: (choice: SavePromptChoice) => void;
}

/**
 * Workspace lifecycle orchestration for multiple workspaces.
 *
 * Manages workspace list operations (new, open, close, switch, save)
 * with dirty-check prompts. Wired into ActionsContext via HookWiring.
 */
export function useWorkspace(
  closeAllSessions: () => Promise<void>,
  loadFile: (path: string) => Promise<void>,
): WorkspaceActions {
  const wsCtx = useWorkspaceContext();
  const wsCtxRef = useRef(wsCtx);
  wsCtxRef.current = wsCtx;

  // Save prompt state
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const pendingActionRef = useRef<{ type: 'new' } | { type: 'open'; path: string } | { type: 'close' } | { type: 'switch'; targetId: string } | null>(null);

  // --- Internal helpers ---

  /** Collect the current layout state from localStorage. */
  const getLayoutState = useCallback(() => {
    return storageGetJSON<unknown>(STORAGE_KEY, null);
  }, []);

  /** Save the active workspace to a .ltw v4 file. */
  const doSave = useCallback(async (destPath: string) => {
    const ctx = wsCtxRef.current;
    const activeWs = ctx.activeWorkspace;
    if (!activeWs) return;

    const editorTabs = collectEditorTabs();
    const layout = getLayoutState();

    await saveWorkspaceV4({
      destPath,
      workspaceName: activeWs.name,
      editorTabs: editorTabs.map(t => ({
        label: t.label,
        content: t.content,
        viewMode: t.viewMode,
        wordWrap: t.wordWrap,
        filePath: t.filePath,
      })),
      layout,
      pipelineChain: [], // TODO: read from PipelineContext
      disabledChainIds: [], // TODO: read from PipelineContext
    });

    ctx.markClean(workspaceNameFromPath(destPath), destPath);
  }, [getLayoutState]);

  /** Auto-save the active workspace to app_data_dir for workspace switching. */
  const doAutoSave = useCallback(async () => {
    const ctx = wsCtxRef.current;
    const active = ctx.activeWorkspace;
    if (!active) return;

    const editorTabs = collectEditorTabs();
    const layout = getLayoutState();

    try {
      const savedPath = await autoSaveWorkspace({
        workspaceId: active.id,
        workspaceName: active.name,
        editorTabs,
        layout,
        pipelineChain: [], // TODO: read from PipelineContext
        disabledChainIds: [], // TODO: read from PipelineContext
      });
      // Update the workspace entry with the auto-save path so we can restore
      ctx.setWorkspacePath(active.id, savedPath);
    } catch (e) {
      console.warn('[useWorkspace] Auto-save failed:', e);
    }
  }, [getLayoutState]);

  /** Clear the current panes (close all backend sessions + reset layout tree). */
  const doClearPanes = useCallback(async () => {
    bus.emit('workspace:before-reset', undefined);
    await closeAllSessions();
    // Layout tree is reset via the workspace:reset event listener in useWorkspaceLayout
  }, [closeAllSessions]);

  /** Load a workspace from a .ltw file into the active slot. */
  const doLoadWorkspace = useCallback(async (path: string) => {
    const result = await loadWorkspaceV4(path);

    // Load each session by file path
    for (const session of result.sessions) {
      try {
        await loadFile(session.filePath);
      } catch (e) {
        console.warn(`[useWorkspace] Failed to load session ${session.filePath}:`, e);
      }
    }

    // TODO: restore layout, editor tabs, pipeline chain from result
    bus.emit('workspace:opened', { name: result.workspaceName, filePath: path });
  }, [loadFile]);

  /** Persist the workspace list to backend app-state.json. */
  const persistAppState = useCallback(async () => {
    const ctx = wsCtxRef.current;
    await saveAppState({
      workspaces: ctx.workspaces.map(w => ({
        id: w.id,
        name: w.name,
        ltwPath: w.filePath,
        dirty: w.dirty,
      })),
      activeWorkspaceId: ctx.activeId,
    }).catch(e => console.warn('[useWorkspace] Failed to persist app state:', e));
  }, []);

  // --- Prompt flow ---

  const getActiveDirty = useCallback((): boolean => {
    return wsCtxRef.current.activeWorkspace?.dirty ?? false;
  }, []);

  const executePendingAction = useCallback(async () => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (!action) return;

    const ctx = wsCtxRef.current;

    switch (action.type) {
      case 'new': {
        await doClearPanes();
        ctx.addWorkspace();
        await persistAppState();
        bus.emit('workspace:reset', undefined);
        break;
      }
      case 'open': {
        await doClearPanes();
        const name = workspaceNameFromPath(action.path);
        const ws: WorkspaceIdentity = {
          id: crypto.randomUUID(),
          name,
          filePath: action.path,
          dirty: false,
        };
        ctx.addWorkspaceEntry(ws);
        await doLoadWorkspace(action.path);
        await persistAppState();
        break;
      }
      case 'close': {
        const activeId = ctx.activeId;
        if (!activeId) break;
        await doClearPanes();
        ctx.removeWorkspace(activeId);
        // If there's a next workspace, load it
        // (removeWorkspace auto-selects the next one)
        // We need to wait for the state update, then load
        // For now, emit reset — the next render will pick up the new active
        await persistAppState();
        bus.emit('workspace:reset', undefined);
        break;
      }
      case 'switch': {
        // Always auto-save current workspace state before switching
        await doAutoSave();
        await doClearPanes();
        bus.emit('workspace:reset', undefined);
        ctx.setActiveId(action.targetId);
        // Load the target workspace from its saved .ltw
        const target = ctx.workspaces.find(w => w.id === action.targetId);
        if (target?.filePath) {
          await doLoadWorkspace(target.filePath);
        }
        await persistAppState();
        break;
      }
    }
  }, [doClearPanes, doAutoSave, doLoadWorkspace, persistAppState]);

  const handleSavePromptResult = useCallback(async (choice: SavePromptChoice) => {
    setShowSavePrompt(false);
    if (choice === 'cancel') {
      pendingActionRef.current = null;
      return;
    }
    if (choice === 'save') {
      const ctx = wsCtxRef.current;
      const active = ctx.activeWorkspace;
      if (active?.filePath) {
        await doSave(active.filePath);
      } else {
        const destPath = await save({
          filters: [{ name: 'LogTapper Workspace', extensions: ['ltw'] }],
        });
        if (typeof destPath !== 'string') {
          pendingActionRef.current = null;
          return;
        }
        await doSave(destPath);
      }
    }
    await executePendingAction();
  }, [doSave, executePendingAction]);

  // --- Guarded actions (check dirty before proceeding) ---

  const guardedAction = useCallback((action: NonNullable<typeof pendingActionRef.current>) => {
    if (getActiveDirty()) {
      pendingActionRef.current = action;
      setShowSavePrompt(true);
      return;
    }
    pendingActionRef.current = action;
    executePendingAction();
  }, [getActiveDirty, executePendingAction]);

  // --- Public actions ---

  const newWorkspace = useCallback(() => {
    guardedAction({ type: 'new' });
  }, [guardedAction]);

  const openWorkspace = useCallback(async (path?: string) => {
    let resolvedPath = path;
    if (!resolvedPath) {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'LogTapper Workspace', extensions: ['ltw'] }],
      });
      if (typeof selected !== 'string') return;
      resolvedPath = selected;
    }
    guardedAction({ type: 'open', path: resolvedPath });
  }, [guardedAction]);

  const saveWorkspace = useCallback(async () => {
    const ctx = wsCtxRef.current;
    const active = ctx.activeWorkspace;
    if (!active) return;

    if (active.filePath) {
      await doSave(active.filePath);
    } else {
      const destPath = await save({
        filters: [{ name: 'LogTapper Workspace', extensions: ['ltw'] }],
      });
      if (typeof destPath === 'string') {
        await doSave(destPath);
      }
    }
    await persistAppState();
  }, [doSave, persistAppState]);

  const saveWorkspaceAs = useCallback(async () => {
    const destPath = await save({
      filters: [{ name: 'LogTapper Workspace', extensions: ['ltw'] }],
    });
    if (typeof destPath === 'string') {
      await doSave(destPath);
      await persistAppState();
    }
  }, [doSave, persistAppState]);

  const closeWorkspace = useCallback(() => {
    guardedAction({ type: 'close' });
  }, [guardedAction]);

  const switchWorkspace = useCallback((targetId: string) => {
    const ctx = wsCtxRef.current;
    if (ctx.activeId === targetId) return;
    guardedAction({ type: 'switch', targetId });
  }, [guardedAction]);

  return {
    newWorkspace,
    openWorkspace,
    saveWorkspace,
    saveWorkspaceAs,
    closeWorkspace,
    switchWorkspace,
    showSavePrompt,
    handleSavePromptResult,
  };
}
