import { useCallback, useRef, useEffect } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { StateSnapshot, StateTransition } from '../bridge/types';
import { onAdbTrackerUpdate } from '../bridge/events';
import { getAllTransitionLines, getStateAtLine, getStateTransitions } from '../bridge/commands';
import { useTrackerContext } from '../context/TrackerContext';
import { useSessionCoreCtx } from '../context/SessionContext';
import { bus } from '../events/bus';

export interface StateTrackerActions {
  /** Fetch all transition line numbers for a session after a pipeline run. */
  refreshTransitionLines: (sessionId: string) => Promise<void>;
  /** Fetch current state snapshot for a specific tracker and line number. */
  getSnapshot: (sessionId: string, trackerId: string, lineNum: number) => Promise<StateSnapshot>;
  /** Fetch all transitions for a specific tracker. */
  getTransitions: (sessionId: string, trackerId: string) => Promise<StateTransition[]>;
}

export function useStateTracker(): StateTrackerActions {
  const {
    setSessionUpdateCounts,
    setSessionTransitionData,
    clearSessionData,
  } = useTrackerContext();

  const { paneSessionMap } = useSessionCoreCtx();

  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;

  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Throttled transition line refresh for streaming — at most once per 3s.
  const transitionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTransitionRefreshRef = useRef<string | null>(null);

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

      setSessionTransitionData(sessionId, lineNums, byLine);
    } catch {
      // No tracker results yet -- silently ignore
    }
  }, [setSessionTransitionData]);

  // Subscribe to adb-tracker-update events (StrictMode-safe).
  // Updates streaming session update counts, forwards to bus for usePipeline
  // runCount bump, and drives throttled refreshTransitionLines.
  useEffect(() => {
    let cancelled = false;
    onAdbTrackerUpdate((payload) => {
      if (cancelled) return;
      const { trackerId, transitionCount, sessionId } = payload;
      setSessionUpdateCounts(sessionId, (prev) => ({
        ...prev,
        [trackerId]: transitionCount,
      }));
      bus.emit('pipeline:adb-tracker-update', { sessionId, trackerId, transitionCount });
      // Throttled transition line refresh during streaming
      pendingTransitionRefreshRef.current = sessionId;
      if (!transitionRefreshTimerRef.current) {
        transitionRefreshTimerRef.current = setTimeout(() => {
          transitionRefreshTimerRef.current = null;
          const sid = pendingTransitionRefreshRef.current;
          if (sid) {
            pendingTransitionRefreshRef.current = null;
            refreshTransitionLines(sid);
          }
        }, 3000);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
      if (transitionRefreshTimerRef.current) {
        clearTimeout(transitionRefreshTimerRef.current);
        transitionRefreshTimerRef.current = null;
      }
    };
  }, [setSessionUpdateCounts, refreshTransitionLines]);

  // Subscribe to bus events
  useEffect(() => {
    const handlePreLoad = (e: { paneId: string }) => {
      const outgoingSessionId = paneSessionMapRef.current.get(e.paneId);
      if (outgoingSessionId) {
        clearSessionData(outgoingSessionId);
      }
    };

    const handlePipelineCompleted = (data: { sessionId: string; hasTrackers: boolean }) => {
      if (data.hasTrackers) {
        refreshTransitionLines(data.sessionId);
      }
    };

    const handleSessionClosed = (e: { sessionId: string }) => {
      clearSessionData(e.sessionId);
    };

    bus.on('session:pre-load', handlePreLoad);
    bus.on('pipeline:completed', handlePipelineCompleted);
    bus.on('session:closed', handleSessionClosed);

    return () => {
      bus.off('session:pre-load', handlePreLoad);
      bus.off('pipeline:completed', handlePipelineCompleted);
      bus.off('session:closed', handleSessionClosed);
    };
  }, [clearSessionData, refreshTransitionLines]);

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
  };
}
