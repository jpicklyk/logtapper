import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface TrackerState {
  trackerUpdateCounts: Record<string, number>;
  allTransitionLineNums: Set<number>;
  transitionsByLine: Map<number, string[]>;
}

interface TrackerContextValue extends TrackerState {
  setTrackerUpdateCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setAllTransitionLineNums: React.Dispatch<React.SetStateAction<Set<number>>>;
  setTransitionsByLine: React.Dispatch<React.SetStateAction<Map<number, string[]>>>;
}

const TrackerContext = createContext<TrackerContextValue | null>(null);

export function TrackerProvider({ children }: { children: ReactNode }) {
  const [trackerUpdateCounts, setTrackerUpdateCounts] = useState<Record<string, number>>({});
  const [allTransitionLineNums, setAllTransitionLineNums] = useState<Set<number>>(new Set());
  const [transitionsByLine, setTransitionsByLine] = useState<Map<number, string[]>>(new Map());

  const value = useMemo<TrackerContextValue>(() => ({
    trackerUpdateCounts,
    allTransitionLineNums,
    transitionsByLine,
    setTrackerUpdateCounts,
    setAllTransitionLineNums,
    setTransitionsByLine,
  }), [trackerUpdateCounts, allTransitionLineNums, transitionsByLine]);

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
