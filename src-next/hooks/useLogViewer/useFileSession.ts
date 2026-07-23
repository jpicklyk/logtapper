import { useState, useCallback, useRef, useEffect } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { SourceType } from '../../bridge/types';
import { isBugreportLike } from '../../bridge/types';
import { loadLogFile, closeSession as closeSessionCmd, getLines } from '../../bridge/commands';
import { onFileIndexProgress, onFileIndexComplete } from '../../bridge/events';
import { preSeedSession, clearPreSeed } from '../../cache';
import { useSessionCoreCtx, useSessionProgressCtx } from '../../context/SessionContext';
import { bus, emitSessionLoadedWithFocus } from '../../events/bus';
import { getStoredFirstPaneId } from '../useWorkspaceLayout';
import type { CacheController } from '../../cache';
import { diag, diagStart, diagEnd } from '../../utils/diagnostics';
import type { SharedLogViewerRefs } from './types';
import { planExtraSessionImport } from './multiSessionImport';
import { genKeyFor } from './loadGeneration';
import { readTabPaths, saveTabPaths } from '../workspace/workspacePersistence';

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
  } = useSessionCoreCtx();
  const { setIndexingProgress: setIndexingProgressCtx } = useSessionProgressCtx();

  // Keep a stable ref for terminateSession so loadFile can use it without
  // being re-created every time terminateSession identity changes.
  const terminateSessionRef = useRef(terminateSession);
  terminateSessionRef.current = terminateSession;

  const [indexingProgress, setIndexingProgressLocal] = useState<{ percent: number; indexedLines: number } | null>(null);

  const loadGenRef = useRef<Map<string, number>>(new Map());
  // Throttle totalLines → sessions update to at most every 250ms (reduces LogViewer re-renders
  // on large file indexing which can emit ~1000 progress events for a 1M-line file).
  const lastTotalLinesUpdateRef = useRef(0);

  const loadFile = useCallback(async (path: string, paneId?: string, existingTabId?: string) => {
    // Prevent duplicate imports: if this .lts file already has an active session, skip.
    // Check live session context (via ref) rather than localStorage which can be stale.
    if (!existingTabId && path.endsWith('.lts')) {
      const sessionsMap = refs.sessionsRef?.current;
      if (sessionsMap) {
        const alreadyOpen = Array.from(sessionsMap.values()).some((s) => s.filePath === path);
        if (alreadyOpen) {
          diag('file-load', 'skipping — .lts already open', { path });
          const label = path.split(/[\\/]/).pop() ?? path;
          bus.emit('file:lts-already-open', { label });
          return;
        }
      }
    }

    const targetPaneId = paneId ?? refs.activeLogPaneIdRef.current ?? getStoredFirstPaneId() ?? DEFAULT_PANE_ID;

    // The generation guard cancels a load that has been superseded. Its unit is
    // the *destination*: a fresh open replaces whatever is loading in the pane,
    // but a load aimed at a specific tab only supersedes an earlier load into
    // that same tab. Keying purely by pane made concurrent restores into sibling
    // tabs cancel each other — and since the restore loop runs active-tab-first,
    // the file under investigation was always the one destroyed.
    const genKey = genKeyFor(targetPaneId, existingTabId);
    const gen = (loadGenRef.current.get(genKey) ?? 0) + 1;
    loadGenRef.current.set(genKey, gen);

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
    diagStart(`loadFile:${label}`);
    diag('file-load', 'starting', { path: label, paneId: targetPaneId, tabId, isNewTab });
    bus.emit('session:loading', { paneId: targetPaneId, tabId, label, isNewTab });

    try {
      diag('file-load', 'calling loadLogFile IPC');
      const results = await loadLogFile(path);
      const result = results[0];
      if (!result) throw new Error('No sessions returned from load_log_file');
      diag('file-load', 'IPC returned', { sessionId: result.sessionId, totalLines: result.totalLines, sourceType: result.sourceType, isIndexing: result.isIndexing, sessionCount: results.length });

      if (loadGenRef.current.get(genKey) !== gen) {
        diag('file-load', 'stale generation — discarding', { gen, current: loadGenRef.current.get(genKey), genKey });
        for (const r of results) {
          try { await closeSessionCmd(r.sessionId); } catch { /* ignore */ }
          clearPreSeed(r.sessionId);
        }
        return;
      }

      // Optimistic fetch: pre-populate cache while React propagates session state.
      // When useViewCache allocates the handle it will consume these pre-seeded lines,
      // making the FetchScheduler's first viewport fetch a cache hit.
      diag('file-load', 'optimistic fetch: requesting first 100 lines');
      getLines({
        sessionId: result.sessionId,
        mode: { mode: 'Full' },
        offset: 0,
        count: 100,
        context: 0,
      }).then((window) => {
        diag('file-load', 'optimistic fetch: received', { lines: window.lines.length });
        preSeedSession(result.sessionId, window.lines);
      }).catch((err) => { console.warn('[useFileSession] optimistic fetch failed (non-fatal):', err); });

      diag('session', 'registerSession', { paneId: targetPaneId, sessionId: result.sessionId, isNewTab, sourceType: result.sourceType });
      registerSession(targetPaneId, result);

      if (!isNewTab) {
        diag('session', 'activateSessionForPane', { paneId: targetPaneId, sessionId: result.sessionId });
        activateSessionForPane(targetPaneId, result.sessionId);
      }

      if (result.isIndexing) {
        setIndexingProgressCtx(result.sessionId, { linesIndexed: 0, totalLines: 0, percent: 0, done: false });
      }

      const tabPathsSave = readTabPaths(); tabPathsSave[tabId] = path; saveTabPaths(tabPathsSave);

      diag('bus', 'emitting session:loaded + session:focused');
      emitSessionLoadedWithFocus(
        {
          sourceName: result.sourceName,
          sourceType: result.sourceType as SourceType,
          sessionId: result.sessionId,
          paneId: targetPaneId,
          tabId,
          isNewTab,
          previousSessionId,
          readOnly: isBugreportLike(result.sourceType) ? true : undefined,
          isIndexing: result.isIndexing,
        },
        { sessionId: result.sessionId, paneId: targetPaneId },
      );

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

      // Register additional sessions from multi-session .lts import.
      const extraActions = planExtraSessionImport(
        targetPaneId,
        result.sessionId,
        results.slice(1),
        () => crypto.randomUUID(),
      );
      for (const action of extraActions) {
        switch (action.type) {
          case 'loading':
            bus.emit('session:loading', { paneId: action.paneId, tabId: action.tabId, label: action.label, isNewTab: true });
            break;
          case 'register':
            registerSession(action.paneId, results.find(r => r.sessionId === action.session.sessionId)!);
            break;
          case 'activate':
            activateSessionForPane(action.paneId, action.sessionId);
            break;
          case 'loaded':
            bus.emit('session:loaded', {
              sourceName: action.session.sourceName,
              sourceType: action.session.sourceType as SourceType,
              sessionId: action.session.sessionId,
              paneId: action.paneId,
              tabId: action.tabId,
              isNewTab: true,
              previousSessionId: action.previousSessionId,
              readOnly: action.readOnly || undefined,
              isIndexing: action.session.isIndexing,
            });
            break;
          case 'persistTabPath': {
            const tabPathsExtra = readTabPaths(); tabPathsExtra[action.tabId] = path; saveTabPaths(tabPathsExtra);
            break;
          }
        }
      }
    } catch (e) {
      diag('file-load', 'ERROR', { error: String(e) });
      if (loadGenRef.current.get(genKey) === gen) {
        const tabPathsErr = readTabPaths(); delete tabPathsErr[tabId]; saveTabPaths(tabPathsErr);
        setErrorPane(targetPaneId, String(e));
      }
    } finally {
      if (loadGenRef.current.get(genKey) === gen) {
        loadGenRef.current.delete(genKey);
        setLoadingPane(targetPaneId, false);
      }
      diagEnd(`loadFile:${label}`);
    }
  }, [
    refs.activeLogPaneIdRef, refs.paneSessionMapRef,
    refs.streamingPaneIdRef,
    cacheManager, registerSession, activateSessionForPane, setLoadingPane, setErrorPane,
    setIndexingProgressCtx,
    deps.resetSessionState, deps.detachStream,
  ]);

  // Startup restore of open files is now owned by `useStartupRestore` (design
  // §Q2) — it drives the same union/dedup planner used by explicit opens and
  // gates on Q1 hydration + Q3 trust. The inline localStorage replay that lived
  // here (and its latent auto-run ordering defect) has been removed.

  // Subscribe to progressive file-indexing events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    let unlistenProgress: UnlistenFn | null = null;
    let unlistenComplete: UnlistenFn | null = null;

    onFileIndexProgress((payload) => {
      if (cancelled) return;
      // Throttle totalLines → sessions update to reduce LogViewer re-renders.
      // setIndexingProgressCtx is unthrottled — it's in a separate sub-context.
      const now = performance.now();
      if (now - lastTotalLinesUpdateRef.current > 250) {
        lastTotalLinesUpdateRef.current = now;
        updateSession(payload.sessionId, (prev) => ({
          ...prev,
          totalLines: payload.indexedLines,
        }));
      }
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
