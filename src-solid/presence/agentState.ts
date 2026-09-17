/**
 * Derives the agent orb's visual state from four independent signals:
 * bridge connectivity, the `agentRawAccess` setting, the bridge's
 * request-lifecycle events, and the live activity journal. Framework-adjacent
 * (uses Solid signals) but touches no DOM and makes no bridge calls itself —
 * `presenceStore` owns fetching `getActivity()` and subscribing to
 * `onActivity()`/`onAgentRequest()`/`onNavigateRequest()`, and calls
 * `feed()`/`request()`/`setPending()` here as those arrive.
 *
 * Priority (highest first): `detached` (not connected — nothing else is
 * meaningful) > `needs` (blocked on a human; most actionable) > `raw` (a
 * persistent security-relevant indicator) > the activity-derived
 * `reading|running|wrote` > `idle` (the activity machine's resting state).
 *
 * The activity machine models an agent *working*, not a sequence of blips.
 * An agent's run is a stretch of tool calls separated by thinking gaps of
 * anything from a second to half a minute, and the journal only ever sees the
 * writes. So:
 *
 * - A request in flight decides the state directly: `running` while any
 *   long-running job (`kind: 'run'`) is in flight, otherwise `reading`.
 * - Between requests the orb *holds* the last in-flight-derived state — the
 *   agent is thinking, not resting — until `WORKING_DECAY_MS` passes with no
 *   request and no journal entry. Only then does it rest to `idle`.
 * - A journaled agent write flashes `wrote` for `WROTE_FLASH_MS`, then falls
 *   back to whatever the agent is doing (held state, or idle).
 * - `HOLD_MS` is the minimum time any active state is shown before a
 *   different one may replace it, so rapid read/run alternation cannot
 *   flicker. `idle` is never held — the first request after a quiet period
 *   reacts immediately.
 */
