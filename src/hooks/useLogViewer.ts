import { useState, useCallback, useRef, useEffect } from 'react';
import { type UnlistenFn } from '@tauri-apps/api/event';
import type { ViewLine, SearchQuery, SearchSummary, LoadResult, AdbBatchPayload } from '../bridge/types';
import { loadLogFile, getLines, searchLogs, startAdbStream, stopAdbStream, getPackagePids } from '../bridge/commands';
import { onAdbBatch, onAdbStreamStopped } from '../bridge/events';
import { parseFilter, matchesFilter, extractPackageNames, type FilterNode, FilterParseError } from '../filter';

const WINDOW_SIZE = 500; // lines to fetch per request

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

  loadFile: (path: string) => Promise<void>;
  startStream: (deviceId?: string, packageFilter?: string, activeProcessorIds?: string[]) => Promise<void>;
  stopStream: () => Promise<void>;
  setStreamFilter: (expr: string) => Promise<void>;
  handleFetchNeeded: (offset: number, count: number) => void;
  handleSearch: (query: SearchQuery | null) => void;
  jumpToMatch: (direction: 1 | -1) => void;
  jumpToLine: (lineNum: number) => void;
  setProcessorView: (processorId: string) => void;
  clearProcessorView: () => void;
}

export function useLogViewer(): LogViewerState {
  const [session, setSession] = useState<LoadResult | null>(null);
  const [lineCache, setLineCache] = useState<Map<number, ViewLine>>(new Map());
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

  // Track in-flight fetch requests to avoid duplicates
  const pendingFetches = useRef<Set<string>>(new Set());
  const sessionRef = useRef<LoadResult | null>(null);
  const searchRef = useRef<SearchQuery | null>(null);
  const processorIdRef = useRef<string | null>(null);

  // Filter refs — writable from callbacks without causing re-renders
  const filterAstRef = useRef<FilterNode | null>(null);
  const packagePidsRef = useRef<Map<string, number[]>>(new Map());
  const streamDeviceSerialRef = useRef<string | null>(null);
  // Mirror of lineCache for synchronous access in filter recompute
  const lineCacheRef = useRef<Map<number, ViewLine>>(new Map());

  // ADB event unlisteners
  const adbBatchUnlistenRef = useRef<UnlistenFn | null>(null);
  const adbStoppedUnlistenRef = useRef<UnlistenFn | null>(null);

  // Cleanup ADB subscriptions on unmount
  useEffect(() => {
    return () => {
      adbBatchUnlistenRef.current?.();
      adbStoppedUnlistenRef.current?.();
    };
  }, []);

  const resetSessionState = useCallback(() => {
    const emptyCache = new Map<number, ViewLine>();
    setLineCache(emptyCache);
    lineCacheRef.current = emptyCache;
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
  }, []);

  const handleAdbBatch = useCallback((payload: AdbBatchPayload) => {
    if (payload.sessionId !== sessionRef.current?.sessionId) return;

    // Append new lines to lineCache (keyed by sequential lineNum)
    setLineCache((prev) => {
      const next = new Map(prev);
      for (const line of payload.lines) {
        next.set(line.lineNum, line);
      }
      lineCacheRef.current = next;
      return next;
    });

    // Update totalLines in session so virtualizer resizes
    setSession((prev) => {
      if (!prev) return prev;
      return { ...prev, totalLines: payload.totalLines };
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

  const loadFile = useCallback(async (path: string) => {
    // Clean up any active stream first
    adbBatchUnlistenRef.current?.();
    adbBatchUnlistenRef.current = null;
    adbStoppedUnlistenRef.current?.();
    adbStoppedUnlistenRef.current = null;
    setIsStreaming(false);

    setLoading(true);
    setError(null);
    resetSessionState();
    try {
      const result = await loadLogFile(path);
      setSession(result);
      sessionRef.current = result;
      // Pre-fetch the first window
      const first = await getLines({
        sessionId: result.sessionId,
        mode: { mode: 'Full' },
        offset: 0,
        count: WINDOW_SIZE,
        context: 0,
      });
      setLineCache((prev) => {
        const next = new Map(prev);
        for (const line of first.lines) next.set(line.lineNum, line);
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [resetSessionState]);

  const startStream = useCallback(async (
    deviceId?: string,
    packageFilter?: string,
    activeProcessorIds: string[] = [],
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
      const result = await startAdbStream(deviceId, packageFilter, activeProcessorIds);
      setSession(result);
      sessionRef.current = result;
      setIsStreaming(true);

      // Subscribe to incoming line batches
      const unlistenBatch = await onAdbBatch(handleAdbBatch);
      adbBatchUnlistenRef.current = unlistenBatch;

      // Subscribe to stream-stopped (device disconnect / user stop)
      const unlistenStopped = await onAdbStreamStopped((payload) => {
        if (payload.sessionId !== sessionRef.current?.sessionId) return;
        setIsStreaming(false);
        adbBatchUnlistenRef.current?.();
        adbBatchUnlistenRef.current = null;
      });
      adbStoppedUnlistenRef.current = unlistenStopped;
    } catch (e) {
      setError(String(e));
      setIsStreaming(false);
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
  }, []);

  const handleFetchNeeded = useCallback(
    (offset: number, count: number) => {
      const sess = sessionRef.current;
      if (!sess) return;
      const pid = processorIdRef.current;
      const key = `${pid ?? 'full'}:${offset}:${count}`;
      if (pendingFetches.current.has(key)) return;
      pendingFetches.current.add(key);

      const mode = pid
        ? { mode: 'Processor' as const }
        : { mode: 'Full' as const };

      getLines({
        sessionId: sess.sessionId,
        mode,
        offset,
        count: Math.min(count, WINDOW_SIZE),
        context: 3,
        processorId: pid ?? undefined,
        search: searchRef.current ?? undefined,
      })
        .then((window) => {
          setLineCache((prev) => {
            const next = new Map(prev);
            for (const line of window.lines) next.set(line.lineNum, line);
            return next;
          });
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

      if (!sess || !query) {
        setSearchSummary(null);
        setLineCache(new Map());
        return;
      }

      try {
        const summary = await searchLogs(sess.sessionId, query);
        setSearchSummary(summary);
        setCurrentMatchIndex(0);
        if (summary.matchLineNums.length > 0) {
          setScrollToLine(summary.matchLineNums[0]);
        }
        setLineCache(new Map());
      } catch (e) {
        console.error('Search error:', e);
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

  const setProcessorView = useCallback((id: string) => {
    setProcessorId(id);
    processorIdRef.current = id;
    setLineCache(new Map());
    pendingFetches.current.clear();
  }, []);

  const clearProcessorView = useCallback(() => {
    setProcessorId(null);
    processorIdRef.current = null;
    setLineCache(new Map());
    pendingFetches.current.clear();
  }, []);

  return {
    session,
    lineCache,
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
    loadFile,
    startStream,
    stopStream,
    setStreamFilter,
    handleFetchNeeded,
    handleSearch,
    jumpToMatch,
    jumpToLine,
    setProcessorView,
    clearProcessorView,
  };
}
