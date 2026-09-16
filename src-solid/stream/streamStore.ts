/**
 * Live ADB stream store (L1).
 *
 * Wraps `viewer/createStreamSession`'s pure batch/stop primitive and is the
 * thing that actually turns a capture into a first-class session: the moment
 * `createStreamSession` reports `'streaming'`, this store registers the
 * session with the app's `SessionStore` (`sessions.add` + `sessions
 * .setFocused`) exactly like opening a file does, and the moment it reports
 * `'stopped'`, it flips that session's `kind` back to `'file'`
 * (`sessions.setStreamingKind`) — the retained capture becomes an ordinary,
 * postmortem-browsable session, matching the backend's own model (`stop_
 * adb_stream`'s doc comment: "the session remains in AppState as a static
 * log"). `shell/mode.ts` derives the workspace mode from exactly this field,
 * so starting a capture is what puts the app in live mode, and stopping one
 * takes it back out — no separate "set mode" call exists or is needed.
 *
 * This is also the app's one surface for every other ADB streaming bridge
 * call the L1 task-scope names: device listing, package PID resolution,
 * live anonymize/processor/tracker/transformer updates, and saving the
 * retained capture to a file. `stream/StreamControlsPanel.tsx` is its UI;
 * `app/benchDriver.ts`'s `window.__benchApp.startStream` is its other
 * caller — `App.tsx` builds exactly one instance and hands it to both, so a
 * live session is registered through the identical path either way (see
 * task `fe34022c`'s implementation-notes for why that matters).
 *
 * As of L3 (task `2439a7c5`), this store also binds the wrapped
 * `createStreamSession`'s batched `AdbProcessorUpdate`/`AdbProcessorsExcluded`
 * Channel forwarding to `analyzers/analyzerStore.ts`'s live-counter methods
 * (`deps.analyzers`, optional) — closing `createStreamSession.ts`'s former
 * `handleProcessorUpdate` TODO now that a pipeline context to dispatch into
 * (the analyzer store itself) exists.
 *
 * As of L4 (task `2ecd8bbc`), `deps.filter` (optional) threads through to
 * the same four `createStreamSession` options L1 already built and left
 * unwired: `filterAst`/`filterSessionId`/`packagePids`/
 * `appendFilterMatches`. This store adds no filter logic of its own — it is
 * pure pass-through, same shape as the `analyzers` dep above. `App.tsx` is
 * where the actual `FilterScan` instance gets bound (see its own comment):
 * that binding is necessarily indirect, because `FilterScan` instances are
 * constructed privately inside `query/QueryBar.tsx`, one per mounted pane,
 * not owned by this store or by `App.tsx` itself.
 */
import { createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import * as cmds from '@bridge/commands';
import type { AdbDevice, AdbProcessorUpdate, AdbProcessorsExcluded, LoadResult, SourceType } from '@bridge/types';
import type { FilterNode } from '@filter/index';
import { createStreamSession } from '../viewer';
import type {
  CacheController,
  StreamPusher,
  StreamSession,
  StreamSessionStatus,
  StreamStartOptions,
} from '../viewer';
import type { SessionStore } from '../app/index';

/** The bridge calls this store drives beyond start/stop, injectable for tests. */
export type StreamCommands = Pick<
  typeof cmds,
  | 'listAdbDevices'
  | 'getPackagePids'
  | 'setStreamAnonymize'
  | 'updateStreamProcessors'
  | 'updateStreamTrackers'
  | 'updateStreamTransformers'
  | 'saveLiveCapture'
>;

/** The slice of W4a's `AnalyzerStore` this store feeds live counters into —
 *  structural, so a test can pass a literal instead of a real store. See
 *  `analyzers/analyzerStore.ts`'s "Live counters" section for what these
 *  fold into. Optional: omitting it just means a live capture's analyzer
 *  cards never advance past `--`, same as before L3. */
export interface LiveStreamAnalyzers {
  applyProcessorUpdates(sessionId: string, updates: AdbProcessorUpdate[]): void;
  applyProcessorsExcluded(sessionId: string, excluded: AdbProcessorsExcluded['excluded']): void;
}

/**
 * Live incremental filter matching (L4) — threaded straight through to
 * `createStreamSession`'s own `filterAst`/`filterSessionId`/`packagePids`/
 * `appendFilterMatches` options (see that file's doc comment for the exact
 * contract). This store owns no filter state itself; it only carries
 * whichever `FilterScan` the app currently has bound as "the live one" (see
 * `App.tsx`) down to the session primitive that needs to read it per batch.
 * Optional: omitting it just means live batches are never matched against
 * a filter, same as before L4.
 */
export interface LiveStreamFilterHooks {
  filterAst: Accessor<FilterNode | null>;
  filterSessionId: Accessor<string | null>;
  packagePids: Accessor<Map<string, number[]>>;
  appendFilterMatches: (sessionId: string, lineNums: number[]) => void;
}

export interface LiveStreamStoreDeps {
  cacheManager: CacheController;
  registry: StreamPusher;
  sessions: SessionStore;
  /** Feeds `AdbProcessorUpdate`/`AdbProcessorsExcluded` Channel messages into
   *  the analyzer store's live-counter path (L3). Optional so existing
   *  callers/tests that don't care about analyzer cards need no change. */
  analyzers?: LiveStreamAnalyzers;
  /** See {@link LiveStreamFilterHooks}. Optional (L4). */
  filter?: LiveStreamFilterHooks;
  /**
   * Dismiss the top bar's stale failure when a capture actually starts, the
   * same way `openPath` clears it at the start of an open. Without this a
   * startup-restore failure (a workspace naming a file on an unmounted drive,
   * say) sits in the top bar beside a healthy running capture. Called only on
   * the transition INTO streaming, never per batch — `handleBatch` republishes
   * the streaming status on every payload, so clearing on each one would
   * swallow any error raised during the capture.
   */
  clearError?: () => void;
  /** Injected for tests; defaults to the real bridge commands. */
  commands?: Partial<StreamCommands>;
}

export interface LiveStreamStore {
  /** The wrapped `createStreamSession`'s lifecycle status, unchanged. */
  status: Accessor<StreamSessionStatus>;
  active: Accessor<boolean>;

  devices: Accessor<AdbDevice[]>;
  devicesLoading: Accessor<boolean>;
  devicesError: Accessor<string | null>;
  refreshDevices(): Promise<void>;

  /** Start a capture. On success, registers (or re-focuses) its session. */
  start(deviceId?: string, opts?: StreamStartOptions): Promise<void>;
  /** Stop the active capture. Its session stays open as a static log. */
  stop(): Promise<void>;
  /**
   * Stop iff `sessionId` is the current capture's session; a no-op for any
   * other id (including "no capture running"). The `app/actions.ts` `close()`
   * guard this store is built for calls it unconditionally — see
   * `AppActionsDeps.stopLiveSession`'s doc comment.
   */
  stopIfCurrent(sessionId: string): Promise<void>;

  setAnonymize(sessionId: string, enabled: boolean): Promise<void>;
  updateProcessors(sessionId: string, processorIds: string[]): Promise<void>;
  updateTrackers(sessionId: string, trackerIds: string[]): Promise<void>;
  updateTransformers(sessionId: string, transformerIds: string[]): Promise<void>;
  resolvePackagePids(deviceSerial: string, packageName: string): Promise<number[]>;
  /** Write the session's retained raw lines to `outputPath`. Returns the line count. */
  saveCapture(sessionId: string, outputPath: string): Promise<number>;

  dispose(): void;
}

/**
 * A live ADB stream has no `LoadResult` of its own — `start_adb_stream`
 * answers with a status, not a load — so one is synthesized from the
 * `'streaming'` status `createStreamSession` reports. Only the fields the
 * session store and the shell actually read are meaningful; the rest carry
 * the "not a file" values. (Relocated from `app/benchDriver.ts`, which used
 * to build this by hand for its own bench-only registration path.)
 */
function streamLoadResult(status: {
  sessionId: string;
  sourceName: string;
  sourceType: SourceType;
  totalLines: number;
}): LoadResult {
  return {
    sessionId: status.sessionId,
    sourceId: status.sessionId,
    sourceName: status.sourceName,
    filePath: null,
    totalLines: status.totalLines,
    fileSize: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    sourceType: status.sourceType,
    isStreaming: true,
    isIndexing: false,
    hasCrlf: false,
    encoding: 'UTF-8',
  };
}

export function createLiveStreamStore(deps: LiveStreamStoreDeps): LiveStreamStore {
  const { cacheManager, registry, sessions, analyzers, filter } = deps;
  const c: StreamCommands = { ...cmds, ...deps.commands };

  return createRoot((disposeRoot) => {
    const [devices, setDevices] = createSignal<AdbDevice[]>([]);
    const [devicesLoading, setDevicesLoading] = createSignal(false);
    const [devicesError, setDevicesError] = createSignal<string | null>(null);
    let disposed = false;

    const onStatus = (next: StreamSessionStatus): void => {
      if (disposed) return;
      if (next.phase === 'streaming') {
        // A repeat 'streaming' status for a session that is already open —
        // which every batch produces — only updates its line count below. It
        // must not re-register, re-focus, or clear the error bar.
        if (!sessions.byId(next.sessionId)) {
          sessions.add(streamLoadResult(next));
          // Transition into streaming, not every batch — see `clearError`'s
          // doc. Focus belongs here for the same reason: `handleBatch`
          // republishes the streaming status on every payload (a fresh object,
          // so `onStatus` always fires), and focusing from out here snapped
          // the user back to the live tab within ~50 ms of clicking any other
          // one — remounting its `QueryBar` and every focus-derived panel with
          // it, for as long as the capture ran (H2). The registration above
          // is the only "transition into streaming" there is.
          sessions.setFocused(next.sessionId);
          deps.clearError?.();
        }
        // `handleBatch` republishes the status on every batch with the running
        // total, so this is where a live session's line count comes from —
        // nothing else updates it (`updateTotal`'s other callers are the file
        // open path and the index-progress events, neither of which fires for
        // a stream).
        //
        // Missing this was invisible while streaming and destructive on stop.
        // In tail mode the viewer sizes itself from `ScrollControls.
        // liveTotalLines`, which tracks the data source's own `onAppend`
        // total, so the capture rendered correctly and only the top bar's
        // "— 0 lines" hinted at the gap. On stop, `kind` flips to 'file',
        // tail mode goes false, `liveTotalLines` falls back to the
        // `totalLineCount` prop — this entry's count — and a 339k-line capture
        // rendered as an empty viewer while the backend still held every line.
        // Found by the phase's live smoke; no unit test spans the two stores
        // and the viewer, which is why all eight packages passed without it.
        sessions.updateTotal(next.sessionId, next.totalLines, false);
      } else if (next.phase === 'stopped') {
        sessions.setStreamingKind(next.sessionId, false);
      }
    };

    const session: StreamSession = createStreamSession({
      cacheManager,
      registry,
      onStatus,
      onProcessorUpdates: (sessionId, updates) => analyzers?.applyProcessorUpdates(sessionId, updates),
      onProcessorsExcluded: (payload) => analyzers?.applyProcessorsExcluded(payload.sessionId, payload.excluded),
      filterAst: filter?.filterAst,
      filterSessionId: filter?.filterSessionId,
      packagePids: filter?.packagePids,
      appendFilterMatches: filter?.appendFilterMatches,
    });

    const refreshDevices = async (): Promise<void> => {
      setDevicesLoading(true);
      setDevicesError(null);
      try {
        const found = await c.listAdbDevices();
        if (!disposed) setDevices(found);
      } catch (e) {
        if (!disposed) setDevicesError(String(e));
      } finally {
        if (!disposed) setDevicesLoading(false);
      }
    };

    const stopIfCurrent = async (sessionId: string): Promise<void> => {
      const current = session.status();
      if (current.phase === 'streaming' && current.sessionId === sessionId) {
        await session.stop();
      }
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      // Best-effort: don't leave a backend capture task orphaned when the app
      // tears this store down (mirrors the old benchDriver's own onCleanup).
      void session.stop();
      disposeRoot();
    };

    return {
      status: session.status,
      active: session.active,

      devices,
      devicesLoading,
      devicesError,
      refreshDevices,

      start: session.start,
      stop: session.stop,
      stopIfCurrent,

      setAnonymize: (sessionId, enabled) => c.setStreamAnonymize(sessionId, enabled),
      updateProcessors: (sessionId, processorIds) => c.updateStreamProcessors(sessionId, processorIds),
      updateTrackers: (sessionId, trackerIds) => c.updateStreamTrackers(sessionId, trackerIds),
      updateTransformers: (sessionId, transformerIds) => c.updateStreamTransformers(sessionId, transformerIds),
      resolvePackagePids: (deviceSerial, packageName) => c.getPackagePids(deviceSerial, packageName),
      saveCapture: (sessionId, outputPath) => c.saveLiveCapture(sessionId, outputPath),

      dispose,
    };
  });
}
