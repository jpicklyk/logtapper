import { useCallback, useRef, useEffect } from 'react';
import type { SearchQuery, LoadResult, LineWindow } from '../../bridge/types';
import { useSessionContext } from '../../context/SessionContext';
import { useViewerContext } from '../../context/ViewerContext';
import type { CacheController } from '../../cache';
import type { StreamPusher } from '../../viewport';
import { useFileSession } from './useFileSession';
import { useStreamSession } from './useStreamSession';
import { useFilterScan } from './useFilterScan';
import { useSearchNavigation } from './useSearchNavigation';
import { useSessionTabManager } from './useSessionTabManager';
import type { SharedLogViewerRefs } from './types';

export interface LogViewerActions {
  loadFile: (path: string, paneId?: string) => Promise<void>;
  startStream: (deviceId?: string, packageFilter?: string, activeProcessorIds?: string[], maxRawLines?: number) => Promise<void>;
  stopStream: () => Promise<void>;
  setStreamFilter: (expr: string) => Promise<void>;
  cancelStreamFilter: () => void;
  setTimeFilter: (start: string, end: string) => Promise<void>;
  /** Fetch lines from backend for file mode. Returns a LineWindow. */
  fetchLines: (offset: number, count: number) => Promise<LineWindow>;
  handleSearch: (query: SearchQuery | null) => void;
  jumpToMatch: (direction: 1 | -1) => void;
  jumpToLine: (lineNum: number, paneId?: string) => void;
  jumpToEnd: () => void;
  setProcessorView: (processorId: string) => void;
  clearProcessorView: () => void;
  closeSession: (paneId?: string) => Promise<void>;
  /** Non-null while background file indexing is in progress (focused session). */
  indexingProgress: { percent: number; indexedLines: number } | null;
  filterScanning: boolean;
  filteredLineNums: number[] | null;
  filterParseError: string | null;
  timeFilterLineNums: number[] | null;
}

export function useLogViewer(cacheManager: CacheController, registry: StreamPusher): LogViewerActions {
  const {
    sessions,
    paneSessionMap,
    focusedPaneId,
  } = useSessionContext();

  const {
    setSearch,
    setSearchSummary,
    setCurrentMatchIndex,
    setScrollToLine,
    setJumpSeq,
    setStreamFilter: setStreamFilterCtx,
    setTimeFilterStart: setTimeFilterStartCtx,
    setTimeFilterEnd: setTimeFilterEndCtx,
  } = useViewerContext();

  // ---------------------------------------------------------------------------
  // Create SharedLogViewerRefs — all refs created once (never recreated)
  // ---------------------------------------------------------------------------
  const refsContainer = useRef<SharedLogViewerRefs | null>(null);
  if (!refsContainer.current) {
    refsContainer.current = {
      sessionRef:              { current: null },
      focusedPaneIdRef:        { current: null },
      paneSessionMapRef:       { current: new Map() },
      sessionsRef:             { current: new Map() },
      streamingPaneIdRef:      { current: null },
      streamingSessionIdRef:   { current: null },
      isStreamingRef:          { current: false },
      streamDeviceSerialRef:   { current: null },
      adbBatchUnlistenRef:     { current: null },
      adbStoppedUnlistenRef:   { current: null },
      filterAstRef:            { current: null },
      packagePidsRef:          { current: new Map() },
      appendFilterMatchesRef:  { current: null },
      resetSessionStateRef:    { current: () => {} },
    };
  }
  const refs = refsContainer.current;

  // Sync context-derived values into refs on every render (synchronous — no extra renders)
  const focusedSessionId = focusedPaneId ? paneSessionMap.get(focusedPaneId) : undefined;
  const focusedSession: LoadResult | null = focusedSessionId ? (sessions.get(focusedSessionId) ?? null) : null;
  refs.sessionRef.current        = focusedSession;
  refs.focusedPaneIdRef.current  = focusedPaneId;
  refs.paneSessionMapRef.current = paneSessionMap;
  refs.sessionsRef.current       = sessions;

  // Cleanup remaining ADB listeners on unmount
  useEffect(() => {
    return () => {
      refs.adbBatchUnlistenRef.current?.();
      refs.adbStoppedUnlistenRef.current?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Sub-hooks (filterScan and searchNav first — resetSessionState needs their resets)
  // ---------------------------------------------------------------------------

  const filterScan = useFilterScan(cacheManager, refs);
  const searchNav  = useSearchNavigation(refs);

  // Wire appendMatches ref so useStreamSession can update filter state without a dep.
  refs.appendFilterMatchesRef.current = filterScan.appendMatches;

  // Use refs to break the forward-dependency: resetSessionState is defined after sub-hooks
  // but references their reset functions. Both resets have stable [] deps so this is safe.
  const filterScanResetRef = useRef(filterScan.reset);
  const searchNavResetRef  = useRef(searchNav.reset);
  filterScanResetRef.current = filterScan.reset;
  searchNavResetRef.current  = searchNav.reset;

  const resetSessionState = useCallback(() => {
    filterScanResetRef.current();
    searchNavResetRef.current();
    const sid = refs.sessionRef.current?.sessionId ?? '';
    if (sid) cacheManager.clearSession(sid);
    setSearch(null);
    setSearchSummary(null);
    setCurrentMatchIndex(0);
    setStreamFilterCtx('');
    setTimeFilterStartCtx('');
    setTimeFilterEndCtx('');
    setScrollToLine(0);
    setJumpSeq((s) => s + 1);
  }, [
    cacheManager, refs.sessionRef,
    setSearch, setSearchSummary, setCurrentMatchIndex,
    setStreamFilterCtx, setTimeFilterStartCtx, setTimeFilterEndCtx,
    setScrollToLine, setJumpSeq,
  ]);

  // Wire resetSessionState into refs so useStreamSession can call it
  // when starting a stream into an empty pane (not a new-tab scenario).
  refs.resetSessionStateRef.current = resetSessionState;

  const streamSession = useStreamSession(cacheManager, registry, refs);

  const fileSession = useFileSession(cacheManager, refs, {
    resetSessionState,
    detachStream: streamSession.detachStream,
  });

  const tabManager = useSessionTabManager(cacheManager, refs, {
    stopStream: streamSession.stopStream,
    resetSessionState,
    setIndexingProgressLocal: fileSession.setIndexingProgressLocal,
  });

  return {
    loadFile:           fileSession.loadFile,
    indexingProgress:   fileSession.indexingProgress,
    startStream:        streamSession.startStream,
    stopStream:         streamSession.stopStream,
    setStreamFilter:    filterScan.setStreamFilter,
    cancelStreamFilter: filterScan.cancelStreamFilter,
    setTimeFilter:      filterScan.setTimeFilter,
    filterScanning:     filterScan.filterScanning,
    filteredLineNums:   filterScan.filteredLineNums,
    filterParseError:   filterScan.filterParseError,
    timeFilterLineNums: filterScan.timeFilterLineNums,
    handleSearch:       searchNav.handleSearch,
    jumpToMatch:        searchNav.jumpToMatch,
    jumpToLine:         searchNav.jumpToLine,
    jumpToEnd:          searchNav.jumpToEnd,
    fetchLines:         searchNav.fetchLines,
    setProcessorView:   searchNav.setProcessorView,
    clearProcessorView: searchNav.clearProcessorView,
    closeSession:       tabManager.closeSession,
  };
}
