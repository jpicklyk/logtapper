import { useState, useCallback, useRef, useEffect } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { SourceType } from '../../bridge/types';
import { isBugreportLike } from '../../bridge/types';
import { loadLogFile, closeSession as closeSessionCmd } from '../../bridge/commands';
import { onFileIndexProgress, onFileIndexComplete } from '../../bridge/events';
import { useSessionContext } from '../../context/SessionContext';
import { bus } from '../../events/bus';
import { getStoredFirstPaneId, getStoredLogviewerTabs } from '../useWorkspaceLayout';
import { storageGetJSON, storageSetJSON, storageRemove } from '../../utils';
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

interface FileSessionDeps {
  resetSessionState: () => void;
  detachStream: (paneId: string) => void;
}

export interface FileSessionResult {
  loadFile: (path: string, paneId?: string) => Promise<void>;
  indexingProgress: { percent: number; indexedLines: number } | null;
  /** Exposed for closeSession in useSessionTabManager to clear progress on session close. */
  setIndexingProgressLocal: (v: { percent: number; indexedLines: number } | null) => void;
}

export function useFileSession(
  cacheManager: CacheController,
  refs: SharedLogViewerRefs,
  deps: FileSessionDeps,
): FileSessionResult {
  const {
    sessions,
    registerSession,
    terminateSession,
    updateSession,
    activateSessionForPane,
    setLoadingPane,
    setErrorPane,
    setIndexingProgress: setIndexingProgressCtx,
  } = useSessionContext();

  // Keep a stable ref for terminateSession so loadFile can use it without
  // being re-created every time terminateSession identity changes.
  const terminateSessionRef = useRef(terminateSession);
  terminateSessionRef.current = terminateSession;

  const [indexingProgress, setIndexingProgressLocal] = useState<{ percent: number; indexedLines: number } | null>(null);

  const loadGenRef = useRef<Map<string, number>>(new Map());
  const hasRestoredRef = useRef(false);

  const loadFile = useCallback(async (path: string, paneId?: string, existingTabId?: string) => {
    const targetPaneId = paneId ?? refs.activeLogPaneIdRef.current ?? getStoredFirstPaneId() ?? DEFAULT_PANE_ID;

    const gen = (loadGenRef.current.get(targetPaneId) ?? 0) + 1;
    loadGenRef.current.set(targetPaneId, gen);

    const tabId = existingTabId ?? crypto.randomUUID();

    const previousSessionId = refs.paneSessionMapRef.current.get(targetPaneId);
    const isNewTab = previousSessionId !== undefined;

    if (!isNewTab) {
      if (previousSessionId) {
        try { await closeSessionCmd(previousSessionId); } catch { /* ignore */ }
        // Inline terminateSession — deps object doesn't include it, get it from ref
        terminateSessionRef.current(previousSessionId);
        cacheManager.releaseSessionViews(previousSessionId);
      }

      bus.emit('session:pre-load', { paneId: targetPaneId });

      // Clean up any active stream on this pane
      if (refs.streamingPaneIdRef.current === targetPaneId) {
        deps.detachStream(targetPaneId);
      }

      setIndexingProgressLocal(null);
      deps.resetSessionState();
    }

    setLoadingPane(targetPaneId, true);
    setErrorPane(targetPaneId, null);

    // Create a placeholder tab immediately so the user sees feedback while the
    // backend decompresses/indexes (especially important for large .lts files).
    const label = path.split(/[\\/]/).pop() ?? path;
    bus.emit('session:loading', { paneId: targetPaneId, tabId, label, isNewTab });

    try {
      const result = await loadLogFile(path);

      if (loadGenRef.current.get(targetPaneId) !== gen) {
        try { await closeSessionCmd(result.sessionId); } catch { /* ignore */ }
        return;
      }

      registerSession(targetPaneId, result);

      if (!isNewTab) {
        activateSessionForPane(targetPaneId, result.sessionId);
      }

      if (result.isIndexing) {
        setIndexingProgressCtx(result.sessionId, { linesIndexed: 0, totalLines: 0, percent: 0, done: false });
      }

      const tabPathsSave = readTabPaths(); tabPathsSave[tabId] = path; saveTabPaths(tabPathsSave);

      bus.emit('session:focused', { sessionId: result.sessionId, paneId: targetPaneId });
      bus.emit('session:loaded', {
        sourceName: result.sourceName,
        sourceType: result.sourceType as SourceType,
        sessionId: result.sessionId,
        paneId: targetPaneId,
        tabId,
        isNewTab,
        previousSessionId,
        readOnly: isBugreportLike(result.sourceType) ? true : undefined,
      });

      if (isBugreportLike(result.sourceType)) {
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
      if (loadGenRef.current.get(targetPaneId) === gen) {
        const tabPathsErr = readTabPaths(); delete tabPathsErr[tabId]; saveTabPaths(tabPathsErr);
        setErrorPane(targetPaneId, String(e));
      }
    } finally {
      if (loadGenRef.current.get(targetPaneId) === gen) {
        loadGenRef.current.delete(targetPaneId);
        setLoadingPane(targetPaneId, false);
      }
    }
  }, [
    refs.activeLogPaneIdRef, refs.paneSessionMapRef,
    refs.streamingPaneIdRef,
    cacheManager, registerSession, activateSessionForPane, setLoadingPane, setErrorPane,
    setIndexingProgressCtx,
    deps.resetSessionState, deps.detachStream,
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

  // Restore all open files on app startup (StrictMode double-mount guard).
  // Active tabs are loaded first (they replace the existing logviewer tab in the
  // pane), then non-active tabs are loaded with their persisted tabId so the
  // session:loaded handler matches them to the already-existing tab in the tree.
  useEffect(() => {
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;
    storageRemove('logtapper_last_file');

    const tabPaths = readTabPaths();
    const storedTabs = getStoredLogviewerTabs();

    // Sort: active tabs first so they establish the pane's initial session,
    // then non-active tabs load into existing persisted tab slots.
    const sorted = [...storedTabs].sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0));
    const loadedPanes = new Set<string>();
    for (const { tabId, paneId, isActive } of sorted) {
      const path = tabPaths[tabId];
      if (!path) continue;
      if (isActive && !loadedPanes.has(paneId)) {
        // First load for this pane — replaces the existing logviewer tab.
        loadedPanes.add(paneId);
        loadFile(path, paneId);
      } else {
        // Non-active tab — load with the persisted tabId so the session:loaded
        // handler finds the existing tab in the tree instead of creating a new one.
        loadFile(path, paneId, tabId);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to progressive file-indexing events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    let unlistenProgress: UnlistenFn | null = null;
    let unlistenComplete: UnlistenFn | null = null;

    onFileIndexProgress((payload) => {
      if (cancelled) return;
      updateSession(payload.sessionId, (prev) => ({
        ...prev,
        totalLines: payload.indexedLines,
      }));
      const percent = payload.totalBytes > 0
        ? (payload.bytesScanned / payload.totalBytes) * 100
        : 0;
      setIndexingProgressCtx(payload.sessionId, {
        linesIndexed: payload.indexedLines,
        totalLines: payload.indexedLines,
        percent,
        done: false,
      });
      if (payload.sessionId === refs.sessionRef.current?.sessionId) {
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
      setIndexingProgressCtx(payload.sessionId, null);
      if (payload.sessionId === refs.sessionRef.current?.sessionId) {
        setIndexingProgressLocal(null);
      }
      bus.emit('session:indexing-complete', {
        sessionId: payload.sessionId,
        totalLines: payload.totalLines,
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenComplete = fn;
    });

    return () => {
      cancelled = true;
      unlistenProgress?.();
      unlistenComplete?.();
    };
  }, [updateSession, setIndexingProgressCtx, refs.sessionRef]);

  // Emit session:dumpstate:indexing-complete when indexing completes for Bugreport sessions.
  // Separate effect so it can read the current sessions Map without stale closure.
  useEffect(() => {
    const handler = (e: { sessionId: string; totalLines: number }) => {
      const sess = sessions.get(e.sessionId);
      if (sess && isBugreportLike(sess.sourceType)) {
        bus.emit('session:dumpstate:indexing-complete', {
          sessionId: e.sessionId,
          totalLines: e.totalLines,
        });
      }
    };
    bus.on('session:indexing-complete', handler);
    return () => { bus.off('session:indexing-complete', handler); };
  }, [sessions]);

  return { loadFile, indexingProgress, setIndexingProgressLocal };
}
