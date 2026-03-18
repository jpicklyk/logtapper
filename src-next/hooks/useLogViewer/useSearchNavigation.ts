import { useCallback, useRef } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { SearchQuery, SearchProgress, LineWindow } from '../../bridge/types';
import { getLines, searchLogs } from '../../bridge/commands';
import { onSearchProgress } from '../../bridge/events';
import { useViewerContext } from '../../context/ViewerContext';
import type { SharedLogViewerRefs } from './types';

export interface SearchNavigationResult {
  handleSearch: (query: SearchQuery | null) => void;
  jumpToMatch: (direction: 1 | -1) => void;
  jumpToLine: (lineNum: number, paneId?: string) => void;
  jumpToEnd: () => void;
  fetchLines: (offset: number, count: number) => Promise<LineWindow>;
  setProcessorView: (processorId: string) => void;
  clearProcessorView: () => void;
  reset: () => void;
}

export function useSearchNavigation(refs: SharedLogViewerRefs): SearchNavigationResult {
  const {
    setSearch,
    setSearchSummary,
    setCurrentMatchIndex,
    setScrollToLine,
    setJumpSeq,
    setJumpPaneId,
    setProcessorId,
  } = useViewerContext();

  const searchRef = useRef<SearchQuery | null>(null);
  const processorIdRef = useRef<string | null>(null);
  const searchProgressUnlistenRef = useRef<UnlistenFn | null>(null);

  const reset = useCallback(() => {
    setSearch(null);
    searchRef.current = null;
    setCurrentMatchIndex(0);
    setProcessorId(null);
    processorIdRef.current = null;
    searchProgressUnlistenRef.current?.();
    searchProgressUnlistenRef.current = null;
  }, [setSearch, setCurrentMatchIndex, setProcessorId]);

  // Cleanup on unmount
  // Note: parent orchestrator calls adbBatchUnlisten cleanup; search unlisten is internal
  const handleSearch = useCallback(async (query: SearchQuery | null) => {
    const sess = refs.sessionRef.current;
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
  }, [refs.sessionRef, setSearch, setSearchSummary, setCurrentMatchIndex, setScrollToLine, setJumpSeq]);

  const jumpToMatch = useCallback(
    (direction: 1 | -1) => {
      setSearchSummary((summary) => {
        if (!summary || summary.matchLineNums.length === 0) return summary;

        // Scope matches to the currently visible lines (intersection of all active
        // filters: stream filter + section filter). If no filter is active,
        // effectiveLineNumsRef is null and all matches are navigable.
        const effectiveLines = refs.effectiveLineNumsRef.current;
        const matches = effectiveLines
          ? summary.matchLineNums.filter((ln) => {
              // Binary search in the sorted effectiveLines array — O(log n).
              let lo = 0;
              let hi = effectiveLines.length - 1;
              while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (effectiveLines[mid] === ln) return true;
                if (effectiveLines[mid] < ln) lo = mid + 1;
                else hi = mid - 1;
              }
              return false;
            })
          : summary.matchLineNums;

        if (matches.length === 0) return summary;

        setCurrentMatchIndex((idx) => {
          const len = matches.length;
          const next = (idx + direction + len) % len;
          setScrollToLine(matches[next]);
          setJumpPaneId(refs.focusedPaneIdRef.current ?? null);
          setJumpSeq((s) => s + 1);
          return next;
        });
        return summary;
      });
    },
    [refs.focusedPaneIdRef, refs.effectiveLineNumsRef, setSearchSummary, setCurrentMatchIndex, setScrollToLine, setJumpPaneId, setJumpSeq],
  );

  const jumpToLine = useCallback((lineNum: number, paneId?: string) => {
    setScrollToLine(lineNum);
    setJumpPaneId(paneId ?? null);
    setJumpSeq((s) => s + 1);
  }, [setScrollToLine, setJumpPaneId, setJumpSeq]);

  const jumpToEnd = useCallback(() => {
    const total = refs.sessionRef.current?.totalLines ?? 0;
    if (total <= 0) return;
    setScrollToLine(total - 1);
    setJumpSeq((s) => s + 1);
  }, [refs.sessionRef, setScrollToLine, setJumpSeq]);

  const fetchLines = useCallback((offset: number, count: number): Promise<LineWindow> => {
    const sess = refs.sessionRef.current;
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
  }, [refs.sessionRef]);

  const setProcessorView = useCallback((id: string) => {
    setProcessorId(id);
    processorIdRef.current = id;
  }, [setProcessorId]);

  const clearProcessorView = useCallback(() => {
    setProcessorId(null);
    processorIdRef.current = null;
  }, [setProcessorId]);

  return {
    handleSearch,
    jumpToMatch,
    jumpToLine,
    jumpToEnd,
    fetchLines,
    setProcessorView,
    clearProcessorView,
    reset,
  };
}
