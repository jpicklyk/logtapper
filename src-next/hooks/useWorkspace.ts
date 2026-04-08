import { useState, useCallback, useRef } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useWorkspaceContext } from '../context/WorkspaceContext';
import { saveWorkspaceV4, loadWorkspaceV4, saveAppState, restoreWorkspaceSession } from '../bridge/commands';
import type { WorkspaceIdentity } from '../bridge/workspaceTypes';

import { bus } from '../events/bus';
import { basename, dirname, storageGetJSON } from '../utils';
import { collectEditorTabsForSave, buildEditorTabEvents, performAutoSave, buildAppStatePayload } from './workspace/workspacePersistence';
import { STORAGE_KEY } from './workspace/workspaceTypes';

/** Derive a workspace display name from a file path. */
export function workspaceNameFromPath(path: string): string {
  return basename(path).replace(/\.(ltw|lts)$/i, '');
}

/** Return a sensible default directory for file dialogs, or undefined. */
function resolveDefaultDir(
  ctx: { activeWorkspace: { filePath: string | null } | null },
  getDefaultDir?: () => string | undefined,
): string | undefined {
  // Prefer the directory of the active workspace's .ltw file
  const fp = ctx.activeWorkspace?.filePath;
  if (fp) return dirname(fp);
  // Fall back to caller-supplied default (e.g. directory of the focused session's source file)
  return getDefaultDir?.();
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
  getDefaultDir?: () => string | undefined,
  getPipelineChain?: () => string[],
  getDisabledChainIds?: () => string[],
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

  /** Build the save payload from current state. */
  const buildSavePayload = useCallback((destPath: string, name: string) => {
    return {
      destPath,
      workspaceName: name,
      editorTabs: collectEditorTabsForSave(),
      layout: getLayoutState(),
      pipelineChain: getPipelineChain?.() ?? [],
      disabledChainIds: getDisabledChainIds?.() ?? [],
    };
  }, [getLayoutState, getPipelineChain, getDisabledChainIds]);

  /** Save the active workspace to a .ltw v4 file. */
  const doSave = useCallback(async (destPath: string) => {
    const ctx = wsCtxRef.current;
    const activeWs = ctx.activeWorkspace;
    if (!activeWs) return;
    await saveWorkspaceV4(buildSavePayload(destPath, activeWs.name));
    ctx.markClean(activeWs.name, destPath);
  }, [buildSavePayload]);

  /** Auto-save the active workspace (for workspace switching). Not a user save — no markClean. */
  const doAutoSave = useCallback(async () => {
    const ctx = wsCtxRef.current;
    const active = ctx.activeWorkspace;
    if (!active) return;

    const { workspaceName, editorTabs, layout, pipelineChain, disabledChainIds } =
      buildSavePayload('', active.name);
    try {
      const savedPath = await performAutoSave({
        workspaceName, filePath: active.filePath, editorTabs, layout, pipelineChain, disabledChainIds,
      });
      if (savedPath) ctx.setWorkspacePath(active.id, savedPath);
    } catch (e) {
      console.warn('[useWorkspace] Auto-save failed:', e);
    }
  }, [buildSavePayload]);

  /** Clear the current panes (close all backend sessions + reset layout tree). */
  const doClearPanes = useCallback(async () => {
    bus.emit('workspace:before-reset', undefined);
    await closeAllSessions();
    // Layout tree is reset via the workspace:reset event listener in useWorkspaceLayout
  }, [closeAllSessions]);

  /** Load a workspace from a .ltw file into the active slot. */
  const doLoadWorkspace = useCallback(async (path: string) => {
    const result = await loadWorkspaceV4(path);

    // Collect session IDs in order as each session:loaded event fires.
    // session:loaded fires synchronously before loadFile's promise resolves,
    // so by the time each await returns, the corresponding ID is queued.
    const loadedSessionIds: string[] = [];
    const onSessionLoaded = (payload: { sessionId: string }) => {
      loadedSessionIds.push(payload.sessionId);
    };
    bus.on('session:loaded', onSessionLoaded);

    // Load each session by file path
    for (const session of result.sessions) {
      try {
        await loadFile(session.filePath);
      } catch (e) {
        console.warn(`[useWorkspace] Failed to load session ${session.filePath}:`, e);
      }
    }

    bus.off('session:loaded', onSessionLoaded);

    // Restore per-session artifacts (bookmarks, analyses, pipeline meta).
    // Match by index: loadedSessionIds[i] corresponds to result.sessionData[i].
    // Restores are independent — run in parallel.
    await Promise.all(
      loadedSessionIds.map((sessionId, i) => {
        const data = result.sessionData[i];
        if (!data) return Promise.resolve();
        return restoreWorkspaceSession({ sessionId, ...data })
          .catch(e => console.warn(`[useWorkspace] Failed to restore artifacts for session ${sessionId}:`, e));
      }),
    );

    // Restore editor tabs from workspace
    for (const event of buildEditorTabEvents(result.editorTabs)) {
      bus.emit('layout:open-tab', event);
    }

    // Restore layout pane state (widths, visible panes, tab order, etc.)
    if (result.layout) {
      bus.emit('workspace:restore-layout', { layout: result.layout });
    }

    // Pipeline chain restore is handled by useWorkspaceRestore via the
    // workspace-restored Tauri event emitted by the backend during session load.

    bus.emit('workspace:opened', { name: result.workspaceName, filePath: path });
  }, [loadFile]);

  /** Persist the workspace list to backend app-state.json. */
  const persistAppState = useCallback(async () => {
    const ctx = wsCtxRef.current;
    await saveAppState(buildAppStatePayload(ctx.workspaces, ctx.activeId))
      .catch(e => console.warn('[useWorkspace] Failed to persist app state:', e));
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
          defaultPath: resolveDefaultDir(ctx, getDefaultDir),
          filters: [{ name: 'LogTapper Workspace', extensions: ['ltw'] }],
        });
        if (typeof destPath !== 'string') {
          pendingActionRef.current = null;
          return;
        }
        await doSave(destPath);
        if (active) ctx.renameWorkspace(active.id, workspaceNameFromPath(destPath));
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
        defaultPath: resolveDefaultDir(wsCtxRef.current, getDefaultDir),
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
        defaultPath: resolveDefaultDir(ctx, getDefaultDir),
        filters: [{ name: 'LogTapper Workspace', extensions: ['ltw'] }],
      });
      if (typeof destPath === 'string') {
        await doSave(destPath);
        // User chose a new path — update name to match the filename
        ctx.renameWorkspace(active.id, workspaceNameFromPath(destPath));
      }
    }
    await persistAppState();
  }, [doSave, persistAppState]);

  const saveWorkspaceAs = useCallback(async () => {
    const destPath = await save({
      defaultPath: resolveDefaultDir(wsCtxRef.current, getDefaultDir),
      filters: [{ name: 'LogTapper Workspace', extensions: ['ltw'] }],
    });
    if (typeof destPath === 'string') {
      await doSave(destPath);
      // User chose a new path — update name to match the filename
      const ctx = wsCtxRef.current;
      const active = ctx.activeWorkspace;
      if (active) ctx.renameWorkspace(active.id, workspaceNameFromPath(destPath));
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
