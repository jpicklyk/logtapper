import { useState, useCallback, useRef, useEffect } from 'react';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { ViewLine, SearchQuery, SearchSummary, SearchProgress, LoadResult, AdbBatchPayload } from '../bridge/types';
import { loadLogFile, getLines, searchLogs, startAdbStream, stopAdbStream, getPackagePids, closeSession as closeSessionCmd } from '../bridge/commands';

import { onAdbBatch, onAdbStreamStopped, onFileIndexProgress, onFileIndexComplete, onSearchProgress } from '../bridge/events';
import { parseFilter, matchesFilter, extractPackageNames, type FilterNode, FilterParseError } from '../filter';

const WINDOW_SIZE = 500; // lines to fetch per request
const LS_LAST_FILE = 'logtapper_last_file';

export interface LogViewerState {
  session: LoadResult | null;
  lineCache: Map<number, ViewLine>;
  search: SearchQuery | null;
  searchSummary: SearchSummary | null;
  currentMatchIndex: number;
  scrollToLine: number | undefined;
  /** Incremented on every jumpToLine call so repeated jumps to the same line
   *  still trigger the scroll effect and re-flash the highlight. */
  jumpSeq: number;
  loading: boolean;
  error: string | null;
  processorId: string | null;
  isStreaming: boolean;
  /** Current raw filter expression (empty = no filter) */
  streamFilter: string;
  /** Parse error from the last setStreamFilter call */
  filterParseError: string | null;
  /**
   * When a filter is active, this array maps virtualizer index → actual
   * line number. null means no filter (show all lines).
   */
  filteredLineNums: number[] | null;
  /** Maximum frontend cache size in lines (0 = unlimited). */
  cacheMax: number;
  /** Non-null while background file indexing is in progress. */
  indexingProgress: { percent: number; indexedLines: number } | null;
  /** Current time range filter start ("HH:MM"), empty = not set */
  timeStart: string;
  /** Current time range filter end ("HH:MM"), empty = not set */
  timeEnd: string;
  /**
   * Line numbers matching the active time range filter.
   * null = no time filter active; [] = filter active but 0 matches.
   */
  timeFilterLineNums: number[] | null;

  loadFile: (path: string) => Promise<void>;
  startStream: (deviceId?: string, packageFilter?: string, activeProcessorIds?: string[], maxRawLines?: number) => Promise<void>;
  stopStream: () => Promise<void>;
  setStreamFilter: (expr: string) => Promise<void>;
  setTimeFilter: (start: string, end: string) => Promise<void>;
  handleFetchNeeded: (offset: number, count: number) => void;
  handleSearch: (query: SearchQuery | null) => void;
  jumpToMatch: (direction: 1 | -1) => void;
  jumpToLine: (lineNum: number) => void;
  jumpToEnd: () => void;
  setProcessorView: (processorId: string) => void;
  clearProcessorView: () => void;
  closeSession: () => Promise<void>;
}

/**
 * @param frontendCacheMax - Maximum number of ViewLine entries kept in the
 *   frontend lineCache. When exceeded, the oldest entries (lowest lineNum) are
 *   evicted. 0 = unlimited. Updated via useEffect so changes take effect on the
 *   next streaming batch.
 */
