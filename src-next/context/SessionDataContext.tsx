import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { PipelineRunSummary } from '../bridge/types';
import { usePipelineContext, type SessionPipelineState } from './PipelineContext';
import { useTrackerContext, type TrackerSessionData } from './TrackerContext';
import { useSessionProgressCtx, type IndexingProgress, type FilterState } from './SessionContext';

// ---------------------------------------------------------------------------
// Empty defaults — module-level singletons for referential stability
// ---------------------------------------------------------------------------

const EMPTY_RESULTS: PipelineRunSummary[] = [];
const EMPTY_TRACKER_COUNTS: Record<string, number> = {};
const EMPTY_TRACKER_LINES = new Set<number>();
const EMPTY_TRACKER_BY_LINE = new Map<number, string[]>();
const EMPTY_FILTER: FilterState = {
  streamFilter: '',
  timeFilterStart: '',
  timeFilterEnd: '',
  filterScanning: false,
  filteredLineNums: null,
  filterParseError: null,
  sectionFilteredLineNums: null,
};

// ---------------------------------------------------------------------------
// Context value
// ---------------------------------------------------------------------------

export interface SessionDataContextValue {
  /** The session ID this provider is scoped to (null when no session is bound). */
  sessionId: string | null;

  // Pipeline results for THIS session
  pipelineResults: PipelineRunSummary[];
  runCount: number;
  pipelineRunning: boolean;
  pipelineProgress: { current: number; total: number } | null;
  pipelineError: string | null;

  // Tracker transitions for THIS session
  trackerUpdateCounts: Record<string, number>;
  trackerAllLineNums: Set<number>;
  trackerByLine: Map<number, string[]>;

  // Filter state for THIS session
  filterState: FilterState;

  // Indexing progress for THIS session
  indexingProgress: IndexingProgress | null;
}

const SessionDataContext = createContext<SessionDataContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface SessionDataProviderProps {
  sessionId: string | null;
  children: ReactNode;
}

/**
 * Per-session data provider. Extracts this session's slice from global context
 * Maps and provides it in isolation. Child re-renders only happen when THIS
 * session's data changes — changes to other sessions are invisible.
 *
 * Mount one per pane in PaneContent. The workspace controls provider lifecycle
 * indirectly: opening/closing sessions adds/removes panes, which mounts/unmounts
 * these providers.
 */
export function SessionDataProvider({ sessionId, children }: SessionDataProviderProps) {
  // Read from global contexts
  const { resultsBySession } = usePipelineContext();
  const { dataBySession } = useTrackerContext();
  const { indexingProgressBySession, filterStateBySession } = useSessionProgressCtx();

  // Extract this session's slices
  const pipelineState: SessionPipelineState | undefined = sessionId
    ? resultsBySession.get(sessionId)
    : undefined;

  const trackerData: TrackerSessionData | undefined = sessionId
    ? dataBySession[sessionId]
    : undefined;

  const filterState: FilterState = sessionId
    ? (filterStateBySession.get(sessionId) ?? EMPTY_FILTER)
    : EMPTY_FILTER;

  const indexingProgress: IndexingProgress | null = sessionId
    ? (indexingProgressBySession.get(sessionId) ?? null)
    : null;

  // Build context value. All consumers of this context re-render together when
  // any field changes. The isolation benefit is cross-SESSION (Session A changes
  // don't re-render Session B), not cross-FIELD within a session.
  // For field-level isolation, split into sub-contexts (future optimization).
  const value = useMemo<SessionDataContextValue>(() => ({
    sessionId,
    pipelineResults: pipelineState?.results ?? EMPTY_RESULTS,
    runCount: pipelineState?.runCount ?? 0,
    pipelineRunning: pipelineState?.running ?? false,
    pipelineProgress: pipelineState?.progress ?? null,
    pipelineError: pipelineState?.error ?? null,
    trackerUpdateCounts: trackerData?.updateCounts ?? EMPTY_TRACKER_COUNTS,
    trackerAllLineNums: trackerData?.allLineNums ?? EMPTY_TRACKER_LINES,
    trackerByLine: trackerData?.byLine ?? EMPTY_TRACKER_BY_LINE,
    filterState,
    indexingProgress,
  }), [
    sessionId,
    pipelineState, trackerData, filterState, indexingProgress,
  ]);

  return (
    <SessionDataContext.Provider value={value}>
      {children}
    </SessionDataContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useSessionDataContext(): SessionDataContextValue {
  const ctx = useContext(SessionDataContext);
  if (!ctx) throw new Error('useSessionDataContext must be used within a SessionDataProvider');
  return ctx;
}

/** Pipeline results for the enclosing session. */
export function useSessionPipelineResults(): { results: PipelineRunSummary[]; runCount: number } {
  const { pipelineResults, runCount } = useSessionDataContext();
  return useMemo(() => ({ results: pipelineResults, runCount }), [pipelineResults, runCount]);
}

/** Whether the enclosing session's pipeline is currently running. */
export function useSessionPipelineRunning(): boolean {
  return useSessionDataContext().pipelineRunning;
}

/** Pipeline progress for the enclosing session. */
export function useSessionPipelineProgress(): { current: number; total: number } | null {
  return useSessionDataContext().pipelineProgress;
}

/** Pipeline error for the enclosing session. */
export function useSessionPipelineError(): string | null {
  return useSessionDataContext().pipelineError;
}

/** Tracker transitions for the enclosing session. */
export function useSessionTrackerTransitions(): {
  allLineNums: Set<number>;
  byLine: Map<number, string[]>;
} {
  const { trackerAllLineNums, trackerByLine } = useSessionDataContext();
  return useMemo(
    () => ({ allLineNums: trackerAllLineNums, byLine: trackerByLine }),
    [trackerAllLineNums, trackerByLine],
  );
}

/** Tracker update counts for the enclosing session. */
export function useSessionTrackerUpdateCounts(): Record<string, number> {
  return useSessionDataContext().trackerUpdateCounts;
}

/** Filter state for the enclosing session. */
export function useSessionFilterState(): FilterState {
  return useSessionDataContext().filterState;
}

/** Indexing progress for the enclosing session. */
export function useSessionIndexingProgress(): IndexingProgress | null {
  return useSessionDataContext().indexingProgress;
}

/** The session ID from the enclosing SessionDataProvider. */
export function useSessionDataId(): string | null {
  return useSessionDataContext().sessionId;
}
