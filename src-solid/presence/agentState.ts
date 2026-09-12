/**
 * Derives the agent orb's visual state from three independent signals:
 * bridge connectivity, the `agentRawAccess` setting, and the live activity
 * journal. Framework-adjacent (uses Solid signals) but touches no DOM and
 * makes no bridge calls itself — `A2`'s `PresencePanel`/`ActivityFeed` own
 * fetching `getActivity()`/subscribing to `onActivity()`/`onNavigateRequest()`
 * and call `feed()`/`setPending()` here as those events arrive.
 *
 * Priority (highest first) — see `implementation-notes` on this item for the
 * rationale: `detached` (not connected — nothing else is meaningful) >
 * `needs` (blocked on a human; most actionable) > `raw` (a persistent
 * security-relevant indicator) > the activity-derived `reading|running|wrote`
 * (transient, hold+decay) > `idle` (the activity machine's resting state).
 */
import { createEffect, createMemo, createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { ActivityEntry } from '@bridge/generated/ActivityEntry';

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
   * Optional backing signal for the activity list (e.g. the panel's
   * `getActivity()` fetch result). When provided, every entry newer than the
   * last one seen is fed automatically — equivalent to calling `feed()` for
   * each, so a consumer may use either this or manual `feed()` calls (or
   * both; `feed()` de-duplicates nothing beyond what the classifier does).
   */
  activity?: Accessor<readonly ActivityEntry[]>;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface AgentStateController {
  state: Accessor<AgentOrbState>;
  lastAgentEntry: Accessor<ActivityEntry | null>;
  /** Feed one journal entry (from `onActivity()` or a `getActivity()` page). Human-caller entries are ignored. */
  feed: (entry: ActivityEntry) => void;
  /** Set whether a navigation request (or, later, a consent request) is awaiting the user. */
  setPending: (pending: boolean) => void;
  dispose: () => void;
}

/** How stale `idleSecs` may be before the orb reports `detached` even though `running` is true. */
export const DETACHED_IDLE_THRESHOLD_SEC = 5 * 60;

/** Minimum time an activity-derived state (`reading|running|wrote`) is held before a different one may replace it. */
export const HOLD_MS = 800;

/** Time since the last agent activity entry before the state decays back to `idle`. */
export const DECAY_MS = 3000;

type ActivityDerivedState = 'idle' | 'reading' | 'running' | 'wrote';

/**
 * `ActivityEntry.action` prefix → orb state. Unmatched actions (e.g.
 * `session.open`) still reset the decay clock (see `feed`) but do not change
 * `activityState` themselves.
 */
function classifyAction(action: string): ActivityDerivedState | null {
  if (/^(query|search|lines|sessions\.get)/.test(action)) return 'reading';
  if (action.startsWith('pipeline.run')) return 'running';
  if (/^(bookmark\.|analysis\.|watch\.|export\.)/.test(action)) return 'wrote';
  return null;
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

    let enteredAt = now();
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let decayTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingTarget: ActivityDerivedState | null = null;
    let lastSeenId = -1;

    function clearHoldTimer(): void {
      if (holdTimer !== undefined) {
        clearTimeout(holdTimer);
        holdTimer = undefined;
      }
    }
    function clearDecayTimer(): void {
      if (decayTimer !== undefined) {
        clearTimeout(decayTimer);
        decayTimer = undefined;
      }
    }

    function applyState(next: ActivityDerivedState): void {
      setActivityStateSignal(next);
      enteredAt = now();
      pendingTarget = null;
      clearHoldTimer();
    }

    function scheduleDecay(): void {
      clearDecayTimer();
      decayTimer = setTimeout(() => {
        applyState('idle');
      }, DECAY_MS);
    }

    /**
     * Request a transition, honouring the minimum hold. `idle` itself is
     * never held — it's the resting state, so the *first* activity after a
     * quiet period reacts immediately. The hold only guards against
     * flickering between two active states (e.g. `reading` → `running` →
     * `reading` on rapid, alternating entries).
     */
    function requestState(next: ActivityDerivedState): void {
      if (activityState() === next) {
        pendingTarget = null;
        clearHoldTimer();
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
      pendingTarget = next;
      clearHoldTimer();
      holdTimer = setTimeout(() => {
        if (pendingTarget !== null) applyState(pendingTarget);
      }, HOLD_MS - elapsed);
    }

    function feed(entry: ActivityEntry): void {
      if (entry.caller.kind !== 'agent') return; // human entries never change the orb
      if (entry.id <= lastSeenId) return; // already processed (e.g. re-delivered via the activity accessor)
      lastSeenId = entry.id;
      setLastAgentEntry(entry);
      scheduleDecay();
      const classified = classifyAction(entry.action);
      if (classified) requestState(classified);
    }

    function setPending(value: boolean): void {
      setPendingSignal(value);
    }

    if (inputs.activity) {
      const activity = inputs.activity;
      createEffect(() => {
        for (const entry of activity()) {
          if (entry.id > lastSeenId) feed(entry);
        }
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
      clearHoldTimer();
      clearDecayTimer();
      dispose();
    }

    return { state, lastAgentEntry, feed, setPending, dispose: disposeAll };
  });
}
