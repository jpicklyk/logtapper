import { useState, useCallback, useRef, useEffect } from 'react';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { SearchQuery, SearchProgress, LoadResult, AdbBatchPayload, LineWindow } from '../bridge/types';
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

const LS_LAST_FILE = 'logtapper_last_file';

export interface LogViewerActions {
  loadFile: (path: string) => Promise<void>;
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
  closeSession: () => Promise<void>;
  /** Current parsed filter state for file-mode filter scans */
  filterScanning: boolean;
  filteredLineNums: number[] | null;
  filterParseError: string | null;
  /** Non-null while background file indexing is in progress. */
  indexingProgress: { percent: number; indexedLines: number } | null;
  /** Current time range filter results */
  timeFilterLineNums: number[] | null;
}

export function useLogViewer(cacheManager: CacheController, registry: StreamPusher): LogViewerActions {
  // -- Context setters --
  const {
    session, setSession,
    setSessionGeneration,
    setIsStreaming,
    setLoading,
    setError,
    setIndexingProgress: setIndexingProgressCtx,
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

  // -- Local state for filter scanning (not in context) --
  const [filterScanning, setFilterScanning] = useState(false);
  const [filteredLineNums, setFilteredLineNums] = useState<number[] | null>(null);
  const [filterParseError, setFilterParseError] = useState<string | null>(null);
  const [indexingProgress, setIndexingProgress] = useState<{ percent: number; indexedLines: number } | null>(null);
  const [timeFilterLineNums, setTimeFilterLineNums] = useState<number[] | null>(null);

  // -- Refs for stable callback access --
  const sessionRef = useRef<LoadResult | null>(null);
  const searchRef = useRef<SearchQuery | null>(null);
  const processorIdRef = useRef<string | null>(null);
  const isStreamingRef = useRef(false);

  // Keep session ref in sync
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Filter refs
  const filterAstRef = useRef<FilterNode | null>(null);
  const packagePidsRef = useRef<Map<string, number[]>>(new Map());
  const streamDeviceSerialRef = useRef<string | null>(null);
  const filterScanGenRef = useRef(0);

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
    const sid = sessionRef.current?.sessionId;
    if (sid) cacheManager.clearSession(sid);
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
    if (payload.sessionId !== sessionRef.current?.sessionId) return;

    // Populate ViewCacheHandle LRU for all handles on this session
    cacheManager.broadcastToSession(payload.sessionId, payload.lines);
    // Fire onAppend listeners on all CacheDataSources for this session (tail-mode)
    registry.pushToSession(payload.sessionId, payload.lines, payload.totalLines);

    setSession((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        totalLines: payload.totalLines,
        fileSize: payload.byteCount,
        firstTimestamp: prev.firstTimestamp ?? payload.firstTimestamp,
        lastTimestamp: payload.lastTimestamp,
      };
    });

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
  }, [cacheManager, registry, setSession]);

  /**
   * Parse and apply a composable filter expression.
   */
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

    // Resolve package: atoms to PIDs
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
      // Streaming mode: scan CacheManager session entries
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
      // File mode: scan the file in batches
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
            if (matchesFilter(ast, line, pids)) {
              matches.push(line.lineNum);
            }
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

  /**
   * Apply a time-of-day range filter.
   */
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

  /**
   * Fetch lines from the backend for file mode rendering.
   */
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

  const loadingGuardRef = useRef(false);
  const loadFile = useCallback(async (path: string) => {
    if (loadingGuardRef.current) return;
    loadingGuardRef.current = true;

    // Emit pre-load event (replaces onBeforeLoad callback)
    bus.emit('session:pre-load', undefined);

    // Clean up any active stream first
    adbBatchUnlistenRef.current?.();
    adbBatchUnlistenRef.current = null;
    adbStoppedUnlistenRef.current?.();
    adbStoppedUnlistenRef.current = null;
    setIsStreaming(false);
    isStreamingRef.current = false;

    setIndexingProgress(null);
    setIndexingProgressCtx(null);
    setLoading(true);
    setError(null);
    resetSessionState();
    try {
      const result = await loadLogFile(path);
      setSessionGeneration((g) => g + 1);
      setSession(result);
      sessionRef.current = result;
      try { localStorage.setItem(LS_LAST_FILE, path); } catch { /* storage full */ }
      setLoading(false);
      // Emit session:loaded
      bus.emit('session:loaded', {
        sourceName: result.sourceName,
        sourceType: result.sourceType,
        sessionId: result.sessionId,
      });
    } catch (e) {
      try { localStorage.removeItem(LS_LAST_FILE); } catch { /* ignore */ }
      setError(String(e));
      setLoading(false);
    } finally {
      loadingGuardRef.current = false;
    }
  }, [resetSessionState, setIsStreaming, setLoading, setError, setSession, setSessionGeneration, setIndexingProgressCtx]);

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
    if (saved) loadFile(saved);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to progressive file-indexing events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    let unlistenProgress: UnlistenFn | null = null;
    let unlistenComplete: UnlistenFn | null = null;

    onFileIndexProgress((payload) => {
      if (cancelled) return;
      if (payload.sessionId !== sessionRef.current?.sessionId) return;
      const percent = payload.totalBytes > 0
        ? (payload.bytesScanned / payload.totalBytes) * 100
        : 0;
      setIndexingProgress({ percent, indexedLines: payload.indexedLines });
      setIndexingProgressCtx({ linesIndexed: payload.indexedLines, totalLines: 0, done: false });
      setSession((prev) => {
        if (!prev || prev.sessionId !== payload.sessionId) return prev;
        return { ...prev, totalLines: payload.indexedLines };
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenProgress = fn;
    });

    onFileIndexComplete((payload) => {
      if (cancelled) return;
      if (payload.sessionId !== sessionRef.current?.sessionId) return;
      setSession((prev) => {
        if (!prev || prev.sessionId !== payload.sessionId) return prev;
        return { ...prev, totalLines: payload.totalLines };
      });
      setIndexingProgress(null);
      setIndexingProgressCtx(null);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenComplete = fn;
    });

    return () => {
      cancelled = true;
      unlistenProgress?.();
      unlistenComplete?.();
    };
  }, [setSession, setIndexingProgressCtx]);

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

    // Emit pre-load event
    bus.emit('session:pre-load', undefined);

    setLoading(true);
    setError(null);
    resetSessionState();

    streamDeviceSerialRef.current = deviceId ?? null;

    try {
      const result = await startAdbStream(deviceId, packageFilter, activeProcessorIds, maxRawLines);
      setSessionGeneration((g) => g + 1);
      setSession(result);
      sessionRef.current = result;
      setIsStreaming(true);
      isStreamingRef.current = true;

      // Subscribe to incoming line batches
      const unlistenBatch = await onAdbBatch(handleAdbBatch);
      adbBatchUnlistenRef.current = unlistenBatch;

      // Subscribe to stream-stopped
      const unlistenStopped = await onAdbStreamStopped((payload) => {
        if (payload.sessionId !== sessionRef.current?.sessionId) return;
        setIsStreaming(false);
        isStreamingRef.current = false;
        adbBatchUnlistenRef.current?.();
        adbBatchUnlistenRef.current = null;
        bus.emit('stream:stopped', { sessionId: payload.sessionId });
      });
      adbStoppedUnlistenRef.current = unlistenStopped;

      // Emit stream:started
      bus.emit('stream:started', {
        sessionId: result.sessionId,
        deviceSerial: deviceId ?? '',
      });
    } catch (e) {
      setError(String(e));
      setIsStreaming(false);
      isStreamingRef.current = false;
    } finally {
      setLoading(false);
    }
  }, [resetSessionState, handleAdbBatch, setLoading, setError, setSession, setSessionGeneration, setIsStreaming]);

  const stopStream = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await stopAdbStream(sess.sessionId);
    } catch (e) {
      console.error('Error stopping ADB stream:', e);
    }
    adbBatchUnlistenRef.current?.();
    adbBatchUnlistenRef.current = null;
    adbStoppedUnlistenRef.current?.();
    adbStoppedUnlistenRef.current = null;
    setIsStreaming(false);
    isStreamingRef.current = false;
    bus.emit('stream:stopped', { sessionId: sess.sessionId });
  }, [setIsStreaming]);

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

  const closeSession = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;

    if (isStreamingRef.current) {
      await stopStream();
    }

    try {
      await closeSessionCmd(sess.sessionId);
    } catch (e) {
      console.error('Error closing session:', e);
    }

    try { localStorage.removeItem(LS_LAST_FILE); } catch { /* ignore */ }

    resetSessionState();
    setSession(null);
    sessionRef.current = null;
    setLoading(false);
    setError(null);
    setIndexingProgress(null);
    setIndexingProgressCtx(null);
    setIsStreaming(false);
    isStreamingRef.current = false;
    bus.emit('session:closed', undefined);
  }, [resetSessionState, stopStream, setSession, setLoading, setError, setIsStreaming, setIndexingProgressCtx]);

  // Subscribe to pipeline:chain-changed to update stream processors/trackers/transformers
  useEffect(() => {
    const handleChainChanged = (data: { chain: string[] }) => {
      const sess = sessionRef.current;
      if (!sess || !isStreamingRef.current) return;
      // Fire-and-forget updates to the backend
      updateStreamProcessors(sess.sessionId, data.chain).catch(() => {});
      updateStreamTrackers(sess.sessionId, data.chain).catch(() => {});
      updateStreamTransformers(sess.sessionId, data.chain).catch(() => {});
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
    filterScanning,
    filteredLineNums,
    filterParseError,
    indexingProgress,
    timeFilterLineNums,
  };
}
