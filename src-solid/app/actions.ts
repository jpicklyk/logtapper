/**
 * The app's action surface: everything that opens, closes or focuses a session.
 *
 * Components call these; nothing outside this module calls `loadLogFile` /
 * `closeSession` or mutates the session store's membership directly. The store
 * owns *state*, this owns *transitions* — the same split `src-next/context`
 * draws between `SessionContext` and `ActionsContext`.
 */
import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { closeSession, getLines, loadLogFile } from '@bridge/commands';
import type { LoadResult } from '@bridge/types';
// The one src-next reach-through W0b adds: the multi-session `.lts` import
// planner. Framework-free and already unit-tested on the React side — reused
// verbatim rather than reimplemented, per "search before creating".
import { planExtraSessionImport } from '@hooks/useLogViewer/multiSessionImport';
import type { ImportedSession } from '@hooks/useLogViewer/multiSessionImport';
import type { ViewerController } from '../viewer';
import type { SessionStore } from './sessions';

/** The single pane 2b renders. The planner is pane-aware; multi-pane is post-2b. */
export const MAIN_PANE_ID = 'main';

/** Gap between index-stability probes when `waitForIndex` is on. */
export const INDEX_PROBE_MS = 750;

/** How long `waitForIndex` will keep probing before giving up on a stable total. */
export const INDEX_PROBE_TIMEOUT_MS = 120_000;

export interface OpenPathOptions {
  /**
   * Poll the line total until it has been stable across two consecutive probes
   * before resolving. Bench only: a benchmark must sweep the whole file, not
   * whatever the background indexer had reached at open time. The UI path does
   * not wait — it watches `file-index-progress` instead.
   */
  waitForIndex?: boolean;
}

export interface AppActionsDeps {
  store: SessionStore;
  controller: ViewerController;
  /** Injected for tests; defaults to the Tauri native dialog. */
  chooseFile?: typeof openDialog;
  /**
   * Stop a live ADB stream before its session is closed — mirrors React's
   * `useSessionTabManager.closeSession` guard (`if
   * (refs.streamingSessionIdRef.current === resolvedSessionId) await
   * deps.stopStream()`). Injected rather than imported directly so this
   * module stays free of a `stream/` dependency; `App.tsx` wires
   * `liveStream.stopIfCurrent`. The stream module is responsible for
   * no-op-ing when `sessionId` isn't its current session — this call site
   * always invokes it unconditionally, same as React always calling
   * `stopStream()` once the id check passes.
   */
  stopLiveSession?: (sessionId: string) => Promise<void>;
}

export interface AppActions {
  /** Open a path, register every session it yields, focus the primary. Returns its id. */
  openPath(path: string, options?: OpenPathOptions): Promise<string>;
  /** Native open dialog, then {@link AppActions.openPath}. A cancelled dialog is a no-op. */
  openFileDialog(): Promise<void>;
  close(sessionId: string): Promise<void>;
  focus(sessionId: string): void;
  /**
   * Show a failure that did not come from one of the actions above (the editor
   * tab's read, today). Keeps the top bar's error line single-sourced.
   */
  reportError(message: string): void;
  /** True while an open is in flight. */
  busy: Accessor<boolean>;
  /** Last failure, or `''`. Cleared at the start of every open. */
  error: Accessor<string>;
}

const LOG_FILE_FILTERS = [
  { name: 'Log Files', extensions: ['log', 'txt', 'zip', 'gz', 'lts'] },
  { name: 'All Files', extensions: ['*'] },
];

function toImported(load: LoadResult): ImportedSession {
  return {
    sessionId: load.sessionId,
    sourceName: load.sourceName,
    sourceType: load.sourceType,
    isIndexing: load.isIndexing,
    totalLines: load.totalLines,
  };
}

