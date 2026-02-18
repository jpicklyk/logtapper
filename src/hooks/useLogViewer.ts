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

  loadFile: (path: string) => Promise<void>;
  handleFetchNeeded: (offset: number, count: number) => void;
  handleSearch: (query: SearchQuery | null) => void;
  jumpToMatch: (direction: 1 | -1) => void;
  jumpToLine: (lineNum: number) => void;
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

  // Track in-flight fetch requests to avoid duplicates
  const pendingFetches = useRef<Set<string>>(new Set());

  const loadFile = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setLineCache(new Map());
    setSearch(null);
    setSearchSummary(null);
    setCurrentMatchIndex(0);
    try {
      const result = await loadLogFile(path);
      setSession(result);
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
      if (!session) return;
      const key = `${offset}:${count}`;
      if (pendingFetches.current.has(key)) return;
      pendingFetches.current.add(key);

      getLines({
        sessionId: session.sessionId,
        mode: { mode: 'Full' },
        offset,
        count: Math.min(count, WINDOW_SIZE),
        context: 0,
        search: search ?? undefined,
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
    [session, search],
  );

  const handleSearch = useCallback(
    async (query: SearchQuery | null) => {
      setSearch(query);
      setCurrentMatchIndex(0);

      if (!session || !query) {
        setSearchSummary(null);
        // Re-fetch current view without search highlights
        setLineCache(new Map());
        return;
      }

      try {
        const summary = await searchLogs(session.sessionId, query);
        setSearchSummary(summary);
        setCurrentMatchIndex(0);
        if (summary.matchLineNums.length > 0) {
          setScrollToLine(summary.matchLineNums[0]);
        }
        // Invalidate cache so lines are re-fetched with highlights
        setLineCache(new Map());
      } catch (e) {
        console.error('Search error:', e);
      }
    },
    [session],
  );

  const jumpToMatch = useCallback(
    (direction: 1 | -1) => {
      if (!searchSummary || searchSummary.matchLineNums.length === 0) return;
      const len = searchSummary.matchLineNums.length;
      const next = (currentMatchIndex + direction + len) % len;
      setCurrentMatchIndex(next);
      setScrollToLine(searchSummary.matchLineNums[next]);
    },
    [searchSummary, currentMatchIndex],
  );

  const jumpToLine = useCallback((lineNum: number) => {
    setScrollToLine(lineNum);
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
    loadFile,
    handleFetchNeeded,
    handleSearch,
    jumpToMatch,
    jumpToLine,
  };
}
