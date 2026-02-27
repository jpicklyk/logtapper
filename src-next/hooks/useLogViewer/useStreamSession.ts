import { useCallback, useRef } from 'react';
import type { AdbBatchPayload, AdbStreamEvent, SourceType } from '../../bridge/types';
import { matchesFilter } from '../../../src/filter';
import { startAdbStream, stopAdbStream } from '../../bridge/commands';
import { onAdbStreamStopped } from '../../bridge/events';
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

  // Guard flag: set false when the stream is stopped/detached so late-arriving
  // Channel messages are ignored. This replaces the need for an unlisten() call
  // since Channel<T> has no cancellation API.
  const channelActiveRef = useRef(false);

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
    channelActiveRef.current = false;
    refs.adbStoppedUnlistenRef.current?.();
    refs.adbStoppedUnlistenRef.current = null;
    if (refs.streamingSessionIdRef.current) {
      setStreamingSession(refs.streamingSessionIdRef.current, false);
    }
    refs.isStreamingRef.current = false;
    refs.streamingPaneIdRef.current = null;
    refs.streamingSessionIdRef.current = null;
  }, [refs.adbStoppedUnlistenRef, refs.streamingSessionIdRef,
      refs.isStreamingRef, refs.streamingPaneIdRef, setStreamingSession]);

  const startStream = useCallback(async (
    deviceId?: string,
    packageFilter?: string,
    activeProcessorIds: string[] = [],
    maxRawLines?: number,
  ) => {
    channelActiveRef.current = false;
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

    // Channel event handler — receives Batch, ProcessorUpdate, StreamStopped.
    // The channelActiveRef guard prevents late-arriving messages from being
    // processed after the stream is stopped or detached.
    const handleChannelEvent = (msg: AdbStreamEvent) => {
      if (!channelActiveRef.current) return;
      if (msg.event === 'batch') {
        handleAdbBatch(msg.data);
      } else if (msg.event === 'streamStopped') {
        const payload = msg.data;
        if (payload.sessionId !== refs.streamingSessionIdRef.current) return;
        channelActiveRef.current = false;
        setStreamingSession(payload.sessionId, false);
        refs.isStreamingRef.current = false;
        const stoppedPaneId = refs.streamingPaneIdRef.current ?? targetPaneId;
        refs.streamingPaneIdRef.current = null;
        refs.streamingSessionIdRef.current = null;
        bus.emit('stream:stopped', { sessionId: payload.sessionId, paneId: stoppedPaneId });
      }
      // TODO: processorUpdate must drive PipelineContext (adb:results-update +
      // throttled adb:run-count-bump) so ProcessorDashboard, CorrelationsView,
      // StatePanel, and StateTimeline refresh during streaming. The old path was
      // listen('adb-processor-update') in usePipeline.ts — that broadcast is
      // now dead. Fix: emit a bus event here (e.g. pipeline:adb-processor-update)
      // and consume it in usePipeline.
    };

    try {
      const result = await startAdbStream(
        deviceId, packageFilter, activeProcessorIds, maxRawLines, handleChannelEvent,
      );

      channelActiveRef.current = true;
      registerSession(targetPaneId, result);
      activateSessionForPane(targetPaneId, result.sessionId);
      setStreamingSession(result.sessionId, true);
      refs.isStreamingRef.current = true;
      refs.streamingPaneIdRef.current = targetPaneId;
      refs.streamingSessionIdRef.current = result.sessionId;

      // Keep the adb-stream-stopped emit listener as a fallback for the case
      // where stop_adb_stream emits it directly (e.g. the streaming task had
      // already exited before the stop command arrived).
      const unlistenStopped = await onAdbStreamStopped((payload) => {
        if (payload.sessionId !== refs.streamingSessionIdRef.current) return;
        channelActiveRef.current = false;
        setStreamingSession(payload.sessionId, false);
        refs.isStreamingRef.current = false;
        const stoppedPaneId = refs.streamingPaneIdRef.current ?? targetPaneId;
        refs.streamingPaneIdRef.current = null;
        refs.streamingSessionIdRef.current = null;
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
      channelActiveRef.current = false;
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
    refs.adbStoppedUnlistenRef,
    refs.resetSessionStateRef,
    registerSession, activateSessionForPane, setLoadingPane, setErrorPane,
    setStreamingSession, handleAdbBatch,
  ]);

  const stopStream = useCallback(async () => {
    const sessionId = refs.streamingSessionIdRef.current;
    const paneId = refs.streamingPaneIdRef.current;
    if (!sessionId) return;
    // Deactivate channel and unlisten the fallback emit handler BEFORE issuing
    // the stop command so neither path double-fires 'stream:stopped'.
    channelActiveRef.current = false;
    refs.adbStoppedUnlistenRef.current?.();
    refs.adbStoppedUnlistenRef.current = null;
    try {
      await stopAdbStream(sessionId);
    } catch (e) {
      console.error('Error stopping ADB stream:', e);
    }
    setStreamingSession(sessionId, false);
    refs.isStreamingRef.current = false;
    const stoppedPaneId = paneId ?? (refs.focusedPaneIdRef.current ?? DEFAULT_PANE_ID);
    refs.streamingPaneIdRef.current = null;
    refs.streamingSessionIdRef.current = null;
    bus.emit('stream:stopped', { sessionId, paneId: stoppedPaneId });
  }, [
    refs.streamingSessionIdRef, refs.streamingPaneIdRef, refs.focusedPaneIdRef,
    refs.adbStoppedUnlistenRef, refs.isStreamingRef,
    setStreamingSession,
  ]);

  return { startStream, stopStream, detachStream };
}
