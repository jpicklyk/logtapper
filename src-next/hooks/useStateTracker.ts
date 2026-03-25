import { useCallback, useRef, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AdbTrackerUpdate, StateSnapshot, StateTransition } from '../bridge/types';
import { getAllTransitionLines, getStateAtLine, getStateTransitions } from '../bridge/commands';
import { useTrackerContext } from '../context/TrackerContext';
import { useSessionContext } from '../context/SessionContext';
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

  const { paneSessionMap } = useSessionContext();

  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;

  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Subscribe to adb-tracker-update events (StrictMode-safe).
  // Updates the streaming session's update counts and forwards to bus
  // so usePipeline can bump runCount for dashboard rendering.
  useEffect(() => {
    let cancelled = false;
    listen<AdbTrackerUpdate>('adb-tracker-update', (event) => {
      if (cancelled) return;
      const { trackerId, transitionCount, sessionId } = event.payload;
      setSessionUpdateCounts(sessionId, (prev) => ({
        ...prev,
        [trackerId]: transitionCount,
      }));
      bus.emit('pipeline:adb-tracker-update', { sessionId, trackerId, transitionCount });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, [setSessionUpdateCounts]);

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

  // Throttled transition line refresh for streaming — at most once per 3s.
  const transitionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTransitionRefreshRef = useRef<string | null>(null);

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

    // Throttled refresh during streaming so timeline updates without flooding.
    const handleTrackerUpdate = (e: { sessionId: string }) => {
      pendingTransitionRefreshRef.current = e.sessionId;
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
    };

    bus.on('session:pre-load', handlePreLoad);
    bus.on('pipeline:completed', handlePipelineCompleted);
    bus.on('session:closed', handleSessionClosed);
    bus.on('pipeline:adb-tracker-update', handleTrackerUpdate);

    return () => {
      bus.off('session:pre-load', handlePreLoad);
      bus.off('pipeline:completed', handlePipelineCompleted);
      bus.off('session:closed', handleSessionClosed);
      bus.off('pipeline:adb-tracker-update', handleTrackerUpdate);
      if (transitionRefreshTimerRef.current) {
        clearTimeout(transitionRefreshTimerRef.current);
        transitionRefreshTimerRef.current = null;
      }
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
