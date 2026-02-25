import { useState, useCallback, useRef, useEffect } from 'react';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { SearchQuery, SearchProgress, LoadResult, AdbBatchPayload, LineWindow, SourceType } from '../bridge/types';
import {
  loadLogFile,
  getLines,
  searchLogs,
  startAdbStream,
  stopAdbStream,
  getPackagePids,
  closeSession as closeSessionCmd,
  updateStreamProcessors,
  updateStreamTrackers,
  updateStreamTransformers,
} from '../bridge/commands';
import type { CacheController } from '../cache';
import type { StreamPusher } from '../viewport';
import {
  onAdbBatch,
  onAdbStreamStopped,
  onFileIndexProgress,
  onFileIndexComplete,
  onSearchProgress,
} from '../bridge/events';
import { parseFilter, matchesFilter, extractPackageNames, type FilterNode, FilterParseError } from '../../src/filter';
import { useSessionContext } from '../context/SessionContext';
import { useViewerContext } from '../context/ViewerContext';
import { bus } from '../events/bus';
import { getStoredFirstPaneId } from './useWorkspaceLayout';

const LS_LAST_FILE = 'logtapper_last_file';
const DEFAULT_PANE_ID = 'primary';

export interface LogViewerActions {
  loadFile: (path: string, paneId?: string) => Promise<void>;
  startStream: (deviceId?: string, packageFilter?: string, activeProcessorIds?: string[], maxRawLines?: number) => Promise<void>;
  stopStream: () => Promise<void>;
  setStreamFilter: (expr: string) => Promise<void>;
  setTimeFilter: (start: string, end: string) => Promise<void>;
  /** Fetch lines from backend for file mode. Returns a LineWindow. */
  fetchLines: (offset: number, count: number) => Promise<LineWindow>;
  handleSearch: (query: SearchQuery | null) => void;
  jumpToMatch: (direction: 1 | -1) => void;
  jumpToLine: (lineNum: number) => void;
  jumpToEnd: () => void;
  setProcessorView: (processorId: string) => void;
  clearProcessorView: () => void;
  closeSession: (paneId?: string) => Promise<void>;
  /** Non-null while background file indexing is in progress (focused session). */
  indexingProgress: { percent: number; indexedLines: number } | null;
  /** Current parsed filter state for file-mode filter scans */
  filterScanning: boolean;
  filteredLineNums: number[] | null;
  filterParseError: string | null;
  /** Current time range filter results */
  timeFilterLineNums: number[] | null;
}

