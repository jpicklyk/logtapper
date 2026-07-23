import { useMemo, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { SessionProvider } from './SessionContext';
import { useSessionCoreCtx, useSessionPaneCtx } from './SessionContext';
import { saveLiveCapture, loadProcessorYaml, uninstallProcessor,
  loadProcessorFromFile as bridgeLoadProcessorFromFile,
  setFileAssociation, openDefaultAppsSettings,
  startMcpBridge, stopMcpBridge, exportAllSessions,
  syncWorkspaceEnvelope,
} from '../bridge/commands';
import { basename, dirname } from '../utils';
import { ViewerProvider } from './ViewerContext';

export { ThemeProvider, useTheme } from './ThemeContext';
export type { ThemeMode, ResolvedTheme } from './ThemeContext';
import { PipelineProvider, usePipelineChainCtx } from './PipelineContext';
import { TrackerProvider } from './TrackerContext';
import { ActionsProvider, trackMutations, type ActionsContextValue } from './ActionsContext';
import { MarketplaceProvider } from './MarketplaceContext';
import { WorkspaceProvider, useWorkspaceIdentity, useWorkspaceContext } from './WorkspaceContext';
import { SavePromptDialog } from '../ui/SavePromptDialog';
import { useCacheManager, useDataSourceRegistry } from '../cache';
import { useLogViewer } from '../hooks/useLogViewer';
import { usePipeline, type PipelineActions } from '../hooks/usePipeline';
import { useSettings } from '../hooks/useSettings';
import { useWorkspace } from '../hooks/useWorkspace';
import { useWorkspaceAutoSave } from '../hooks/useWorkspaceAutoSave';
import { useAppExitSave } from '../hooks/useAppExitSave';
import { useStartupRestore } from '../hooks/useStartupRestore';
import { createAutoRunScheduler, type AutoRunScheduler } from '../hooks/workspace/autoRunScheduler';
import type { AppStateFile } from '../bridge/types';
import { collectEditorTabsForSave, buildAppStatePayload } from '../hooks/workspace/workspacePersistence';
import { STORAGE_KEY } from '../hooks/workspace/workspaceTypes';
import { storageGetJSON } from '../utils';
import { bus } from '../events/bus';

/**
 * Inner component that has access to context setters (inside providers)
 * and cache (from CacheProvider above). Instantiates domain hooks and
 * wires their actions into ActionsProvider.
 */
function HookWiring({ children }: { children: ReactNode }) {
  const cacheManager = useCacheManager();
  const registry = useDataSourceRegistry();
  const sessionCore = useSessionCoreCtx();
  const sessionPane = useSessionPaneCtx();
  const { paneSessionMap } = sessionCore;
  const logViewer = useLogViewer(cacheManager, registry);
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const pipelineChainCtx = usePipelineChainCtx();
  const { activeProcessorIds, pipelineChain, disabledChainIds, dispatch: pipelineDispatch } = pipelineChainCtx;
  const activeProcessorIdsRef = useRef(activeProcessorIds);
  activeProcessorIdsRef.current = activeProcessorIds;
  const pipelineChainRef = useRef(pipelineChain);
  pipelineChainRef.current = pipelineChain;
  const disabledChainIdsRef = useRef(disabledChainIds);
  disabledChainIdsRef.current = disabledChainIds;

  const getPipelineChain = useCallback(() => pipelineChainRef.current, []);
  const getDisabledChainIds = useCallback(() => disabledChainIdsRef.current, []);

  // Pipeline chain mutations â thin wrappers around dispatch, stable via useCallback.
  const addToChain = useCallback((id: string) => {
    pipelineDispatch({ type: 'chain:add', id });
  }, [pipelineDispatch]);
  const addPackToChain = useCallback((processorIds: string[]) => {
    pipelineDispatch({ type: 'chain:add-pack', processorIds });
  }, [pipelineDispatch]);
  const removeFromChain = useCallback((id: string) => {
    pipelineDispatch({ type: 'chain:remove', id });
  }, [pipelineDispatch]);
  const reorderChain = useCallback((fromIndex: number, toIndex: number) => {
    pipelineDispatch({ type: 'chain:reorder', fromIndex, toIndex });
  }, [pipelineDispatch]);
  const toggleChainEnabled = useCallback((id: string) => {
    pipelineDispatch({ type: 'chain:toggle-enabled', id });
  }, [pipelineDispatch]);

  // Processor library mutations
  const installProcessor = useCallback(async (yaml: string) => {
    pipelineDispatch({ type: 'error:clear' });
    try {
      const processor = await loadProcessorYaml(yaml);
      pipelineDispatch({ type: 'processor:installed', processor });
    } catch (e) {
      pipelineDispatch({ type: 'error:set', error: String(e) });
      throw e;
    }
  }, [pipelineDispatch]);

  const removeProcessor = useCallback(async (id: string) => {
    try {
      await uninstallProcessor(id);
      pipelineDispatch({ type: 'processor:removed', id });
    } catch (e) {
      pipelineDispatch({ type: 'error:set', error: String(e) });
    }
  }, [pipelineDispatch]);

  const loadProcessorFromFile = useCallback(async (filePath: string) => {
    pipelineDispatch({ type: 'error:clear' });
    try {
      const processor = await bridgeLoadProcessorFromFile(filePath);
      pipelineDispatch({ type: 'processor:installed', processor });
      return processor;
    } catch (e) {
      pipelineDispatch({ type: 'error:set', error: String(e) });
      throw e;
    }
  }, [pipelineDispatch]);

  // Keep a ref so setActiveLogPane can read the current map without being
  // recreated every time paneSessionMap changes (which would invalidate
  // the entire ActionsContext useMemo on every session load/close).
  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;

  // Refs for save callbacks â reads from narrow contexts without subscribing to progress.
  const sessionCoreRef = useRef(sessionCore);
  sessionCoreRef.current = sessionCore;
  const sessionPaneRef = useRef(sessionPane);
  sessionPaneRef.current = sessionPane;

  const openWithFilters = useCallback(async (filters: { name: string; extensions: string[] }[]) => {
    const selected = await open({ multiple: false, filters });
    if (typeof selected === 'string') {
      await logViewer.loadFile(selected);
    }
  }, [logViewer.loadFile]);

  const openFileDialog = useCallback(
    () => openWithFilters([
      { name: 'Log Files', extensions: ['log', 'txt', 'zip', 'gz', 'lts'] },
      { name: 'All Files', extensions: ['*'] },
    ]),
    [openWithFilters],
  );

  const openInEditorDialog = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: 'Text Files', extensions: ['yaml', 'yml', 'md', 'txt', 'json', 'log'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (typeof selected === 'string') {
      const filename = basename(selected);
      bus.emit('layout:open-tab', { type: 'editor', label: filename, filePath: selected });
    }
  }, []);

  // All focus changes go through the bus so SessionContext and WorkspaceLayout
  // both update from a single emission point.
  // Empty dep array â reads paneSessionMap via ref so the callback never needs
  // to be recreated, keeping ActionsContext stable across session changes.
  const setActiveLogPane = useCallback((paneId: string) => {
    const sessionId = paneSessionMapRef.current.get(paneId) ?? null;
    bus.emit('session:focused', { sessionId, paneId });
  }, []);

  const setActivePane = useCallback((paneId: string) => {
    bus.emit('pane:activated', { paneId });
  }, []);

  const saveFile = useCallback(async () => {
    const { streamingSessionIds, paneSessionMap: psMap } = sessionCoreRef.current;
    const { activePaneId } = sessionPaneRef.current;
    const sessionId = activePaneId ? (psMap.get(activePaneId) ?? null) : null;
    if (sessionId && streamingSessionIds.has(sessionId)) {
      // Streaming session: prompt for output path and save live capture
      const outputPath = await save({
        filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }],
      });
      if (typeof outputPath === 'string') {
        await saveLiveCapture(sessionId, outputPath);
        bus.emit('stream:saved', { sessionId, path: outputPath });
      }
    } else if (activePaneId) {
      // Static file / editor tab: emit targeted save event for the specific pane
      bus.emit('file:save-request', { paneId: activePaneId });
    }
  }, []);

  const saveFileAs = useCallback(async () => {
    const { activePaneId } = sessionPaneRef.current;
    if (activePaneId) {
      bus.emit('file:save-as-request', { paneId: activePaneId });
    }
  }, []);

  const exportSession = useCallback(() => {
    bus.emit('layout:export-session-requested', undefined);
  }, []);

  // Close all open sessions (for workspace new/open transitions).
  const closeAllSessions = useCallback(async () => {
    const paneIds = [...paneSessionMapRef.current.keys()];
    await Promise.all(paneIds.map(paneId => logViewer.closeSession(paneId)));
  }, [logViewer.closeSession]);

  // Default directory for file dialogs: directory of the focused session's source file.
  const getDefaultDir = useCallback((): string | undefined => {
    const { sessions, paneSessionMap: psMap } = sessionCoreRef.current;
    const { activeLogPaneId: paneId } = sessionPaneRef.current;
    const sessionId = paneId ? psMap.get(paneId) : undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    return session?.filePath ? dirname(session.filePath) : undefined;
  }, []);

  // Auto-run scheduler (Q2): shared by the `.ltw` restore core (via useWorkspace)
  // and useWorkspaceRestore (the `.lts` path, via usePipeline). Created once
  // (construction is side-effect-free; it registers bus handlers only when a
  // session must wait on indexing). pipeline.run is kept fresh via a ref that is
  // populated right after usePipeline below — scheduleAutoRun is only ever
  // invoked during an async restore, long after that assignment.
  const runRef = useRef<PipelineActions['run'] | null>(null);
  const autoRunSchedulerRef = useRef<AutoRunScheduler | null>(null);
  if (!autoRunSchedulerRef.current) {
    autoRunSchedulerRef.current = createAutoRunScheduler(
      {
        on: (e, h) => bus.on(e, h),
        off: (e, h) => bus.off(e, h),
      },
      (sessionId, chain, disabled) => {
        void runRef.current?.(sessionId, false, { chain, disabled }).catch(() => {});
      },
    );
  }
  const scheduleAutoRun = useCallback(
    (sessionId: string, isIndexing: boolean | undefined, chain: string[], disabled: string[]) => {
      autoRunSchedulerRef.current?.schedule(sessionId, isIndexing, chain, disabled);
    },
    [],
  );

  const pipeline = usePipeline(scheduleAutoRun);
  runRef.current = pipeline.run;

  useEffect(() => () => { autoRunSchedulerRef.current?.dispose(); }, []);
  // Q5-safe lifecycle: forget a session's auto-run record on close so reopening
  // it (even with a recurring deterministic id) schedules again.
  useEffect(() => {
    const onClosed = (e: { sessionId: string }) => { autoRunSchedulerRef.current?.forget(e.sessionId); };
    bus.on('session:closed', onClosed);
    return () => { bus.off('session:closed', onClosed); };
  }, []);

  const workspace = useWorkspace(closeAllSessions, logViewer.loadFile, scheduleAutoRun, getDefaultDir, getPipelineChain, getDisabledChainIds);
  const wsCtx = useWorkspaceContext();
  const { markDirty } = wsCtx;

  // Stable ref to workspace context â lets buildAutoSavePayload read the
  // latest state without being recreated on every render.
  const wsCtxRef = useRef(wsCtx);
  wsCtxRef.current = wsCtx;

  const buildAutoSavePayload = useCallback(() => {
    const active = wsCtxRef.current.activeWorkspace;
    if (!active) return null;
    return {
      workspaceId: active.id,
      workspaceName: active.name,
      filePath: active.filePath,
      editorTabs: collectEditorTabsForSave(),
      layout: storageGetJSON<unknown>(STORAGE_KEY, null),
      pipelineChain: getPipelineChain(),
      disabledChainIds: getDisabledChainIds(),
    };
  }, [getPipelineChain, getDisabledChainIds]);

  useWorkspaceAutoSave(buildAutoSavePayload);

  // Q4 — keep the backend workspace envelope's identity fields fresh when the
  // ACTIVE workspace is renamed or its path changes (save-as / recordAutoSave).
  // Such changes don't go through a save command, so nothing else refreshes the
  // cached name/ltwPath. Runs post-commit (fresh values) and deliberately skips
  // workspace *switches* (id change) — those are covered by doLoadWorkspace's
  // own end-of-restore envelope push.
  const prevIdentityRef = useRef<{ id: string | null; name: string | null; filePath: string | null }>(
    { id: null, name: null, filePath: null },
  );
  const activeWs = wsCtx.activeWorkspace;
  useEffect(() => {
    const prev = prevIdentityRef.current;
    const curr = { id: activeWs?.id ?? null, name: activeWs?.name ?? null, filePath: activeWs?.filePath ?? null };
    prevIdentityRef.current = curr;
    if (!wsCtxRef.current.hydrated) return;
    // Only refresh for an in-place identity change on the same active workspace.
    if (curr.id === null || prev.id !== curr.id) return;
    if (prev.name === curr.name && prev.filePath === curr.filePath) return;
    const payload = buildAutoSavePayload();
    if (!payload) return;
    syncWorkspaceEnvelope({
      workspaceId: payload.workspaceId,
      workspaceName: payload.workspaceName,
      ltwPath: payload.filePath,
      editorTabs: payload.editorTabs,
      layout: payload.layout,
      pipelineChain: payload.pipelineChain,
      disabledChainIds: payload.disabledChainIds,
    }).catch((e: unknown) => console.warn('[HookWiring] Envelope identity sync failed:', e));
  }, [activeWs?.id, activeWs?.name, activeWs?.filePath, buildAutoSavePayload]);

  // Build the AppStateFile payload for exit save — reads workspace list from context.
  const getAppStatePayload = useCallback((): AppStateFile => {
    const ctx = wsCtxRef.current;
    return buildAppStatePayload(ctx.workspaces, ctx.activeId);
  }, []);

  useAppExitSave(buildAutoSavePayload, getAppStatePayload);

  // Q2 — single startup restore orchestrator. Replaces the inline localStorage
  // replay that used to live in useFileSession. Awaits Q1 hydration, runs Q3's
  // trust gate, and drives the shared restore core + auto-run scheduler.
  useStartupRestore({
    loadFile: logViewer.loadFile,
    scheduleAutoRun,
    getPipelineChain,
    getDisabledChainIds,
  });

  // Sync fileCacheBudget setting → CacheManager whenever it changes.
  // Kept here (not in AppShell) because this is business logic — wiring a
  // settings value to the cache subsystem — not structural layout concern.
  useEffect(() => {
    cacheManager.setTotalBudget(settings.fileCacheBudget);
  }, [cacheManager, settings.fileCacheBudget]);

  const rawActions = useMemo<Partial<ActionsContextValue>>(() => ({
    // --- Workspace mutations (auto-tracked via trackMutations) ---
    loadFile: logViewer.loadFile,
    startStream: (deviceId?: string) => logViewer.startStream(
      deviceId, undefined, activeProcessorIdsRef.current, settingsRef.current.streamBackendLineMax,
    ),
    closeSession: logViewer.closeSession,
    installProcessor,
    removeProcessor,
    loadProcessorFromFile,
    addToChain,
    addPackToChain,
    removeFromChain,
    reorderChain,
    toggleChainEnabled,
    newWorkspace: workspace.newWorkspace,
    openWorkspace: workspace.openWorkspace,
    saveWorkspace: workspace.saveWorkspace,
    saveWorkspaceAs: workspace.saveWorkspaceAs,
    closeWorkspace: workspace.closeWorkspace,
    switchWorkspace: workspace.switchWorkspace,

    // --- View actions (not tracked) ---
    runPipeline: async () => {
      const sessionId = paneSessionMapRef.current.get(sessionPaneRef.current.activeLogPaneId ?? '') ?? null;
      if (sessionId) await pipeline.run(sessionId);
    },
    stopPipeline: () => {
      const sessionId = paneSessionMapRef.current.get(sessionPaneRef.current.activeLogPaneId ?? '') ?? null;
      if (sessionId) pipeline.stop(sessionId);
    },
    clearResults: () => {
      const sessionId = paneSessionMapRef.current.get(sessionPaneRef.current.activeLogPaneId ?? '') ?? null;
      if (sessionId) pipeline.clearResults(sessionId);
    },
    openFileDialog,
    openInEditorDialog,
    stopStream: logViewer.stopStream,
    jumpToLine: logViewer.jumpToLine,
    jumpToMatch: logViewer.jumpToMatch,
    setSearch: logViewer.handleSearch,
    setStreamFilter: logViewer.setStreamFilter,
    cancelStreamFilter: logViewer.cancelStreamFilter,
    openTab: (type: string) => { bus.emit('layout:open-tab', { type }); },
    setActiveLogPane,
    setActivePane,
    setEffectiveLineNums: logViewer.setEffectiveLineNums,
    saveFile,
    saveFileAs,
    exportSession,
    setFileAssociation,
    openDefaultAppsSettings,
    startMcpBridge,
    stopMcpBridge,
    exportAllSessions,
  }), [logViewer.loadFile, logViewer.startStream, logViewer.stopStream, logViewer.closeSession,
       installProcessor, removeProcessor, loadProcessorFromFile,
       logViewer.jumpToLine, logViewer.jumpToMatch,
       logViewer.handleSearch, logViewer.setStreamFilter, logViewer.cancelStreamFilter,
       logViewer.setEffectiveLineNums,
       addToChain, addPackToChain, removeFromChain, reorderChain, toggleChainEnabled,
       pipeline.run, pipeline.stop, pipeline.clearResults,
       openFileDialog, openInEditorDialog, saveFile, saveFileAs, exportSession,
       workspace.newWorkspace, workspace.openWorkspace, workspace.saveWorkspace, workspace.saveWorkspaceAs,
       workspace.closeWorkspace, workspace.switchWorkspace]);

  // Wrap mutation actions with automatic dirty tracking â the single enforcement point.
  const actions = useMemo(
    () => trackMutations(rawActions, markDirty),
    [rawActions, markDirty],
  );

  const workspaceIdentity = useWorkspaceIdentity();

  return (
    <ActionsProvider actions={actions}>
      {children}
      <SavePromptDialog
        open={workspace.showSavePrompt}
        workspaceName={workspaceIdentity?.name ?? 'Untitled'}
        onResult={workspace.handleSavePromptResult}
      />
    </ActionsProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <MarketplaceProvider>
        <SessionProvider>
          <ViewerProvider>
            <PipelineProvider>
              <TrackerProvider>
                <HookWiring>
                  {children}
                </HookWiring>
              </TrackerProvider>
            </PipelineProvider>
          </ViewerProvider>
        </SessionProvider>
      </MarketplaceProvider>
    </WorkspaceProvider>
  );
}

