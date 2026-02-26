import { useCallback, useRef, useEffect } from 'react';
import type { SourceType } from '../../bridge/types';
import { getLines, closeSession as closeSessionCmd } from '../../bridge/commands';
import { updateStreamProcessors, updateStreamTrackers, updateStreamTransformers } from '../../bridge/commands';
import { useSessionContext } from '../../context/SessionContext';
import { useViewerContext } from '../../context/ViewerContext';
import { bus } from '../../events/bus';
import { sessionScrollPositions } from '../../viewport';
import type { CacheController } from '../../cache';
import type { SharedLogViewerRefs } from './types';

const LS_TAB_PATHS = 'logtapper_tab_paths';

function readTabPaths(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_TAB_PATHS) ?? '{}') as Record<string, string>; }
  catch { return {}; }
}
function saveTabPaths(paths: Record<string, string>): void {
  try { localStorage.setItem(LS_TAB_PATHS, JSON.stringify(paths)); } catch { /* storage full */ }
}
const DEFAULT_PANE_ID = 'primary';

interface TabManagerDeps {
  stopStream: () => Promise<void>;
  resetSessionState: () => void;
  setIndexingProgressLocal: (v: { percent: number; indexedLines: number } | null) => void;
}

export interface SessionTabManagerResult {
  closeSession: (paneId?: string, tabId?: string, sessionId?: string) => Promise<void>;
}

export function useSessionTabManager(
  cacheManager: CacheController,
  refs: SharedLogViewerRefs,
  deps: TabManagerDeps,
): SessionTabManagerResult {
  const {
    focusedPaneId,
    unregisterSession,
    terminateSession,
    setIndexingProgress: setIndexingProgressCtx,
    activateSessionForPane,
  } = useSessionContext();

  const {
    setProcessorId,
    setSearch,
    setSearchSummary,
    setCurrentMatchIndex,
    setStreamFilter: setStreamFilterCtx,
    setTimeFilterStart: setTimeFilterStartCtx,
    setTimeFilterEnd: setTimeFilterEndCtx,
  } = useViewerContext();

  // Clear session-scoped viewer state when switching tabs (does not reset filter scan state).
  const resetViewerState = useCallback(() => {
    setProcessorId(null);
    setSearch(null);
    setSearchSummary(null);
    setCurrentMatchIndex(0);
    setStreamFilterCtx('');
    setTimeFilterStartCtx('');
    setTimeFilterEndCtx('');
  }, [setProcessorId, setSearch, setSearchSummary, setCurrentMatchIndex,
      setStreamFilterCtx, setTimeFilterStartCtx, setTimeFilterEndCtx]);

  const closeSession = useCallback(async (paneId?: string, tabId?: string, sessionId?: string) => {
    const targetPaneId = paneId ?? focusedPaneId ?? DEFAULT_PANE_ID;

    // Prefer the caller-supplied sessionId (workspace already knows it).
    // Fall back to pane map for calls that don't supply it (e.g. toolbar close button).
    const resolvedSessionId = sessionId ?? refs.paneSessionMapRef.current.get(targetPaneId);

    if (!resolvedSessionId) return;

    if (refs.streamingSessionIdRef.current === resolvedSessionId) {
      await deps.stopStream();
    }

    try {
      await closeSessionCmd(resolvedSessionId);
    } catch (e) {
      console.error('Error closing session:', e);
    }

    if (tabId) {
      const tabPathsClose = readTabPaths();
      delete tabPathsClose[tabId];
      saveTabPaths(tabPathsClose);
    }

    const sourceType = (refs.sessionsRef.current.get(resolvedSessionId)?.sourceType ?? 'Unknown') as SourceType;
    const isActivePaneSession = refs.paneSessionMapRef.current.get(targetPaneId) === resolvedSessionId;

    if (isActivePaneSession) {
      deps.resetSessionState();
      deps.setIndexingProgressLocal(null);
      setIndexingProgressCtx(resolvedSessionId, null);
      unregisterSession(targetPaneId);
    } else {
      setIndexingProgressCtx(resolvedSessionId, null);
      terminateSession(resolvedSessionId);
    }
    cacheManager.releaseSessionViews(resolvedSessionId);
    sessionScrollPositions.delete(resolvedSessionId);

    bus.emit('session:closed', { sessionId: resolvedSessionId, paneId: targetPaneId, sourceType, tabId });
  }, [
    focusedPaneId,
    refs.paneSessionMapRef, refs.streamingSessionIdRef, refs.sessionsRef,
    deps.stopStream, deps.resetSessionState, deps.setIndexingProgressLocal,
    setIndexingProgressCtx, unregisterSession, terminateSession, cacheManager,
  ]);

  // Keep a stable ref so event handlers always have the latest closeSession
  const closeSessionRef = useRef(closeSession);
  useEffect(() => { closeSessionRef.current = closeSession; }, [closeSession]);

  useEffect(() => {
    const handleTabClosed = ({ tabId, paneId, sessionId }: { tabId: string; paneId: string; sessionId: string }) => {
      closeSessionRef.current(paneId, tabId, sessionId);
    };
    const handleTabActivated = ({ paneId, sessionId, reason }: { tabId: string; paneId: string; sessionId: string; reason?: 'drag' }) => {
      if (!sessionId) return;
      // Skip viewer state reset for drag rearrangements — the user is moving a
      // tab to a new position, not switching sessions, so search/filter should
      // be preserved.
      if (reason !== 'drag') resetViewerState();
      activateSessionForPane(paneId, sessionId);
      const sess = refs.sessionsRef.current.get(sessionId);
      if (sess && sess.totalLines > 0) {
        let hasCachedLines = false;
        for (const _ of cacheManager.getSessionEntries(sessionId)) { hasCachedLines = true; break; }
        if (!hasCachedLines) {
          getLines({ sessionId, mode: { mode: 'Full' }, offset: 0, count: 100, context: 3 })
            .then((win) => {
              if (win.lines.length > 0) cacheManager.broadcastToSession(sessionId, win.lines);
            })
            .catch(() => {});
        }
      }
    };
    const handlePaneRemap = ({ originalPaneId, actualPaneId, sessionId }: {
      originalPaneId: string; actualPaneId: string; sessionId: string;
    }) => {
      activateSessionForPane(actualPaneId, sessionId);
      unregisterSession(originalPaneId);
    };

    bus.on('layout:logviewer-tab-closed', handleTabClosed);
    bus.on('layout:logviewer-tab-activated', handleTabActivated);
    bus.on('layout:pane-session-remap', handlePaneRemap);
    return () => {
      bus.off('layout:logviewer-tab-closed', handleTabClosed);
      bus.off('layout:logviewer-tab-activated', handleTabActivated);
      bus.off('layout:pane-session-remap', handlePaneRemap);
    };
  }, [refs.sessionsRef, activateSessionForPane, unregisterSession,
      resetViewerState, cacheManager]);

  // Subscribe to pipeline:chain-changed to update stream processors/trackers/transformers
  useEffect(() => {
    const handleChainChanged = (data: { chain: string[] }) => {
      const sessionId = refs.streamingSessionIdRef.current;
      if (!sessionId || !refs.isStreamingRef.current) return;
      updateStreamProcessors(sessionId, data.chain).catch(() => {});
      updateStreamTrackers(sessionId, data.chain).catch(() => {});
      updateStreamTransformers(sessionId, data.chain).catch(() => {});
    };
    bus.on('pipeline:chain-changed', handleChainChanged);
    return () => { bus.off('pipeline:chain-changed', handleChainChanged); };
  }, [refs.streamingSessionIdRef, refs.isStreamingRef]);

  return { closeSession };
}
