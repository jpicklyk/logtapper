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
import { createGenerationGuard } from '../reactive';
import type { GenerationGuard } from '../reactive';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { closeSession, getLines, loadLogFile } from '@bridge/commands';
import type { LoadResult } from '@bridge/types';
// The one src-next reach-through W0b adds: the multi-session `.lts` import
// planner. Framework-free and already unit-tested on the React side — reused
// verbatim rather than reimplemented, per "search before creating".
import { planExtraSessionImport } from '@hooks/useLogViewer/multiSessionImport';
import type { ImportedSession } from '@hooks/useLogViewer/multiSessionImport';
import type { ViewerController } from '../viewer';
import { resetSessionView } from './sessions';
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
  /**
   * Dismiss the current failure.
   *
   * The top bar's error line is the only place a failure is shown, and it used
   * to be clearable ONLY by starting another open. A startup restore that
   * cannot reach a file — a workspace naming a path on a drive that is not
   * mounted, say — therefore parked its message in the top bar for the rest of
   * the session, outliving every unrelated success including starting a live
   * capture. A failure is an event, not app state; the user gets to close it.
   */
  clearError(): void;
  /** True while an open is in flight. */
  busy: Accessor<boolean>;
  /** Last failure, or `''`. Cleared at the start of every open, by
   *  {@link AppActions.clearError}, and when a capture starts. */
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

  /**
   * How many opens are in flight.
   *
   * `busy` used to be a bare boolean each call set and cleared, so two
   * concurrent opens (a restore opening several files, a double-click) made
   * the first one's `finally` report "done" while the second was still
   * running — the Open button re-enabled mid-restore (review A-M10). A
   * refcount is the same signal for the single-open case and correct for the
   * concurrent one.
   */
  let openDepth = 0;

  /**
   * Per-session generation for the post-open index probe.
   *
   * `probeTotal` is awaited *after* the session is registered, and under
   * `waitForIndex` the loop runs for up to {@link INDEX_PROBE_TIMEOUT_MS}.
   * Backend session ids are deterministic per path, so a close + reopen of the
   * same file inside that window lands on the same id and the late
   * `updateTotal` would overwrite the fresh session's `isIndexing` with the
   * previous open's total (review A-M10). Each open captures its guard
   * *object* and token up front and checks both before writing.
   *
   * Entries are bumped, never deleted — a token captured before a close must
   * keep comparing false afterwards, which it could not do if the guard were
   * removed and a reopen started a fresh counter at the same number. One small
   * object per distinct path opened in this process is a bounded cost.
   */
  const probeGuards = new Map<string, GenerationGuard>();
  const probeGuardFor = (sessionId: string): GenerationGuard => {
    let guard = probeGuards.get(sessionId);
    if (!guard) {
      guard = createGenerationGuard();
      probeGuards.set(sessionId, guard);
    }
    return guard;
  };

  let tabSeq = 0;
  const makeTabId = (): string => `solid-tab-${++tabSeq}`;

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
    // Only the open that *starts* a batch clears the error line. A second
    // concurrent open clearing it would erase a failure the first one has
    // already reported and the user has not seen yet (review A-M10).
    if (openDepth === 0) setError('');
    openDepth += 1;
    setBusy(true);
    try {
      const results = await loadLogFile(path);
      const primary = results[0];
      if (!primary) throw new Error(`No sessions were loaded from ${path}`);

      const loadsById = new Map(results.map((load) => [load.sessionId, load]));
      // Captured before the first await that follows a registration: any
      // earlier open of this same id is superseded as of here.
      const probeGuard = probeGuardFor(primary.sessionId);
      const probeToken = probeGuard.bump();

      // `store.add` is what resets this session's view state, for the bridge's
      // open edge as well as this one — see `sessions.ts`'s `resetSessionView`.
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

      // The backend keeps indexing after `load_log_file` resolves, so the
      // authoritative total is a probe, not `LoadResult.totalLines`.
      let total = await probeTotal(primary.sessionId);
      if (options.waitForIndex) {
        const deadline = Date.now() + INDEX_PROBE_TIMEOUT_MS;
        let previous = -1;
        while (
          probeGuard.isCurrent(probeToken) &&
          Date.now() < deadline &&
          !(total > 0 && total === previous)
        ) {
          previous = total;
          await new Promise((resolve) => setTimeout(resolve, INDEX_PROBE_MS));
          total = await probeTotal(primary.sessionId);
        }
      }
      // A newer open (or reopen) of this id owns the session now; writing this
      // probe's total would reset its `isIndexing` to a stale value.
      if (probeGuard.isCurrent(probeToken)) store.updateTotal(primary.sessionId, total, false);

      return primary.sessionId;
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      openDepth -= 1;
      if (openDepth === 0) setBusy(false);
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
    // Supersede any probe still running against this id, so a `waitForIndex`
    // loop started before the close cannot write a total back into the session
    // a later reopen puts at the same id.
    probeGuardFor(sessionId).bump();
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
      // The tab still goes away in `finally` (the data source is disposed and
      // the view cache released, so keeping it would render nothing), but the
      // *backend* session is still open — holding its mmap and file lock, and
      // still listed by `GET /mcp/sessions`. That divergence used to be
      // completely silent: the one caller, `App.tsx`'s `closeTab`, swallows
      // the rejection (review A-M11). Say so on the same error line every
      // other failure uses; the user can reopen and retry.
      setError(`Failed to close session: ${String(e)}`);
      throw e;
    } finally {
      store.remove(sessionId);
      resetSessionView(controller, sessionId);
    }
  };

  return {
    openPath,
    openFileDialog,
    close,
    focus: (sessionId) => store.setFocused(sessionId),
    reportError: (message) => setError(message),
    clearError: () => setError(''),
    busy,
    error,
  };
}
