import { useState, useCallback, useRef } from 'react';
import type { ViewLine, SearchQuery, SearchSummary, LoadResult } from '../bridge/types';
import { loadLogFile, getLines, searchLogs } from '../bridge/commands';

const WINDOW_SIZE = 500; // lines to fetch per request

export interface LogViewerState {
  session: LoadResult | null;
  lineCache: Map<number, ViewLine>;
  search: SearchQuery | null;
  searchSummary: SearchSummary | null;
  currentMatchIndex: number;
  scrollToLine: number | undefined;
  loading: boolean;
  error: string | null;
  processorId: string | null;

  loadFile: (path: string) => Promise<void>;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processorId, setProcessorId] = useState<string | null>(null);

  // Track in-flight fetch requests to avoid duplicates
  const pendingFetches = useRef<Set<string>>(new Set());
  const sessionRef = useRef<LoadResult | null>(null);
  const searchRef = useRef<SearchQuery | null>(null);
  const processorIdRef = useRef<string | null>(null);

  const loadFile = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setLineCache(new Map());
    setSearch(null);
    setSearchSummary(null);
    setCurrentMatchIndex(0);
    setProcessorId(null);
    processorIdRef.current = null;
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
          return next;
        });
        return summary;
      });
    },
    [],
  );

  const jumpToLine = useCallback((lineNum: number) => {
    setScrollToLine(lineNum);
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
    loading,
    error,
    processorId,
    loadFile,
    handleFetchNeeded,
    handleSearch,
    jumpToMatch,
    jumpToLine,
    setProcessorView,
    clearProcessorView,
  };
}
