import { createContext, useContext, useMemo, useState, useCallback, type ReactNode } from 'react';

export interface TrackerSessionData {
  updateCounts: Record<string, number>;   // trackerId → transitionCount
  allLineNums: Set<number>;
  byLine: Map<number, string[]>;
}

interface TrackerContextValue {
  dataBySession: Record<string, TrackerSessionData>;
  setSessionUpdateCounts: (sessionId: string, fn: (prev: Record<string, number>) => Record<string, number>) => void;
  setSessionTransitionData: (sessionId: string, allLineNums: Set<number>, byLine: Map<number, string[]>) => void;
  clearSessionData: (sessionId: string) => void;
}

const TrackerContext = createContext<TrackerContextValue | null>(null);

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

  const value = useMemo<TrackerContextValue>(() => ({
    dataBySession,
    setSessionUpdateCounts,
    setSessionTransitionData,
    clearSessionData,
  }), [dataBySession, setSessionUpdateCounts, setSessionTransitionData, clearSessionData]);

  return (
    <TrackerContext.Provider value={value}>
      {children}
    </TrackerContext.Provider>
  );
}

export function useTrackerContext(): TrackerContextValue {
  const ctx = useContext(TrackerContext);
  if (!ctx) {
    throw new Error('useTrackerContext must be used within a TrackerProvider');
  }
  return ctx;
}