export function useLogViewer(frontendCacheMax: number = 50_000, onBeforeLoad?: () => void): LogViewerState {
  const [session, setSession] = useState<LoadResult | null>(null);
  const [search, setSearch] = useState<SearchQuery | null>(null);
  const [searchSummary, setSearchSummary] = useState<SearchSummary | null>(null);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [scrollToLine, setScrollToLine] = useState<number | undefined>(undefined);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processorId, setProcessorId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamFilter, setStreamFilterExpr] = useState('');
  const [filterParseError, setFilterParseError] = useState<string | null>(null);
  const [filteredLineNums, setFilteredLineNums] = useState<number[] | null>(null);
  const [timeStart, setTimeStartState] = useState('');
  const [timeEnd, setTimeEndState] = useState('');
  const [timeFilterLineNums, setTimeFilterLineNums] = useState<number[] | null>(null);
  const [indexingProgress, setIndexingProgress] = useState<{ percent: number; indexedLines: number } | null>(null);
  const timeStartRef = useRef('');
  const timeEndRef = useRef('');

  // Cache version triggers re-renders when lineCacheRef is mutated (file fetch path).
  const [, setCacheVersion] = useState(0);

  // Track in-flight fetch requests to avoid duplicates
  const pendingFetches = useRef<Set<string>>(new Set());
  const sessionRef = useRef<LoadResult | null>(null);
  const searchRef = useRef<SearchQuery | null>(null);
  const processorIdRef = useRef<string | null>(null);
  const isStreamingRef = useRef(false);

  // Keep frontendCacheMax in a ref so handleAdbBatch (stable callback) reads the latest value.
  const frontendCacheMaxRef = useRef(frontendCacheMax);
  useEffect(() => { frontendCacheMaxRef.current = frontendCacheMax; }, [frontendCacheMax]);

  // Keep onBeforeLoad in a ref so loadFile (stable callback) sees the latest value.
  const onBeforeLoadRef = useRef(onBeforeLoad);
  useEffect(() => { onBeforeLoadRef.current = onBeforeLoad; }, [onBeforeLoad]);

  // Filter refs — writable from callbacks without causing re-renders
  const filterAstRef = useRef<FilterNode | null>(null);
  const packagePidsRef = useRef<Map<string, number[]>>(new Map());
  const streamDeviceSerialRef = useRef<string | null>(null);

  // Mutable lineCache backing store — never replaced during streaming batches,
  // only mutated in place. This eliminates the O(N) new Map(prev) copy every 50 ms.
  // Re-renders are triggered by:
  //   • setSession()  — streaming batch path (updates totalLines + file info)
  //   • setCacheVersion() — file fetch path (no session update needed)
  const lineCacheRef = useRef<Map<number, ViewLine>>(new Map());

  // ADB event unlisteners
  const adbBatchUnlistenRef = useRef<UnlistenFn | null>(null);
  const adbStoppedUnlistenRef = useRef<UnlistenFn | null>(null);

  // Search-progress event unlistener (for chunked streaming search results)
  const searchProgressUnlistenRef = useRef<UnlistenFn | null>(null);

  // Cleanup ADB and search subscriptions on unmount
  useEffect(() => {
    return () => {
      adbBatchUnlistenRef.current?.();
      adbStoppedUnlistenRef.current?.();
      searchProgressUnlistenRef.current?.();
    };
  }, []);

  const resetSessionState = useCallback(() => {
    lineCacheRef.current = new Map<number, ViewLine>();
    setCacheVersion((v) => v + 1);
    setSearch(null);
    searchRef.current = null;
    setSearchSummary(null);
    setCurrentMatchIndex(0);
    setProcessorId(null);
    processorIdRef.current = null;
    pendingFetches.current.clear();
    // Reset filter state
    setStreamFilterExpr('');
    setFilterParseError(null);
    setFilteredLineNums(null);
    filterAstRef.current = null;
    packagePidsRef.current = new Map();
    // Reset time range filter
    setTimeStartState('');
    setTimeEndState('');
    timeStartRef.current = '';
    timeEndRef.current = '';
    setTimeFilterLineNums(null);
  }, []);

  const handleAdbBatch = useCallback((payload: AdbBatchPayload) => {
    if (payload.sessionId !== sessionRef.current?.sessionId) return;

    // Mutate lineCache in place — no O(N) copy.
    const cache = lineCacheRef.current;
    for (const line of payload.lines) {
      cache.set(line.virtualIndex ?? line.lineNum, line);
    }

    // Evict oldest entries if over the frontend cap (Map iteration is insertion-ordered).
    const cap = frontendCacheMaxRef.current;
    if (cap > 0 && cache.size > cap) {
      let toEvict = cache.size - cap;
      for (const key of cache.keys()) {
        if (toEvict <= 0) break;
        cache.delete(key);
        toEvict--;
      }
    }

    // Update session metadata — this setState triggers the re-render that shows new lines.
    setSession((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        totalLines: payload.totalLines,
        fileSize: payload.byteCount,
        // Preserve first timestamp once set; always update last timestamp.
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
  }, []);

  /**
   * Parse and apply a composable filter expression.
   * Resolves any package: atoms to PIDs via adb, then scans the full lineCache
   * to produce an initial filteredLineNums array.  Subsequent batches are
   * filtered incrementally in handleAdbBatch.
   */
  const setStreamFilter = useCallback(async (expr: string) => {
    setStreamFilterExpr(expr);

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

    // Resolve package: atoms to PIDs (skip already-resolved ones)
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

    // Full scan of current cache to build initial filtered list
    const pids = packagePidsRef.current;
    const nums: number[] = [];
    for (const [lineNum, line] of lineCacheRef.current) {
      if (matchesFilter(ast, line, pids)) nums.push(lineNum);
    }
    nums.sort((a, b) => a - b);
    setFilteredLineNums(nums);
  }, []);

  /**
   * Apply a time-of-day range filter to the loaded file.
   * Calls the backend search_logs to find all lines within the range, then
   * sets timeFilterLineNums to drive the viewer's lineNumbers prop.
   * Pass empty strings to clear the filter.
   */
  const setTimeFilter = useCallback(async (start: string, end: string) => {
    setTimeStartState(start);
    setTimeEndState(end);
    timeStartRef.current = start;
    timeEndRef.current = end;

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
  }, []);

  const loadFile = useCallback(async (path: string) => {
    // Let the caller (App.tsx) clear app-level state (metadata, sections, etc.)
    onBeforeLoadRef.current?.();

    // Clean up any active stream first
    adbBatchUnlistenRef.current?.();
    adbBatchUnlistenRef.current = null;
    adbStoppedUnlistenRef.current?.();
    adbStoppedUnlistenRef.current = null;
    setIsStreaming(false);
    isStreamingRef.current = false;

    setIndexingProgress(null);
    setLoading(true);
    setError(null);
    resetSessionState();
    try {
      const result = await loadLogFile(path);
      setSession(result);
      sessionRef.current = result;
      // Persist the file path so we can reopen it on next launch.
      try { localStorage.setItem(LS_LAST_FILE, path); } catch { /* storage full */ }
      // Show the viewer immediately — the virtualizer will fetch visible rows naturally.
      setLoading(false);
      // Warm the cache for the first window in the background (best-effort, no await).
      getLines({
        sessionId: result.sessionId,
        mode: { mode: 'Full' },
        offset: 0,
        count: WINDOW_SIZE,
        context: 0,
      }).then((first) => {
        if (sessionRef.current?.sessionId !== result.sessionId) return;
        for (const line of first.lines) lineCacheRef.current.set(line.virtualIndex ?? line.lineNum, line);
        setCacheVersion((v) => v + 1);
      }).catch(() => { /* ignore — virtualizer will retry */ });
    } catch (e) {
      // Clear saved path if the file can't be loaded (deleted/moved)
      try { localStorage.removeItem(LS_LAST_FILE); } catch { /* ignore */ }
      setError(String(e));
      setLoading(false);
    }
  }, [resetSessionState]);

  // Wire up Tauri file drag-and-drop so users can drag a log file onto the window.
  // Uses `cancelled` flag to handle React StrictMode double-mount: if cleanup runs
  // before the async `.then()` resolves, the listener is immediately unregistered.
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

  // Restore the last-opened file on app startup.
  useEffect(() => {
    const saved = localStorage.getItem(LS_LAST_FILE);
    if (saved) loadFile(saved);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to progressive file-indexing events.
  // Same `cancelled` flag pattern for StrictMode safety.
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
      // Extend totalLines so the virtualizer stays current during background indexing.
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
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenComplete = fn;
    });

    return () => {
      cancelled = true;
      unlistenProgress?.();
      unlistenComplete?.();
    };
  }, []);

  const startStream = useCallback(async (
    deviceId?: string,
    packageFilter?: string,
    activeProcessorIds: string[] = [],
    maxRawLines?: number,
  ) => {
    // Clean up any previous stream
    adbBatchUnlistenRef.current?.();
    adbBatchUnlistenRef.current = null;
    adbStoppedUnlistenRef.current?.();
    adbStoppedUnlistenRef.current = null;

    setLoading(true);
    setError(null);
    resetSessionState();

    // Store device serial so setStreamFilter can resolve package names
    streamDeviceSerialRef.current = deviceId ?? null;

    try {
      const result = await startAdbStream(deviceId, packageFilter, activeProcessorIds, maxRawLines);
      setSession(result);
      sessionRef.current = result;
      setIsStreaming(true);
      isStreamingRef.current = true;

      // Subscribe to incoming line batches
      const unlistenBatch = await onAdbBatch(handleAdbBatch);
      adbBatchUnlistenRef.current = unlistenBatch;

      // Subscribe to stream-stopped (device disconnect / user stop)
      const unlistenStopped = await onAdbStreamStopped((payload) => {
        if (payload.sessionId !== sessionRef.current?.sessionId) return;
        setIsStreaming(false);
        isStreamingRef.current = false;
        adbBatchUnlistenRef.current?.();
        adbBatchUnlistenRef.current = null;
      });
      adbStoppedUnlistenRef.current = unlistenStopped;
    } catch (e) {
      setError(String(e));
      setIsStreaming(false);
      isStreamingRef.current = false;
    } finally {
      setLoading(false);
    }
  }, [resetSessionState, handleAdbBatch]);

  const stopStream = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await stopAdbStream(sess.sessionId);
    } catch (e) {
      console.error('Error stopping ADB stream:', e);
    }
    // Clean up subscriptions (adb-stream-stopped will also fire and clean up)
    adbBatchUnlistenRef.current?.();
    adbBatchUnlistenRef.current = null;
    adbStoppedUnlistenRef.current?.();
    adbStoppedUnlistenRef.current = null;
    setIsStreaming(false);
    isStreamingRef.current = false;
  }, []);

  const handleFetchNeeded = useCallback(
    (offset: number, count: number) => {
      // Skip file fetches during active streaming — all lines arrive via batch events.
      if (isStreamingRef.current) return;

      const sess = sessionRef.current;
      if (!sess) return;
      const pid = processorIdRef.current;
      const key = `${pid ?? 'full'}:${offset}:${count}`;
      if (pendingFetches.current.has(key)) return;
      pendingFetches.current.add(key);

      const mode = pid
        ? { mode: 'Processor' as const }
        : { mode: 'Full' as const };

      // Capture session ID now; discard results if session changes before response arrives.
      const sessionId = sess.sessionId;
      getLines({
        sessionId,
        mode,
        offset,
        count: Math.min(count, WINDOW_SIZE),
        context: 3,
        processorId: pid ?? undefined,
        search: searchRef.current ?? undefined,
      })
        .then((window) => {
          // Guard: discard stale results from a previous session (e.g. in-flight
          // file fetches that complete after a stream session has replaced the file).
          if (sessionRef.current?.sessionId !== sessionId) return;

          // Self-correct totalLines: backend is authoritative. If file-index-complete
          // was missed (timing / lifecycle race), this ensures the virtualizer count
          // eventually catches up to the true line count.
          setSession((prev) => {
            if (!prev || prev.sessionId !== sessionId) return prev;
            if (window.totalLines <= (prev.totalLines ?? 0)) return prev;
            return { ...prev, totalLines: window.totalLines };
          });
          for (const line of window.lines) lineCacheRef.current.set(line.virtualIndex ?? line.lineNum, line);
          // Evict oldest entries if over the cap (same ring-buffer logic as streaming).
          const cap = frontendCacheMaxRef.current;
          if (cap > 0 && lineCacheRef.current.size > cap) {
            let toEvict = lineCacheRef.current.size - cap;
            for (const key of lineCacheRef.current.keys()) {
              if (toEvict <= 0) break;
              lineCacheRef.current.delete(key);
              toEvict--;
            }
          }
          // Re-apply active filter to newly fetched lines (file session incremental filter).
          const ast = filterAstRef.current;
          if (ast) {
            const pids = packagePidsRef.current;
            const newMatches = window.lines
              .filter((line) => matchesFilter(ast, line, pids))
              .map((line) => line.lineNum);
            if (newMatches.length > 0) {
              setFilteredLineNums((prev) => {
                const merged = [...(prev ?? []), ...newMatches];
                merged.sort((a, b) => a - b);
                return merged;
              });
            }
          }
          setCacheVersion((v) => v + 1);
        })
        .catch(console.error)
        .finally(() => pendingFetches.current.delete(key));
    },
    [],
  );

  const handleSearch = useCallback(
    async (query: SearchQuery | null) => {
      const sess = sessionRef.current;
      setSearch(query);
      searchRef.current = query;
      setCurrentMatchIndex(0);

      // Cancel any in-flight search subscription
      searchProgressUnlistenRef.current?.();
      searchProgressUnlistenRef.current = null;

      if (!sess || !query) {
        setSearchSummary(null);
        lineCacheRef.current = new Map();
        setCacheVersion((v) => v + 1);
        return;
      }

      // Accumulator for incremental matches arriving via events
      const accumulatedMatches: number[] = [];
      let jumpedToFirst = false;

      // Subscribe to search-progress BEFORE invoking the command
      const unlisten = await onSearchProgress((payload: SearchProgress) => {
        if (payload.sessionId !== sess.sessionId) return;

        if (payload.newMatches.length > 0) {
          accumulatedMatches.push(...payload.newMatches);

          // Update searchSummary incrementally so the UI shows progress
          setSearchSummary((prev) => ({
            totalMatches: payload.matchedSoFar,
            matchLineNums: [...accumulatedMatches],
            byLevel: prev?.byLevel ?? {},
            byTag: prev?.byTag ?? {},
          }));

          // Jump to the first match as soon as it's found
          if (!jumpedToFirst) {
            jumpedToFirst = true;
            setScrollToLine(accumulatedMatches[0]);
          }
        }

        if (payload.done) {
          // Unsubscribe once search is complete
          searchProgressUnlistenRef.current?.();
          searchProgressUnlistenRef.current = null;
        }
      });
      searchProgressUnlistenRef.current = unlisten;

      try {
        // The command still returns the full SearchSummary at the end
        const summary = await searchLogs(sess.sessionId, query);
        // Replace with the authoritative final result (includes byLevel/byTag)
        setSearchSummary(summary);
        setCurrentMatchIndex(0);
        if (summary.matchLineNums.length > 0 && !jumpedToFirst) {
          setScrollToLine(summary.matchLineNums[0]);
          setJumpSeq((s) => s + 1);
        }
        lineCacheRef.current = new Map();
        setCacheVersion((v) => v + 1);
      } catch (e) {
        console.error('Search error:', e);
      } finally {
        // Ensure cleanup in case the done event was missed
        searchProgressUnlistenRef.current?.();
        searchProgressUnlistenRef.current = null;
      }
    },
    [],
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
    [],
  );

  const jumpToLine = useCallback((lineNum: number) => {
    setScrollToLine(lineNum);
    setJumpSeq((s) => s + 1);
  }, []);

  const jumpToEnd = useCallback(() => {
    const total = sessionRef.current?.totalLines ?? 0;
    if (total <= 0) return;
    setScrollToLine(total - 1);
    setJumpSeq((s) => s + 1);
  }, []);

  const setProcessorView = useCallback((id: string) => {
    setProcessorId(id);
    processorIdRef.current = id;
    lineCacheRef.current = new Map();
    setCacheVersion((v) => v + 1);
    pendingFetches.current.clear();
  }, []);

  const clearProcessorView = useCallback(() => {
    setProcessorId(null);
    processorIdRef.current = null;
    lineCacheRef.current = new Map();
    setCacheVersion((v) => v + 1);
    pendingFetches.current.clear();
  }, []);

  const closeSession = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;

    // Stop active stream first (cleans up event listeners)
    if (isStreamingRef.current) {
      await stopStream();
    }

    // Call backend to free all session data
    try {
      await closeSessionCmd(sess.sessionId);
    } catch (e) {
      console.error('Error closing session:', e);
    }

    // Clear persisted file path
    try { localStorage.removeItem(LS_LAST_FILE); } catch { /* ignore */ }

    // Reset all frontend state
    resetSessionState();
    setSession(null);
    sessionRef.current = null;
    setLoading(false);
    setError(null);
    setIndexingProgress(null);
    setIsStreaming(false);
    isStreamingRef.current = false;
  }, [resetSessionState, stopStream]);

  return {
    session,
    lineCache: lineCacheRef.current,
    search,
    searchSummary,
    currentMatchIndex,
    scrollToLine,
    jumpSeq,
    loading,
    error,
    processorId,
    isStreaming,
    streamFilter,
    filterParseError,
    filteredLineNums,
    cacheMax: frontendCacheMax,
    indexingProgress,
    timeStart,
    timeEnd,
    timeFilterLineNums,
    loadFile,
    startStream,
    stopStream,
    setStreamFilter,
    setTimeFilter,
    handleFetchNeeded,
    handleSearch,
    jumpToMatch,
    jumpToLine,
    jumpToEnd,
    setProcessorView,
    clearProcessorView,
    closeSession,
  };
}
