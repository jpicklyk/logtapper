import { useCallback, useRef, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AdbTrackerUpdate, StateSnapshot, StateTransition } from '../bridge/types';
import { getAllTransitionLines, getStateAtLine, getStateTransitions } from '../bridge/commands';
import { useTrackerContext } from '../context/TrackerContext';
import { bus } from '../events/bus';

export interface StateTrackerActions {
  /** Fetch all transition line numbers for a session after a pipeline run. */
  refreshTransitionLines: (sessionId: string) => Promise<void>;
  /** Fetch current state snapshot for a specific tracker and line number. */
  getSnapshot: (sessionId: string, trackerId: string, lineNum: number) => Promise<StateSnapshot>;
  /** Fetch all transitions for a specific tracker. */
  getTransitions: (sessionId: string, trackerId: string) => Promise<StateTransition[]>;
  /** Clear all accumulated transition data (e.g. on new file load). */
  clearTransitions: () => void;
}

export function useStateTracker(): StateTrackerActions {
  const {
    setTrackerUpdateCounts,
    setAllTransitionLineNums,
    setTransitionsByLine,
  } = useTrackerContext();

  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Subscribe to adb-tracker-update events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    listen<AdbTrackerUpdate>('adb-tracker-update', (event) => {
      if (cancelled) return;
      const { trackerId, transitionCount } = event.payload;
      setTrackerUpdateCounts((prev) => ({
        ...prev,
        [trackerId]: transitionCount,
      }));
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, [setTrackerUpdateCounts]);

  const clearTransitions = useCallback(() => {
    setTrackerUpdateCounts({});
    setAllTransitionLineNums(new Set());
    setTransitionsByLine(new Map());
  }, [setTrackerUpdateCounts, setAllTransitionLineNums, setTransitionsByLine]);

  const refreshTransitionLines = useCallback(async (sessionId: string) => {
    try {
      const byTracker = await getAllTransitionLines(sessionId);

      const lineNums = new Set<number>();
      const byLine = new Map<number, string[]>();

      for (const [trackerId, lines] of Object.entries(byTracker)) {
        for (const ln of lines) {
          lineNums.add(ln);
          const existing = byLine.get(ln);
          if (existing) {
            existing.push(trackerId);
          } else {
            byLine.set(ln, [trackerId]);
          }
        }
      }

      setAllTransitionLineNums(lineNums);
      setTransitionsByLine(byLine);
    } catch {
      // No tracker results yet -- silently ignore
    }
  }, [setAllTransitionLineNums, setTransitionsByLine]);

  // Subscribe to bus events: clear on session pre-load, refresh on pipeline completed
  useEffect(() => {
    const handlePreLoad = () => {
      clearTransitions();
    };
    const handlePipelineCompleted = (data: { sessionId: string; hasTrackers: boolean }) => {
      if (data.hasTrackers) {
        refreshTransitionLines(data.sessionId);
      }
    };

    bus.on('session:pre-load', handlePreLoad);
    bus.on('pipeline:completed', handlePipelineCompleted);

    return () => {
      bus.off('session:pre-load', handlePreLoad);
      bus.off('pipeline:completed', handlePipelineCompleted);
    };
  }, [clearTransitions, refreshTransitionLines]);

  const getSnapshot = useCallback(
    (sessionId: string, trackerId: string, lineNum: number) =>
      getStateAtLine(sessionId, trackerId, lineNum),
    [],
  );

  const getTransitions = useCallback(
    (sessionId: string, trackerId: string) =>
      getStateTransitions(sessionId, trackerId),
    [],
  );

  return {
    refreshTransitionLines,
    getSnapshot,
    getTransitions,
    clearTransitions,
  };
}
