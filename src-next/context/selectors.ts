import { useMemo } from 'react';
import type { LoadResult, SearchQuery, SearchSummary, ProcessorSummary, PipelineRunSummary, Source, UpdateAvailable } from '../bridge/types';
import { useSessionCoreCtx, useSessionPaneCtx, useSessionProgressCtx, type IndexingProgress } from './SessionContext';
import { useSearchCtx, useScrollCtx, useProcessorViewCtx } from './ViewerContext';
import { usePipelineContext, type SessionPipelineState } from './PipelineContext';
import { useTrackerContext } from './TrackerContext';
import { useActionsContext } from './ActionsContext';
import { useMarketplaceContext } from './MarketplaceContext';

// ---------------------------------------------------------------------------
// Session selectors
// ---------------------------------------------------------------------------

/** Returns the session for the currently focused log pane. */
export function useFocusedSession(): LoadResult | null {
  const { sessions, paneSessionMap } = useSessionCoreCtx();
  const { activeLogPaneId } = useSessionPaneCtx();
  if (!activeLogPaneId) return null;
  const sessionId = paneSessionMap.get(activeLogPaneId);
  if (!sessionId) {
    if (sessions.size > 0) {
      console.warn('[useFocusedSession] paneSessionMap miss — activeLogPaneId not mapped', {
        activeLogPaneId,
        paneMap: [...paneSessionMap.entries()],
        sessionIds: [...sessions.keys()],
      });
    }
    return null;
  }
  return sessions.get(sessionId) ?? null;
}

/** Returns the session for a specific pane (for per-pane rendering). */
export function useSessionForPane(paneId: string | null): LoadResult | null {
  const { sessions, paneSessionMap } = useSessionCoreCtx();
  if (!paneId) return null;
  const sessionId = paneSessionMap.get(paneId);
  if (!sessionId) return null;
  return sessions.get(sessionId) ?? null;
}

export function useActiveLogPaneId(): string | null {
  return useSessionPaneCtx().activeLogPaneId;
}

/** Returns true only for the pane that is the active log pane — avoids
 *  re-rendering sibling PaneContent instances when focus changes. */
export function useIsActiveLogPane(paneId: string): boolean {
  return useSessionPaneCtx().activeLogPaneId === paneId;
}

export function useActivePaneId(): string | null {
  return useSessionPaneCtx().activePaneId;
}

export function useIsActivePane(paneId: string): boolean {
  return useSessionPaneCtx().activePaneId === paneId;
}

export function useIndexingProgress(sessionId: string | null): IndexingProgress | null {
  const { indexingProgressBySession } = useSessionProgressCtx();
  if (!sessionId) return null;
  return indexingProgressBySession.get(sessionId) ?? null;
}

/** Backward-compat alias — returns the focused session. */
export function useSession(): LoadResult | null {
  return useFocusedSession();
}

export function useIsStreaming(): boolean {
  const { streamingSessionIds, paneSessionMap } = useSessionCoreCtx();
  const { activeLogPaneId } = useSessionPaneCtx();
  if (!activeLogPaneId) return false;
  const sessionId = paneSessionMap.get(activeLogPaneId);
  if (!sessionId) return false;
  return streamingSessionIds.has(sessionId);
}

export function useIsStreamingForPane(paneId: string | null): boolean {
  const { streamingSessionIds, paneSessionMap } = useSessionCoreCtx();
  if (!paneId) return false;
  const sessionId = paneSessionMap.get(paneId);
  if (!sessionId) return false;
  return streamingSessionIds.has(sessionId);
}

export function useIsLoading(): boolean {
  const { loadingPaneIds } = useSessionCoreCtx();
  const { activeLogPaneId } = useSessionPaneCtx();
  if (!activeLogPaneId) return false;
  return loadingPaneIds.has(activeLogPaneId);
}

/** Per-pane loading state — for use in components that render a specific pane. */
export function useIsLoadingForPane(paneId: string): boolean {
  const { loadingPaneIds } = useSessionCoreCtx();
  return loadingPaneIds.has(paneId);
}

export function useSessionError(): string | null {
  const { errorByPane } = useSessionCoreCtx();
  const { activeLogPaneId } = useSessionPaneCtx();
  if (!activeLogPaneId) return null;
  return errorByPane.get(activeLogPaneId) ?? null;
}

// ---------------------------------------------------------------------------
// Viewer selectors
// ---------------------------------------------------------------------------

export function useSearch(): { query: SearchQuery | null; summary: SearchSummary | null; matchIndex: number } {
  const { search, searchSummary, currentMatchIndex } = useSearchCtx();
  return { query: search, summary: searchSummary, matchIndex: currentMatchIndex };
}

