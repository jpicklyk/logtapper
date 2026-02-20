import { useState, useCallback, useRef, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AdbTrackerUpdate, StateSnapshot, StateTransition } from '../bridge/types';
import { getAllTransitionLines, getStateAtLine, getStateTransitions } from '../bridge/commands';

export interface StateTrackerState {
  /** transitionCount per tracker (from adb-tracker-update events). */
  trackerUpdateCounts: Record<string, number>;
  /** All line numbers that have a state transition (union across all trackers). */
  allTransitionLineNums: Set<number>;
  /** lineNum → list of tracker IDs that transitioned on that line. */
  transitionsByLine: Record<number, string[]>;
  /** Fetch all transition line numbers for a session after a pipeline run. */
  refreshTransitionLines: (sessionId: string) => Promise<void>;
  /** Fetch current state snapshot for a specific tracker and line number. */
  getSnapshot: (sessionId: string, trackerId: string, lineNum: number) => Promise<StateSnapshot>;
  /** Fetch all transitions for a specific tracker. */
  getTransitions: (sessionId: string, trackerId: string) => Promise<StateTransition[]>;
  /** Clear all accumulated transition data (e.g. on new file load). */
  clearTransitions: () => void;
}

export function useStateTracker(): StateTrackerState {
  const [trackerUpdateCounts, setTrackerUpdateCounts] = useState<Record<string, number>>({});
  const [allTransitionLineNums, setAllTransitionLineNums] = useState<Set<number>>(new Set());
  const [transitionsByLine, setTransitionsByLine] = useState<Record<number, string[]>>({});
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Subscribe to adb-tracker-update events from the streaming pipeline
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
  }, []);

  const refreshTransitionLines = useCallback(async (sessionId: string) => {
    try {
      const byTracker = await getAllTransitionLines(sessionId);

      // Build a union set and a per-line tracker list
      const lineNums = new Set<number>();
      const byLine: Record<number, string[]> = {};

      for (const [trackerId, lines] of Object.entries(byTracker)) {
        for (const ln of lines) {
          lineNums.add(ln);
          if (!byLine[ln]) byLine[ln] = [];
          byLine[ln].push(trackerId);
        }
      }

      setAllTransitionLineNums(lineNums);
      setTransitionsByLine(byLine);
    } catch {
      // No tracker results yet — silently ignore
    }
  }, []);

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

  const clearTransitions = useCallback(() => {
    setTrackerUpdateCounts({});
    setAllTransitionLineNums(new Set());
    setTransitionsByLine({});
  }, []);

  return {
    trackerUpdateCounts,
    allTransitionLineNums,
    transitionsByLine,
    refreshTransitionLines,
    getSnapshot,
    getTransitions,
    clearTransitions,
  };
}
