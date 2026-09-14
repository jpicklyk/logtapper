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
 */
import { createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import * as cmds from '@bridge/commands';
import type { AdbDevice, LoadResult, SourceType } from '@bridge/types';
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

export interface LiveStreamStoreDeps {
  cacheManager: CacheController;
  registry: StreamPusher;
  sessions: SessionStore;
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
  const { cacheManager, registry, sessions } = deps;
  const c: StreamCommands = { ...cmds, ...deps.commands };

  return createRoot((disposeRoot) => {
    const [devices, setDevices] = createSignal<AdbDevice[]>([]);
    const [devicesLoading, setDevicesLoading] = createSignal(false);
    const [devicesError, setDevicesError] = createSignal<string | null>(null);
    let disposed = false;

    const onStatus = (next: StreamSessionStatus): void => {
      if (disposed) return;
      if (next.phase === 'streaming') {
        // A repeat 'streaming' status for a session that is already open
        // (there is no reconnect path today, but nothing here assumes that)
        // just re-focuses it rather than re-registering.
        if (!sessions.byId(next.sessionId)) sessions.add(streamLoadResult(next));
        sessions.setFocused(next.sessionId);
      } else if (next.phase === 'stopped') {
        sessions.setStreamingKind(next.sessionId, false);
      }
    };

    const session: StreamSession = createStreamSession({ cacheManager, registry, onStatus });

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
