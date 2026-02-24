import { useMemo, type ReactNode } from 'react';
import { SessionProvider } from './SessionContext';
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
  const logViewer = useLogViewer(cacheManager, registry);

  const actions = useMemo<Partial<ActionsContextValue>>(() => ({
    loadFile: logViewer.loadFile,
    startStream: (deviceId?: string) => logViewer.startStream(deviceId),
    stopStream: logViewer.stopStream,
    closeSession: logViewer.closeSession,
    jumpToLine: logViewer.jumpToLine,
    setSearch: logViewer.handleSearch,
    openTab: (type: string) => { bus.emit('layout:open-tab', { type }); },
  }), [logViewer.loadFile, logViewer.startStream, logViewer.stopStream,
       logViewer.closeSession, logViewer.jumpToLine, logViewer.handleSearch]);

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
  useIsStreaming,
  useIsLoading,
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
