/**
 * Device state store (W5): the analyzers' understanding of the device at the
 * viewer cursor — a snapshot for the session's selected state tracker, its
 * diff against the previously displayed snapshot, transition navigation, and
 * per-tracker transition data for the on-demand timeline strip.
 *
 * Lifetime: owns a `createRoot` (same pattern as `analyzers/analyzerStore.ts`,
 * `sections/sectionsStore.ts`) so it can be built outside a component body.
 * `dispose()` clears every session's debounce timer and tears the root down.
 *
 * ## Deviation from the task-scope note, disclosed
 *
 * The task text says `timeline(sid, trackerId)` fetches via `getTimelineData`
 * (the bridge command backing `ChartData`/`DataSeries`). Read
 * `src-tauri/src/services/timeline.rs`'s own module doc first: `chart_data`/
 * `timeline_data` are Reporter-only — `build_charts`/`build_chart` short-
 * circuit to an empty result for any non-Reporter processor, and neither
 * reads a state tracker's transition history at all ("No `services::tracker`
 * reuse either... there is nothing here that re-reads a result map
 * `services::tracker` already owns"). `ChartData`/`DataSeries` are therefore
 * not reachable for a `state_tracker` processor by construction. The React
 * app confirms this split: `StateTimeline.tsx` builds its tracker tracks from
 * `stateTracker.getTransitions()` (→ `getStateTransitions`, the same command
 * this store's `transitions()` already calls) and only calls `getTimelineData`
 * for **Reporter** processors' sparkline tracks — out of this package's scope
 * (device state + timeline is trackers only; reporter timelines are a W4b/
 * analyzer concern). `timeline(sid, trackerId)` below is therefore built from
 * this store's own `transitions()` cache, gated on `trackerTimeline !== false`
 * — same generation-cached data, no second network call, no unreachable
 * `getTimelineData` call for a tracker id.
 *
 * The "throttled like `useStateTracker.ts`" note refers to that hook's
 * ADB-streaming throttle (at most one `getAllTransitionLines` refresh per 3s,
 * driven by `adb-tracker-update` events). At the time this doc comment was
 * first written, nothing in `src-solid/` wired ADB streaming events (checked
 * — no consumer of `onAdbTrackerUpdate` anywhere under `src-solid/`), so
 * `transitions()` refreshed once per pipeline-run generation only. L1 has
 * since landed live sessions (`SessionEntry.kind`), so this was re-checked
 * for L3 rather than assumed still true — it *was* still true (re-grepped:
 * still zero consumers before this package) — and `transitions()` is
 * deliberately left as-is: a live ADB stream has no discrete pipeline "run"
 * (`analyzers.lastRunAt()` stays `null` throughout a capture — `run()` is
 * the file-mode path only), so `transitions()`/`timeline()` simply never
 * populate during live streaming. That is not a regression to fix here: the
 * task-scope's own "No live timeline strip" constraint means `TimelineStrip`
 * is post-mortem-only by design, and `DeviceStatePanel`'s transition-nav
 * chip (prev/next transition, driven by the same `transitions()` cache) is
 * hidden whenever a session is live — see `isLive` below.
 *
 * ## Live "now" projection (L3, task `2439a7c5`)
 *
 * For a session whose `SessionEntry.kind === 'live'` (read via
 * {@link DeviceStateSessions.byId}, never `LiveStreamStore.status()` — see
 * task `fe34022c`'s implementation-notes on why the session-store field, not
 * the stream store's own lifecycle signal, is the right thing to read here),
 * `DeviceStatePanel` renders a "now" snapshot instead of the cursor-tied one:
 * the selected tracker's state at `Number.MAX_SAFE_INTEGER` (the highest
 * known line — "now"), refetched on a throttle rather than a debounce. This
 * reuses the exact same `snapshot`/`snapshotLoading`/`changes` signals and
 * `applySnapshot` field-diffing the cursor-tied path writes — only the
 * trigger and the fetched line differ — so `DeviceStatePanel`'s field-table
 * rendering needs no live-specific branch at all, only its empty-state text
 * and the (now conceptually meaningless) transition-nav chip.
 *
 * The trigger is `adb-tracker-update` (`AdbTrackerUpdate`, a genuine Tauri
 * broadcast event — unlike `AdbProcessorUpdate`/`AdbProcessorsExcluded`,
 * which arrive only via the streaming Channel and are therefore NOT directly
 * subscribable here; see `analyzers/analyzerStore.ts`'s "Live counters"
 * section for that path), throttled per session to one refresh per 3s to
 * match React's `components/StatePanel/StatePanel.tsx` reference cited in
 * this task's brief. React's own implementation actually blends a 2s
 * `adb:run-count-bump` throttle (`usePipelineWiring.ts`) with a separate 3s
 * `refreshTransitionLines` throttle (`useStateTracker.ts`) across two hooks
 * — there is no single 3s constant to port literally. This store uses one
 * explicit 3s throttle ({@link LIVE_REFRESH_THROTTLE_MS}), trailing-edge
 * (mirrors `useStateTracker.refreshTransitionLines`'s own timer shape: the
 * first event in a quiet period schedules a fetch 3s out; every event that
 * arrives while that timer is already pending is absorbed for free), plus
 * an immediate fetch whenever the effective tracker changes or a session
 * newly becomes live — so the panel is never left showing stale-by-default
 * data purely because no `adb-tracker-update` has arrived yet this session.
 * `state.guard` ({@link GenerationGuard}) is shared between the cursor-tied
 * and live fetch paths: they never run for the same session at the same
 * time (one is gated on `!isLive(sessionId)`, the other on `isLive`), so a
 * single per-session guard correctly discards either path's late-settling
 * fetch without needing a second guard instance.
 *
 * Deliberately NOT ported: `SessionDeviceState.snapshotCache` (the
 * per-run-generation cache for `trackerMode: 'snapshot'` processors). A live
 * stream has no run generation to key it on, and caching a "now" value would
 * defeat the entire point of a continuously refreshing live projection —
 * every live fetch is a genuine fresh `getStateAtLine` call.
 *
 * When a live session's stream stops (`kind` flips `'live'` → `'file'`),
 * this store does nothing special: `isLive(sessionId)` starts reading
 * `false`, the live effect's guard clause stops firing, and the *existing*
 * cursor-tied effect (which has been idle, not torn down) picks back up —
 * on whatever cursor state already existed for that session. In practice
 * that means the last "now" snapshot stays displayed, frozen, until the
 * user clicks a line (post-mortem browsing resumes exactly as it would for
 * any freshly-opened file). No snapshot is cleared and no extra fetch is
 * forced on the stop transition itself.
 */
