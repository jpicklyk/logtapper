import type { ReactNode } from 'react';
import { SessionProvider } from './SessionContext';
import { ViewerProvider } from './ViewerContext';
import { PipelineProvider } from './PipelineContext';
import { TrackerProvider } from './TrackerContext';
import { ActionsProvider } from './ActionsContext';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ViewerProvider>
        <PipelineProvider>
          <TrackerProvider>
            <ActionsProvider>
              {children}
            </ActionsProvider>
          </TrackerProvider>
        </PipelineProvider>
      </ViewerProvider>
    </SessionProvider>
  );
}

// Re-export context hooks for convenience
export { useSessionContext } from './SessionContext';
export { useViewerContext } from './ViewerContext';
export { usePipelineContext } from './PipelineContext';
export { useTrackerContext } from './TrackerContext';
export { useActionsContext } from './ActionsContext';

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
} from './selectors';

// Re-export types
export type { IndexingProgress } from './SessionContext';