export function useLogViewer(cacheManager: CacheController, registry: StreamPusher): LogViewerActions {
  // -- Session registry (new API) --
  const {
    sessions,
    paneSessionMap,
    focusedPaneId,
    registerSession,
    unregisterSession,
    updateSession,
    terminateSession,
    activateSessionForPane,
    setLoadingPane,
    setErrorPane,
    setIndexingProgress: setIndexingProgressCtx,
    setStreamingSession,
  } = useSessionContext();

  const {
    setSearch,
    setSearchSummary,
    setCurrentMatchIndex,
    setScrollToLine,
    setJumpSeq,
    setProcessorId,
    setStreamFilter: setStreamFilterCtx,
    setTimeFilterStart: setTimeFilterStartCtx,
    setTimeFilterEnd: setTimeFilterEndCtx,
  } = useViewerContext();

  // -- Local state for filter scanning and display progress --
  const [filterScanning, setFilterScanning] = useState(false);
  const [filteredLineNums, setFilteredLineNums] = useState<number[] | null>(null);
  const [filterParseError, setFilterParseError] = useState<string | null>(null);
  /** UI-facing progress (percent + lines) for the focused session's indexing. */
  const [indexingProgress, setIndexingProgressLocal] = useState<{ percent: number; indexedLines: number } | null>(null);
  const [timeFilterLineNums, setTimeFilterLineNums] = useState<number[] | null>(null);

  // -- Stable refs --

  /**
   * sessionRef always points to the focused pane's session.
   * Updated synchronously on each render (no useState needed — just a ref for callbacks).
   */
  const sessionRef = useRef<LoadResult | null>(null);
  // Compute and sync on every render (synchronous — no extra renders caused)
  const focusedSessionId = focusedPaneId ? paneSessionMap.get(focusedPaneId) : undefined;
  const focusedSession = focusedSessionId ? (sessions.get(focusedSessionId) ?? null) : null;
  sessionRef.current = focusedSession;

  const searchRef = useRef<SearchQuery | null>(null);
  const processorIdRef = useRef<string | null>(null);

  /** paneId the active ADB stream belongs to. */
  const streamingPaneIdRef = useRef<string | null>(null);
  /** sessionId the active ADB stream belongs to. */
  const streamingSessionIdRef = useRef<string | null>(null);
  const isStreamingRef = useRef(false);

  const filterAstRef = useRef<FilterNode | null>(null);
  const packagePidsRef = useRef<Map<string, number[]>>(new Map());
  const streamDeviceSerialRef = useRef<string | null>(null);
  const filterScanGenRef = useRef(0);
  const paneSessionMapRef = useRef(paneSessionMap);
  paneSessionMapRef.current = paneSessionMap;
  /** tabId → sessionId — tracks the session for each logviewer tab in the layout. */
  const tabSessionMapRef = useRef<Map<string, string>>(new Map());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // ADB event unlisteners
  const adbBatchUnlistenRef = useRef<UnlistenFn | null>(null);
  const adbStoppedUnlistenRef = useRef<UnlistenFn | null>(null);
  const searchProgressUnlistenRef = useRef<UnlistenFn | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      adbBatchUnlistenRef.current?.();
      adbStoppedUnlistenRef.current?.();
      searchProgressUnlistenRef.current?.();
    };
  }, []);

  const resetSessionState = useCallback(() => {
    const sess = sessionRef.current;
    if (sess) cacheManager.clearSession(sess.sessionId);
    setSearch(null);
    searchRef.current = null;
    setSearchSummary(null);
    setCurrentMatchIndex(0);
    setProcessorId(null);
    processorIdRef.current = null;
    setStreamFilterCtx('');
    setFilterParseError(null);
    setFilterScanning(false);
    setFilteredLineNums(null);
    filterAstRef.current = null;
    packagePidsRef.current = new Map();
    setTimeFilterStartCtx('');
    setTimeFilterEndCtx('');
    setTimeFilterLineNums(null);
  }, [cacheManager, setSearch, setSearchSummary, setCurrentMatchIndex, setProcessorId,
      setStreamFilterCtx, setTimeFilterStartCtx, setTimeFilterEndCtx]);

  const handleAdbBatch = useCallback((payload: AdbBatchPayload) => {
    // Only handle batches for the active stream's session
    if (payload.sessionId !== streamingSessionIdRef.current) return;

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
    const ast = filterAstRef.current;
    if (ast) {
      const pids = packagePidsRef.current;
      const newMatches = payload.lines
        .filter((line) => matchesFilter(ast, line, pids))
        .map((line) => line.lineNum);
      if (newMatches.length > 0) {
        setFilteredLineNums((prev) => [...(prev ?? []), ...newMatches]);
      }
    }
  }, [cacheManager, registry, updateSession]);

  const setStreamFilter = useCallback(async (expr: string) => {
    setStreamFilterCtx(expr);
    const gen = ++filterScanGenRef.current;

    if (!expr.trim()) {
      setFilterParseError(null);
      setFilteredLineNums(null);
      filterAstRef.current = null;
      return;
    }

    let ast: FilterNode | null;
    try {
      ast = parseFilter(expr);
      setFilterParseError(null);
    } catch (e) {
      setFilterParseError(e instanceof FilterParseError ? e.message : String(e));
      filterAstRef.current = null;
      setFilteredLineNums(null);
      return;
    }

    if (!ast) {
      filterAstRef.current = null;
      setFilteredLineNums(null);
      return;
    }

    filterAstRef.current = ast;

    const packageNames = extractPackageNames(ast);
    const serial = streamDeviceSerialRef.current;
    if (serial && packageNames.length > 0) {
      const resolvePromises = packageNames
        .filter((pkg) => !packagePidsRef.current.has(pkg))
        .map(async (pkg) => {
          try {
            const pids = await getPackagePids(serial, pkg);
            packagePidsRef.current.set(pkg, pids);
          } catch {
            packagePidsRef.current.set(pkg, []);
          }
        });
      await Promise.all(resolvePromises);
    }

    const pids = packagePidsRef.current;

    if (isStreamingRef.current) {
      const nums: number[] = [];
      const sess = sessionRef.current;
      if (sess) {
        for (const [lineNum, line] of cacheManager.getSessionEntries(sess.sessionId)) {
          if (matchesFilter(ast, line, pids)) nums.push(lineNum);
        }
      }
      nums.sort((a, b) => a - b);
      setFilteredLineNums(nums);
    } else {
      const sess = sessionRef.current;
      if (!sess) return;

      setFilterScanning(true);
      const BATCH = 5000;
      const matches: number[] = [];
      let offset = 0;
      let total = Infinity;

      while (offset < total) {
        if (filterScanGenRef.current !== gen) {
          setFilterScanning(false);
          return;
        }
        try {
          const window = await getLines({
            sessionId: sess.sessionId,
            mode: { mode: 'Full' },
            offset,
            count: BATCH,
            context: 0,
          });
          total = window.totalLines;
          for (const line of window.lines) {
            if (matchesFilter(ast, line, pids)) matches.push(line.lineNum);
          }
          offset += window.lines.length;
          if (window.lines.length === 0) break;
        } catch {
          break;
        }
      }
      if (filterScanGenRef.current === gen) {
        setFilteredLineNums(matches.length > 0 ? matches : null);
        setFilterScanning(false);
      }
    }
  }, [cacheManager, setStreamFilterCtx]);

  const setTimeFilter = useCallback(async (start: string, end: string) => {
    setTimeFilterStartCtx(start);
    setTimeFilterEndCtx(end);

    if (!start.trim() && !end.trim()) {
      setTimeFilterLineNums(null);
      return;
    }

    const sess = sessionRef.current;
    if (!sess) {
      setTimeFilterLineNums(null);
      return;
    }

    try {
      const summary = await searchLogs(sess.sessionId, {
        text: '',
        isRegex: false,
        caseSensitive: false,
        startTime: start.trim() || undefined,
        endTime: end.trim() || undefined,
      });
      setTimeFilterLineNums(summary.matchLineNums);
    } catch (e) {
      console.error('Time filter error:', e);
    }
  }, [setTimeFilterStartCtx, setTimeFilterEndCtx]);

  const fetchLines = useCallback((offset: number, count: number): Promise<LineWindow> => {
    const sess = sessionRef.current;
    if (!sess) return Promise.resolve({ totalLines: 0, lines: [] });

    const pid = processorIdRef.current;
    const mode = pid
      ? { mode: 'Processor' as const }
      : { mode: 'Full' as const };

    return getLines({
      sessionId: sess.sessionId,
      mode,
      offset,
      count,
      context: 3,
      processorId: pid ?? undefined,
      search: searchRef.current ?? undefined,
    });
  }, []);

  /** Per-pane load generation. Increment on each new load; stale results are discarded. */
  const loadGenRef = useRef<Map<string, number>>(new Map());

  const loadFile = useCallback(async (path: string, paneId?: string) => {
    const targetPaneId = paneId ?? focusedPaneId ?? getStoredFirstPaneId() ?? DEFAULT_PANE_ID;

    // Claim this pane. Any in-flight load for the same pane becomes stale.
    const gen = (loadGenRef.current.get(targetPaneId) ?? 0) + 1;
    loadGenRef.current.set(targetPaneId, gen);

    // Pre-assign a tab ID. Workspace layout will create the logviewer tab with this
    // exact ID so we can look up its session when the user switches between tabs.
    const tabId = crypto.randomUUID();

    // If the target pane already has a session, the new file opens as an additional
    // tab alongside the existing one instead of replacing it.
    const previousSessionId = paneSessionMapRef.current.get(targetPaneId);
    const isNewTab = previousSessionId !== undefined;

    if (!isNewTab) {
      if (previousSessionId) {
        try { await closeSessionCmd(previousSessionId); } catch { /* ignore */ }
        terminateSession(previousSessionId);
        // Remove the stale tab→session mapping for the evicted session so
        // tabSessionMapRef doesn't accumulate orphaned entries over time.
        for (const [tid, sid] of tabSessionMapRef.current.entries()) {
          if (sid === previousSessionId) {
            tabSessionMapRef.current.delete(tid);
            break;
          }
        }
      }

      bus.emit('session:pre-load', { paneId: targetPaneId });

      // Clean up any active stream on this pane
      if (streamingPaneIdRef.current === targetPaneId) {
        adbBatchUnlistenRef.current?.();
        adbBatchUnlistenRef.current = null;
        adbStoppedUnlistenRef.current?.();
        adbStoppedUnlistenRef.current = null;
        if (streamingSessionIdRef.current) {
          setStreamingSession(streamingSessionIdRef.current, false);
        }
        isStreamingRef.current = false;
        streamingPaneIdRef.current = null;
        streamingSessionIdRef.current = null;
      }

      setIndexingProgressLocal(null);
      // Only wipe the shared ViewerContext state (search, filter, processorId, etc.)
      // when loading into the focused pane. If the user is loading a file into a
      // background pane, clearing global viewer state would disrupt the focused pane.
      if (targetPaneId === focusedPaneId || !focusedPaneId) {
        resetSessionState();
      }
    }

    setLoadingPane(targetPaneId, true);
    setErrorPane(targetPaneId, null);

    try {
      const result = await loadLogFile(path);

      // Stale check: a newer load claimed this pane while we were awaiting.
      if (loadGenRef.current.get(targetPaneId) !== gen) {
        try { await closeSessionCmd(result.sessionId); } catch { /* ignore */ }
        return;
      }

      registerSession(targetPaneId, result);
      tabSessionMapRef.current.set(tabId, result.sessionId);

      // For non-new-tab loads (replacing the pane's session), immediately activate the
      // new session. For new-tab loads, paneSessionMap stays on the previous active tab —
      // activation happens via layout:logviewer-tab-activated when the user switches tabs.
      if (!isNewTab) {
        activateSessionForPane(targetPaneId, result.sessionId);
      }

      // If result is still indexing, set a sentinel so useFileInfo waits for completion.
      if (result.isIndexing) {
        setIndexingProgressCtx(result.sessionId, { linesIndexed: 0, totalLines: 0, done: false });
      }

      try { localStorage.setItem(LS_LAST_FILE, path); } catch { /* storage full */ }

      // Auto-focus: emitting session:focused updates both SessionContext and WorkspaceLayout.
      bus.emit('session:focused', { sessionId: result.sessionId, paneId: targetPaneId });
      bus.emit('session:loaded', {
        sourceName: result.sourceName,
        sourceType: result.sourceType as SourceType,
        sessionId: result.sessionId,
        paneId: targetPaneId,
        tabId,
        isNewTab,
        previousSessionId,
      });

      // Source-type-specific events
      if (result.sourceType === 'Bugreport') {
        bus.emit('session:dumpstate:opened', {
          sessionId: result.sessionId,
          paneId: targetPaneId,
          sourceName: result.sourceName,
        });
      } else if (result.sourceType === 'Logcat') {
        bus.emit('session:logcat:opened', {
          sessionId: result.sessionId,
          paneId: targetPaneId,
          sourceName: result.sourceName,
        });
      }
    } catch (e) {
      // Only apply the error if this load is still the current one for the pane.
      if (loadGenRef.current.get(targetPaneId) === gen) {
        try { localStorage.removeItem(LS_LAST_FILE); } catch { /* ignore */ }
        setErrorPane(targetPaneId, String(e));
      }
    } finally {
      // Only clear loading state if this load is still current; the winning load
      // will clear it otherwise.
      if (loadGenRef.current.get(targetPaneId) === gen) {
        loadGenRef.current.delete(targetPaneId);
        setLoadingPane(targetPaneId, false);
      }
    }
  }, [
    focusedPaneId, registerSession, activateSessionForPane, setLoadingPane, setErrorPane,
    setIndexingProgressCtx, setStreamingSession, resetSessionState,
  ]);

  // Wire up Tauri file drag-and-drop (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      if (event.payload.type === 'drop' && event.payload.paths.length > 0) {
        loadFile(event.payload.paths[0]);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadFile]);

  // Restore the last-opened file on app startup (StrictMode double-mount guard)
  const hasRestoredRef = useRef(false);
  useEffect(() => {
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;
    const saved = localStorage.getItem(LS_LAST_FILE);
    if (saved) loadFile(saved, getStoredFirstPaneId() ?? DEFAULT_PANE_ID);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to progressive file-indexing events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    let unlistenProgress: UnlistenFn | null = null;
    let unlistenComplete: UnlistenFn | null = null;

    onFileIndexProgress((payload) => {
      if (cancelled) return;
      // Update whichever session is indexing (could be any pane)
      updateSession(payload.sessionId, (prev) => ({
        ...prev,
        totalLines: payload.indexedLines,
      }));
      const percent = payload.totalBytes > 0
        ? (payload.bytesScanned / payload.totalBytes) * 100
        : 0;
      // Update context progress for useFileInfo reactive dep
      setIndexingProgressCtx(payload.sessionId, {
        linesIndexed: payload.indexedLines,
        totalLines: payload.totalBytes > 0 ? payload.totalBytes : 0,
        done: false,
      });
      // Update local UI progress only for the focused session
      if (payload.sessionId === sessionRef.current?.sessionId) {
        setIndexingProgressLocal({ percent, indexedLines: payload.indexedLines });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenProgress = fn;
    });

    onFileIndexComplete((payload) => {
      if (cancelled) return;
      updateSession(payload.sessionId, (prev) => ({
        ...prev,
        totalLines: payload.totalLines,
        isIndexing: false,
      }));
      // Signal completion — null means "done"
      setIndexingProgressCtx(payload.sessionId, null);
      if (payload.sessionId === sessionRef.current?.sessionId) {
        setIndexingProgressLocal(null);
      }
      // Emit generic and source-type-specific indexing-complete events
      bus.emit('session:indexing-complete', {
        sessionId: payload.sessionId,
        totalLines: payload.totalLines,
      });
      // Find the session to determine source type
      // (sessions Map is read via closure — will have the latest value at call time)
      // We emit dumpstate:indexing-complete if the session is a Bugreport
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenComplete = fn;
    });

    return () => {
      cancelled = true;
      unlistenProgress?.();
      unlistenComplete?.();
    };
  }, [updateSession, setIndexingProgressCtx]);

  // Emit session:dumpstate:indexing-complete when indexing completes for Bugreport sessions.
  // Separate effect so it can read the current sessions Map without stale closure.
  useEffect(() => {
    const handler = (e: { sessionId: string; totalLines: number }) => {
      const sess = sessions.get(e.sessionId);
      if (sess?.sourceType === 'Bugreport') {
        bus.emit('session:dumpstate:indexing-complete', {
          sessionId: e.sessionId,
          totalLines: e.totalLines,
        });
      }
    };
    bus.on('session:indexing-complete', handler);
    return () => { bus.off('session:indexing-complete', handler); };
  }, [sessions]);

  const startStream = useCallback(async (
    deviceId?: string,
    packageFilter?: string,
    activeProcessorIds: string[] = [],
    maxRawLines?: number,
  ) => {
    adbBatchUnlistenRef.current?.();
    adbBatchUnlistenRef.current = null;
    adbStoppedUnlistenRef.current?.();
    adbStoppedUnlistenRef.current = null;

    const targetPaneId = focusedPaneId ?? DEFAULT_PANE_ID;
    bus.emit('session:pre-load', { paneId: targetPaneId });
    setLoadingPane(targetPaneId, true);
    setErrorPane(targetPaneId, null);
    resetSessionState();

    streamDeviceSerialRef.current = deviceId ?? null;

    try {
      const result = await startAdbStream(deviceId, packageFilter, activeProcessorIds, maxRawLines);

      registerSession(targetPaneId, result);
      activateSessionForPane(targetPaneId, result.sessionId);
      setStreamingSession(result.sessionId, true);
      isStreamingRef.current = true;
      streamingPaneIdRef.current = targetPaneId;
      streamingSessionIdRef.current = result.sessionId;

      const unlistenBatch = await onAdbBatch(handleAdbBatch);
      adbBatchUnlistenRef.current = unlistenBatch;

      const unlistenStopped = await onAdbStreamStopped((payload) => {
        if (payload.sessionId !== streamingSessionIdRef.current) return;
        setStreamingSession(payload.sessionId, false);
        isStreamingRef.current = false;
        const stoppedPaneId = streamingPaneIdRef.current ?? targetPaneId;
        streamingPaneIdRef.current = null;
        streamingSessionIdRef.current = null;
        adbBatchUnlistenRef.current?.();
        adbBatchUnlistenRef.current = null;
        bus.emit('stream:stopped', { sessionId: payload.sessionId, paneId: stoppedPaneId });
      });
      adbStoppedUnlistenRef.current = unlistenStopped;

      setLoadingPane(targetPaneId, false);

      // Auto-focus the streaming pane
      bus.emit('session:focused', { sessionId: result.sessionId, paneId: targetPaneId });
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
      isStreamingRef.current = false;
      streamingPaneIdRef.current = null;
      streamingSessionIdRef.current = null;
      setLoadingPane(targetPaneId, false);
    }
  }, [
    focusedPaneId, registerSession, activateSessionForPane, setLoadingPane, setErrorPane,
    setStreamingSession, handleAdbBatch, resetSessionState,
  ]);

  const stopStream = useCallback(async () => {
    const sessionId = streamingSessionIdRef.current;
    const paneId = streamingPaneIdRef.current;
    if (!sessionId) return;
    try {
      await stopAdbStream(sessionId);
    } catch (e) {
      console.error('Error stopping ADB stream:', e);
    }
    adbBatchUnlistenRef.current?.();
    adbBatchUnlistenRef.current = null;
    adbStoppedUnlistenRef.current?.();
    adbStoppedUnlistenRef.current = null;
    setStreamingSession(sessionId, false);
    isStreamingRef.current = false;
    const stoppedPaneId = paneId ?? (focusedPaneId ?? DEFAULT_PANE_ID);
    streamingPaneIdRef.current = null;
    streamingSessionIdRef.current = null;
    bus.emit('stream:stopped', { sessionId, paneId: stoppedPaneId });
  }, [setStreamingSession, focusedPaneId]);

  const handleSearch = useCallback(
    async (query: SearchQuery | null) => {
      const sess = sessionRef.current;
      setSearch(query);
      searchRef.current = query;
      setCurrentMatchIndex(0);

      searchProgressUnlistenRef.current?.();
      searchProgressUnlistenRef.current = null;

      if (!sess || !query) {
        setSearchSummary(null);
        return;
      }

      const accumulatedMatches: number[] = [];
      let jumpedToFirst = false;

      const unlisten = await onSearchProgress((payload: SearchProgress) => {
        if (payload.sessionId !== sess.sessionId) return;

        if (payload.newMatches.length > 0) {
          accumulatedMatches.push(...payload.newMatches);
          setSearchSummary((prev) => ({
            totalMatches: payload.matchedSoFar,
            matchLineNums: [...accumulatedMatches],
            byLevel: prev?.byLevel ?? {},
            byTag: prev?.byTag ?? {},
          }));
          if (!jumpedToFirst) {
            jumpedToFirst = true;
            setScrollToLine(accumulatedMatches[0]);
          }
        }

        if (payload.done) {
          searchProgressUnlistenRef.current?.();
          searchProgressUnlistenRef.current = null;
        }
      });
      searchProgressUnlistenRef.current = unlisten;

      try {
        const summary = await searchLogs(sess.sessionId, query);
        setSearchSummary(summary);
        setCurrentMatchIndex(0);
        if (summary.matchLineNums.length > 0 && !jumpedToFirst) {
          setScrollToLine(summary.matchLineNums[0]);
          setJumpSeq((s) => s + 1);
        }
      } catch (e) {
        console.error('Search error:', e);
      } finally {
        searchProgressUnlistenRef.current?.();
        searchProgressUnlistenRef.current = null;
      }
    },
    [setSearch, setSearchSummary, setCurrentMatchIndex, setScrollToLine, setJumpSeq],
  );

  const jumpToMatch = useCallback(
    (direction: 1 | -1) => {
      setSearchSummary((summary) => {
        if (!summary || summary.matchLineNums.length === 0) return summary;
        setCurrentMatchIndex((idx) => {
          const len = summary.matchLineNums.length;
          const next = (idx + direction + len) % len;
          setScrollToLine(summary.matchLineNums[next]);
          setJumpSeq((s) => s + 1);
          return next;
        });
        return summary;
      });
    },
    [setSearchSummary, setCurrentMatchIndex, setScrollToLine, setJumpSeq],
  );

  const jumpToLine = useCallback((lineNum: number) => {
    setScrollToLine(lineNum);
    setJumpSeq((s) => s + 1);
  }, [setScrollToLine, setJumpSeq]);

  const jumpToEnd = useCallback(() => {
    const total = sessionRef.current?.totalLines ?? 0;
    if (total <= 0) return;
    setScrollToLine(total - 1);
    setJumpSeq((s) => s + 1);
  }, [setScrollToLine, setJumpSeq]);

  const setProcessorView = useCallback((id: string) => {
    setProcessorId(id);
    processorIdRef.current = id;
  }, [setProcessorId]);

  const clearProcessorView = useCallback(() => {
    setProcessorId(null);
    processorIdRef.current = null;
  }, [setProcessorId]);

  const closeSession = useCallback(async (paneId?: string, tabId?: string) => {
    const targetPaneId = paneId ?? focusedPaneId ?? DEFAULT_PANE_ID;

    // When a tabId is provided, close that specific tab's session.
    // Otherwise close the currently active session for the pane.
    let sessionId: string | undefined;
    if (tabId) {
      sessionId = tabSessionMapRef.current.get(tabId);
      tabSessionMapRef.current.delete(tabId);
    } else {
      sessionId = paneSessionMapRef.current.get(targetPaneId);
    }

    if (!sessionId) return;

    // Stop stream if this session is streaming
    if (streamingSessionIdRef.current === sessionId) {
      await stopStream();
    }

    try {
      await closeSessionCmd(sessionId);
    } catch (e) {
      console.error('Error closing session:', e);
    }

    try { localStorage.removeItem(LS_LAST_FILE); } catch { /* ignore */ }

    const sourceType = (sessionsRef.current.get(sessionId)?.sourceType ?? 'Unknown') as SourceType;

    // Use the ref (not the closure value) — paneSessionMap may have changed while
    // we were awaiting closeSessionCmd, and a stale value here would cause
    // unregisterSession to delete the wrong session from the sessions map.
    const isActivePaneSession = paneSessionMapRef.current.get(targetPaneId) === sessionId;
    if (isActivePaneSession) {
      resetSessionState();
      setIndexingProgressLocal(null);
      setIndexingProgressCtx(sessionId, null);
      unregisterSession(targetPaneId);
    } else {
      // Non-active tab: remove session data without touching the pane's active session.
      setIndexingProgressCtx(sessionId, null);
      terminateSession(sessionId);
    }

    bus.emit('session:closed', { sessionId, paneId: targetPaneId, sourceType, tabId });
  }, [focusedPaneId, resetSessionState, stopStream,
      setIndexingProgressCtx, unregisterSession, terminateSession]);

  // Close the backend session when the user closes a logviewer tab via the UI.
  // Uses a ref so the handler always sees the current closeSession without
  // re-subscribing on every render.
  const closeSessionRef = useRef(closeSession);
  useEffect(() => { closeSessionRef.current = closeSession; }, [closeSession]);
  useEffect(() => {
    const handleTabClosed = ({ tabId, paneId }: { tabId: string; paneId: string }) => {
      closeSessionRef.current(paneId, tabId);
    };
    const handleTabActivated = ({ tabId, paneId }: { tabId: string; paneId: string }) => {
      const sessionId = tabSessionMapRef.current.get(tabId);
      if (sessionId) activateSessionForPane(paneId, sessionId);
    };
    const handleTabBind = ({ tabId, sessionId }: { tabId: string; sessionId: string; paneId: string }) => {
      tabSessionMapRef.current.set(tabId, sessionId);
    };
    const handlePaneRemap = ({ originalPaneId, actualPaneId, sessionId }: {
      originalPaneId: string; actualPaneId: string; sessionId: string;
    }) => {
      // Session was registered under a placeholder pane ID (e.g. 'primary') but the
      // tab landed in a different pane. Re-register under the real pane ID so
      // PaneContent can find the session via useSessionForPane(pane.id).
      activateSessionForPane(actualPaneId, sessionId);
      unregisterSession(originalPaneId);
    };
    bus.on('layout:logviewer-tab-closed', handleTabClosed);
    bus.on('layout:logviewer-tab-activated', handleTabActivated);
    bus.on('layout:tab-session-bind', handleTabBind);
    bus.on('layout:pane-session-remap', handlePaneRemap);
    return () => {
      bus.off('layout:logviewer-tab-closed', handleTabClosed);
      bus.off('layout:logviewer-tab-activated', handleTabActivated);
      bus.off('layout:tab-session-bind', handleTabBind);
      bus.off('layout:pane-session-remap', handlePaneRemap);
    };
  }, [activateSessionForPane, unregisterSession]);

  // Subscribe to pipeline:chain-changed to update stream processors/trackers/transformers
  useEffect(() => {
    const handleChainChanged = (data: { chain: string[] }) => {
      const sessionId = streamingSessionIdRef.current;
      if (!sessionId || !isStreamingRef.current) return;
      updateStreamProcessors(sessionId, data.chain).catch(() => {});
      updateStreamTrackers(sessionId, data.chain).catch(() => {});
      updateStreamTransformers(sessionId, data.chain).catch(() => {});
    };
    bus.on('pipeline:chain-changed', handleChainChanged);
    return () => { bus.off('pipeline:chain-changed', handleChainChanged); };
  }, []);

  return {
    loadFile,
    startStream,
    stopStream,
    setStreamFilter,
    setTimeFilter,
    fetchLines,
    handleSearch,
    jumpToMatch,
    jumpToLine,
    jumpToEnd,
    setProcessorView,
    clearProcessorView,
    closeSession,
    indexingProgress,
    filterScanning,
    filteredLineNums,
    filterParseError,
    timeFilterLineNums,
  };
}