import { createEffect, createMemo, createRoot, createSignal, getOwner, runWithOwner, untrack } from 'solid-js';
import type { Accessor, Owner } from 'solid-js';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getStateAtLine, getStateTransitions } from '@bridge/commands';
import { onAdbTrackerUpdate } from '@bridge/events';
import type { AdbTrackerUpdate, FieldChange, ProcessorSummary, StateSnapshot, StateTransition } from '@bridge/types';
import type { CursorPosition, NavSource } from '../viewer';
import { createGenerationGuard } from '../reactive';
import type { GenerationGuard } from '../reactive';

/** Debounce window between a cursor move and the resulting `getStateAtLine`
 *  fetch — cheap enough that a fast scroll doesn't fire one request per line. */
export const SNAPSHOT_DEBOUNCE_MS = 80;

/** Throttle window between live "now" refreshes while a session streams —
 *  see the module doc's "Live 'now' projection" section for why 3s and why
 *  trailing-edge. */
export const LIVE_REFRESH_THROTTLE_MS = 3000;

/** The slice of W0b's session store this store reads — structural, so a test
 *  can pass a literal. `order()` prunes per-session state when a session
 *  closes (mirrors `analyzerStore`'s own `sessions.order()` prune effect);
 *  `byId(sessionId)?.kind` is read only for its `'live'`/`'file'` value (a
 *  real `SessionEntry` carries far more, structurally compatible as-is). */
