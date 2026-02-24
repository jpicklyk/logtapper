import type { LoadResult, SearchQuery, SearchSummary, ProcessorSummary } from '../bridge/types';
import { useSessionContext } from './SessionContext';
import { useViewerContext } from './ViewerContext';
import { usePipelineContext } from './PipelineContext';
import { useTrackerContext } from './TrackerContext';
import { useActionsContext } from './ActionsContext';

// ---------------------------------------------------------------------------
// Session selectors
// ---------------------------------------------------------------------------

export function useSession(): LoadResult | null {
  return useSessionContext().session;
}

export function useIsStreaming(): boolean {
  return useSessionContext().isStreaming;
}

export function useIsLoading(): boolean {
  return useSessionContext().loading;
}

export function useSessionError(): string | null {
  return useSessionContext().error;
}

// ---------------------------------------------------------------------------
// Viewer selectors
// ---------------------------------------------------------------------------

export function useSearch(): { query: SearchQuery | null; summary: SearchSummary | null; matchIndex: number } {
  const { search, searchSummary, currentMatchIndex } = useViewerContext();
  return { query: search, summary: searchSummary, matchIndex: currentMatchIndex };
}

export function useScrollTarget(): { lineNum: number | null; seq: number } {
  const { scrollToLine, jumpSeq } = useViewerContext();
  return { lineNum: scrollToLine, seq: jumpSeq };
}

// ---------------------------------------------------------------------------
// Pipeline selectors
// ---------------------------------------------------------------------------

export function usePipelineChain(): string[] {
  return usePipelineContext().pipelineChain;
}

export function useActiveProcessorIds(): string[] {
  return usePipelineContext().activeProcessorIds;
}

export function usePipelineRunning(): boolean {
  return usePipelineContext().running;
}

export function usePipelineResults(): { results: unknown[]; runCount: number } {
  const { lastResults, runCount } = usePipelineContext();
  return { results: lastResults, runCount };
}

export function useProcessors(): ProcessorSummary[] {
  return usePipelineContext().processors;
}

// ---------------------------------------------------------------------------
// Tracker selectors
// ---------------------------------------------------------------------------

export function useTrackerTransitions(): {
  allLineNums: Set<number>;
  byLine: Map<number, string[]>;
} {
  const { allTransitionLineNums, transitionsByLine } = useTrackerContext();
  return { allLineNums: allTransitionLineNums, byLine: transitionsByLine };
}

// ---------------------------------------------------------------------------
// Action selectors
// ---------------------------------------------------------------------------

export function useViewerActions() {
  const { loadFile, openFileDialog, startStream, stopStream, closeSession,
          jumpToLine, setSearch, openTab } = useActionsContext();
  return { loadFile, openFileDialog, startStream, stopStream, closeSession,
           jumpToLine, setSearch, openTab };
}

export function usePipelineActions() {
  const { runPipeline, stopPipeline, clearResults, installProcessor,
          removeProcessor, toggleProcessor } = useActionsContext();
  return { runPipeline, stopPipeline, clearResults, installProcessor,
           removeProcessor, toggleProcessor };
}

export function useTrackerActions() {
  // Tracker actions will be added when tracker orchestration is implemented.
  // For now, return an empty object to establish the pattern.
  return {};
}
