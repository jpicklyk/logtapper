import { useMemo, useCallback, useRef, type ReactNode } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { SessionProvider } from './SessionContext';
import { useSessionCoreCtx, useSessionPaneCtx } from './SessionContext';
import { saveLiveCapture } from '../bridge/commands';
import { basename } from '../utils';
import { ViewerProvider } from './ViewerContext';

export { ThemeProvider, useTheme } from './ThemeContext';
export type { ThemeMode, ResolvedTheme } from './ThemeContext';
import { PipelineProvider, usePipelineContext } from './PipelineContext';
import { TrackerProvider } from './TrackerContext';
import { ActionsProvider, trackMutations, type ActionsContextValue } from './ActionsContext';
import { MarketplaceProvider } from './MarketplaceContext';
import { WorkspaceProvider, useWorkspaceIdentity, useWorkspaceContext } from './WorkspaceContext';
import { SavePromptDialog } from '../ui/SavePromptDialog';
import { useCacheManager, useDataSourceRegistry } from '../cache';
import { useLogViewer } from '../hooks/useLogViewer';
import { useSettings } from '../hooks/useSettings';
import { useWorkspace } from '../hooks/useWorkspace';
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

  const pipelineCtx = usePipelineContext();
  const { activeProcessorIds, dispatch: pipelineDispatch } = pipelineCtx;
  const activeProcessorIdsRef = useRef(activeProcessorIds);
  activeProcessorIdsRef.current = activeProcessorIds;

  // Pipeline chain mutations — thin wrappers around dispatch, stable via useCallback.
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

  // Keep a ref so setActiveLogPane can read the current map without being
  // recreated every time paneSessionMap changes (which would invalidate
  // the entire ActionsContext useMemo on every session load/close).
  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;

  // Refs for save callbacks — reads from narrow contexts without subscribing to progress.
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
  // Empty dep array — reads paneSessionMap via ref so the callback never needs
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
    } else {
      // Static file / editor tab: emit bus event for the focused EditorTab to handle
      bus.emit('file:save-request', undefined);
    }
  }, []);

  const saveFileAs = useCallback(async () => {
    bus.emit('file:save-as-request', undefined);
  }, []);

  const exportSession = useCallback(() => {
    bus.emit('layout:export-session-requested', undefined);
  }, []);

  // Close all open sessions (for workspace new/open transitions).
  const closeAllSessions = useCallback(async () => {
    const entries = [...paneSessionMapRef.current.entries()];
    for (const [paneId] of entries) {
      await logViewer.closeSession(paneId);
    }
  }, [logViewer.closeSession]);

  const workspace = useWorkspace(closeAllSessions, logViewer.loadFile);
  const { markDirty } = useWorkspaceContext();

  // Build raw actions, then wrap mutations with automatic dirty tracking.
  const rawActions = useMemo<Partial<ActionsContextValue>>(() => ({
    // --- Workspace mutations (auto-tracked via trackMutations) ---
    loadFile: logViewer.loadFile,
    startStream: (deviceId?: string) => logViewer.startStream(
      deviceId, undefined, activeProcessorIdsRef.current, settingsRef.current.streamBackendLineMax,
    ),
    closeSession: logViewer.closeSession,
    addToChain,
    addPackToChain,
    removeFromChain,
    reorderChain,
    toggleChainEnabled,
    newWorkspace: workspace.newWorkspace,
    openWorkspace: workspace.openWorkspace,
    saveWorkspace: workspace.saveWorkspace,
    saveWorkspaceAs: workspace.saveWorkspaceAs,

    // --- View actions (not tracked) ---
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
  }), [logViewer.loadFile, logViewer.startStream, logViewer.stopStream, logViewer.closeSession,
       logViewer.jumpToLine, logViewer.jumpToMatch,
       logViewer.handleSearch, logViewer.setStreamFilter, logViewer.cancelStreamFilter,
       logViewer.setEffectiveLineNums,
       addToChain, addPackToChain, removeFromChain, reorderChain, toggleChainEnabled,
       openFileDialog, openInEditorDialog, saveFile, saveFileAs, exportSession,
       workspace.newWorkspace, workspace.openWorkspace, workspace.saveWorkspace, workspace.saveWorkspaceAs]);

  // Wrap mutation actions with automatic dirty tracking — the single enforcement point.
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
        workspaceName={workspaceIdentity.name}
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
  usePipelineRunning,
  usePipelineRunningForSession,
  usePipelineResults,
  usePipelineResultsForSession,
  usePipelineProgressForSession,
  usePipelineErrorForSession,
  useProcessors,
  useTrackerTransitions,
  useViewerActions,
  usePipelineActions,
  useTrackerActions,
  useProcessorId,
  useSearchQuery,
  useStreamFilter,
  useSetSessionFilter,
  usePipelineProgress,
  usePipelineError,
  useTotalLines,
  usePendingUpdateCount,
  usePendingUpdates,
  useMarketplaceSources,
  useWorkspaceActions,
} from './selectors';

// Re-export workspace hooks
export { useWorkspaceIdentity } from './WorkspaceContext';
export { useWorkspaceContext } from './WorkspaceContext';

// Re-export types
export type { IndexingProgress, FilterState } from './SessionContext';
export type { WorkspaceContextValue } from './WorkspaceContext';
