import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@bridge/generated/ActivityEntry';
import { createAgentState, DECAY_MS, DETACHED_IDLE_THRESHOLD_SEC, HOLD_MS } from './agentState';
import type { AgentBridgeStatus, AgentStateController } from './agentState';

let nextId = 1;

function agentEntry(action: string, overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: nextId++,
    ts: Date.now(),
    caller: { kind: 'agent', client: 'test-client' },
    action,
    sessionId: null,
    summary: action,
    ...overrides,
  };
}

function humanEntry(action: string): ActivityEntry {
  return agentEntry(action, { caller: { kind: 'ui' } });
}

const CONNECTED: AgentBridgeStatus = { running: true, idleSecs: 0 };

describe('createAgentState', () => {
  let controller: AgentStateController | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    nextId = 1;
  });

  afterEach(() => {
    controller?.dispose();
    controller = undefined;
    vi.useRealTimers();
  });

  it('reports detached when the bridge is not running', () => {
    const [status] = createSignal<AgentBridgeStatus | null>({ running: false, idleSecs: null });
    controller = createAgentState({ bridgeStatus: status, agentRawAccess: () => false });
    expect(controller.state()).toBe('detached');
  });

  it('reports detached when the bridge status is null/undefined', () => {
    const [status] = createSignal<AgentBridgeStatus | null>(null);
    controller = createAgentState({ bridgeStatus: status, agentRawAccess: () => false });
    expect(controller.state()).toBe('detached');
  });

  it('reports detached when idleSecs is null (never connected this process)', () => {
    const [status] = createSignal<AgentBridgeStatus | null>({ running: true, idleSecs: null });
    controller = createAgentState({ bridgeStatus: status, agentRawAccess: () => false });
    expect(controller.state()).toBe('detached');
  });

  it('reports detached when idleSecs exceeds the threshold, idle when within it', () => {
    const [status, setStatus] = createSignal<AgentBridgeStatus | null>({
      running: true,
      idleSecs: DETACHED_IDLE_THRESHOLD_SEC - 1,
    });
    controller = createAgentState({ bridgeStatus: status, agentRawAccess: () => false });
    expect(controller.state()).toBe('idle');

    setStatus({ running: true, idleSecs: DETACHED_IDLE_THRESHOLD_SEC + 1 });
    expect(controller.state()).toBe('detached');
  });

  it('reports idle by default when connected with no activity', () => {
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });
    expect(controller.state()).toBe('idle');
  });

  it('transitions to reading/running/wrote from classified agent activity', () => {
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });

    controller.feed(agentEntry('query.lines'));
    expect(controller.state()).toBe('reading');

    vi.advanceTimersByTime(HOLD_MS + 1);
    controller.feed(agentEntry('pipeline.run'));
    expect(controller.state()).toBe('running');

    vi.advanceTimersByTime(HOLD_MS + 1);
    controller.feed(agentEntry('bookmark.create'));
    expect(controller.state()).toBe('wrote');
  });

  it('classifies search/lines/sessions.get as reading', () => {
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });
    controller.feed(agentEntry('search.run'));
    expect(controller.state()).toBe('reading');
  });

  it('classifies analysis.*/watch.*/export.* as wrote', () => {
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });
    for (const action of ['analysis.publish', 'watch.create', 'export.run']) {
      controller.feed(agentEntry(action));
      expect(controller.state()).toBe('wrote');
      vi.advanceTimersByTime(DECAY_MS + 1);
      expect(controller.state()).toBe('idle');
    }
  });

  it('ignores an unclassified action for state but still updates lastAgentEntry', () => {
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });
    const entry = agentEntry('session.open');
    controller.feed(entry);
    expect(controller.state()).toBe('idle');
    expect(controller.lastAgentEntry()).toEqual(entry);
  });

  it('never changes state for a human-caller entry, and does not record it as lastAgentEntry', () => {
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });
    controller.feed(humanEntry('query.lines'));
    expect(controller.state()).toBe('idle');
    expect(controller.lastAgentEntry()).toBeNull();
  });

  it('holds an activity-derived state for at least HOLD_MS before switching to a different one', () => {
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });

    controller.feed(agentEntry('query.lines'));
    expect(controller.state()).toBe('reading');

    // Arrives well before the hold expires — must not flip immediately.
    vi.advanceTimersByTime(HOLD_MS / 2);
    controller.feed(agentEntry('pipeline.run'));
    expect(controller.state()).toBe('reading');

    // Once the hold (measured from entering 'reading') elapses, the queued target applies.
    vi.advanceTimersByTime(HOLD_MS / 2 + 1);
    expect(controller.state()).toBe('running');
  });

  it('decays back to idle after DECAY_MS with no new agent activity', () => {
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });
    controller.feed(agentEntry('query.lines'));
    expect(controller.state()).toBe('reading');

    vi.advanceTimersByTime(DECAY_MS - 1);
    expect(controller.state()).toBe('reading');

    vi.advanceTimersByTime(2);
    expect(controller.state()).toBe('idle');
  });

  it('a fresh agent entry resets the decay clock even when unclassified', () => {
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });
    controller.feed(agentEntry('query.lines'));
    expect(controller.state()).toBe('reading');

    vi.advanceTimersByTime(DECAY_MS - 100);
    controller.feed(agentEntry('session.open')); // unclassified, but resets the decay timer
    vi.advanceTimersByTime(DECAY_MS - 100);
    expect(controller.state()).toBe('reading'); // would have decayed by now without the reset

    vi.advanceTimersByTime(200);
    expect(controller.state()).toBe('idle');
  });

  it('raw overrides idle/reading/running/wrote while agentRawAccess is true', () => {
    const [rawAccess, setRawAccess] = createSignal(false);
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: rawAccess });

    controller.feed(agentEntry('query.lines'));
    expect(controller.state()).toBe('reading');

    setRawAccess(true);
    expect(controller.state()).toBe('raw');

    setRawAccess(false);
    expect(controller.state()).toBe('reading');
  });

  it('needs overrides raw and every activity-derived state while a request is pending', () => {
    const [rawAccess] = createSignal(true);
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: rawAccess });
    expect(controller.state()).toBe('raw');

    controller.setPending(true);
    expect(controller.state()).toBe('needs');

    controller.feed(agentEntry('pipeline.run')); // activity keeps flowing underneath
    expect(controller.state()).toBe('needs');

    // rawAccess is still true throughout — releasing "needs" falls back to
    // "raw", not to the activity-derived "running" underneath it.
    controller.setPending(false);
    expect(controller.state()).toBe('raw');
  });

  it('detached overrides needs and raw — nothing else matters when the bridge is not connected', () => {
    const [status, setStatus] = createSignal<AgentBridgeStatus | null>(CONNECTED);
    controller = createAgentState({ bridgeStatus: status, agentRawAccess: () => true });
    controller.setPending(true);
    expect(controller.state()).toBe('needs');

    setStatus({ running: false, idleSecs: null });
    expect(controller.state()).toBe('detached');
  });

  it('feeds entries from an optional activity accessor automatically, without duplicating already-seen ids', () => {
    const [entries, setEntries] = createSignal<ActivityEntry[]>([]);
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false, activity: entries });

    const e1 = agentEntry('query.lines');
    setEntries([e1]);
    expect(controller.state()).toBe('reading');
    expect(controller.lastAgentEntry()).toEqual(e1);

    vi.advanceTimersByTime(HOLD_MS + 1);
    const e2 = agentEntry('pipeline.run');
    setEntries([e1, e2]);
    expect(controller.state()).toBe('running');
  });

  it('dispose() clears pending timers so no state change fires afterwards', () => {
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });
    controller.feed(agentEntry('query.lines'));
    const stateAtDispose = controller.state();
    controller.dispose();
    vi.advanceTimersByTime(DECAY_MS + HOLD_MS + 100);
    // No throw, and reading the last known value is still safe post-dispose.
    expect(stateAtDispose).toBe('reading');
  });
});

describe('createAgentState activity effect (C-L3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-reads the journal only when the journal changes, not on hold/decay transitions', () => {
    let reads = 0;
    const [entries, setEntries] = createSignal<ActivityEntry[]>([]);
    const tracked = () => {
      reads += 1;
      return entries();
    };
    const controller = createAgentState({
      bridgeStatus: () => CONNECTED,
      agentRawAccess: () => false,
      activity: tracked,
    });

    setEntries([agentEntry('query.lines')]);
    const afterFeed = reads;
    expect(controller.state()).toBe('reading');

    // The hold expiring and the decay firing both write `activityState`, which
    // `feed()` reads. Without the untrack the effect subscribes to its own write
    // and re-walks the whole journal on each of these.
    vi.advanceTimersByTime(HOLD_MS + DECAY_MS + 100);
    expect(controller.state()).toBe('idle');
    expect(reads).toBe(afterFeed);

    controller.dispose();
  });
});
