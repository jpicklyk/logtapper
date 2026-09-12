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
 * driven by `adb-tracker-update` events). Nothing in `src-solid/` wires ADB
 * streaming events yet (checked — no consumer of `onAdbTrackerUpdate`
 * anywhere under `src-solid/`), so there is no streaming signal to throttle.
 * `transitions()` refreshes once per pipeline-run generation instead, which
 * is the same "not more often than a run can actually change" ceiling
 * `useStateTracker`'s throttle approximates for the streaming case.
 */
import { createEffect, createMemo, createRoot, createSignal, getOwner, runWithOwner, untrack } from 'solid-js';
import type { Accessor, Owner } from 'solid-js';
import { getStateAtLine, getStateTransitions } from '@bridge/commands';
import type { FieldChange, ProcessorSummary, StateSnapshot, StateTransition } from '@bridge/types';
import type { CursorPosition, NavSource } from '../viewer';

/** Debounce window between a cursor move and the resulting `getStateAtLine`
 *  fetch — cheap enough that a fast scroll doesn't fire one request per line. */
export const SNAPSHOT_DEBOUNCE_MS = 80;

/** The slice of W0b's session store this store reads — structural, so a test
 *  can pass a literal. Used only to prune per-session state when a session
 *  closes (mirrors `analyzerStore`'s own `sessions.order()` prune effect). */
export interface DeviceStateSessions {
  order(): readonly string[];
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
   *  which is the panel's third empty state ("cursor outside data"). */
  hasCursor(sessionId: string): boolean;
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
  fetchToken: number;
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
  /** Guards a late-settling `getStateAtLine` after a newer one was issued. */
  fetchToken: number;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
  trackerRuntimes: Map<string, TrackerRuntime>;
}

export function createDeviceStateStore(deps: DeviceStateStoreDeps): DeviceStateStore {
  const { sessions, controller, analyzers } = deps;
  const commands = deps.commands ?? defaultCommands;

  return createRoot((disposeRoot) => {
    const owner = getOwner() as Owner;
    const states = new Map<string, SessionDeviceState>();
    let disposed = false;

    const createTrackerRuntime = (): TrackerRuntime => {
      const [transitions, setTransitionsSignal] = createSignal<StateTransition[]>([]);
      const [loading, setLoadingSignal] = createSignal(false);
      return {
        transitions,
        setTransitions: (v) => setTransitionsSignal(v),
        loading,
        setLoading: (v) => setLoadingSignal(v),
        fetchedGeneration: UNFETCHED,
        fetchToken: 0,
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
          const myToken = ++runtime!.fetchToken;
          commands
            .getStateTransitions(sessionId, trackerId)
            .then((trans) => {
              if (disposed || runtime!.fetchToken !== myToken) return;
              runtime!.setTransitions(trans);
              runtime!.setLoading(false);
            })
            .catch(() => {
              if (disposed || runtime!.fetchToken !== myToken) return;
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
        fetchToken: 0,
        debounceTimer: undefined,
        trackerRuntimes: new Map(),
      };

      const effectiveTrackerId = createMemo<string | null>(() =>
        resolveTracker(sessionId, selectedOverride()),
      );

      // Snapshot fetch: debounced + generation-guarded, and short-circuited
      // entirely for a snapshot-mode tracker once its run generation is cached.
      createEffect(() => {
        const trackerId = effectiveTrackerId();
        const cursor = controller.cursor();
        if (disposed) return;

        if (state.debounceTimer !== undefined) {
          clearTimeout(state.debounceTimer);
          state.debounceTimer = undefined;
        }

        if (!trackerId) {
          state.setSnapshot(null);
          state.setChanges({});
          state.setSnapshotLoading(false);
          state.displayedTrackerId = null;
          return;
        }
        if (!cursor || cursor.sessionId !== sessionId) return;

        const line = cursor.line;
        const meta = analyzers.trackers(sessionId).find((t) => t.id === trackerId);
        const isSnapshotMode = meta?.trackerMode === 'snapshot';
        const generation = analyzers.lastRunAt(sessionId);

        const applySnapshot = (snap: StateSnapshot): void => {
          const prev = state.displayedTrackerId === trackerId ? untrack(state.snapshot) : null;
          state.setChanges(prev ? diffSnapshotFields(prev.fields, snap.fields) : {});
          state.setSnapshot(snap);
          state.setSnapshotLoading(false);
          state.displayedTrackerId = trackerId;
        };

        if (isSnapshotMode) {
          const cached = state.snapshotCache.get(trackerId);
          if (cached && cached.generation === generation) {
            applySnapshot(cached.snapshot);
            return;
          }
        }

        state.setSnapshotLoading(true);
        const myToken = ++state.fetchToken;
        state.debounceTimer = setTimeout(() => {
          state.debounceTimer = undefined;
          commands
            .getStateAtLine(sessionId, trackerId, line)
            .then((snap) => {
              if (disposed || state.fetchToken !== myToken) return;
              if (isSnapshotMode) state.snapshotCache.set(trackerId, { generation, snapshot: snap });
              applySnapshot(snap);
            })
            .catch(() => {
              if (disposed || state.fetchToken !== myToken) return;
              state.setSnapshotLoading(false);
            });
        }, SNAPSHOT_DEBOUNCE_MS);
      });

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
          states.delete(key);
        }
      });
    });

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
      for (const state of states.values()) {
        if (state.debounceTimer !== undefined) clearTimeout(state.debounceTimer);
      }
      states.clear();
      disposeRoot();
    };

    return {
      trackers,
      selectedTracker,
      setSelectedTracker,
      hasCursor,
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
