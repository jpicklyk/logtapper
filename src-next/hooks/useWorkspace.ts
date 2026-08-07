import { useCallback, useRef } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useWorkspaceContext } from '../context/WorkspaceContext';
import { saveWorkspaceV4, loadWorkspaceV4, saveAppState, beginWorkspaceSwitch, setWorkspaceAnalyses } from '../bridge/commands';
import type { WorkspaceIdentity } from '../bridge/workspaceTypes';

import { bus } from '../events';
import { basename, dirname, storageGetJSON } from '../utils';
import { collectEditorTabsForSave, performAutoSave, buildAppStatePayload } from './workspace/workspacePersistence';
import { STORAGE_KEY } from './workspace/workspaceTypes';
import { planExplicitOpen } from './workspace/restorePlan';
import { restoreWorkspace, type RestoreIo } from './workspace/restoreCore';
import { pushWorkspaceEnvelope } from './workspace/envelopeSync';
import { bumpWorkspaceEpoch } from './workspace/workspaceEpoch';
import { waitForPendingLoads } from './workspace/pendingLoads';

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

export interface WorkspaceActions {
  /** Create a new empty workspace and make it active. */
  newWorkspace: () => void;
  /** Open a workspace from an .ltw file and add to the list. */
  openWorkspace: (path?: string) => void;
  /** Save the active workspace to its .ltw path (or prompt Save As). */
  saveWorkspace: () => Promise<void>;
  /** Save the active workspace to a new .ltw path. */
  saveWorkspaceAs: () => Promise<void>;
  /** Close a workspace by ID. */
  closeWorkspace: (targetId: string) => void;
  /** Switch to a different workspace by ID. Auto-saves the current one. */
  switchWorkspace: (targetId: string) => void;
}

/**
 * Workspace lifecycle orchestration for multiple workspaces.
 *
 * Manages workspace list operations (new, open, close, switch, save).
 * Transitions (new/open/switch) execute immediately regardless of the dirty
 * flag — durability comes from `doAutoSave()` running before `doClearPanes()`
 * in the 'switch' case, not from a blocking prompt. Wired into ActionsContext
 * via HookWiring.
 */
export function useWorkspace(
  closeAllSessions: () => Promise<void>,
  // Must mirror RestoreIo['loadFile'] exactly — it is assigned straight into a
  // RestoreIo below. A narrower signature here still compiles (fewer params are
  // assignable to more) but documents a contract this does not have, and invites
  // the next refactor to wrap it and drop the extra argument.
  loadFile: RestoreIo['loadFile'],
  scheduleAutoRun: (sessionId: string, isIndexing: boolean | undefined, chain: string[], disabled: string[]) => void,
  getDefaultDir?: () => string | undefined,
  getPipelineChain?: () => string[],
  getDisabledChainIds?: () => string[],
): WorkspaceActions {
  const wsCtx = useWorkspaceContext();
  const wsCtxRef = useRef(wsCtx);
  wsCtxRef.current = wsCtx;

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

    // SAVE HOLE fix: this save's payload is built from backend
    // `state.sessions`, which a file whose `load_log_file` IPC hasn't
    // resolved yet is absent from — waiting here gives any load that was
    // already in flight when the switch was triggered a chance to land in
    // `state.sessions` first, instead of the source workspace's manifest
    // silently losing it. Bounded (see `pendingLoads.ts`) so a hung load
    // can't block the switch indefinitely — this call happens BEFORE
    // `doClearPanes` bumps the workspace epoch, so any load still in flight
    // when the wait times out resolves normally afterward (not discarded by
    // the epoch guard) and is simply absent from this particular save, same
    // as today.
    await waitForPendingLoads();

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
    // Bump the workspace epoch FIRST — synchronously, before any `await` —
    // so it happens strictly before this teardown's `closeAllSessions()`
    // below and, critically, before whatever workspace-restore burst of
    // `loadFile` calls follows this function's caller (`doLoadWorkspace` /
    // `restoreWorkspace`, invoked only after `doClearPanes()` resolves). Any
    // load already in flight at this point captured the OLD epoch and
    // discards itself on resolve (see `useFileSession.loadFile`); the
    // restore's own loads start after this line and capture the NEW epoch,
    // so they are correctly NOT discarded.
    bumpWorkspaceEpoch();
    bus.emit('workspace:before-reset', undefined);
    // Arm the backend autosave switch-suppression window before tearing sessions
    // down. This is the single common teardown for every workspace transition
    // (new / open / switch), so one call here covers them all. It is the earliest
    // backend-visible teardown step: session closes are per-session commands the
    // flusher can't distinguish from ordinary churn, and there is no bulk/switch
    // command to hang the signal on. The window is cleared when the restore
    // re-caches the envelope (or auto-expires), so a failed `beginWorkspaceSwitch`
    // only degrades to the pre-existing behaviour — never a stuck-off autosave.
    await beginWorkspaceSwitch().catch(e =>
      console.warn('[useWorkspace] Failed to arm switch-suppression window:', e));
    // Single common teardown for every workspace transition (new/open/switch):
    // clear the workspace analysis store before sessions are closed, while
    // the switch-suppression window armed above is still covering a backend
    // flush that might otherwise write an empty analyses.json mid-teardown.
    await setWorkspaceAnalyses([]).catch(e =>
      console.warn('[useWorkspace] Failed to clear workspace analyses:', e));
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
    const io: RestoreIo = { loadFile, scheduleAutoRun, setWorkspaceAnalyses };
    const plan = planExplicitOpen(result.sessions);
    const warnings = await restoreWorkspace(
      {
        workspaceName: result.workspaceName,
        filePath: path,
        sessionData: result.sessionData,
        editorTabs: result.editorTabs,
        layout: result.layout,
        analyses: result.analyses,
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

  // --- Transitions (new / open / switch) ---
  //
  // These execute immediately regardless of the dirty flag — there is no
  // blocking "save changes?" prompt. Durability is guaranteed instead by
  // `doAutoSave()` running before `doClearPanes()` in the 'switch' case
  // below; that ordering is load-bearing and must not change.

  const runTransition = useCallback(async (
    action: { type: 'new' } | { type: 'open'; path: string } | { type: 'switch'; targetId: string },
  ) => {
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
        // Auto-save current workspace state before switching — this is the
        // durability guarantee that replaced the save-changes prompt. Must
        // run BEFORE doClearPanes() tears the current workspace's sessions
        // down; see doAutoSave's own comment for why the ordering matters.
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

  // --- Public actions ---

  const newWorkspace = useCallback(() => {
    void runTransition({ type: 'new' });
  }, [runTransition]);

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
    void runTransition({ type: 'open', path: resolvedPath });
  }, [runTransition]);

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
    void runTransition({ type: 'switch', targetId });
  }, [runTransition]);

  return {
    newWorkspace,
    openWorkspace,
    saveWorkspace,
    saveWorkspaceAs,
    closeWorkspace,
    switchWorkspace,
  };
}
