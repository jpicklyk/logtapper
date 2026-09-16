import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdbTrackerUpdate, ProcessorSummary, StateSnapshot, StateTransition } from '@bridge/types';
import { createDeviceStateStore, diffSnapshotFields, LIVE_REFRESH_THROTTLE_MS, SNAPSHOT_DEBOUNCE_MS } from './deviceStateStore';
import type {
  DeviceStateAnalyzers,
  DeviceStateCommands,
  DeviceStateController,
  DeviceStateSessions,
  DeviceStateStore,
} from './deviceStateStore';

/** A promise plus its settlers, for controlling exactly when IPC "resolves". */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function processor(id: string, overrides: Partial<ProcessorSummary> = {}): ProcessorSummary {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: '',
    tags: [],
    builtin: false,
    processorType: 'state_tracker',
    group: null,
    varsMeta: [],
    deprecated: false,
    hasSchema: false,
    trackerSections: [],
    sourceTypes: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return { lineNum: 0, timestamp: 0, fields: {}, initializedFields: [], sourceSections: [], ...overrides };
}

function transition(lineNum: number, overrides: Partial<StateTransition> = {}): StateTransition {
  return { lineNum, timestamp: 0, transitionName: 't', changes: {}, ...overrides };
}

interface Harness {
  store: DeviceStateStore;
  commands: DeviceStateCommands;
  setOrder: (ids: string[]) => void;
  setTrackers: (sessionId: string, list: ProcessorSummary[]) => void;
  setLastRunAt: (sessionId: string, v: number | null) => void;
  setCursor: (sessionId: string, line: number) => void;
  clearCursor: () => void;
  /** Flips a session's `SessionEntry.kind` — see the module doc's "Live 'now'
   *  projection" section. Defaults every unset session to `'file'`. */
  setKind: (sessionId: string, kind: 'file' | 'live') => void;
  /** Fires the injected `listenTrackerUpdate` callback as if a real
   *  `adb-tracker-update` Tauri event arrived. */
  fireTrackerUpdate: (payload: AdbTrackerUpdate) => void;
  scrollToLine: ReturnType<typeof vi.fn>;
  /** Session state (and its cursor-watching effect) is created lazily on
   *  first getter access — the same as a real `DeviceStatePanel` mounting
   *  and reading `store.snapshot(sid)` for the first time. Tests that assert
   *  on a fetch triggered by a cursor move must call this first, or the
   *  effect (and its debounce timer) will not exist yet when the cursor
   *  changes. */
  watch: (sessionId: string) => void;
}

function mount(commandOverrides: Partial<DeviceStateCommands> = {}): Harness {
  const [order, setOrderSignal] = createSignal<readonly string[]>([]);
  const [trackersMap, setTrackersMap] = createSignal<Record<string, ProcessorSummary[]>>({});
  const [lastRunMap, setLastRunMap] = createSignal<Record<string, number | null>>({});
  const [cursor, setCursorSignal] = createSignal<{ sessionId: string; line: number } | null>(null);
  const [kindMap, setKindMap] = createSignal<Record<string, 'file' | 'live'>>({});
  const scrollToLine = vi.fn();

  const sessions: DeviceStateSessions = {
    order: () => order(),
    byId: (sid) => ({ kind: kindMap()[sid] ?? 'file' }),
  };
  const controller: DeviceStateController = { cursor, scrollToLine };
  const analyzers: DeviceStateAnalyzers = {
    trackers: (sid) => trackersMap()[sid] ?? [],
    lastRunAt: (sid) => lastRunMap()[sid] ?? null,
  };
  const commands: DeviceStateCommands = {
    getStateAtLine: vi.fn(async () => snapshot()),
    getStateTransitions: vi.fn(async () => []),
    ...commandOverrides,
  };

  let trackerUpdateCb: ((payload: AdbTrackerUpdate) => void) | null = null;
  const listenTrackerUpdate = vi.fn((cb: (payload: AdbTrackerUpdate) => void) => {
    trackerUpdateCb = cb;
    return Promise.resolve(vi.fn());
  });

  const store = createDeviceStateStore({ sessions, controller, analyzers, commands, listenTrackerUpdate });

  return {
    store,
    commands,
    setOrder: (ids) => setOrderSignal(ids),
    setTrackers: (sid, list) => setTrackersMap((m) => ({ ...m, [sid]: list })),
    setLastRunAt: (sid, v) => setLastRunMap((m) => ({ ...m, [sid]: v })),
    setCursor: (sid, line) => setCursorSignal({ sessionId: sid, line }),
    clearCursor: () => setCursorSignal(null),
    setKind: (sid, kind) => setKindMap((m) => ({ ...m, [sid]: kind })),
    fireTrackerUpdate: (payload) => trackerUpdateCb?.(payload),
    scrollToLine,
    watch: (sid) => void store.snapshotLoading(sid),
  };
}

