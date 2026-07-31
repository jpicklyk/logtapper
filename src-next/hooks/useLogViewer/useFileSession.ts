import { useState, useCallback, useRef, useEffect } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { SourceType, LoadResult } from '../../bridge/types';
import { isBugreportLike } from '../../bridge/types';
import { loadLogFile, closeSession as closeSessionCmd, getLines } from '../../bridge/commands';
import { onFileIndexProgress, onFileIndexComplete, onBridgeSessionOpened } from '../../bridge/events';
import { preSeedSession, clearPreSeed } from '../../cache';
import type { CacheController } from '../../cache';
import { useSessionCoreCtx, useSessionProgressCtx } from '../../context/SessionContext';
import { bus, emitSessionLoadedWithFocus } from '../../events';
import { getStoredFirstPaneId } from '../useWorkspaceLayout';
import { diag, diagStart, diagEnd } from '../../utils/diagnostics';
import { basename } from '../../utils';
import type { SharedLogViewerRefs } from './types';
import { planExtraSessionImport } from './multiSessionImport';
import { genKeyFor } from './loadGeneration';
import { planBridgeSessionOpen } from './bridgeSessionOpen';
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

  // Stable ref so `loadFile` does not need terminateSession in its deps.
  const terminateSessionRef = useRef(terminateSession);
  terminateSessionRef.current = terminateSession;

  const [indexingProgress, setIndexingProgressLocal] = useState<{ percent: number; indexedLines: number } | null>(null);

  const loadGenRef = useRef<Map<string, number>>(new Map());
  // Throttle totalLines → sessions update to at most every 250ms (reduces LogViewer re-renders
  // on large file indexing which can emit ~1000 progress events for a 1M-line file).
  const lastTotalLinesUpdateRef = useRef(0);

  // The "post-load half" of an open: given an ALREADY-loaded backend session
  // (its LoadResult), register it and create/activate its logviewer tab. Shared
  // by `loadFile` (after its load_log_file IPC returns) and the bridge
  // `session-opened` listener (whose session was opened out-of-band by the MCP
  // bridge — so it must run this WITHOUT re-invoking load_log_file, which would
  // close+reopen the session). Tab creation itself is delegated to useCenterTree
  // via `emitSessionLoadedWithFocus` — this never mutates the tree directly.
  const registerLoadedSession = useCallback((
    result: LoadResult,
    targetPaneId: string,
    tabId: string,
    opts: { isNewTab: boolean; previousSessionId?: string; path: string; loadRequestId?: string },
  ) => {
    const { isNewTab, previousSessionId, path, loadRequestId } = opts;

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
        loadRequestId,
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
  }, [registerSession, activateSessionForPane, setIndexingProgressCtx]);

  // `sourceType` overrides backend content detection for this open. It cannot be
  // applied after the fact — the line index is built with the parser the type
  // selects — so correcting a misdetection means reopening the path, which is
  // exactly what this does.
  //
  // `replace` states the caller's intent instead of leaving it to be inferred
  // from `paneSessionMapRef` below. A reopen closes the pane's session first,
  // but `unregisterSession` is a React dispatch and that ref only re-syncs on
  // render — so the very next statement still read the OLD session id, decided
  // this was an additional tab, and appended a duplicate. Awaiting the close
  // resolves its IPC, not React's state propagation, so the intent has to be
  // passed rather than timed around.
  const loadFile = useCallback(async (
    path: string,
    paneId?: string,
    existingTabId?: string,
    sourceType?: SourceType,
    replace?: boolean,
    // Stamped by a workspace restore (`hooks/workspace/restoreCore.ts`) so the
    // session:loaded event(s) this load produces can be told apart from an
    // unrelated concurrent open. See the `loadRequestId` doc on
    // AppEvents['session:loaded'].
    loadRequestId?: string,
  ) => {
    // Prevent duplicate imports: if this .lts file already has an active session, skip.
    // Check live session context (via ref) rather than localStorage which can be stale.
    if (!existingTabId && path.endsWith('.lts')) {
      const sessionsMap = refs.sessionsRef?.current;
      if (sessionsMap) {
        const alreadyOpen = Array.from(sessionsMap.values()).some((s) => s.filePath === path);
        if (alreadyOpen) {
          diag('file-load', 'skipping — .lts already open', { path });
          const label = basename(path);
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

    // `isNewTab` reads backwards: it is true when the pane ALREADY holds a
    // session, because then this open ADDS a tab alongside it rather than
    // replacing it. The name is kept because it travels on the session:loading
    // / session:loaded payloads with exactly that meaning. The existing session
    // stays open — its tab is still visible — so nothing is disposed here;
    // disposal belongs to closeSession (useSessionTabManager) when a tab is
    // actually closed. Callers that want a REPLACE (e.g. reopen-as in
    // FileInfoPane) close first so this load takes the empty-pane path.
    const previousSessionId = refs.paneSessionMapRef.current.get(targetPaneId);
    // An explicit `replace` overrides the inference: the caller has already
    // closed the pane's session and is putting a different one in its place, so
    // this must take the replace branch even though the ref may not have caught
    // up yet.
    const isNewTab = replace ? false : previousSessionId !== undefined;

    if (!isNewTab) {
      // Replacing the pane's session with a different one for the SAME file.
      // Frontend-side disposal only: the previous session's cached lines were
      // produced by the old parser and must not be served under the new session,
      // and its context entry must go.
      //
      // Deliberately does NOT call closeSession on the backend. `open_file_inner`
      // closes the stale session itself, and it first rescues that session's
      // bookmarks and analyses onto the new id. Closing from here would run
      // `close_session_inner` early and delete them before the rescue could see
      // them — silently undoing the fix for exactly the flow that needs it.
      if (replace && previousSessionId) {
        terminateSessionRef.current(previousSessionId);
        cacheManager.releaseSessionViews(previousSessionId);
      }

      bus.emit('session:pre-load', { paneId: targetPaneId, outgoingSessionId: previousSessionId ?? null });

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
    const label = basename(path);
    diagStart(`loadFile:${label}`);
    diag('file-load', 'starting', { path: label, paneId: targetPaneId, tabId, isNewTab });
    bus.emit('session:loading', { paneId: targetPaneId, tabId, label, isNewTab });

    try {
      diag('file-load', 'calling loadLogFile IPC');
      const results = await loadLogFile(path, sourceType);
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

      // Post-load half: register the session and create/activate its tab.
      registerLoadedSession(result, targetPaneId, tabId, { isNewTab, previousSessionId, path, loadRequestId });

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
              loadRequestId,
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
    registerLoadedSession,
    deps.resetSessionState, deps.detachStream,
  ]);

  // ---------------------------------------------------------------------------
  // Bridge/agent-initiated session open (Tauri `session-opened` event)
  // ---------------------------------------------------------------------------
  //
  // The MCP bridge can open a file out-of-band (POST /mcp/open_file). The backend
  // session ALREADY exists by the time this fires, so the frontend runs ONLY the
  // post-load half (`registerLoadedSession`) — it must NOT call loadFile /
  // load_log_file again, which would close+reopen the session. Tab creation is the
  // same path a normal open uses: emit `session:loading` then `session:loaded`
  // (via registerLoadedSession), which useCenterTree turns into a tab + a
  // tabSessionMap binding. No duplication of tab logic.
  //
  // Idempotency (rule 6 targeting + no duplicate tab): the decision is made by the
  // pure `planBridgeSessionOpen`, keyed on the payload's sessionId. Auto-permit
  // reopen re-fires `session-opened` with the SAME deterministic sessionId; because
  // session registration and tab creation move in lockstep, `sessions.has(id)` is
  // an exact proxy for "a tab already exists" — so an already-open session is
  // skipped (no second tab). A missing sessionId is also a safe no-op.
  //
  // StrictMode-safe async listener: cancelled flag + captured unlisten +
  // immediate-unregister-if-cleanup-already-ran.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onBridgeSessionOpened((payload) => {
      if (cancelled) return;
      const plan = planBridgeSessionOpen({
        sessionId: payload.sessionId,
        activeLogPaneId: refs.activeLogPaneIdRef.current,
        storedFirstPaneId: getStoredFirstPaneId() ?? null,
        defaultPaneId: DEFAULT_PANE_ID,
        paneSessionMap: refs.paneSessionMapRef.current,
        isSessionOpen: (sid) => refs.sessionsRef.current.has(sid),
      });
      if (plan.kind !== 'open') {
        diag('file-load', 'bridge session-opened — no-op', { sessionId: payload.sessionId, reason: plan.reason });
        return;
      }
      const tabId = crypto.randomUUID();
      const label = payload.filePath ? basename(payload.filePath) : payload.sourceName;
      diag('file-load', 'bridge session-opened — creating tab', { sessionId: payload.sessionId, paneId: plan.targetPaneId, tabId, isNewTab: plan.isNewTab });
      // Placeholder tab first (mirrors the normal open), then the post-load half.
      bus.emit('session:loading', { paneId: plan.targetPaneId, tabId, label, isNewTab: plan.isNewTab });
      registerLoadedSession(payload, plan.targetPaneId, tabId, {
        isNewTab: plan.isNewTab,
        previousSessionId: plan.previousSessionId,
        path: payload.filePath ?? '',
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [registerLoadedSession, refs.activeLogPaneIdRef, refs.paneSessionMapRef, refs.sessionsRef]);

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
