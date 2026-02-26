import { useCallback } from 'react';
import type { AdbBatchPayload, SourceType } from '../../bridge/types';
import { matchesFilter } from '../../../src/filter';
import { startAdbStream, stopAdbStream } from '../../bridge/commands';
import { onAdbBatch, onAdbStreamStopped } from '../../bridge/events';
import { useSessionContext } from '../../context/SessionContext';
import { bus } from '../../events/bus';
import type { CacheController } from '../../cache';
import type { StreamPusher } from '../../viewport';
import type { SharedLogViewerRefs } from './types';

const DEFAULT_PANE_ID = 'primary';

export interface StreamSessionResult {
  startStream: (deviceId?: string, packageFilter?: string, activeProcessorIds?: string[], maxRawLines?: number) => Promise<void>;
  stopStream: () => Promise<void>;
  /** Disconnect listeners + clear refs without a backend call. Used by loadFile when replacing a stream. */
  detachStream: (paneId: string) => void;
  handleAdbBatch: (payload: AdbBatchPayload) => void;
}

export function useStreamSession(
  cacheManager: CacheController,
  registry: StreamPusher,
  refs: SharedLogViewerRefs,
): StreamSessionResult {
  const {
    registerSession,
    activateSessionForPane,
    setLoadingPane,
    setErrorPane,
    setStreamingSession,
    updateSession,
  } = useSessionContext();

  const handleAdbBatch = useCallback((payload: AdbBatchPayload) => {
    if (payload.sessionId !== refs.streamingSessionIdRef.current) return;

    cacheManager.broadcastToSession(payload.sessionId, payload.lines);
    registry.pushToSession(payload.sessionId, payload.lines, payload.totalLines);

    updateSession(payload.sessionId, (prev) => ({
      ...prev,
      totalLines: payload.totalLines,
      fileSize: payload.byteCount,
      firstTimestamp: prev.firstTimestamp ?? payload.firstTimestamp,
      lastTimestamp: payload.lastTimestamp,
    }));

    // Incremental filter: check only new lines from this batch
    const ast = refs.filterAstRef.current;
    if (ast) {
      const pids = refs.packagePidsRef.current;
      const newMatches = payload.lines
        .filter((line) => matchesFilter(ast, line, pids))
        .map((line) => line.lineNum);
      if (newMatches.length > 0) {
        refs.appendFilterMatchesRef.current?.(newMatches);
      }
    }
  }, [cacheManager, registry, updateSession,
      refs.streamingSessionIdRef, refs.filterAstRef, refs.packagePidsRef,
      refs.appendFilterMatchesRef]);

  const detachStream = useCallback((_paneId: string) => {
    refs.adbBatchUnlistenRef.current?.();
    refs.adbBatchUnlistenRef.current = null;
    refs.adbStoppedUnlistenRef.current?.();
    refs.adbStoppedUnlistenRef.current = null;
    if (refs.streamingSessionIdRef.current) {
      setStreamingSession(refs.streamingSessionIdRef.current, false);
    }
    refs.isStreamingRef.current = false;
    refs.streamingPaneIdRef.current = null;
    refs.streamingSessionIdRef.current = null;
  }, [refs.adbBatchUnlistenRef, refs.adbStoppedUnlistenRef, refs.streamingSessionIdRef,
      refs.isStreamingRef, refs.streamingPaneIdRef, setStreamingSession]);

  const startStream = useCallback(async (
    deviceId?: string,
    packageFilter?: string,
    activeProcessorIds: string[] = [],
    maxRawLines?: number,
  ) => {
    refs.adbBatchUnlistenRef.current?.();
    refs.adbBatchUnlistenRef.current = null;
    refs.adbStoppedUnlistenRef.current?.();
    refs.adbStoppedUnlistenRef.current = null;

    const targetPaneId = refs.focusedPaneIdRef.current ?? DEFAULT_PANE_ID;
    const tabId = crypto.randomUUID();

    // If the pane already has a session, open the stream as a new tab alongside it.
    // If the pane is empty, replace (isNewTab: false) and reset viewer state.
    const previousSessionId = refs.paneSessionMapRef.current.get(targetPaneId);
    const isNewTab = previousSessionId !== undefined;

    if (!isNewTab) {
      bus.emit('session:pre-load', { paneId: targetPaneId });
      refs.resetSessionStateRef.current();
    }

    setLoadingPane(targetPaneId, true);
    setErrorPane(targetPaneId, null);

    refs.streamDeviceSerialRef.current = deviceId ?? null;

    try {
      const result = await startAdbStream(deviceId, packageFilter, activeProcessorIds, maxRawLines);

      registerSession(targetPaneId, result);
      activateSessionForPane(targetPaneId, result.sessionId);
      setStreamingSession(result.sessionId, true);
      refs.isStreamingRef.current = true;
      refs.streamingPaneIdRef.current = targetPaneId;
      refs.streamingSessionIdRef.current = result.sessionId;

      const unlistenBatch = await onAdbBatch(handleAdbBatch);
      refs.adbBatchUnlistenRef.current = unlistenBatch;

      const unlistenStopped = await onAdbStreamStopped((payload) => {
        if (payload.sessionId !== refs.streamingSessionIdRef.current) return;
        setStreamingSession(payload.sessionId, false);
        refs.isStreamingRef.current = false;
        const stoppedPaneId = refs.streamingPaneIdRef.current ?? targetPaneId;
        refs.streamingPaneIdRef.current = null;
        refs.streamingSessionIdRef.current = null;
        refs.adbBatchUnlistenRef.current?.();
        refs.adbBatchUnlistenRef.current = null;
        bus.emit('stream:stopped', { sessionId: payload.sessionId, paneId: stoppedPaneId });
      });
      refs.adbStoppedUnlistenRef.current = unlistenStopped;

      setLoadingPane(targetPaneId, false);

      bus.emit('session:focused', { sessionId: result.sessionId, paneId: targetPaneId });

      // Emit session:loaded so the workspace layout creates a dedicated tab with
      // the device name. This is the same event file sessions emit for tab management.
      bus.emit('session:loaded', {
        sourceName: result.sourceName,
        sourceType: result.sourceType as SourceType,
        sessionId: result.sessionId,
        paneId: targetPaneId,
        tabId,
        isNewTab,
        previousSessionId,
      });

      bus.emit('stream:started', {
        sessionId: result.sessionId,
        paneId: targetPaneId,
        deviceSerial: deviceId ?? '',
      });
      bus.emit('session:logcat:opened', {
        sessionId: result.sessionId,
        paneId: targetPaneId,
        sourceName: result.sourceName,
      });
    } catch (e) {
      setErrorPane(targetPaneId, String(e));
      setStreamingSession('', false);
      refs.isStreamingRef.current = false;
      refs.streamingPaneIdRef.current = null;
      refs.streamingSessionIdRef.current = null;
      setLoadingPane(targetPaneId, false);
    }
  }, [
    refs.focusedPaneIdRef, refs.paneSessionMapRef,
    refs.streamDeviceSerialRef, refs.isStreamingRef,
    refs.streamingPaneIdRef, refs.streamingSessionIdRef,
    refs.adbBatchUnlistenRef, refs.adbStoppedUnlistenRef,
    refs.resetSessionStateRef,
    registerSession, activateSessionForPane, setLoadingPane, setErrorPane,
    setStreamingSession, handleAdbBatch,
  ]);

  const stopStream = useCallback(async () => {
    const sessionId = refs.streamingSessionIdRef.current;
    const paneId = refs.streamingPaneIdRef.current;
    if (!sessionId) return;
    // Unlisten the Tauri stopped-event handler BEFORE issuing the stop command.
    // stopAdbStream triggers the backend to emit adb-stream-stopped, and if the
    // listener is still active at that point both paths emit 'stream:stopped'.
    refs.adbStoppedUnlistenRef.current?.();
    refs.adbStoppedUnlistenRef.current = null;
    try {
      await stopAdbStream(sessionId);
    } catch (e) {
      console.error('Error stopping ADB stream:', e);
    }
    refs.adbBatchUnlistenRef.current?.();
    refs.adbBatchUnlistenRef.current = null;
    setStreamingSession(sessionId, false);
    refs.isStreamingRef.current = false;
    const stoppedPaneId = paneId ?? (refs.focusedPaneIdRef.current ?? DEFAULT_PANE_ID);
    refs.streamingPaneIdRef.current = null;
    refs.streamingSessionIdRef.current = null;
    bus.emit('stream:stopped', { sessionId, paneId: stoppedPaneId });
  }, [
    refs.streamingSessionIdRef, refs.streamingPaneIdRef, refs.focusedPaneIdRef,
    refs.adbBatchUnlistenRef, refs.adbStoppedUnlistenRef, refs.isStreamingRef,
    setStreamingSession,
  ]);

  return { startStream, stopStream, detachStream, handleAdbBatch };
}
