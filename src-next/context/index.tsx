import { useMemo, useCallback, useRef, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { SessionProvider } from './SessionContext';
import { useSessionContext } from './SessionContext';
import { ViewerProvider } from './ViewerContext';

export { ThemeProvider, useTheme } from './ThemeContext';
export type { ThemeMode, ResolvedTheme } from './ThemeContext';
import { PipelineProvider } from './PipelineContext';
import { TrackerProvider } from './TrackerContext';
import { ActionsProvider, type ActionsContextValue } from './ActionsContext';
import { MarketplaceProvider } from './MarketplaceContext';
import { useCacheManager, useDataSourceRegistry } from '../cache';
import { useLogViewer } from '../hooks/useLogViewer';
import { useSettings } from '../hooks/useSettings';
import { bus } from '../events/bus';

/**
 * Inner component that has access to context setters (inside providers)
 * and cache (from CacheProvider above). Instantiates domain hooks and
 * wires their actions into ActionsProvider.
 */
function HookWiring({ children }: { children: ReactNode }) {
  const cacheManager = useCacheManager();
  const registry = useDataSourceRegistry();
  const { paneSessionMap } = useSessionContext();
  const logViewer = useLogViewer(cacheManager, registry);
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Keep a ref so setFocusedPane can read the current map without being
  // recreated every time paneSessionMap changes (which would invalidate
  // the entire ActionsContext useMemo on every session load/close).
  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;

  const openFileDialog = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: 'Log Files', extensions: ['log', 'txt', 'gz'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (typeof selected === 'string') {
      // loadFile reads focusedPaneId internally; no need to pass it explicitly here
      await logViewer.loadFile(selected);
    }
  }, [logViewer.loadFile]);

  // All focus changes go through the bus so SessionContext and WorkspaceLayout
  // both update from a single emission point.
  // Empty dep array — reads paneSessionMap via ref so the callback never needs
  // to be recreated, keeping ActionsContext stable across session changes.
  const setFocusedPane = useCallback((paneId: string) => {
    const sessionId = paneSessionMapRef.current.get(paneId) ?? null;
    bus.emit('session:focused', { sessionId, paneId });
  }, []);

  const actions = useMemo<Partial<ActionsContextValue>>(() => ({
    loadFile: logViewer.loadFile,
    openFileDialog,
    startStream: (deviceId?: string) => logViewer.startStream(
      deviceId, undefined, undefined, settingsRef.current.streamBackendLineMax,
    ),
    stopStream: logViewer.stopStream,
    closeSession: logViewer.closeSession,
    jumpToLine: logViewer.jumpToLine,
    jumpToMatch: logViewer.jumpToMatch,
    setSearch: logViewer.handleSearch,
    setStreamFilter: logViewer.setStreamFilter,
    cancelStreamFilter: logViewer.cancelStreamFilter,
    openTab: (type: string) => { bus.emit('layout:open-tab', { type }); },
    setFocusedPane,
    setEffectiveLineNums: logViewer.setEffectiveLineNums,
  }), [logViewer.loadFile, openFileDialog, logViewer.startStream, logViewer.stopStream,
       logViewer.closeSession, logViewer.jumpToLine, logViewer.jumpToMatch,
       logViewer.handleSearch, logViewer.setStreamFilter, logViewer.cancelStreamFilter,
       logViewer.setEffectiveLineNums]);

  return (
    <ActionsProvider actions={actions}>
      {children}
    </ActionsProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
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
  );
}

// Re-export selector hooks
export {
  useSession,
  useFocusedSession,
  useSessionForPane,
  useFocusedPaneId,
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
} from './selectors';

// Re-export types
export type { IndexingProgress, FilterState } from './SessionContext';
