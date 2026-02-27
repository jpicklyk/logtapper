import type { LoadResult, SearchQuery, SearchSummary, ProcessorSummary, PipelineRunSummary } from '../bridge/types';
import { useSessionContext, type IndexingProgress } from './SessionContext';
import { useViewerContext } from './ViewerContext';
import { usePipelineContext } from './PipelineContext';
import { useTrackerContext } from './TrackerContext';
import { useActionsContext } from './ActionsContext';

// ---------------------------------------------------------------------------
// Session selectors
// ---------------------------------------------------------------------------

/** Returns the session for the currently focused pane. */
export function useFocusedSession(): LoadResult | null {
  const { sessions, paneSessionMap, focusedPaneId } = useSessionContext();
  if (!focusedPaneId) return null;
  const sessionId = paneSessionMap.get(focusedPaneId);
  if (!sessionId) return null;
  return sessions.get(sessionId) ?? null;
}

/** Returns the session for a specific pane (for per-pane rendering). */
export function useSessionForPane(paneId: string | null): LoadResult | null {
  const { sessions, paneSessionMap } = useSessionContext();
  if (!paneId) return null;
  const sessionId = paneSessionMap.get(paneId);
  if (!sessionId) return null;
  return sessions.get(sessionId) ?? null;
}

export function useFocusedPaneId(): string | null {
  return useSessionContext().focusedPaneId;
}

export function useIndexingProgress(sessionId: string | null): IndexingProgress | null {
  const { indexingProgressBySession } = useSessionContext();
  if (!sessionId) return null;
  return indexingProgressBySession.get(sessionId) ?? null;
}

/** Backward-compat alias — returns the focused session. */
export function useSession(): LoadResult | null {
  return useFocusedSession();
}

export function useIsStreaming(): boolean {
  const { streamingSessionIds, paneSessionMap, focusedPaneId } = useSessionContext();
  if (!focusedPaneId) return false;
  const sessionId = paneSessionMap.get(focusedPaneId);
  if (!sessionId) return false;
  return streamingSessionIds.has(sessionId);
}

export function useIsStreamingForPane(paneId: string | null): boolean {
  const { streamingSessionIds, paneSessionMap } = useSessionContext();
  if (!paneId) return false;
  const sessionId = paneSessionMap.get(paneId);
  if (!sessionId) return false;
  return streamingSessionIds.has(sessionId);
}

export function useIsLoading(): boolean {
  const { loadingPaneIds, focusedPaneId } = useSessionContext();
  if (!focusedPaneId) return false;
  return loadingPaneIds.has(focusedPaneId);
}

/** Per-pane loading state — for use in components that render a specific pane. */
export function useIsLoadingForPane(paneId: string): boolean {
  const { loadingPaneIds } = useSessionContext();
  return loadingPaneIds.has(paneId);
}

export function useSessionError(): string | null {
  const { errorByPane, focusedPaneId } = useSessionContext();
  if (!focusedPaneId) return null;
  return errorByPane.get(focusedPaneId) ?? null;
}

// ---------------------------------------------------------------------------
// Viewer selectors
// ---------------------------------------------------------------------------

export function useSearch(): { query: SearchQuery | null; summary: SearchSummary | null; matchIndex: number } {
  const { search, searchSummary, currentMatchIndex } = useViewerContext();
  return { query: search, summary: searchSummary, matchIndex: currentMatchIndex };
}

export function useScrollTarget(): { lineNum: number | null; seq: number; paneId: string | null } {
  const { scrollToLine, jumpSeq, jumpPaneId } = useViewerContext();
  return { lineNum: scrollToLine, seq: jumpSeq, paneId: jumpPaneId };
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

export function usePipelineResults(): { results: PipelineRunSummary[]; runCount: number } {
  const { lastResults, runCount } = usePipelineContext();
  return { results: lastResults, runCount };
}

export function useProcessors(): ProcessorSummary[] {
  return usePipelineContext().processors;
}

// ---------------------------------------------------------------------------
// Tracker selectors
// ---------------------------------------------------------------------------

// Module-level stable empty references avoid a new object on every render
// when there is no data for the focused session.
const EMPTY_TRACKER_SET = new Set<number>();
const EMPTY_TRACKER_MAP = new Map<number, string[]>();

export function useTrackerTransitions(): {
  allLineNums: Set<number>;
  byLine: Map<number, string[]>;
} {
  const { dataBySession } = useTrackerContext();
  const focused = useFocusedSession();
  const data = focused ? dataBySession[focused.sessionId] : undefined;
  return {
    allLineNums: data?.allLineNums ?? EMPTY_TRACKER_SET,
    byLine: data?.byLine ?? EMPTY_TRACKER_MAP,
  };
}

// ---------------------------------------------------------------------------
// Action selectors
// ---------------------------------------------------------------------------

export function useViewerActions() {
  const { loadFile, openFileDialog, startStream, stopStream, closeSession,
          jumpToLine, jumpToMatch, setSearch, setStreamFilter, cancelStreamFilter,
          openTab, setFocusedPane } = useActionsContext();
  return { loadFile, openFileDialog, startStream, stopStream, closeSession,
           jumpToLine, jumpToMatch, setSearch, setStreamFilter, cancelStreamFilter,
           openTab, setFocusedPane };
}

export function usePipelineActions() {
  const { runPipeline, stopPipeline, clearResults, installProcessor,
          removeProcessor, toggleProcessor } = useActionsContext();
  return { runPipeline, stopPipeline, clearResults, installProcessor,
           removeProcessor, toggleProcessor };
}

export function useTrackerActions() {
  // Tracker actions will be added when tracker orchestration is implemented.
  return {};
}

// ---------------------------------------------------------------------------
// Additional narrow selectors
// ---------------------------------------------------------------------------

export function useProcessorId(): string | null {
  return useViewerContext().processorId;
}

export function useStreamFilter(paneId: string): {
  value: string;
  scanning: boolean;
  filteredLineNums: number[] | null;
  parseError: string | null;
} {
  const { filterStateBySession, paneSessionMap } = useSessionContext();
  const sessionId = paneSessionMap.get(paneId);
  const state = sessionId ? filterStateBySession.get(sessionId) : undefined;
  return {
    value: state?.streamFilter ?? '',
    scanning: state?.filterScanning ?? false,
    filteredLineNums: state?.filteredLineNums ?? null,
    parseError: state?.filterParseError ?? null,
  };
}

export function useSearchQuery(): SearchQuery | null {
  return useViewerContext().search;
}

export function usePipelineProgress(): { current: number; total: number } | null {
  return usePipelineContext().progress;
}

export function usePipelineError(): string | null {
  return usePipelineContext().error;
}

export function useTotalLines(): number {
  return useFocusedSession()?.totalLines ?? 0;
}