export interface DeviceStateSessions {
  order(): readonly string[];
  byId(sessionId: string): { kind: 'file' | 'live' } | undefined;
}

/** The slice of W0a's `ViewerController` this store drives — structural on
 *  purpose, so a test double never has to satisfy the real controller. */
export interface DeviceStateController {
  cursor: Accessor<CursorPosition | null>;
  scrollToLine(sessionId: string, line: number, opts?: { source?: NavSource }): void;
}

/** The slice of W4a's `AnalyzerStore` this store reads: which state trackers
 *  are active in a session's chain, and a cheap proxy for "the pipeline
 *  re-ran" (a run's completion timestamp — `null` until the first run). */
export interface DeviceStateAnalyzers {
  trackers(sessionId: string): ProcessorSummary[];
  lastRunAt(sessionId: string): number | null;
}

/** Bridge commands this store calls, injected so tests never touch real IPC. */
export interface DeviceStateCommands {
  getStateAtLine(sessionId: string, trackerId: string, lineNum: number): Promise<StateSnapshot>;
  getStateTransitions(sessionId: string, trackerId: string): Promise<StateTransition[]>;
}

const defaultCommands: DeviceStateCommands = { getStateAtLine, getStateTransitions };

export interface DeviceStateStoreDeps {
  sessions: DeviceStateSessions;
  controller: DeviceStateController;
  analyzers: DeviceStateAnalyzers;
  commands?: DeviceStateCommands;
  /** Injected for tests; defaults to `onAdbTrackerUpdate`. Drives the live
   *  "now" projection's throttled refresh — see the module doc. */
  listenTrackerUpdate?: (cb: (payload: AdbTrackerUpdate) => void) => Promise<UnlistenFn>;
}

export interface TransitionPosition {
  /** Count of transitions at or before the cursor line (0 when the cursor is
   *  before the first transition, or there is no cursor in this session). */
  index: number;
  total: number;
}

/** One tracker's transition history, shaped for `TimelineStrip` — the Solid
 *  analogue of React's `StateTimeline/timelineUtils.ts`'s `TrackerTimeline`. */
export interface TrackerTimelineTrack {
  trackerId: string;
  trackerName: string;
  transitions: StateTransition[];
}

export interface DeviceStateStore {
  /** Active state trackers in this session's chain — a thin passthrough to
   *  `analyzers.trackers(sid)`, re-exposed so a consumer needs only this
   *  store's import, not both. */
  trackers(sessionId: string): ProcessorSummary[];
  /** The tracker whose snapshot is displayed — an explicit override if one
   *  was set via {@link setSelectedTracker}, else the first active tracker. */
  selectedTracker(sessionId: string): string | null;
  setSelectedTracker(sessionId: string, trackerId: string | null): void;

  /** Whether the viewer cursor currently belongs to this session — `false`
   *  right after a session opens and before anything has been navigated to,
   *  which is the panel's third empty state ("cursor outside data"). Not
   *  meaningful (and not consulted by the panel) while {@link isLive} — a
   *  live session shows the "now" snapshot regardless of any cursor. */
  hasCursor(sessionId: string): boolean;
  /** `true` while `sessionId` is an active ADB stream (`SessionEntry.kind
   *  === 'live'`) — the panel renders the "now" projection instead of the
   *  cursor-tied one. See the module doc's "Live 'now' projection" section. */
  isLive(sessionId: string): boolean;
  snapshot(sessionId: string): StateSnapshot | null;
  snapshotLoading(sessionId: string): boolean;
  /** Fields that changed between the previously displayed snapshot and the
   *  current one, for the same tracker. Empty when the tracker just changed,
   *  or there is no previous snapshot yet. */
  changes(sessionId: string): Record<string, FieldChange>;

  transitions(sessionId: string, trackerId: string): StateTransition[];
  transitionsLoading(sessionId: string, trackerId: string): boolean;

  /** Where the cursor sits among the *selected* tracker's transitions. */
  transitionPosition(sessionId: string): TransitionPosition | null;
  /** Jump to the transition before the cursor; wraps to the last one when the
   *  cursor is at or before the first transition. */
  prevTransition(sessionId: string): void;
  /** Jump to the transition after the cursor; wraps to the first one when the
   *  cursor is at or after the last transition. */
  nextTransition(sessionId: string): void;

