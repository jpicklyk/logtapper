import { useMemo, useCallback, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { SessionProvider } from './SessionContext';
import { useSessionContext } from './SessionContext';
import { ViewerProvider } from './ViewerContext';
import { PipelineProvider } from './PipelineContext';
import { TrackerProvider } from './TrackerContext';
import { ActionsProvider, type ActionsContextValue } from './ActionsContext';
import { useCacheManager, useDataSourceRegistry } from '../cache';
import { useLogViewer } from '../hooks/useLogViewer';
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
  const setFocusedPane = useCallback((paneId: string) => {
    const sessionId = paneSessionMap.get(paneId) ?? null;
    bus.emit('session:focused', { sessionId, paneId });
  }, [paneSessionMap]);

  const actions = useMemo<Partial<ActionsContextValue>>(() => ({
    loadFile: logViewer.loadFile,
    openFileDialog,
    startStream: (deviceId?: string) => logViewer.startStream(deviceId),
    stopStream: logViewer.stopStream,
    closeSession: logViewer.closeSession,
    jumpToLine: logViewer.jumpToLine,
    jumpToMatch: logViewer.jumpToMatch,
    setSearch: logViewer.handleSearch,
    openTab: (type: string) => { bus.emit('layout:open-tab', { type }); },
    setFocusedPane,
  }), [logViewer.loadFile, openFileDialog, logViewer.startStream, logViewer.stopStream,
       logViewer.closeSession, logViewer.jumpToLine, logViewer.jumpToMatch,
       logViewer.handleSearch, setFocusedPane]);

  return (
    <ActionsProvider actions={actions}>
      {children}
    </ActionsProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
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
  usePipelineRunning,
  usePipelineResults,
  useProcessors,
  useTrackerTransitions,
  useViewerActions,
  usePipelineActions,
  useTrackerActions,
  useProcessorId,
  useSearchQuery,
  usePipelineProgress,
  usePipelineError,
  useTotalLines,
} from './selectors';

// Re-export types
export type { IndexingProgress } from './SessionContext';
