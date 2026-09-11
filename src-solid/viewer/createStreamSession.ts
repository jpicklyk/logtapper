import { createSignal, createMemo, onCleanup, batch } from 'solid-js';
import type { Accessor } from 'solid-js';
import { startAdbStream, stopAdbStream } from '@bridge/commands';
import type {
  AdbStreamEvent,
  AdbBatchPayload,
  AdbProcessorUpdate,
  LoadResult,
  SourceType,
} from '@bridge/types';
import type { CacheController } from '@cache/CacheManager';
import type { StreamPusher } from '@viewport/DataSourceRegistry';

/**
 * Plain Solid module — ADB streaming session lifecycle.
 *
 * Port of `src-next/hooks/useLogViewer/useStreamSession.ts`'s core batch/stop
 * handling, without the React-only wiring (`SharedLogViewerRefs`, session-tab
 * registration, filter-AST incremental matching, pipeline bus dispatch) that
 * belongs to later phases. See the TODO markers below for what was
 * deliberately left out and which plan phase owns it.
 *
 * Ownership: `createStreamSession(...)` registers `onCleanup`, so it MUST be
 * called inside a component body or an explicit `createRoot` the caller owns.
 * Disposing that root flips the internal `channelActive` guard false, so a
 * message that arrives after disposal is dropped — but it does NOT call the
 * backend `stop_adb_stream`; callers must still await `stop()` themselves
 * (or accept an orphaned backend stream) before tearing down the owner.
 *
 * Tail-mode follow is deliberately NOT re-implemented here. `registry
 * .pushToSession()` already fires `onAppend` on every `CacheDataSource`
 * registered for the session (see `@viewport/DataSourceRegistry` /
 * `@viewport/CacheDataSource`), and P2's `ScrollControls` already subscribes
 * to that `onAppend` to track `liveTotalLines` / the "N new lines" badge. P3
 * and P5 subscribe the same way — no extra signal is exposed here, per the
 * plan's "reuse the registry's onAppend" option.
 */

/** Options accepted by {@link StreamSession.start}. */
export interface StreamStartOptions {
  packageFilter?: string;
  activeProcessorIds?: string[];
  maxRawLines?: number;
}

/**
 * Lifecycle status. Deliberately a discriminated union (rather than mirroring
 * the React hook's scattered refs/state) so `status()` alone tells a Solid
 * consumer everything needed to render — no side-channel refs to read.
 */
export type StreamSessionStatus =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | {
      phase: 'streaming';
      sessionId: string;
      sourceName: string;
      sourceType: SourceType;
      totalLines: number;
    }
  | { phase: 'stopped'; sessionId: string; reason: string }
  | { phase: 'error'; message: string };

export interface StreamSessionOptions {
  cacheManager: CacheController;
  registry: StreamPusher;
  /**
   * Called synchronously whenever `status()` transitions. A non-reactive
   * convenience for callers that would rather wire a plain callback (e.g.
   * bus dispatch) than track a Solid accessor — never called from a render
   * body, only from the async `start`/`stop` flow or the Channel's own
   * message callback, both of which are ordinary event-handler contexts.
   */
  onStatus?: (status: StreamSessionStatus) => void;
}

export interface StreamSession {
  /** Start a new ADB stream. Stops any prior stream state this instance owns first. */
  start(deviceId?: string, opts?: StreamStartOptions): Promise<void>;
  /** Stop the active stream (no-op if nothing is running). */
  stop(): Promise<void>;
  /** Current lifecycle status. */
  status: Accessor<StreamSessionStatus>;
  /** True exactly while `status().phase === 'streaming'`. */
  active: Accessor<boolean>;
}