import { createEffect, createMemo, createRoot, createSignal, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { ActivityEntry } from '@bridge/generated/ActivityEntry';
import type { AgentRequestEvent } from '@bridge/generated/AgentRequestEvent';
import type { AgentRequestKind } from '@bridge/generated/AgentRequestKind';

export type AgentOrbState = 'detached' | 'idle' | 'reading' | 'running' | 'wrote' | 'needs' | 'raw';

/** The subset of `McpStatus`/`BridgeStatusInfo` the derivation needs. */
export interface AgentBridgeStatus {
  running: boolean;
  /** Seconds since the last agent request; `null` = never connected this process. */
  idleSecs: number | null;
}

export interface AgentStateInputs {
  /** `null`/`undefined` is treated the same as `{ running: false, idleSecs: null }`. */
  bridgeStatus: Accessor<AgentBridgeStatus | null | undefined>;
  agentRawAccess: Accessor<boolean>;
  /**
   * Optional backing signal for the activity list (e.g. the store's journal).
   * When provided, every entry newer than the last one seen is fed
   * automatically — equivalent to calling `feed()` for each, so a consumer may
   * use either this or manual `feed()` calls (or both; ids de-duplicate).
   */
  activity?: Accessor<readonly ActivityEntry[]>;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface AgentStateController {
  state: Accessor<AgentOrbState>;
  lastAgentEntry: Accessor<ActivityEntry | null>;
  /**
   * The connected agent's self-reported client name, from its most recent
   * request or journal entry; `null` until an agent has done anything.
   */
  client: Accessor<string | null>;
  /** Number of agent requests currently in flight. */
  inFlight: Accessor<number>;
  /** Feed one journal entry (from `onActivity()` or a `getActivity()` page). Human-caller entries are ignored. */
  feed: (entry: ActivityEntry) => void;
  /** Feed one bridge request-lifecycle event (from `onAgentRequest()`). */
  request: (event: AgentRequestEvent) => void;
  /** Set whether a navigation request (or, later, a consent request) is awaiting the user. */
  setPending: (pending: boolean) => void;
  dispose: () => void;
}

/** How stale `idleSecs` may be before the orb reports `detached` even though `running` is true. */
export const DETACHED_IDLE_THRESHOLD_SEC = 5 * 60;

/** Minimum time an activity-derived state (`reading|running|wrote`) is held before a different one may replace it. */
export const HOLD_MS = 800;

/**
 * Quiet time — no request in flight, no request ended, no journal entry —
 * before the orb rests to `idle`. Sized for an agent's thinking gap between
 * tool calls, not for a network round trip: the orb must not blink idle every
 * time the model pauses to reason, and a high-effort turn can reason for well
 * over half a minute before its next call.
 */
export const WORKING_DECAY_MS = 45_000;

/** How long a journaled agent write shows as `wrote` before the orb returns to what the agent is doing. */
export const WROTE_FLASH_MS = 3_000;

/**
 * A request whose `end` never arrives (the listener mounted mid-request and
 * the end was lost, or a webview reload dropped it) is forgotten after this
 * long so a stuck `running` cannot outlive the job it describes. Longer than
 * any pipeline run or export should take.
 */
export const IN_FLIGHT_STALE_MS = 10 * 60_000;

type ActivityDerivedState = 'idle' | 'reading' | 'running' | 'wrote';
type EngagedState = 'reading' | 'running';

/**
 * `ActivityEntry.action` → what the orb should do with a journaled agent
 * action. The journal is mutation-only, so every agent entry is a write; the
 * one exception worth keeping distinct is a finished pipeline run, which reads
 * as `running` (the state the in-flight event already put the orb in) rather
 * than a `wrote` flash.
 */
function classifyJournal(action: string): EngagedState | 'wrote' {
  return action.startsWith('pipeline.run') ? 'running' : 'wrote';
}

function isDetached(status: AgentBridgeStatus | null | undefined): boolean {
  if (!status || !status.running) return true;
  if (status.idleSecs === null) return true;
  return status.idleSecs > DETACHED_IDLE_THRESHOLD_SEC;
}

/**
 * Builds the live agent-state controller. Owns its own `createRoot` (like
 * `createThemeController`) so it is safe to construct outside a component
 * body — call `dispose()` when the owning panel unmounts.
 */
export function createAgentState(inputs: AgentStateInputs): AgentStateController {
  return createRoot((dispose) => {
    const { bridgeStatus, agentRawAccess } = inputs;
    const now = inputs.now ?? Date.now;

    const [pending, setPendingSignal] = createSignal(false);
    const [activityState, setActivityStateSignal] = createSignal<ActivityDerivedState>('idle');
    const [lastAgentEntry, setLastAgentEntry] = createSignal<ActivityEntry | null>(null);
    const [client, setClient] = createSignal<string | null>(null);
    const [inFlightCount, setInFlightCount] = createSignal(0);

    // ── Inputs to the derivation (plain fields; `reconcile()` reads them) ──
    /** Requests started but not yet ended, by id, with the stale timer that forgets them. */
    const inFlight = new Map<number, { kind: AgentRequestKind; stale: ReturnType<typeof setTimeout> }>();
    /** The last in-flight-derived state, held while the agent is thinking between requests. */
    let held: EngagedState = 'reading';
    /** True from any agent request or journal entry until `WORKING_DECAY_MS` of quiet. */
    let engaged = false;
    /** True while a journaled write is being flashed as `wrote`. */
    let flashing = false;

    let enteredAt = now();
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let decayTimer: ReturnType<typeof setTimeout> | undefined;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSeenId = -1;

    function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): undefined {
      if (timer !== undefined) clearTimeout(timer);
      return undefined;
    }

    function applyState(next: ActivityDerivedState): void {
      setActivityStateSignal(next);
      enteredAt = now();
      holdTimer = clearTimer(holdTimer);
    }

    /**
     * Move to `next`, honouring the minimum hold. `idle` itself is never
     * held — it's the resting state, so the *first* activity after a quiet
     * period reacts immediately. When the hold defers a change, the timer
     * re-derives the target rather than replaying a stale one: by the time it
     * fires, a flash may have ended or a request may have finished.
     */
    function requestState(next: ActivityDerivedState): void {
      if (activityState() === next) {
        holdTimer = clearTimer(holdTimer);
        return;
      }
      if (activityState() === 'idle') {
        applyState(next);
        return;
      }
      const elapsed = now() - enteredAt;
      if (elapsed >= HOLD_MS) {
        applyState(next);
        return;
      }
      holdTimer = clearTimer(holdTimer);
      holdTimer = setTimeout(reconcile, HOLD_MS - elapsed);
    }

    /** Derive the activity state from the inputs above and request it. */
    function reconcile(): void {
      let target: ActivityDerivedState;
      if (inFlight.size > 0) {
        let running = false;
        for (const { kind } of inFlight.values()) {
          if (kind === 'run') {
            running = true;
            break;
          }
        }
        held = running ? 'running' : 'reading';
        target = held;
      } else if (flashing) {
        target = 'wrote';
      } else if (engaged) {
        target = held;
      } else {
        target = 'idle';
      }
      requestState(target);
    }

    /** Any sign of the agent: (re)start the quiet clock. */
    function markEngaged(): void {
      engaged = true;
      decayTimer = clearTimer(decayTimer);
      decayTimer = setTimeout(() => {
        engaged = false;
        reconcile();
      }, WORKING_DECAY_MS);
    }

    function flashWrote(): void {
      flashing = true;
      flashTimer = clearTimer(flashTimer);
      flashTimer = setTimeout(() => {
        flashing = false;
        reconcile();
      }, WROTE_FLASH_MS);
    }

    function endRequest(id: number): void {
      const entry = inFlight.get(id);
      if (!entry) return;
      clearTimeout(entry.stale);
      inFlight.delete(id);
      setInFlightCount(inFlight.size);
    }

    function request(event: AgentRequestEvent): void {
      setClient(event.client);
      markEngaged();
      if (event.phase === 'start') {
        const previous = inFlight.get(event.id);
        if (previous) clearTimeout(previous.stale);
        inFlight.set(event.id, {
          kind: event.kind,
          stale: setTimeout(() => {
            endRequest(event.id);
            reconcile();
          }, IN_FLIGHT_STALE_MS),
        });
        setInFlightCount(inFlight.size);
      } else {
        // An `end` with no `start` (listener mounted mid-request) still
        // counts as engagement — handled by `markEngaged()` above.
        endRequest(event.id);
      }
      reconcile();
    }

    function feed(entry: ActivityEntry): void {
      if (entry.caller.kind !== 'agent') return; // human entries never change the orb
      if (entry.id <= lastSeenId) return; // already processed (e.g. re-delivered via the activity accessor)
      lastSeenId = entry.id;
      setLastAgentEntry(entry);
      setClient(entry.caller.client);
      markEngaged();
      const classified = classifyJournal(entry.action);
      if (classified === 'wrote') flashWrote();
      else held = classified;
      reconcile();
    }

    function setPending(value: boolean): void {
      setPendingSignal(value);
    }

    if (inputs.activity) {
      const activity = inputs.activity;
      createEffect(() => {
        const list = activity();
        // Untracked: `feed()` -> `reconcile()` -> `requestState()` *reads*
        // `activityState()` before writing it, so without this the effect
        // subscribes to a signal it writes and re-runs on every hold/decay
        // transition, re-walking the whole journal. Only `activity()` above
        // should re-trigger it.
        untrack(() => {
          for (const entry of list) {
            if (entry.id > lastSeenId) feed(entry);
          }
        });
      });
    }

    const detached = createMemo(() => isDetached(bridgeStatus()));

    const state = createMemo<AgentOrbState>(() => {
      if (detached()) return 'detached';
      if (pending()) return 'needs';
      if (agentRawAccess()) return 'raw';
      return activityState();
    });

    function disposeAll(): void {
      holdTimer = clearTimer(holdTimer);
      decayTimer = clearTimer(decayTimer);
      flashTimer = clearTimer(flashTimer);
      for (const { stale } of inFlight.values()) clearTimeout(stale);
      inFlight.clear();
      setInFlightCount(0);
      dispose();
    }

    return {
      state,
      lastAgentEntry,
      client,
      inFlight: inFlightCount,
      feed,
      request,
      setPending,
      dispose: disposeAll,
    };
  });
}
