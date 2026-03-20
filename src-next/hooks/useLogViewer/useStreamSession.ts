import { useCallback, useRef, useEffect } from 'react';
import type { AdbBatchPayload, AdbStreamEvent, SourceType } from '../../bridge/types';
import { matchesFilter } from '../../../src/filter';
import { startAdbStream, stopAdbStream } from '../../bridge/commands';
import { onAdbStreamStopped } from '../../bridge/events';
import { useSessionContext } from '../../context/SessionContext';
import { loadSettings } from '../../hooks';
import { bus } from '../../events/bus';
import type { CacheController } from '../../cache';
import type { StreamPusher } from '../../viewport';
import type { SharedLogViewerRefs } from './types';

// A stream that ran for less than this duration before EOF is counted as a
// "quick" failure. Five consecutive quick failures abort auto-reconnect.
const QUICK_FAILURE_MS = 5_000;
const MAX_CONSECUTIVE_QUICK_FAILURES = 5;
const RECONNECT_DELAY_MS = 2_000;

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

  // Auto-reconnect state
  const reconnectTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef      = useRef(0);
  const streamStartedAtRef     = useRef<number | null>(null);
  // Params of the most-recent startStream call, for use by the reconnect timer.
  interface StreamParams { deviceId?: string; packageFilter?: string; activeProcessorIds: string[]; maxRawLines?: number; }
  const lastStreamParamsRef    = useRef<StreamParams | null>(null);
  // Stable ref to startStream so the reconnect timer (defined in useEffect)
  // always calls the latest version without a stale closure.
  const startStreamRef         = useRef<(deviceId?: string, packageFilter?: string, activeProcessorIds?: string[], maxRawLines?: number) => Promise<void>>();
  // Stable ref to scheduleReconnect so it can be set once in useEffect([])
  // and called from the channel/fallback handlers without re-creating them.
  const scheduleReconnectRef   = useRef<((params: StreamParams) => void) | null>(null);

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

  // Wire scheduleReconnectRef once. The effect has empty deps; it reads dynamic
  // values (settings, startStream) through refs so no re-creation is needed.
  useEffect(() => {
    scheduleReconnectRef.current = (params: StreamParams) => {
      if (!loadSettings().autoReconnectStream) return;
      if (reconnectCountRef.current >= MAX_CONSECUTIVE_QUICK_FAILURES) {
        console.warn('[useStreamSession] auto-reconnect: too many consecutive quick failures, giving up');
        reconnectCountRef.current = 0;
        return;
      }
      console.debug('[useStreamSession] auto-reconnect scheduled', {
        attempt: reconnectCountRef.current + 1,
        delayMs: RECONNECT_DELAY_MS,
      });
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        startStreamRef.current?.(
          params.deviceId,
          params.packageFilter,
          params.activeProcessorIds,
          params.maxRawLines,
        );
      }, RECONNECT_DELAY_MS);
    };
  }, []);  

  const detachStream = useCallback((_paneId: string) => {
    // Cancel any pending reconnect when the stream is detached (replaced by file load).
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectCountRef.current = 0;
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
    // Cancel any pending reconnect timer before starting a new stream.
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    // Record params for potential reconnect and mark start time.
    lastStreamParamsRef.current = { deviceId, packageFilter, activeProcessorIds, maxRawLines };
    streamStartedAtRef.current = Date.now();

    channelActiveRef.current = false;
    refs.adbStoppedUnlistenRef.current?.();
    refs.adbStoppedUnlistenRef.current = null;

    const targetPaneId = refs.activeLogPaneIdRef.current ?? DEFAULT_PANE_ID;
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
        console.debug('[useStreamSession] streamStopped via channel', { sessionId: payload.sessionId, reason: payload.reason });
        channelActiveRef.current = false;
        // Clean up the fallback broadcast listener — it's no longer needed.
        refs.adbStoppedUnlistenRef.current?.();
        refs.adbStoppedUnlistenRef.current = null;
        setStreamingSession(payload.sessionId, false);
        refs.isStreamingRef.current = false;
        const stoppedPaneId = refs.streamingPaneIdRef.current ?? targetPaneId;
        refs.streamingPaneIdRef.current = null;
        refs.streamingSessionIdRef.current = null;
        bus.emit('stream:stopped', { sessionId: payload.sessionId, paneId: stoppedPaneId });
        // Auto-reconnect on EOF (e.g. screen unlock USB reset).
        if (payload.reason === 'eof' && lastStreamParamsRef.current) {
          const elapsed = streamStartedAtRef.current ? Date.now() - streamStartedAtRef.current : 0;
          if (elapsed < QUICK_FAILURE_MS) {
            reconnectCountRef.current += 1;
          } else {
            reconnectCountRef.current = 0;
          }
          scheduleReconnectRef.current?.(lastStreamParamsRef.current);
        }
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
        console.debug('[useStreamSession] streamStopped via broadcast fallback', { sessionId: payload.sessionId, reason: payload.reason });
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
    refs.activeLogPaneIdRef, refs.paneSessionMapRef,
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
    // Cancel any pending reconnect — user explicitly stopped the stream.
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectCountRef.current = 0;
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
    const stoppedPaneId = paneId ?? (refs.activeLogPaneIdRef.current ?? DEFAULT_PANE_ID);
    refs.streamingPaneIdRef.current = null;
    refs.streamingSessionIdRef.current = null;
    bus.emit('stream:stopped', { sessionId, paneId: stoppedPaneId });
  }, [
    refs.streamingSessionIdRef, refs.streamingPaneIdRef, refs.activeLogPaneIdRef,
    refs.adbStoppedUnlistenRef, refs.isStreamingRef,
    setStreamingSession,
  ]);

  // Keep startStreamRef pointing to the latest startStream so the reconnect
  // timer (set up once in the empty-dep useEffect above) always calls the
  // current version without a stale closure.
  useEffect(() => { startStreamRef.current = startStream; }, [startStream]);

  return { startStream, stopStream, detachStream };
}
