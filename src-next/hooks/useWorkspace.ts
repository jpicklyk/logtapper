import { useState, useCallback, useRef } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useWorkspaceContext } from '../context/WorkspaceContext';
import { saveWorkspaceV4, loadWorkspaceV4, saveAppState } from '../bridge/commands';
import type { WorkspaceIdentity } from '../bridge/workspaceTypes';

import { bus } from '../events/bus';
import { basename, dirname, storageGetJSON } from '../utils';
import { collectEditorTabsForSave, performAutoSave, buildAppStatePayload } from './workspace/workspacePersistence';
import { STORAGE_KEY } from './workspace/workspaceTypes';
import { planExplicitOpen } from './workspace/restorePlan';
import { restoreWorkspace, type RestoreIo } from './workspace/restoreCore';
import { pushWorkspaceEnvelope } from './workspace/envelopeSync';

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
  /** Close a workspace by ID. Prompts to save if the target is dirty. */
  closeWorkspace: (targetId: string) => void;
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
  loadFile: (path: string, paneId?: string, existingTabId?: string) => Promise<void>,
  scheduleAutoRun: (sessionId: string, isIndexing: boolean | undefined, chain: string[], disabled: string[]) => void,
  getDefaultDir?: () => string | undefined,
  getPipelineChain?: () => string[],
  getDisabledChainIds?: () => string[],
): WorkspaceActions {
  const wsCtx = useWorkspaceContext();
  const wsCtxRef = useRef(wsCtx);
  wsCtxRef.current = wsCtx;

  // Save prompt state
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const pendingActionRef = useRef<{ type: 'new' } | { type: 'open'; path: string } | { type: 'switch'; targetId: string } | null>(null);

  // --- Internal helpers ---

  /** Collect the current layout state from localStorage. */
  const getLayoutState = useCallback(() => {
    return storageGetJSON<unknown>(STORAGE_KEY, null);
  }, []);

  /** Build the save payload from current state. */
  const buildSavePayload = useCallback((workspaceId: string, destPath: string, name: string) => {
    return {
      workspaceId,
      destPath,
      workspaceName: name,
      editorTabs: collectEditorTabsForSave(),
      layout: getLayoutState(),
      pipelineChain: getPipelineChain?.() ?? [],
      disabledChainIds: getDisabledChainIds?.() ?? [],
    };
  }, [getLayoutState, getPipelineChain, getDisabledChainIds]);

  /** Push the active workspace shell to the backend envelope cache (no file
   *  write) so a backend flush can rebuild it before the frontend's own
   *  debounced auto-save runs. */
  const pushEnvelope = useCallback((ws: WorkspaceIdentity, override?: {
    workspaceName?: string; editorTabs?: ReturnType<typeof collectEditorTabsForSave>;
    layout?: unknown; pipelineChain?: string[]; disabledChainIds?: string[];
  }) => {
    return pushWorkspaceEnvelope({
      workspaceId: ws.id,
      workspaceName: override?.workspaceName ?? ws.name,
      ltwPath: ws.filePath,
      editorTabs: override?.editorTabs ?? collectEditorTabsForSave(),
      layout: override?.layout ?? getLayoutState(),
      pipelineChain: override?.pipelineChain ?? (getPipelineChain?.() ?? []),
      disabledChainIds: override?.disabledChainIds ?? (getDisabledChainIds?.() ?? []),
    }, '[useWorkspace]');
  }, [getLayoutState, getPipelineChain, getDisabledChainIds]);

  /** Save the active workspace to a .ltw v4 file. */
  const doSave = useCallback(async (destPath: string) => {
    const ctx = wsCtxRef.current;
    const activeWs = ctx.activeWorkspace;
    if (!activeWs) return;
    await saveWorkspaceV4(buildSavePayload(activeWs.id, destPath, activeWs.name));
    ctx.markClean(activeWs.name, destPath);
  }, [buildSavePayload]);

  /** Auto-save the active workspace (for workspace switching). Not a user save — no markClean. */
  const doAutoSave = useCallback(async () => {
    const ctx = wsCtxRef.current;
    const active = ctx.activeWorkspace;
    if (!active) return;

    const { workspaceName, editorTabs, layout, pipelineChain, disabledChainIds } =
      buildSavePayload(active.id, '', active.name);
    try {
      const savedPath = await performAutoSave({
        workspaceId: active.id,
        workspaceName, filePath: active.filePath, editorTabs, layout, pipelineChain, disabledChainIds,
      });
      // A non-null path means the workspace was auto-saved to the app-data dir
      // (no explicit .ltw). Record the recovery path + timestamp so switch-back
      // can reload it and app-state.json carries the Q3 linkage fields.
      if (savedPath) ctx.recordAutoSave(active.id, savedPath, Date.now());
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

    // Explicit open: the `.ltw` is the whole truth (no localStorage tabs
    // participate) and its view-state is always applied. The shared core owns the
    // restore-begin/end bracket, per-entry keyed pairing, artifact restore, the
    // targeted auto-run, view-state replay, and `workspace:opened`.
    const io: RestoreIo = { loadFile, scheduleAutoRun };
    const plan = planExplicitOpen(result.sessions);
    const warnings = await restoreWorkspace(
      {
        workspaceName: result.workspaceName,
        filePath: path,
        sessionData: result.sessionData,
        editorTabs: result.editorTabs,
        layout: result.layout,
      },
      plan,
      io,
    );
    if (warnings.length > 0) bus.emit('workspace:restore-warnings', { warnings });

    // Push the freshly-loaded shell to the backend envelope cache so a backend
    // flush (e.g. an MCP artifact write against a just-restored session) can
    // rebuild this workspace even before the frontend's own auto-save runs.
    // Read the active id at the END, after the active workspace has settled.
    const active = wsCtxRef.current.activeWorkspace;
    if (active) {
      void pushWorkspaceEnvelope({
        workspaceId: active.id,
        workspaceName: result.workspaceName,
        ltwPath: path,
        editorTabs: result.editorTabs,
        layout: result.layout,
        pipelineChain: result.pipelineChain.chain,
        disabledChainIds: result.pipelineChain.disabledIds,
      }, '[useWorkspace]');
    }
  }, [loadFile, scheduleAutoRun]);

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
      case 'switch': {
        // Always auto-save current workspace state before switching
        await doAutoSave();
        await doClearPanes();
        bus.emit('workspace:reset', undefined);
        ctx.setActiveId(action.targetId);
        // Load the target workspace from its saved .ltw
        const target = ctx.workspaces.find(w => w.id === action.targetId);
        if (target?.filePath) {
          await doLoadWorkspace(target.filePath); // pushes the envelope at its end
        } else if (target) {
          // Empty target (never saved, no sessions to restore): still register
          // its identity as the active envelope so a later flush targets it.
          await pushEnvelope(target);
        }
        await persistAppState();
        break;
      }
    }
  }, [doClearPanes, doAutoSave, doLoadWorkspace, persistAppState, pushEnvelope]);

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

  const closeWorkspace = useCallback((targetId: string) => {
    const ctx = wsCtxRef.current;
    if (targetId === ctx.activeId) return; // Cannot close the active workspace
    // Non-active workspaces are auto-saved on switch — skip dirty guard
    ctx.removeWorkspace(targetId);
    persistAppState();
  }, [persistAppState]);

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