export function useScrollTarget(): { lineNum: number | null; seq: number; paneId: string | null } {
  const { scrollToLine, jumpSeq, jumpPaneId } = useScrollCtx();
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

export function useDisabledChainIds(): string[] {
  return usePipelineContext().disabledChainIds;
}

export function useProcessors(): ProcessorSummary[] {
  return usePipelineContext().processors;
}

// ── Per-session pipeline selectors ──────────────────────────────────────────

const EMPTY_SESSION_PIPELINE: SessionPipelineState = {
  results: [], runCount: 0, running: false, progress: null, error: null,
};

function sessionPipelineState(map: Map<string, SessionPipelineState>, sessionId: string | null): SessionPipelineState {
  if (!sessionId) return EMPTY_SESSION_PIPELINE;
  return map.get(sessionId) ?? EMPTY_SESSION_PIPELINE;
}

/** Per-session results with referential stability. */
export function usePipelineResultsForSession(sessionId: string | null): { results: PipelineRunSummary[]; runCount: number } {
  const { resultsBySession } = usePipelineContext();
  const sessionState = sessionPipelineState(resultsBySession, sessionId);
  return useMemo(
    () => ({ results: sessionState.results, runCount: sessionState.runCount }),
    [sessionState.results, sessionState.runCount],
  );
}

export function usePipelineRunningForSession(sessionId: string | null): boolean {
  const { resultsBySession } = usePipelineContext();
  return sessionPipelineState(resultsBySession, sessionId).running;
}

export function usePipelineProgressForSession(sessionId: string | null): { current: number; total: number } | null {
  const { resultsBySession } = usePipelineContext();
  return sessionPipelineState(resultsBySession, sessionId).progress;
}

export function usePipelineErrorForSession(sessionId: string | null): string | null {
  const { resultsBySession } = usePipelineContext();
  return sessionPipelineState(resultsBySession, sessionId).error;
}

// ── Backward-compat selectors (auto-resolve focused session) ────────────────

export function usePipelineRunning(): boolean {
  const session = useFocusedSession();
  return usePipelineRunningForSession(session?.sessionId ?? null);
}

export function usePipelineResults(): { results: PipelineRunSummary[]; runCount: number } {
  const session = useFocusedSession();
  return usePipelineResultsForSession(session?.sessionId ?? null);
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
  const { loadFile, openFileDialog, openInEditorDialog, startStream, stopStream, closeSession,
          jumpToLine, jumpToMatch, setSearch, setStreamFilter, cancelStreamFilter,
          openTab, setActiveLogPane, setActivePane, setEffectiveLineNums,
          saveFile, saveFileAs, exportSession,
          newWorkspace, openWorkspace, saveWorkspace, saveWorkspaceAs } = useActionsContext();
  return { loadFile, openFileDialog, openInEditorDialog, startStream, stopStream, closeSession,
           jumpToLine, jumpToMatch, setSearch, setStreamFilter, cancelStreamFilter,
           openTab, setActiveLogPane, setActivePane, setEffectiveLineNums,
           saveFile, saveFileAs, exportSession,
           newWorkspace, openWorkspace, saveWorkspace, saveWorkspaceAs };
}

export function useWorkspaceActions() {
  const { newWorkspace, openWorkspace, saveWorkspace, saveWorkspaceAs } = useActionsContext();
  return { newWorkspace, openWorkspace, saveWorkspace, saveWorkspaceAs };
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
// Marketplace selectors
// ---------------------------------------------------------------------------

export function usePendingUpdateCount(): number {
  return useMarketplaceContext().pendingUpdates.length;
}

export function usePendingUpdates(): UpdateAvailable[] {
  return useMarketplaceContext().pendingUpdates;
}

export function useMarketplaceSources(): { sources: Source[]; loading: boolean } {
  const { sources, sourcesLoading } = useMarketplaceContext();
  return useMemo(() => ({ sources, loading: sourcesLoading }), [sources, sourcesLoading]);
}

// ---------------------------------------------------------------------------
// Additional narrow selectors
// ---------------------------------------------------------------------------

export function useProcessorId(): string | null {
  return useProcessorViewCtx().processorId;
}

/** Returns the stable `setSessionFilter` dispatch from SessionContext. */
export function useSetSessionFilter() {
  return useSessionProgressCtx().setSessionFilter;
}

export function useStreamFilter(paneId: string): {
  value: string;
  scanning: boolean;
  filteredLineNums: number[] | null;
  parseError: string | null;
  sectionFilteredLineNums: number[] | null;
} {
  const { paneSessionMap } = useSessionCoreCtx();
  const { filterStateBySession } = useSessionProgressCtx();
  const sessionId = paneSessionMap.get(paneId);
  const state = sessionId ? filterStateBySession.get(sessionId) : undefined;
  return useMemo(() => ({
    value: state?.streamFilter ?? '',
    scanning: state?.filterScanning ?? false,
    filteredLineNums: state?.filteredLineNums ?? null,
    parseError: state?.filterParseError ?? null,
    sectionFilteredLineNums: state?.sectionFilteredLineNums ?? null,
  }), [state]);
}

export function useSearchQuery(): SearchQuery | null {
  return useSearchCtx().search;
}

export function usePipelineProgress(): { current: number; total: number } | null {
  const session = useFocusedSession();
  return usePipelineProgressForSession(session?.sessionId ?? null);
}

export function usePipelineError(): string | null {
  const session = useFocusedSession();
  const { resultsBySession, error: globalError } = usePipelineContext();
  const sessionError = sessionPipelineState(resultsBySession, session?.sessionId ?? null).error;
  // Per-session run errors take priority over global processor install/remove errors
  return sessionError ?? globalError;
}

export function useTotalLines(): number {
  return useFocusedSession()?.totalLines ?? 0;
}
