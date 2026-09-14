import { createSignal, createMemo, onCleanup, batch } from 'solid-js';
import type { Accessor } from 'solid-js';
import { startAdbStream, stopAdbStream } from '@bridge/commands';
import type {
  AdbStreamEvent,
  AdbBatchPayload,
  AdbProcessorUpdate,
  AdbProcessorsExcluded,
  LoadResult,
  SourceType,
} from '@bridge/types';
import type { CacheController } from '@cache/CacheManager';
import type { StreamPusher } from '@viewport/DataSourceRegistry';
import { matchesFilter } from '@filter/index';
import type { FilterNode } from '@filter/index';

/**
 * Plain Solid module — ADB streaming session lifecycle.
 *
 * Port of `src-next/hooks/useLogViewer/useStreamSession.ts`'s core batch/stop
 * handling, plus (as of L1) its incremental filter-AST matching. What stays
 * deliberately out of this file — and belongs one layer up — is anything that
 * needs the rest of the app: session-tab registration (`store.add` /
 * `store.setFocused`) lives in `src-solid/stream/streamStore.ts`, which wraps
 * this module and is the thing components actually construct; pipeline bus
 * dispatch has no Solid event bus to dispatch into yet (see
 * `handleProcessorUpdate` below). Keeping this file free of `SessionStore` /
 * bus coupling is deliberate: it stays constructible and testable on its own,
 * exactly as the original doc comment intended.
 *
 * Ownership: `createStreamSession(...)` registers `onCleanup`, so it MUST be
 * called inside a component body or an explicit `createRoot` the caller owns.
 * Disposing that root flips the internal `channelActive` guard false, so a
 * message that arrives after disposal is dropped — but it does NOT call the
 * backend `stop_adb_stream`; callers must still await `stop()` themselves
 * (or accept an orphaned backend stream) before tearing down the owner.
 *
 * Tail-mode follow is deliberately NOT re-implemented here, and this was
 * re-verified rather than taken on faith: `registry.pushToSession()` already
 * fires `onAppend` on every `CacheDataSource` registered for the session (see
 * `@viewport/DataSourceRegistry` / `@viewport/CacheDataSource`), and
 * `ScrollControls` already subscribes to that `onAppend` to track
 * `liveTotalLines` / the "N new lines" badge (`viewer/scrollControls.ts`).
 * `App.tsx` already passes `tailMode={entry().kind === 'live'}` to
 * `LogViewer`, so once a stream's session is registered (see
 * `stream/streamStore.ts`), auto-follow works with zero additional code here
 * — there is nothing left to port for this piece.
 *
 * Filter-AST incremental matching (`options.filterAst` /
 * `options.appendFilterMatches` below) IS ported — the same `matchesFilter`
 * check React's `handleAdbBatch` runs against `refs.filterAstRef` — as an
 * injectable capability rather than a hard dependency, because the AST and
 * append-target live in `src-solid/query/` (`FilterScan`), which this
 * package does not own. As of L4 (task `2ecd8bbc`) it IS wired: `FilterScan`
 * gained `currentFilter()` (the AST + resolved pids accessor this needed)
 * and `appendMatches()` (routed through its own `flush()`), and
 * `src-solid/App.tsx` binds whichever `FilterScan` is currently the live
 * session's to these four options. See that file's `bindLiveFilter` comment
 * for why the binding is indirect (a `FilterScan` is private to whichever
 * `QueryBar` constructs it).
 *
 * Live processor-update forwarding (`options.onProcessorUpdates` /
 * `options.onProcessorsExcluded` below) was completed by L3 (task
 * `2439a7c5`), closing the TODO this file's `handleProcessorUpdate` used to
 * carry ("once src-solid has an event bus / pipeline context to dispatch
 * into") — `analyzers/analyzerStore.ts`'s live-counter methods are that
 * pipeline context. Same batching shape as React's `useStreamSession.ts`:
 * `processorUpdate` messages accumulate and flush once per macrotask
 * (`setTimeout(…, 0)`, not a microtask — Channel messages can arrive in
 * separate microtask cycles, so a macrotask gives a wider window to collect
 * every update from one `flush_batch` call), while `processorsExcluded` is
 * forwarded as-is on arrival (sent once when the exclusion set first becomes
 * non-empty and again whenever it changes, never once per batch). Also fixes
 * a real gap this file had: `handleChannelEvent`'s `if`/`else if` chain had
 * no branch at all for `'processorsExcluded'` — that event was silently
 * dropped, not merely stubbed.
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

  /**
   * The currently-committed filter AST to check newly arrived lines against,
   * and the session it applies to — mirrors React's `filterAstRef` /
   * `filterAstSessionIdRef`. Read together on every batch: a match is only
   * attempted when `filterAst()` is non-null AND `filterSessionId()` equals
   * the batch's `sessionId`, so a filter committed for a different pane's
   * session can never capture (or be polluted by) this stream. Both absent
   * (the default) disables incremental matching entirely — no capability is
   * lost by omitting them, since `create_filter` still covers everything up
   * to the snapshot it was created from.
   */
  filterAst?: Accessor<FilterNode | null>;
  filterSessionId?: Accessor<string | null>;
  /** Resolved `package:` → pids for the active filter. Defaults to empty. */
  packagePids?: Accessor<Map<string, number[]>>;
  /**
   * Reports line numbers matched by `filterAst` within one batch. The caller
   * (a `FilterScan` instance, once one is wired to a live session) appends
   * these to its own matched-lines set — mirrors React's
   * `appendFilterMatchesRef.current?.(sessionId, newMatches)`.
   */
  appendFilterMatches?: (sessionId: string, lineNums: number[]) => void;

  /**
   * Receives one batched flush of `AdbProcessorUpdate`s — every update the
   * Channel delivered since the last flush, from possibly several processors
   * — so a caller (the analyzer store's live-counter path) writes its
   * reactive state once per flush instead of once per message. Never called
   * with an empty array.
   */
  onProcessorUpdates?: (sessionId: string, updates: AdbProcessorUpdate[]) => void;
  /** Forwarded verbatim, one call per `processorsExcluded` Channel message. */
  onProcessorsExcluded?: (payload: AdbProcessorsExcluded) => void;
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

  // Processor-update batching: accumulate, flush once per macrotask. See the
  // module doc's "Live processor-update forwarding" section for why a
  // macrotask (not a microtask) and why this mirrors React's own buffer.
  let pendingProcessorUpdates: AdbProcessorUpdate[] = [];
  let flushScheduled = false;

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
    // The running-total status write joins the same batch: left outside it, a
    // batch cost the render layer two reactive flushes (and two commits) per
    // arriving payload instead of one.
    batch(() => {
      cacheManager.broadcastToSession(payload.sessionId, payload.lines);
      registry.pushToSession(payload.sessionId, payload.lines, payload.totalLines);

      const prev = status();
      if (prev.phase === 'streaming' && prev.sessionId === payload.sessionId) {
        applyStatus({ ...prev, totalLines: payload.totalLines });
      }
    });

    // Incremental filter: check only this batch's new lines against the
    // committed AST, same as React's `handleAdbBatch`. Applied outside the
    // `batch()` above deliberately — `appendFilterMatches` writes to a
    // different owner's (FilterScan's) reactive state, not this session's.
    const ast = options.filterAst?.();
    if (ast && options.filterSessionId?.() === payload.sessionId) {
      const pids = options.packagePids?.() ?? new Map<string, number[]>();
      const newMatches = payload.lines
        .filter((line) => matchesFilter(ast, line, pids))
        .map((line) => line.lineNum);
      if (newMatches.length > 0) {
        options.appendFilterMatches?.(payload.sessionId, newMatches);
      }
    }
  };

  const flushProcessorUpdates = (): void => {
    flushScheduled = false;
    if (pendingProcessorUpdates.length === 0) return;
    const updates = pendingProcessorUpdates;
    pendingProcessorUpdates = [];
    // The batch can span a stop/restart if messages queue across a macrotask
    // boundary; only forward while still bound to the stream that produced
    // them, same guard `handleChannelEvent` already applies per-message.
    if (channelActive) options.onProcessorUpdates?.(updates[0].sessionId, updates);
  };

  const handleProcessorUpdate = (payload: AdbProcessorUpdate): void => {
    // Same session guard as `handleBatch` and `handleProcessorsExcluded`. It
    // matters more here than it looks: `flushProcessorUpdates` attributes the
    // whole buffered batch to `updates[0].sessionId`, so one stale update
    // admitted at the head would misattribute every update behind it. Guarding
    // on entry keeps the buffer homogeneous, which is what makes that
    // `updates[0]` read correct by construction rather than by luck.
    if (payload.sessionId !== currentSessionId) return;
    pendingProcessorUpdates.push(payload);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flushProcessorUpdates, 0);
    }
  };

  const handleProcessorsExcluded = (payload: AdbProcessorsExcluded): void => {
    if (payload.sessionId !== currentSessionId) return;
    options.onProcessorsExcluded?.(payload);
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
    } else if (msg.event === 'processorsExcluded') {
      handleProcessorsExcluded(msg.data);
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
