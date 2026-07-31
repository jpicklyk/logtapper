import { useMemo } from 'react';
import type { LoadResult, ProcessorSummary, PackSummary, Source, UpdateAvailable } from '../bridge/types';
import { useSessionCoreCtx, useSessionPaneCtx, useSessionProgressCtx, type IndexingProgress } from './SessionContext';
import { useScrollCtx, useProcessorViewCtx } from './ViewerContext';
import { usePipelineLibraryCtx, usePipelineChainCtx, type SessionChainState } from './PipelineContext';
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
  if (!sessionId) return null;
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

export function useScrollTarget(): { lineNum: number | null; seq: number; paneId: string | null } {
  const { scrollToLine, jumpSeq, jumpPaneId } = useScrollCtx();
  return { lineNum: scrollToLine, seq: jumpSeq, paneId: jumpPaneId };
}

// ---------------------------------------------------------------------------
// Pipeline selectors
// ---------------------------------------------------------------------------

/**
 * A session's own chain state. Pass the session whose chain you mean — omitting
 * it (or passing null) reads the shared default, which is only correct for
 * surfaces with genuinely no session context (e.g. startup, workspace save).
 */
export function useSessionChainState(sessionId: string | null): SessionChainState {
  const { chainBySession, defaultChain } = usePipelineChainCtx();
  return useMemo(
    () => (sessionId ? (chainBySession.get(sessionId) ?? defaultChain) : defaultChain),
    [chainBySession, defaultChain, sessionId],
  );
}

export function usePipelineChain(sessionId: string | null): string[] {
  return useSessionChainState(sessionId).chain;
}

export function useActiveProcessorIds(sessionId: string | null): string[] {
  return useSessionChainState(sessionId).active;
}

/** Global error from processor install/remove operations (not per-session run errors). */
export function usePipelineGlobalError(): string | null {
  return usePipelineLibraryCtx().error;
}

export function useDisabledChainIds(sessionId: string | null): string[] {
  return useSessionChainState(sessionId).disabled;
}

export function useProcessors(): ProcessorSummary[] {
  return usePipelineLibraryCtx().processors;
}

export function usePacks(): PackSummary[] {
  return usePipelineLibraryCtx().packs;
}

// ---------------------------------------------------------------------------
// Action selectors
// ---------------------------------------------------------------------------

export function useNavigationActions() {
  const { jumpToLine } = useActionsContext();
  return useMemo(() => ({ jumpToLine }), [jumpToLine]);
}

export function useFileActions() {
  const { loadFile, openFileDialog, openInEditorDialog, saveFile, saveFileAs,
          exportSession, exportAllSessions, startStream, stopStream, closeSession,
        } = useActionsContext();
  return useMemo(
    () => ({ loadFile, openFileDialog, openInEditorDialog, saveFile, saveFileAs,
             exportSession, exportAllSessions, startStream, stopStream, closeSession }),
    [loadFile, openFileDialog, openInEditorDialog, saveFile, saveFileAs,
     exportSession, exportAllSessions, startStream, stopStream, closeSession],
  );
}

export function usePaneActions() {
  const { setActiveLogPane, setActivePane, setStreamFilter, cancelStreamFilter,
          setTimeFilter, openTab } = useActionsContext();
  return useMemo(
    () => ({ setActiveLogPane, setActivePane, setStreamFilter, cancelStreamFilter, setTimeFilter, openTab }),
    [setActiveLogPane, setActivePane, setStreamFilter, cancelStreamFilter, setTimeFilter, openTab],
  );
}

export function useSettingsActions() {
  const { startMcpBridge, stopMcpBridge, setFileAssociation, openDefaultAppsSettings, setMcpOpenAllowlist } = useActionsContext();
  return useMemo(
    () => ({ startMcpBridge, stopMcpBridge, setFileAssociation, openDefaultAppsSettings, setMcpOpenAllowlist }),
    [startMcpBridge, stopMcpBridge, setFileAssociation, openDefaultAppsSettings, setMcpOpenAllowlist],
  );
}

export function useWorkspaceActions() {
  const { newWorkspace, openWorkspace, saveWorkspace, saveWorkspaceAs,
          closeWorkspace, switchWorkspace } = useActionsContext();
  return useMemo(
    () => ({ newWorkspace, openWorkspace, saveWorkspace, saveWorkspaceAs,
             closeWorkspace, switchWorkspace }),
    [newWorkspace, openWorkspace, saveWorkspace, saveWorkspaceAs,
     closeWorkspace, switchWorkspace],
  );
}

export function usePipelineActions() {
  const { runPipeline, stopPipeline, clearResults, installProcessor,
          removeProcessor, loadProcessorFromFile,
          addToChain, addPackToChain, removeFromChain, reorderChain, toggleChainEnabled } = useActionsContext();
  return useMemo(
    () => ({ runPipeline, stopPipeline, clearResults, installProcessor,
             removeProcessor, loadProcessorFromFile,
             addToChain, addPackToChain, removeFromChain, reorderChain, toggleChainEnabled }),
    [runPipeline, stopPipeline, clearResults, installProcessor,
     removeProcessor, loadProcessorFromFile,
     addToChain, addPackToChain, removeFromChain, reorderChain, toggleChainEnabled],
  );
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
  timeFilterStart: string;
  timeFilterEnd: string;
  timeFilterLineNums: number[] | null;
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
    timeFilterStart: state?.timeFilterStart ?? '',
    timeFilterEnd: state?.timeFilterEnd ?? '',
    timeFilterLineNums: state?.timeFilterLineNums ?? null,
  }), [state]);
}

export function useTotalLines(): number {
  return useFocusedSession()?.totalLines ?? 0;
}