// Re-export selector hooks
export {
  useSession,
  useFocusedSession,
  useSessionForPane,
  useActiveLogPaneId,
  useIsActiveLogPane,
  useActivePaneId,
  useIsActivePane,
  useIndexingProgress,
  useIsStreaming,
  useIsStreamingForPane,
  useIsLoading,
  useIsLoadingForPane,
  useSessionError,
  useSearch,
  useScrollTarget,
  usePipelineChain,
  useActiveProcessorIds,
  useDisabledChainIds,
  usePipelineGlobalError,
  useProcessors,
  usePacks,
} from './selectors';

export { PINNED_TAIL_IDS } from './PipelineContext';

export {
  useViewerActions,
  useNavigationActions,
  useFileActions,
  usePaneActions,
  useSettingsActions,
  usePipelineActions,
  useTrackerActions,
  useProcessorId,
  useSearchQuery,
  useStreamFilter,
  useSetSessionFilter,
  useTotalLines,
  usePendingUpdateCount,
  usePendingUpdates,
  useMarketplaceSources,
  useWorkspaceActions,
} from './selectors';

// Re-export workspace hooks
export { useWorkspaceIdentity, useWorkspaceList, useActiveWorkspaceId } from './WorkspaceContext';
export { useWorkspaceContext } from './WorkspaceContext';

// Re-export per-session context
export { SessionProviders } from './SessionProviders';
export { SessionDataProvider } from './SessionDataContext';
export { SessionActionsProvider, useSessionActions,
  useSessionBookmarkActions, useSessionAnalysisActions, useSessionWatchActions,
} from './SessionActionsContext';
export {
  useSessionPipelineResults,
  useSessionPipelineRunning,
  useSessionPipelineProgress,
  useSessionPipelineError,
  useSessionTrackerTransitions,
  useSessionTrackerUpdateCounts,
  useSessionFilterState,
  useSessionIndexingProgress,
  useSessionDataId,
} from './SessionDataContext';

// Re-export types
export type { IndexingProgress, FilterState } from './SessionContext';
export type { WorkspaceContextValue } from './WorkspaceContext';
export type { SessionDataContextValue } from './SessionDataContext';
export type { SessionActionsContextValue } from './SessionActionsContext';
