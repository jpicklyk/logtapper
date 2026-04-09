import { createContext, useContext, useMemo, useState, useCallback, type ReactNode } from 'react';

export interface TrackerSessionData {
  updateCounts: Record<string, number>;   // trackerId → transitionCount
  allLineNums: Set<number>;
  byLine: Map<number, string[]>;
}

// ---------------------------------------------------------------------------
// Sub-context types (split by change frequency)
// ---------------------------------------------------------------------------

/** High-frequency: changes on every tracker update (~50ms during streaming). */
interface TrackerDataCtxValue {
  dataBySession: Record<string, TrackerSessionData>;
}

/** Stable: callbacks never change (useCallback with [] deps). */
interface TrackerActionsCtxValue {
  setSessionUpdateCounts: (sessionId: string, fn: (prev: Record<string, number>) => Record<string, number>) => void;
  setSessionTransitionData: (sessionId: string, allLineNums: Set<number>, byLine: Map<number, string[]>) => void;
  clearSessionData: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

const TrackerDataCtx = createContext<TrackerDataCtxValue | null>(null);
const TrackerActionsCtx = createContext<TrackerActionsCtxValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function TrackerProvider({ children }: { children: ReactNode }) {
  const [dataBySession, setDataBySession] = useState<Record<string, TrackerSessionData>>({});

  const setSessionUpdateCounts = useCallback((
    sessionId: string,
    fn: (prev: Record<string, number>) => Record<string, number>,
  ) => {
    setDataBySession((prev) => {
      const existing = prev[sessionId] ?? { updateCounts: {}, allLineNums: new Set(), byLine: new Map() };
      const nextCounts = fn(existing.updateCounts);
      return { ...prev, [sessionId]: { ...existing, updateCounts: nextCounts } };
    });
  }, []);

  const setSessionTransitionData = useCallback((
    sessionId: string,
    allLineNums: Set<number>,
    byLine: Map<number, string[]>,
  ) => {
    setDataBySession((prev) => {
      const existing = prev[sessionId] ?? { updateCounts: {}, allLineNums: new Set(), byLine: new Map() };
      return { ...prev, [sessionId]: { ...existing, allLineNums, byLine } };
    });
  }, []);

  const clearSessionData = useCallback((sessionId: string) => {
    setDataBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  // Data value changes frequently; actions value is stable (callbacks never change).
  const dataValue = useMemo<TrackerDataCtxValue>(
    () => ({ dataBySession }),
    [dataBySession],
  );

  const actionsValue = useMemo<TrackerActionsCtxValue>(
    () => ({ setSessionUpdateCounts, setSessionTransitionData, clearSessionData }),
    [setSessionUpdateCounts, setSessionTransitionData, clearSessionData],
  );

  return (
    <TrackerActionsCtx.Provider value={actionsValue}>
      <TrackerDataCtx.Provider value={dataValue}>
        {children}
      </TrackerDataCtx.Provider>
    </TrackerActionsCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Narrow hooks (internal — used by selectors and domain hooks)
// ---------------------------------------------------------------------------

export function useTrackerDataCtx(): TrackerDataCtxValue {
  const ctx = useContext(TrackerDataCtx);
  if (!ctx) throw new Error('useTrackerDataCtx must be used within a TrackerProvider');
  return ctx;
}

export function useTrackerActionsCtx(): TrackerActionsCtxValue {
  const ctx = useContext(TrackerActionsCtx);
  if (!ctx) throw new Error('useTrackerActionsCtx must be used within a TrackerProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Facade (backward compat — used by useStateTracker which needs both)
// ---------------------------------------------------------------------------

interface TrackerContextValue extends TrackerDataCtxValue, TrackerActionsCtxValue {}

export function useTrackerContext(): TrackerContextValue {
  const data = useTrackerDataCtx();
  const actions = useTrackerActionsCtx();
  return { ...data, ...actions };
}