export function createAppActions(deps: AppActionsDeps): AppActions {
  const { store, controller, chooseFile = openDialog, stopLiveSession } = deps;

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  let tabSeq = 0;
  const makeTabId = (): string => `solid-tab-${++tabSeq}`;

  /**
   * Forget a session's rendered index space and highlight overrides.
   *
   * Backend session ids are deterministic per path, so closing a file and
   * reopening it lands on the *same* id — and would inherit whatever filter,
   * section scope, search set or highlight map the previous open left on the
   * controller. Cleared on both edges (open and close) because a session can
   * also leave through an agent's close, which this surface never sees.
   */
  const resetView = (sessionId: string): void => {
    for (const key of ['section', 'filter', 'search'] as const) {
      controller.setLineSet(sessionId, key, null);
    }
    controller.setHighlights(sessionId, null);
  };

  const probeTotal = async (sessionId: string): Promise<number> => {
    const head = await getLines({
      sessionId,
      mode: { mode: 'Full' },
      offset: 0,
      count: 1,
      context: 0,
      processorId: null,
      search: null,
    });
    return head.totalLines;
  };

  const openPath = async (path: string, options: OpenPathOptions = {}): Promise<string> => {
    setError('');
    setBusy(true);
    try {
      const results = await loadLogFile(path);
      const primary = results[0];
      if (!primary) throw new Error(`No sessions were loaded from ${path}`);

      const loadsById = new Map(results.map((load) => [load.sessionId, load]));
      store.add(primary);
      store.setFocused(primary.sessionId);

      // Multi-session `.lts`: replay the shared planner's actions. `register`
      // and `activate` are the only two that mean anything without React's tab
      // manager — `loading`, `loaded` and `persistTabPath` are its concerns, and
      // are deliberately no-ops here (W1a/W9 own persistence).
      const plan = planExtraSessionImport(
        MAIN_PANE_ID,
        primary.sessionId,
        results.slice(1).map(toImported),
        makeTabId,
      );
      for (const action of plan) {
        if (action.type === 'register') {
          const load = loadsById.get(action.session.sessionId);
          if (load) store.add(load);
        } else if (action.type === 'activate') {
          store.setFocused(action.sessionId);
        }
      }

      for (const load of results) resetView(load.sessionId);

      // The backend keeps indexing after `load_log_file` resolves, so the
      // authoritative total is a probe, not `LoadResult.totalLines`.
      let total = await probeTotal(primary.sessionId);
      if (options.waitForIndex) {
        const deadline = Date.now() + INDEX_PROBE_TIMEOUT_MS;
        let previous = -1;
        while (Date.now() < deadline && !(total > 0 && total === previous)) {
          previous = total;
          await new Promise((resolve) => setTimeout(resolve, INDEX_PROBE_MS));
          total = await probeTotal(primary.sessionId);
        }
      }
      store.updateTotal(primary.sessionId, total, false);

      return primary.sessionId;
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const openFileDialog = async (): Promise<void> => {
    const selected = await chooseFile({ multiple: false, filters: LOG_FILE_FILTERS });
    if (typeof selected !== 'string') return;
    await openPath(selected).catch(() => undefined);
  };

  const close = async (sessionId: string): Promise<void> => {
    // Claim the close before the command runs: the backend emits
    // `session-closed` for UI-initiated closes too, and that echo must not be
    // read as an agent closing the session.
    store.markPendingClose(sessionId);
    try {
      // The backend's `close_session` already cancels a running stream task as
      // part of tearing down session state, so skipping this would not leak
      // anything server-side. It matters on the frontend: without it, the
      // `LiveStreamStore`'s `createStreamSession` instance never learns the
      // stream ended — `channelActive`/`currentSessionId` stay set, `status()`
      // never reaches `'stopped'`, and `active()` keeps reporting `true` for a
      // capture whose session no longer exists. Same reasoning as React's
      // `useSessionTabManager.closeSession` stopping first.
      await stopLiveSession?.(sessionId);
      await closeSession(sessionId);
    } catch (e) {
      // No echo will come for a failed close: release the claim so a later
      // foreign `session-closed` for this id is not swallowed.
      store.releasePendingClose(sessionId);
      throw e;
    } finally {
      store.remove(sessionId);
      resetView(sessionId);
    }
  };

  return {
    openPath,
    openFileDialog,
    close,
    focus: (sessionId) => store.setFocused(sessionId),
    reportError: (message) => setError(message),
    busy,
    error,
  };
}