export function createStreamSession(options: StreamSessionOptions): StreamSession {
  const { cacheManager, registry, onStatus } = options;

  const [status, setStatus] = createSignal<StreamSessionStatus>({ phase: 'idle' });
  const active = createMemo(() => status().phase === 'streaming');

  // Non-reactive guard: true only while messages from the CURRENT stream's
  // Channel should be applied. Mirrors `channelActiveRef` in the React hook —
  // flipped false BEFORE `stopAdbStream` is awaited, so a message already
  // in flight when `stop()` is called can never be processed after teardown
  // begins (ported from `useLogViewer/streamStateMachine.ts`'s ordering
  // invariant, which is React-hooks-only and not importable from src-solid).
  let channelActive = false;
  let currentSessionId: string | null = null;

  const applyStatus = (next: StreamSessionStatus): void => {
    setStatus(next);
    onStatus?.(next);
  };

  const handleBatch = (payload: AdbBatchPayload): void => {
    if (!channelActive || payload.sessionId !== currentSessionId) return;

    // Store-then-notify, same order as the React hook: broadcastToSession
    // populates the bounded ViewCacheHandle LRU before pushToSession fires
    // onAppend, so a listener reacting to onAppend can already read the new
    // lines via dataSource.getLine().
    batch(() => {
      cacheManager.broadcastToSession(payload.sessionId, payload.lines);
      registry.pushToSession(payload.sessionId, payload.lines, payload.totalLines);
    });

    const prev = status();
    if (prev.phase === 'streaming' && prev.sessionId === payload.sessionId) {
      applyStatus({ ...prev, totalLines: payload.totalLines });
    }

    // TODO(plan §filter UI phase): incremental filter-AST matching for lines
    // arriving after the create_filter snapshot — useFilterScan.appendMatches
    // in the React hook (useStreamSession.handleAdbBatch).
  };

  const handleProcessorUpdate = (_payload: AdbProcessorUpdate): void => {
    // TODO(P5): accumulate + flush a `pipeline:adb-processor-batch` bus
    // dispatch equivalent once src-solid has an event bus / pipeline
    // context to dispatch into. React's version batches updates from the
    // same flush_batch call into one microtask-flushed bus emit.
  };

  const handleStreamStopped = (sessionId: string, reason: string): void => {
    if (sessionId !== currentSessionId) return;
    channelActive = false;
    currentSessionId = null;
    applyStatus({ phase: 'stopped', sessionId, reason });
    // TODO(spike — out of scope): auto-reconnect on quick EOF failures
    // (useStreamSession's QUICK_FAILURE_MS / MAX_CONSECUTIVE_QUICK_FAILURES
    // / RECONNECT_DELAY_MS) is not ported. The bench harness (P4 §C) does not
    // need it — the fake-adb shim loops its fixture rather than EOF-ing.
  };

  const handleChannelEvent = (msg: AdbStreamEvent): void => {
    if (!channelActive) return;
    if (msg.event === 'batch') {
      handleBatch(msg.data);
    } else if (msg.event === 'processorUpdate') {
      handleProcessorUpdate(msg.data);
    } else if (msg.event === 'streamStopped') {
      handleStreamStopped(msg.data.sessionId, msg.data.reason);
    }
  };

  const start = async (deviceId?: string, opts: StreamStartOptions = {}): Promise<void> => {
    // A prior stream owned by this instance is stopped first — mirrors the
    // React hook's "stop the previous stream if one is still running" guard,
    // minus the auto-reconnect/pane bookkeeping that belongs to later phases.
    if (currentSessionId) {
      await stop();
    }

    applyStatus({ phase: 'starting' });
    channelActive = false;

    let result: LoadResult;
    try {
      result = await startAdbStream(
        deviceId,
        opts.packageFilter,
        opts.activeProcessorIds ?? [],
        opts.maxRawLines,
        handleChannelEvent,
      );
    } catch (e) {
      channelActive = false;
      currentSessionId = null;
      applyStatus({ phase: 'error', message: String(e) });
      return;
    }

    currentSessionId = result.sessionId;
    channelActive = true;
    applyStatus({
      phase: 'streaming',
      sessionId: result.sessionId,
      sourceName: result.sourceName,
      sourceType: result.sourceType as SourceType,
      totalLines: result.totalLines,
    });
  };

  const stop = async (): Promise<void> => {
    const sessionId = currentSessionId;
    if (!sessionId) return;
    // Guard flipped false BEFORE the backend call is awaited — see the
    // `channelActive` comment above.
    channelActive = false;
    currentSessionId = null;
    try {
      await stopAdbStream(sessionId);
    } catch (e) {
      console.warn('[createStreamSession] stopAdbStream failed (best-effort):', e);
    }
    applyStatus({ phase: 'stopped', sessionId, reason: 'stopped' });
  };

  onCleanup(() => {
    channelActive = false;
  });

  return { start, stop, status, active };
}