const tick = (): Promise<void> => Promise.resolve().then(() => Promise.resolve());

describe('deviceStateStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Snapshot fetch: debounce + generation guard ─────────────────────────

  describe('snapshot fetch', () => {
    it('debounces rapid cursor moves into a single fetch for the latest line', async () => {
      const h = mount();
      h.setTrackers('s1', [processor('t1')]);
      h.setLastRunAt('s1', 1);
      h.watch('s1');

      h.setCursor('s1', 5);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS / 2);
      h.setCursor('s1', 10);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS / 2);
      // First debounce window was reset by the second move — not fired yet.
      expect(h.commands.getStateAtLine).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      expect(h.commands.getStateAtLine).toHaveBeenCalledTimes(1);
      expect(h.commands.getStateAtLine).toHaveBeenCalledWith('s1', 't1', 10);
    });

    it('discards a late-settling fetch once a newer one has already applied', async () => {
      const first = deferred<StateSnapshot>();
      const second = deferred<StateSnapshot>();
      const getStateAtLine = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1')]);
      h.setLastRunAt('s1', 1);
      h.watch('s1');

      h.setCursor('s1', 5);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      h.setCursor('s1', 6);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      expect(getStateAtLine).toHaveBeenCalledTimes(2);

      // Newer (second) fetch settles first; older (first) settles after.
      second.resolve(snapshot({ lineNum: 6, fields: { a: 2 } }));
      await tick();
      first.resolve(snapshot({ lineNum: 5, fields: { a: 1 } }));
      await tick();

      expect(h.store.snapshot('s1')?.lineNum).toBe(6);
    });

    it('caches a snapshot-mode tracker per run generation, skipping refetch on line change', async () => {
      const getStateAtLine = vi.fn(async () => snapshot({ fields: { on: true } }));
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1', { trackerMode: 'snapshot' })]);
      h.setLastRunAt('s1', 100);
      h.watch('s1');

      h.setCursor('s1', 1);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      await tick();
      expect(getStateAtLine).toHaveBeenCalledTimes(1);

      // Different line, same generation — cache hit, no new fetch or debounce wait.
      h.setCursor('s1', 999);
      expect(getStateAtLine).toHaveBeenCalledTimes(1);
      expect(h.store.snapshot('s1')?.fields.on).toBe(true);

      // A new run generation invalidates the cache.
      h.setLastRunAt('s1', 101);
      h.setCursor('s1', 5);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      await tick();
      expect(getStateAtLine).toHaveBeenCalledTimes(2);
    });

    it('reports loading while a fetch is in flight and clears it on settle', async () => {
      const gate = deferred<StateSnapshot>();
      const h = mount({ getStateAtLine: vi.fn(() => gate.promise) });
      h.setTrackers('s1', [processor('t1')]);
      h.setLastRunAt('s1', 1);
      h.watch('s1');

      h.setCursor('s1', 1);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      expect(h.store.snapshotLoading('s1')).toBe(true);

      gate.resolve(snapshot());
      await tick();
      expect(h.store.snapshotLoading('s1')).toBe(false);
    });

    // ── C-M3: `controller.cursor()` is one global signal ────────────────
    it("a cursor move in another session neither cancels this session's pending fetch nor strands loading", async () => {
      const getStateAtLine = vi.fn(async (_sid: string, _trackerId: string, line: number) =>
        snapshot({ lineNum: line }),
      );
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1')]);
      h.setTrackers('s2', [processor('t1')]);
      h.setLastRunAt('s1', 1);
      h.setLastRunAt('s2', 1);
      h.watch('s1');
      h.watch('s2');

      // A click in s1 schedules a debounced fetch...
      h.setCursor('s1', 42);
      expect(h.store.snapshotLoading('s1')).toBe(true);

      // ...and a click in s2 lands inside the debounce window. s1's effect
      // re-runs (the cursor signal is global) but must leave s1's timer and
      // loading flag alone.
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS / 2);
      h.setCursor('s2', 7);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      await tick();

      // Both fetches happened — s1's was not cancelled by s2's cursor move.
      expect(getStateAtLine.mock.calls.map((c) => [c[0], c[2]])).toEqual([
        ['s1', 42],
        ['s2', 7],
      ]);
      expect(h.store.snapshotLoading('s1')).toBe(false);
      expect(h.store.snapshotLoading('s2')).toBe(false);
    });

    it('clears loading when the cursor is dropped with a fetch still scheduled', async () => {
      const h = mount();
      h.setTrackers('s1', [processor('t1')]);
      h.setLastRunAt('s1', 1);
      h.watch('s1');

      h.setCursor('s1', 42);
      expect(h.store.snapshotLoading('s1')).toBe(true);

      // No cursor at all: the scheduled fetch is abandoned and nothing else
      // will ever resolve the flag, so this run has to (C-M3).
      h.clearCursor();
      expect(h.store.snapshotLoading('s1')).toBe(false);

      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      await tick();
      expect(h.commands.getStateAtLine).not.toHaveBeenCalled();
    });

    it('hasCursor reflects only this session having the live cursor', () => {
      const h = mount();
      expect(h.store.hasCursor('s1')).toBe(false);
      h.setCursor('s1', 1);
      expect(h.store.hasCursor('s1')).toBe(true);
      expect(h.store.hasCursor('s2')).toBe(false);
    });
  });

  // ── Live "now" projection (L3) ───────────────────────────────────────────

  describe('live "now" projection', () => {
    it('fetches "now" immediately once a session is live, with no cursor at all', async () => {
      const getStateAtLine = vi.fn(async () => snapshot({ lineNum: 999, fields: { on: true } }));
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1')]);
      h.setKind('s1', 'live');
      h.watch('s1');
      await tick();

      expect(h.store.isLive('s1')).toBe(true);
      expect(getStateAtLine).toHaveBeenCalledWith('s1', 't1', Number.MAX_SAFE_INTEGER);
      expect(h.store.snapshot('s1')?.fields.on).toBe(true);
      // No cursor was ever set for this session — the live projection does
      // not need one, unlike the cursor-tied post-mortem path.
      expect(h.store.hasCursor('s1')).toBe(false);
    });

    it('collapses a burst of adb-tracker-update events into a single throttled refresh', async () => {
      const getStateAtLine = vi.fn(async () => snapshot());
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1')]);
      h.setKind('s1', 'live');
      h.watch('s1');
      await tick();
      expect(getStateAtLine).toHaveBeenCalledTimes(1); // the immediate on-live-mount fetch

      // A burst of five updates arriving within the same throttle window.
      for (let i = 0; i < 5; i++) {
        h.fireTrackerUpdate({ sessionId: 's1', trackerId: 't1', transitionCount: i + 1 });
      }
      // Not yet — the throttle is trailing-edge.
      await vi.advanceTimersByTimeAsync(LIVE_REFRESH_THROTTLE_MS - 1);
      expect(getStateAtLine).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await tick();
      // Exactly one more call for the whole burst, not five.
      expect(getStateAtLine).toHaveBeenCalledTimes(2);

      // A second burst after the throttle window closed schedules exactly one more.
      h.fireTrackerUpdate({ sessionId: 's1', trackerId: 't1', transitionCount: 10 });
      h.fireTrackerUpdate({ sessionId: 's1', trackerId: 't1', transitionCount: 11 });
      await vi.advanceTimersByTimeAsync(LIVE_REFRESH_THROTTLE_MS);
      await tick();
      expect(getStateAtLine).toHaveBeenCalledTimes(3);
    });

    it('ignores an adb-tracker-update for a session that is not this one, or not live', async () => {
      const getStateAtLine = vi.fn(async () => snapshot());
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1')]);
      h.setKind('s1', 'live');
      h.watch('s1');
      await tick();
      getStateAtLine.mockClear();

      h.fireTrackerUpdate({ sessionId: 's2', trackerId: 't1', transitionCount: 1 });
      await vi.advanceTimersByTimeAsync(LIVE_REFRESH_THROTTLE_MS);
      await tick();
      expect(getStateAtLine).not.toHaveBeenCalled();

      h.setKind('s1', 'file');
      h.fireTrackerUpdate({ sessionId: 's1', trackerId: 't1', transitionCount: 2 });
      await vi.advanceTimersByTimeAsync(LIVE_REFRESH_THROTTLE_MS);
      await tick();
      expect(getStateAtLine).not.toHaveBeenCalled();
    });

    it('does not run the cursor-tied debounce path while live, even with a cursor set', async () => {
      const getStateAtLine = vi.fn(async () => snapshot());
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1')]);
      h.setKind('s1', 'live');
      h.watch('s1');
      await tick();
      getStateAtLine.mockClear();

      // A cursor move while live must never trigger the debounced,
      // line-scoped fetch — only the live "now" path may write these signals.
      h.setCursor('s1', 42);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS * 4);
      await tick();
      expect(getStateAtLine).not.toHaveBeenCalled();
    });

    it('reverts to cursor-tied browsing once the stream stops, keeping the last "now" snapshot until then', async () => {
      const getStateAtLine = vi
        .fn()
        .mockResolvedValueOnce(snapshot({ lineNum: 999, fields: { now: true } }))
        .mockResolvedValueOnce(snapshot({ lineNum: 7, fields: { now: false } }));
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1')]);
      h.setLastRunAt('s1', 1);
      h.setKind('s1', 'live');
      h.watch('s1');
      await tick();
      expect(h.store.snapshot('s1')?.fields.now).toBe(true);

      // Stream stops — kind flips back to 'file'. No cursor yet, so nothing
      // new fetches, and the last "now" snapshot stays exactly as it was.
      h.setKind('s1', 'file');
      await tick();
      expect(h.store.isLive('s1')).toBe(false);
      expect(h.store.snapshot('s1')?.fields.now).toBe(true);
      expect(getStateAtLine).toHaveBeenCalledTimes(1);

      // Post-mortem browsing resumes normally from here.
      h.setCursor('s1', 7);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      await tick();
      expect(getStateAtLine).toHaveBeenCalledTimes(2);
      expect(getStateAtLine).toHaveBeenLastCalledWith('s1', 't1', 7);
      expect(h.store.snapshot('s1')?.fields.now).toBe(false);
    });
  });

  // ── Field diffs ──────────────────────────────────────────────────────────

  describe('diffSnapshotFields (pure)', () => {
    it('reports only fields that actually changed', () => {
      const out = diffSnapshotFields({ a: 1, b: 'x', c: true }, { a: 1, b: 'y', c: true, d: 5 });
      expect(out).toEqual({ b: { from: 'x', to: 'y' }, d: { from: undefined, to: 5 } });
    });

    it('compares object values structurally, not by reference', () => {
      const out = diffSnapshotFields({ o: { n: 1 } }, { o: { n: 1 } });
      expect(out).toEqual({});
    });
  });

  describe('changes()', () => {
    it('diffs against the previously displayed snapshot for the same tracker', async () => {
      const getStateAtLine = vi
        .fn()
        .mockResolvedValueOnce(snapshot({ fields: { a: 1, b: 2 } }))
        .mockResolvedValueOnce(snapshot({ fields: { a: 1, b: 3 } }));
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1')]);
      h.setLastRunAt('s1', 1);
      h.watch('s1');

      h.setCursor('s1', 1);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      await tick();
      expect(h.store.changes('s1')).toEqual({});

      h.setCursor('s1', 2);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      await tick();
      expect(h.store.changes('s1')).toEqual({ b: { from: 2, to: 3 } });
    });

    it('clears changes when the selected tracker itself changes', async () => {
      const getStateAtLine = vi
        .fn()
        .mockResolvedValueOnce(snapshot({ fields: { a: 1 } }))
        .mockResolvedValueOnce(snapshot({ fields: { a: 9 } }))
        .mockResolvedValueOnce(snapshot({ fields: { z: 1 } }));
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1'), processor('t2')]);
      h.setLastRunAt('s1', 1);
      h.watch('s1');

      h.setCursor('s1', 1);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      await tick();
      h.setCursor('s1', 2);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      await tick();
      expect(h.store.changes('s1')).toEqual({ a: { from: 1, to: 9 } });

      h.store.setSelectedTracker('s1', 't2');
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
      await tick();
      expect(h.store.changes('s1')).toEqual({});
    });
  });

  // ── Tracker selection ────────────────────────────────────────────────────

  describe('selectedTracker', () => {
    it('defaults to the first active tracker until overridden', () => {
      const h = mount();
      h.setTrackers('s1', [processor('t1'), processor('t2')]);
      expect(h.store.selectedTracker('s1')).toBe('t1');
      h.store.setSelectedTracker('s1', 't2');
      expect(h.store.selectedTracker('s1')).toBe('t2');
    });

    it('falls back to the first active tracker when the override leaves the set', () => {
      const h = mount();
      h.setTrackers('s1', [processor('t1'), processor('t2')]);
      h.store.setSelectedTracker('s1', 't2');
      expect(h.store.selectedTracker('s1')).toBe('t2');
      h.setTrackers('s1', [processor('t1')]);
      expect(h.store.selectedTracker('s1')).toBe('t1');
      // The pick is honoured again if its tracker comes back.
      h.setTrackers('s1', [processor('t1'), processor('t2')]);
      expect(h.store.selectedTracker('s1')).toBe('t2');
    });

    it('trackers() passes through the analyzers store', () => {
      const h = mount();
      const list = [processor('t1')];
      h.setTrackers('s1', list);
      expect(h.store.trackers('s1')).toEqual(list);
    });
  });

  // ── Transition navigation ────────────────────────────────────────────────

  describe('prev/next transition', () => {
    function withTransitions(): Harness {
      const h = mount({
        getStateTransitions: vi.fn(async () => [transition(10), transition(20), transition(30)]),
      });
      h.setTrackers('s1', [processor('t1')]);
      h.setLastRunAt('s1', 1);
      return h;
    }

    it('jumps to the nearest earlier/later transition from the cursor', async () => {
      const h = withTransitions();
      // Force the transitions() cache to populate for this tracker.
      h.store.transitions('s1', 't1');
      await tick();

      h.setCursor('s1', 25);
      h.store.prevTransition('s1');
      expect(h.scrollToLine).toHaveBeenLastCalledWith('s1', 20, { source: 'user' });

      h.store.nextTransition('s1');
      expect(h.scrollToLine).toHaveBeenLastCalledWith('s1', 30, { source: 'user' });
    });

    it('wraps to the last transition when prev is called before the first', async () => {
      const h = withTransitions();
      h.store.transitions('s1', 't1');
      await tick();

      h.setCursor('s1', 5);
      h.store.prevTransition('s1');
      expect(h.scrollToLine).toHaveBeenLastCalledWith('s1', 30, { source: 'user' });
    });

    it('wraps to the first transition when next is called past the last', async () => {
      const h = withTransitions();
      h.store.transitions('s1', 't1');
      await tick();

      h.setCursor('s1', 35);
      h.store.nextTransition('s1');
      expect(h.scrollToLine).toHaveBeenLastCalledWith('s1', 10, { source: 'user' });
    });

    it('is a no-op with no transitions or no selected tracker', () => {
      const h = mount();
      h.store.prevTransition('s1'); // no tracker at all
      h.store.nextTransition('s1');
      expect(h.scrollToLine).not.toHaveBeenCalled();
    });

    it('transitionPosition counts transitions at or before the cursor', async () => {
      const h = withTransitions();
      h.store.transitions('s1', 't1');
      await tick();

      h.setCursor('s1', 20);
      expect(h.store.transitionPosition('s1')).toEqual({ index: 2, total: 3 });

      h.setCursor('s1', 5);
      expect(h.store.transitionPosition('s1')).toEqual({ index: 0, total: 3 });
    });
  });

  // ── Transitions fetch: refreshed per run generation ─────────────────────

  describe('transitions()', () => {
    it('refetches only when the run generation moves', async () => {
      const getStateTransitions = vi.fn(async () => [transition(1)]);
      const h = mount({ getStateTransitions });
      h.setTrackers('s1', [processor('t1')]);
      h.setLastRunAt('s1', 1);

      h.store.transitions('s1', 't1');
      await tick();
      h.store.transitions('s1', 't1');
      await tick();
      expect(getStateTransitions).toHaveBeenCalledTimes(1);

      h.setLastRunAt('s1', 2);
      h.store.transitions('s1', 't1');
      await tick();
      expect(getStateTransitions).toHaveBeenCalledTimes(2);
    });

    it('does not fetch until a run has happened (generation null)', () => {
      const getStateTransitions = vi.fn(async () => [transition(1)]);
      const h = mount({ getStateTransitions });
      h.setTrackers('s1', [processor('t1')]);
      h.store.transitions('s1', 't1');
      expect(getStateTransitions).not.toHaveBeenCalled();
    });
  });

  // ── Timeline (built from the transitions cache, not a second network call) ─

  describe('timeline()', () => {
    it('reuses the transitions() cache rather than issuing a second fetch', async () => {
      const getStateTransitions = vi.fn(async () => [transition(1), transition(2)]);
      const h = mount({ getStateTransitions });
      h.setTrackers('s1', [processor('t1', { trackerTimeline: true })]);
      h.setLastRunAt('s1', 1);

      h.store.transitions('s1', 't1');
      await tick();
      const track = h.store.timeline('s1', 't1');
      expect(getStateTransitions).toHaveBeenCalledTimes(1);
      expect(track?.transitions).toHaveLength(2);
      expect(track?.trackerId).toBe('t1');
      expect(track?.trackerName).toBe('t1');
    });

    it('is null when the tracker declares trackerTimeline: false', () => {
      const h = mount();
      h.setTrackers('s1', [processor('t1', { trackerTimeline: false })]);
      expect(h.store.timeline('s1', 't1')).toBeNull();
    });

    it('is null for an id that is not an active tracker', () => {
      const h = mount();
      expect(h.store.timeline('s1', 'nope')).toBeNull();
    });
  });

  // ── Session pruning ──────────────────────────────────────────────────────

  it('prunes per-session state once a session leaves sessions.order(), cancelling a pending debounce', async () => {
    const getStateAtLine = vi.fn(async () => snapshot());
    const h = mount({ getStateAtLine });
    h.setOrder(['s1']);
    h.setTrackers('s1', [processor('t1')]);
    h.setLastRunAt('s1', 1);
    h.watch('s1');

    // Start a debounced fetch, then close the session before it fires.
    h.setCursor('s1', 1);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS / 2);
    h.setOrder([]);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS * 2);
    await tick();

    expect(getStateAtLine).not.toHaveBeenCalled();
  });

  // ── Disposal ─────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('stops further fetches and is idempotent, even mid-debounce', async () => {
      const getStateAtLine = vi.fn(async () => snapshot());
      const h = mount({ getStateAtLine });
      h.setTrackers('s1', [processor('t1')]);
      h.setLastRunAt('s1', 1);
      h.watch('s1');

      // Start a debounced fetch, then dispose before it fires.
      h.setCursor('s1', 1);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS / 2);

      h.store.dispose();
      h.store.dispose(); // idempotent, must not throw

      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS * 2);
      await tick();
      expect(getStateAtLine).not.toHaveBeenCalled();

      // A cursor move after disposal must not resurrect the effect either.
      h.setCursor('s1', 2);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS * 2);
      await tick();
      expect(getStateAtLine).not.toHaveBeenCalled();
    });
  });
});