  /** `null` when `trackerId` is not active, or declares `trackerTimeline:
   *  false` — see the module doc's deviation note for what backs this. */
  timeline(sessionId: string, trackerId: string): TrackerTimelineTrack | null;

  dispose(): void;
}

/** Pure — exported for the unit tests, and because it is genuinely useful on
 *  its own. `unknown` values compare by JSON shape once neither is `===` and
 *  both are non-null objects; everything else is a primitive `===` miss. */
export function diffSnapshotFields(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, FieldChange> {
  const out: Record<string, FieldChange> = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const from = prev[key];
    const to = next[key];
    if (valuesEqual(from, to)) continue;
    out[key] = { from, to };
  }
  return out;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Sentinel distinguishing "never fetched" from "fetched for generation
 *  `null`" (a run has not happened yet is itself a valid, cacheable state). */
const UNFETCHED = Symbol('device-state-unfetched');
type FetchedGeneration = number | null | typeof UNFETCHED;

interface TrackerRuntime {
  transitions: Accessor<StateTransition[]>;
  setTransitions: (v: StateTransition[]) => void;
  loading: Accessor<boolean>;
  setLoading: (v: boolean) => void;
  fetchedGeneration: FetchedGeneration;
  /** Guards a late-settling promise after a newer fetch for this same runtime
   *  started (generation changed again before the first one returned). */
  guard: GenerationGuard;
}

interface SessionDeviceState {
  selectedOverride: Accessor<string | null>;
  setSelectedOverride: (v: string | null) => void;
  snapshot: Accessor<StateSnapshot | null>;
  setSnapshot: (v: StateSnapshot | null) => void;
  snapshotLoading: Accessor<boolean>;
  setSnapshotLoading: (v: boolean) => void;
  changes: Accessor<Record<string, FieldChange>>;
  setChanges: (v: Record<string, FieldChange>) => void;
  /** `trackerMode === 'snapshot'` results don't vary by line — cached per run
   *  generation, mirroring `StatePanel.tsx`'s `snapshotCacheRef`. */
  snapshotCache: Map<string, { generation: number | null; snapshot: StateSnapshot }>;
  /** Which tracker the currently displayed snapshot belongs to, so a tracker
   *  switch does not diff two unrelated trackers' fields against each other. */
  displayedTrackerId: string | null;
  /** Guards a late-settling `getStateAtLine` after a newer one was issued.
   *  Shared between the cursor-tied and live "now" fetch paths — see the
   *  module doc's "Live 'now' projection" section for why one guard covers
   *  both. */
  guard: GenerationGuard;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Trailing-edge throttle timer for the live "now" refresh — set the
   *  moment an `adb-tracker-update` schedules a fetch, cleared when that
   *  fetch fires. `undefined` means "not currently throttled" (the next
   *  update may schedule immediately). */
  liveThrottleTimer: ReturnType<typeof setTimeout> | undefined;
  trackerRuntimes: Map<string, TrackerRuntime>;
}

export function createDeviceStateStore(deps: DeviceStateStoreDeps): DeviceStateStore {
  const { sessions, controller, analyzers } = deps;
  const commands = deps.commands ?? defaultCommands;
  const listenTrackerUpdate = deps.listenTrackerUpdate ?? onAdbTrackerUpdate;

  return createRoot((disposeRoot) => {
    const owner = getOwner() as Owner;
    const states = new Map<string, SessionDeviceState>();
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    /** Unlisten-safe subscribe — a promise that settles after `dispose()`
     *  unlistens itself instead of leaking. Same pattern as `app/sessions.ts`
     *  / `analyzers/analyzerStore.ts`. */
    const track = (pending: Promise<UnlistenFn>): void => {
      void pending
        .then((fn) => {
          if (disposed) fn();
          else unlisteners.push(fn);
        })
        .catch(() => undefined);
    };

    const isLiveSession = (sessionId: string): boolean => sessions.byId(sessionId)?.kind === 'live';

    /** One `scheduleLiveRefresh` closure per session with state, so the
     *  single global `adb-tracker-update` subscription below can route an
     *  event to the right session without a second reactive layer. A session
     *  with no state yet (the panel hasn't read anything for it) has no
     *  entry — harmless, since the live effect's immediate fetch (inside
     *  `createSessionState`) covers that session the moment its state IS
     *  created. */
    const liveRefreshSchedulers = new Map<string, () => void>();

    const createTrackerRuntime = (): TrackerRuntime => {
      const [transitions, setTransitionsSignal] = createSignal<StateTransition[]>([]);
      const [loading, setLoadingSignal] = createSignal(false);
      return {
        transitions,
        setTransitions: (v) => setTransitionsSignal(v),
        loading,
        setLoading: (v) => setLoadingSignal(v),
        fetchedGeneration: UNFETCHED,
        guard: createGenerationGuard(),
      };
    };

    /** Lazily created + wired once per (session, tracker) pair: an effect
     *  that refetches whenever the run generation moves. */
    const runtimeFor = (sessionId: string, trackerId: string, state: SessionDeviceState): TrackerRuntime => {
      let runtime = state.trackerRuntimes.get(trackerId);
      if (runtime) return runtime;
      runtime = createTrackerRuntime();
      state.trackerRuntimes.set(trackerId, runtime);

      runWithOwner(owner, () => {
        createEffect(() => {
          const generation = analyzers.lastRunAt(sessionId);
          if (disposed || generation === null || runtime!.fetchedGeneration === generation) return;
          runtime!.fetchedGeneration = generation;
          runtime!.setLoading(true);
          const myToken = runtime!.guard.bump();
          commands
            .getStateTransitions(sessionId, trackerId)
            .then((trans) => {
              if (disposed || !runtime!.guard.isCurrent(myToken)) return;
              runtime!.setTransitions(trans);
              runtime!.setLoading(false);
            })
            .catch(() => {
              if (disposed || !runtime!.guard.isCurrent(myToken)) return;
              runtime!.setLoading(false);
            });
        });
      });
      return runtime;
    };

    /** The tracker the panel shows: the user's pick while it is still in the
     *  session's active set, else the first active tracker. Validating here
     *  (not only when the pick is made) keeps a pick from outliving its tracker
     *  when the analyzer chain changes underneath it. */
    const resolveTracker = (sessionId: string, override: string | null): string | null => {
      const list = analyzers.trackers(sessionId);
      if (override !== null && list.some((t) => t.id === override)) return override;
      return list[0]?.id ?? null;
    };

    const createSessionState = (sessionId: string): SessionDeviceState => {
      const [selectedOverride, setSelectedOverrideSignal] = createSignal<string | null>(null);
      const [snapshot, setSnapshotSignal] = createSignal<StateSnapshot | null>(null);
      const [snapshotLoading, setSnapshotLoadingSignal] = createSignal(false);
      const [changes, setChangesSignal] = createSignal<Record<string, FieldChange>>({});

      const state: SessionDeviceState = {
        selectedOverride,
        setSelectedOverride: (v) => setSelectedOverrideSignal(v),
        snapshot,
        setSnapshot: (v) => setSnapshotSignal(v),
        snapshotLoading,
        setSnapshotLoading: (v) => setSnapshotLoadingSignal(v),
        changes,
        setChanges: (v) => setChangesSignal(v),
        snapshotCache: new Map(),
        displayedTrackerId: null,
        guard: createGenerationGuard(),
        debounceTimer: undefined,
        liveThrottleTimer: undefined,
        trackerRuntimes: new Map(),
      };

      const effectiveTrackerId = createMemo<string | null>(() =>
        resolveTracker(sessionId, selectedOverride()),
      );

      // Shared by both the cursor-tied and live "now" fetch paths (see the
      // module doc) — applies a resolved snapshot to this session's signals,
      // diffing against the previously displayed one only when it belonged
      // to the same tracker.
      const applySnapshot = (trackerId: string, snap: StateSnapshot): void => {
        const prev = state.displayedTrackerId === trackerId ? untrack(state.snapshot) : null;
        state.setChanges(prev ? diffSnapshotFields(prev.fields, snap.fields) : {});
        state.setSnapshot(snap);
        state.setSnapshotLoading(false);
        state.displayedTrackerId = trackerId;
      };

      /** The live "now" fetch: always `Number.MAX_SAFE_INTEGER` (the highest
       *  known line), never cached (see the module doc for why), guarded by
       *  the same `state.guard` the cursor-tied path uses. */
      const fetchNow = (trackerId: string): void => {
        state.setSnapshotLoading(true);
        const myToken = state.guard.bump();
        commands
          .getStateAtLine(sessionId, trackerId, Number.MAX_SAFE_INTEGER)
          .then((snap) => {
            if (disposed || !state.guard.isCurrent(myToken)) return;
            applySnapshot(trackerId, snap);
          })
          .catch(() => {
            if (disposed || !state.guard.isCurrent(myToken)) return;
            state.setSnapshotLoading(false);
          });
      };

      /** Trailing-edge throttle: the first `adb-tracker-update` in a quiet
       *  period schedules a fetch {@link LIVE_REFRESH_THROTTLE_MS} out; every
       *  update that arrives while a timer is already pending is absorbed —
       *  a burst collapses into exactly one refresh. Re-checks `isLive` and
       *  re-resolves the tracker when the timer fires, since either can have
       *  changed during the wait (a tracker switch, or the stream stopping). */
      const scheduleLiveRefresh = (): void => {
        if (state.liveThrottleTimer !== undefined) return;
        state.liveThrottleTimer = setTimeout(() => {
          state.liveThrottleTimer = undefined;
          if (disposed || !isLiveSession(sessionId)) return;
          const trackerId = resolveTracker(sessionId, untrack(state.selectedOverride));
          if (trackerId) fetchNow(trackerId);
        }, LIVE_REFRESH_THROTTLE_MS);
      };

      // Live "now" effect: owns the signals entirely while `isLive` — fires
      // immediately on mount and whenever the effective tracker changes (so
      // switching trackers, or a session newly going live, never waits out a
      // stale throttle window), and again on each throttled
      // `adb-tracker-update` via `scheduleLiveRefresh` above.
      createEffect(() => {
        const trackerId = effectiveTrackerId();
        const live = isLiveSession(sessionId);
        if (disposed || !live) return;

        if (!trackerId) {
          state.setSnapshot(null);
          state.setChanges({});
          state.setSnapshotLoading(false);
          state.displayedTrackerId = null;
          return;
        }
        fetchNow(trackerId);
      });

      // Cursor-tied snapshot fetch: debounced + generation-guarded, and
      // short-circuited entirely for a snapshot-mode tracker once its run
      // generation is cached. Owns the signals only while NOT live — the
      // effect above takes over for a live session.
      createEffect(() => {
        // The tracker id is deliberately the value at schedule time: the
        // debounced fetch below must resolve for the tracker/cursor pair that
        // scheduled it, and `state.guard` discards a response the effect has
        // since superseded. Re-reading the memo inside the timeout would pair
        // a newer tracker with an older cursor line. (No `solid/reactivity`
        // suppression needed here — that rule flags a reactive read whose
        // value visibly escapes into a closure kept past this run; now that
        // `applySnapshot` takes `trackerId` as a parameter instead of closing
        // over this effect's local, the only escaping use is the plain
        // `setTimeout` closure below, which the rule already accepts.)
        const trackerId = effectiveTrackerId();
        const cursor = controller.cursor();
        const live = isLiveSession(sessionId);
        if (disposed) return;

        // `controller.cursor()` is a single global signal, so this effect
        // re-runs for *every* session that has state whenever any pane's
        // cursor moves. A move in another session must not cancel this
        // session's pending fetch (review C-M3): bail out before touching the
        // debounce timer. The `live` / `!trackerId` branches below still need
        // their clears, so only the "nothing about this session changed" case
        // returns here.
        if (cursor && cursor.sessionId !== sessionId && !live && trackerId) return;

        // Past this point the run either schedules a new fetch or clears the
        // signals, so any fetch already scheduled is superseded.
        const abandonedFetch = state.debounceTimer !== undefined;
        if (abandonedFetch) {
          clearTimeout(state.debounceTimer);
          state.debounceTimer = undefined;
        }

        // The live effect above owns the signals for a live session — bail
        // out without touching `snapshot`/`changes`/`loading` so it never
        // fights the live effect's own writes for the same session.
        if (live) return;

        if (!trackerId) {
          state.setSnapshot(null);
          state.setChanges({});
          state.setSnapshotLoading(false);
          state.displayedTrackerId = null;
          return;
        }
        if (!cursor || cursor.sessionId !== sessionId) {
          // Nothing left to resolve the `snapshotLoading` the previous run
          // set — without this the panel shows "Loading…" until the user
          // moves the cursor inside this session again (C-M3).
          if (abandonedFetch) state.setSnapshotLoading(false);
          return;
        }

        const line = cursor.line;
        const meta = analyzers.trackers(sessionId).find((t) => t.id === trackerId);
        const isSnapshotMode = meta?.trackerMode === 'snapshot';
        const generation = analyzers.lastRunAt(sessionId);

        if (isSnapshotMode) {
          const cached = state.snapshotCache.get(trackerId);
          if (cached && cached.generation === generation) {
            applySnapshot(trackerId, cached.snapshot);
            return;
          }
        }

        state.setSnapshotLoading(true);
        const myToken = state.guard.bump();
        state.debounceTimer = setTimeout(() => {
          state.debounceTimer = undefined;
          commands
            .getStateAtLine(sessionId, trackerId, line)
            .then((snap) => {
              if (disposed || !state.guard.isCurrent(myToken)) return;
              if (isSnapshotMode) state.snapshotCache.set(trackerId, { generation, snapshot: snap });
              applySnapshot(trackerId, snap);
            })
            .catch(() => {
              if (disposed || !state.guard.isCurrent(myToken)) return;
              state.setSnapshotLoading(false);
            });
        }, SNAPSHOT_DEBOUNCE_MS);
      });

      // The global (root-level) `adb-tracker-update` subscription below
      // routes into this closure for whichever session's state already
      // exists — registered in a small side map, not on `SessionDeviceState`
      // itself, since it is bookkeeping for that subscription, not state the
      // rest of this file reads.
      liveRefreshSchedulers.set(sessionId, scheduleLiveRefresh);

      return state;
    };

    const stateFor = (sessionId: string): SessionDeviceState => {
      let state = states.get(sessionId);
      if (!state) {
        state = runWithOwner(owner, () => createSessionState(sessionId)) as SessionDeviceState;
        states.set(sessionId, state);
      }
      return state;
    };

    // Prune state for sessions that no longer exist — same discipline as
    // `analyzerStore`'s own `sessions.order()` cleanup effect.
    runWithOwner(owner, () => {
      createEffect(() => {
        const ids = new Set(sessions.order());
        for (const key of [...states.keys()]) {
          if (ids.has(key)) continue;
          const stale = states.get(key);
          if (stale?.debounceTimer !== undefined) clearTimeout(stale.debounceTimer);
          if (stale?.liveThrottleTimer !== undefined) clearTimeout(stale.liveThrottleTimer);
          states.delete(key);
          liveRefreshSchedulers.delete(key);
        }
      });
    });

    // Live "now" projection trigger: a genuine Tauri broadcast event (unlike
    // `AdbProcessorUpdate`/`AdbProcessorsExcluded`, which arrive only via the
    // streaming Channel — see `analyzers/analyzerStore.ts`), so it is
    // subscribed directly here rather than through `stream/streamStore.ts`.
    // Routed by `payload.sessionId`, guarded by `isLiveSession` so an event
    // for a session that has since stopped streaming (or one this store has
    // no state for yet) is a cheap no-op.
    track(
      listenTrackerUpdate((payload: AdbTrackerUpdate) => {
        if (disposed || !isLiveSession(payload.sessionId)) return;
        liveRefreshSchedulers.get(payload.sessionId)?.();
      }),
    );

    const trackers = (sessionId: string): ProcessorSummary[] => analyzers.trackers(sessionId);

    const selectedTracker = (sessionId: string): string | null =>
      resolveTracker(sessionId, stateFor(sessionId).selectedOverride());

    const setSelectedTracker = (sessionId: string, trackerId: string | null): void => {
      stateFor(sessionId).setSelectedOverride(trackerId);
    };

    const hasCursor = (sessionId: string): boolean => {
      const cursor = controller.cursor();
      return !!cursor && cursor.sessionId === sessionId;
    };

    const isLive = (sessionId: string): boolean => isLiveSession(sessionId);

    const snapshot = (sessionId: string): StateSnapshot | null => stateFor(sessionId).snapshot();
    const snapshotLoading = (sessionId: string): boolean => stateFor(sessionId).snapshotLoading();
    const changes = (sessionId: string): Record<string, FieldChange> => stateFor(sessionId).changes();

    const transitions = (sessionId: string, trackerId: string): StateTransition[] =>
      runtimeFor(sessionId, trackerId, stateFor(sessionId)).transitions();

    const transitionsLoading = (sessionId: string, trackerId: string): boolean =>
      runtimeFor(sessionId, trackerId, stateFor(sessionId)).loading();

    const transitionPosition = (sessionId: string): TransitionPosition | null => {
      const trackerId = selectedTracker(sessionId);
      if (!trackerId) return null;
      const trans = transitions(sessionId, trackerId);
      const cursor = controller.cursor();
      const line = cursor && cursor.sessionId === sessionId ? cursor.line : null;
      if (line == null) return { index: 0, total: trans.length };
      let index = 0;
      for (const t of trans) if (t.lineNum <= line) index++;
      return { index, total: trans.length };
    };

    const jumpToTransition = (sessionId: string, direction: 'prev' | 'next'): void => {
      const trackerId = selectedTracker(sessionId);
      if (!trackerId) return;
      const trans = transitions(sessionId, trackerId);
      if (trans.length === 0) return;
      const cursor = controller.cursor();
      const line = cursor && cursor.sessionId === sessionId ? cursor.line : null;

      let target: StateTransition | undefined;
      if (direction === 'prev') {
        if (line != null) {
          for (let i = trans.length - 1; i >= 0; i--) {
            if (trans[i].lineNum < line) {
              target = trans[i];
              break;
            }
          }
        }
        target ??= trans[trans.length - 1]; // wrap
      } else {
        if (line != null) {
          for (let i = 0; i < trans.length; i++) {
            if (trans[i].lineNum > line) {
              target = trans[i];
              break;
            }
          }
        }
        target ??= trans[0]; // wrap
      }
      controller.scrollToLine(sessionId, target.lineNum, { source: 'user' });
    };

    const prevTransition = (sessionId: string): void => jumpToTransition(sessionId, 'prev');
    const nextTransition = (sessionId: string): void => jumpToTransition(sessionId, 'next');

    const timeline = (sessionId: string, trackerId: string): TrackerTimelineTrack | null => {
      const meta = analyzers.trackers(sessionId).find((t) => t.id === trackerId);
      if (!meta || meta.trackerTimeline === false) return null;
      return {
        trackerId,
        trackerName: meta.name,
        transitions: transitions(sessionId, trackerId),
      };
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      for (const fn of unlisteners) fn();
      unlisteners.length = 0;
      for (const state of states.values()) {
        if (state.debounceTimer !== undefined) clearTimeout(state.debounceTimer);
        if (state.liveThrottleTimer !== undefined) clearTimeout(state.liveThrottleTimer);
      }
      states.clear();
      liveRefreshSchedulers.clear();
      disposeRoot();
    };

    return {
      trackers,
      selectedTracker,
      setSelectedTracker,
      hasCursor,
      isLive,
      snapshot,
      snapshotLoading,
      changes,
      transitions,
      transitionsLoading,
      transitionPosition,
      prevTransition,
      nextTransition,
      timeline,
      dispose,
    };
  });
}
