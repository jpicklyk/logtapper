import { useCallback, useRef, useEffect } from 'react';
import type { SourceType } from '../../bridge/types';
import { getLines, closeSession as closeSessionCmd } from '../../bridge/commands';
import { updateStreamProcessors, updateStreamTrackers, updateStreamTransformers } from '../../bridge/commands';
import { useSessionContext } from '../../context/SessionContext';
import { useViewerContext } from '../../context/ViewerContext';
import { bus } from '../../events/bus';
import { sessionScrollPositions } from '../../viewport';
import { storageGetJSON, storageSetJSON } from '../../utils';
import type { CacheController } from '../../cache';
import type { SharedLogViewerRefs } from './types';

const LS_TAB_PATHS = 'logtapper_tab_paths';

function readTabPaths(): Record<string, string> {
  return storageGetJSON<Record<string, string>>(LS_TAB_PATHS, {});
}
function saveTabPaths(paths: Record<string, string>): void {
  storageSetJSON(LS_TAB_PATHS, paths);
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
    activeLogPaneId,
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
    setScrollToLine,
    setJumpPaneId,
    setJumpSeq,
  } = useViewerContext();

  // Clear session-scoped viewer state when switching tabs.
  // Filter state is per-session in SessionContext — no reset needed here.
  const resetViewerState = useCallback(() => {
    setProcessorId(null);
    setSearch(null);
    setSearchSummary(null);
    setCurrentMatchIndex(0);
  }, [setProcessorId, setSearch, setSearchSummary, setCurrentMatchIndex]);

  const closeSession = useCallback(async (paneId?: string, tabId?: string, sessionId?: string) => {
    const targetPaneId = paneId ?? activeLogPaneId ?? DEFAULT_PANE_ID;

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
    activeLogPaneId,
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
        console.debug('[TabManager] handleTabActivated', { paneId, sessionId, reason, totalLines: sess.totalLines, hasCachedLines });
        if (!hasCachedLines) {
          console.debug('[TabManager] warm-up fetch triggered', { sessionId });
          getLines({ sessionId, mode: { mode: 'Full' }, offset: 0, count: 100, context: 3 })
            .then((win) => {
              console.debug('[TabManager] warm-up fetch result', { sessionId, lineCount: win.lines.length });
              if (win.lines.length > 0) cacheManager.broadcastToSession(sessionId, win.lines);
            })
            .catch(() => {});
        }

        // For stream sessions (Logcat) dragged to a pane, virtualBase is always
        // 0 (tail mode keeps it there), so our position map captures 0 and would
        // restore the viewer to line 0 — the beginning — instead of the tail.
        // Issue an explicit pane-scoped jump to the last line so the user lands
        // at the content they were watching.
        if (reason === 'drag' && sess.sourceType === 'Logcat' && !sess.isStreaming) {
          setScrollToLine(sess.totalLines - 1);
          setJumpPaneId(paneId);
          setJumpSeq((s) => s + 1);
        }
      }
    };
    const handlePaneRemap = ({ originalPaneId, actualPaneId, sessionId }: {
      originalPaneId: string; actualPaneId: string; sessionId: string;
    }) => {
      console.debug('[TabManager] handlePaneRemap', { originalPaneId, actualPaneId, sessionId });
      activateSessionForPane(actualPaneId, sessionId);
      unregisterSession(originalPaneId);
      // Keep the streaming pane ref in sync so stream:stopped fires with the
      // correct pane ID after a remap.
      if (refs.streamingPaneIdRef.current === originalPaneId) {
        refs.streamingPaneIdRef.current = actualPaneId;
      }
      // Re-focus the actual pane so useIsStreaming() and tailMode stay correct.
      // After unregisterSession removes originalPaneId from paneSessionMap,
      // activeLogPaneId would still point to originalPaneId, making the streaming
      // session invisible to focus-based selectors.
      bus.emit('session:focused', { paneId: actualPaneId, sessionId });
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
      resetViewerState, cacheManager, setScrollToLine, setJumpPaneId, setJumpSeq]);

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
