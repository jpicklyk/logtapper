import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@bridge/generated/ActivityEntry';
import type { AgentRequestEvent } from '@bridge/generated/AgentRequestEvent';
import {
  createAgentState,
  DETACHED_IDLE_THRESHOLD_SEC,
  HOLD_MS,
  IN_FLIGHT_STALE_MS,
  WORKING_DECAY_MS,
  WROTE_FLASH_MS,
} from './agentState';
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

function requestEvent(overrides: Partial<AgentRequestEvent> = {}): AgentRequestEvent {
  return {
    id: 1,
    ts: Date.now(),
    client: 'test-client',
    method: 'GET',
    route: '/mcp/sessions/{session_id}/query',
    kind: 'read',
    phase: 'start',
    status: null,
    ...overrides,
  };
}

const CONNECTED: AgentBridgeStatus = { running: true, idleSecs: 0 };

function connected(): AgentStateController {
  return createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false });
}

describe('createAgentState — connectivity', () => {
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
    controller = connected();
    expect(controller.state()).toBe('idle');
    expect(controller.client()).toBeNull();
    expect(controller.inFlight()).toBe(0);
  });

  it('detached overrides needs and raw — nothing else matters when the bridge is not connected', () => {
    const [status, setStatus] = createSignal<AgentBridgeStatus | null>(CONNECTED);
    controller = createAgentState({ bridgeStatus: status, agentRawAccess: () => true });
    controller.setPending(true);
    expect(controller.state()).toBe('needs');

    setStatus({ running: false, idleSecs: null });
    expect(controller.state()).toBe('detached');
  });
});

describe('createAgentState — request lifecycle (the "working" model)', () => {
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

  it('a read in flight shows reading, and the orb keeps reading while the agent thinks after it', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1 }));
    expect(controller.state()).toBe('reading');
    expect(controller.inFlight()).toBe(1);

    controller.request(requestEvent({ id: 1, phase: 'end', status: 200 }));
    expect(controller.inFlight()).toBe(0);
    expect(controller.state()).toBe('reading');

    // A long think between tool calls, well past what a per-call blip would survive.
    vi.advanceTimersByTime(WORKING_DECAY_MS - 1);
    expect(controller.state()).toBe('reading');
  });

  it('rests to idle only after WORKING_DECAY_MS of quiet, measured from the last request end', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1 }));
    vi.advanceTimersByTime(WORKING_DECAY_MS - 1_000);
    controller.request(requestEvent({ id: 1, phase: 'end', status: 200 }));

    vi.advanceTimersByTime(WORKING_DECAY_MS - 1);
    expect(controller.state()).toBe('reading');
    vi.advanceTimersByTime(2);
    expect(controller.state()).toBe('idle');
  });

  it('never rests while a request is still in flight, however long it takes', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1, kind: 'run', method: 'POST', route: '/mcp/sessions/{session_id}/run_pipeline' }));
    expect(controller.state()).toBe('running');

    vi.advanceTimersByTime(WORKING_DECAY_MS * 3);
    expect(controller.state()).toBe('running');

    controller.request(requestEvent({ id: 1, kind: 'run', phase: 'end', status: 200 }));
    // Finished — the agent is still working (thinking about the results).
    expect(controller.state()).toBe('running');
    vi.advanceTimersByTime(WORKING_DECAY_MS + 1);
    expect(controller.state()).toBe('idle');
  });

  it('a run in flight wins over concurrent reads, and the state holds after it ends', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1 }));
    expect(controller.state()).toBe('reading');

    vi.advanceTimersByTime(HOLD_MS + 1);
    controller.request(requestEvent({ id: 2, kind: 'run', method: 'POST' }));
    expect(controller.state()).toBe('running');

    controller.request(requestEvent({ id: 1, phase: 'end', status: 200 }));
    expect(controller.state()).toBe('running'); // the run is still going

    vi.advanceTimersByTime(HOLD_MS + 1);
    controller.request(requestEvent({ id: 2, kind: 'run', phase: 'end', status: 200 }));
    expect(controller.state()).toBe('running'); // held between calls, not dropped to reading
  });

  it('rapid read/run alternation cannot flicker: an active state is held for HOLD_MS', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1 }));
    expect(controller.state()).toBe('reading');

    vi.advanceTimersByTime(HOLD_MS / 2);
    controller.request(requestEvent({ id: 1, phase: 'end', status: 200 }));
    controller.request(requestEvent({ id: 2, kind: 'run', method: 'POST' }));
    expect(controller.state()).toBe('reading'); // deferred, not flipped

    vi.advanceTimersByTime(HOLD_MS / 2 + 1);
    expect(controller.state()).toBe('running');
  });

  it('a deferred change is re-derived when the hold expires, not replayed stale', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1 }));
    vi.advanceTimersByTime(HOLD_MS / 2);
    // A run starts and ends inside the hold window while the read is still
    // in flight: by the time the hold expires the derived state is 'reading'
    // again, so 'running' is never shown — a replayed stale target would
    // have flipped the orb to a job that already finished.
    controller.request(requestEvent({ id: 2, kind: 'run', method: 'POST' }));
    controller.request(requestEvent({ id: 2, kind: 'run', phase: 'end', status: 200 }));
    expect(controller.state()).toBe('reading');
    vi.advanceTimersByTime(HOLD_MS);
    expect(controller.state()).toBe('reading');
    controller.request(requestEvent({ id: 1, phase: 'end', status: 200 }));
    expect(controller.state()).toBe('reading');
  });

  it('an end with no matching start still counts as engagement (listener mounted mid-request)', () => {
    controller = connected();
    controller.request(requestEvent({ id: 7, phase: 'end', status: 200 }));
    expect(controller.inFlight()).toBe(0);
    expect(controller.state()).toBe('reading');
    vi.advanceTimersByTime(WORKING_DECAY_MS + 1);
    expect(controller.state()).toBe('idle');
  });

  it('forgets a request whose end never arrives after IN_FLIGHT_STALE_MS', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1, kind: 'run', method: 'POST' }));
    expect(controller.state()).toBe('running');

    vi.advanceTimersByTime(IN_FLIGHT_STALE_MS - 1);
    expect(controller.inFlight()).toBe(1);
    expect(controller.state()).toBe('running');

    vi.advanceTimersByTime(2);
    expect(controller.inFlight()).toBe(0);
    // The engagement clock expired long ago, so with nothing in flight the orb rests.
    expect(controller.state()).toBe('idle');
  });

  it('records the client name from a request', () => {
    controller = connected();
    controller.request(requestEvent({ client: 'claude-cowork' }));
    expect(controller.client()).toBe('claude-cowork');
  });

  it('dispose() clears every timer: hold, flash, decay and the in-flight stale sweep', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1 })); // decay + stale sweep for id 1
    vi.advanceTimersByTime(HOLD_MS / 2);
    controller.request(requestEvent({ id: 2, kind: 'run', method: 'POST' })); // stale sweep for id 2 + a deferred hold (reading → running)
    controller.feed(agentEntry('bookmark.create')); // flash
    // Sampled before asserting: an `expect()` under fake timers registers
    // timers of its own, which would show up as a leak.
    const armed = vi.getTimerCount();
    controller.dispose();
    const remaining = vi.getTimerCount();
    expect(armed).toBe(5);
    expect(remaining).toBe(0);
    expect(controller.inFlight()).toBe(0);
    // Nothing left to fire — and reading the last value is still safe post-dispose.
    vi.advanceTimersByTime(IN_FLIGHT_STALE_MS + WORKING_DECAY_MS + HOLD_MS + 100);
    expect(controller.state()).toBe('reading');
  });
});

describe('createAgentState — journal entries', () => {
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

  it('a journaled agent write flashes wrote, then returns to what the agent was doing', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1 }));
    controller.request(requestEvent({ id: 1, phase: 'end', status: 200 }));
    expect(controller.state()).toBe('reading');

    vi.advanceTimersByTime(HOLD_MS + 1);
    controller.feed(agentEntry('bookmark.create'));
    expect(controller.state()).toBe('wrote');

    vi.advanceTimersByTime(WROTE_FLASH_MS - 1);
    expect(controller.state()).toBe('wrote');
    vi.advanceTimersByTime(2);
    expect(controller.state()).toBe('reading'); // still within WORKING_DECAY_MS
  });

  it('a write with no request history flashes wrote and then holds reading until the quiet window ends', () => {
    controller = connected();
    controller.feed(agentEntry('analysis.publish'));
    expect(controller.state()).toBe('wrote');
    vi.advanceTimersByTime(WROTE_FLASH_MS + 1);
    expect(controller.state()).toBe('reading');
    vi.advanceTimersByTime(WORKING_DECAY_MS);
    expect(controller.state()).toBe('idle');
  });

  it('every kind of journaled agent mutation is a write — the journal never carries reads', () => {
    for (const action of ['analysis.publish', 'watch.create', 'export.run', 'session.open', 'focus.set', 'chain.update']) {
      controller = connected();
      controller.feed(agentEntry(action));
      expect(controller.state(), action).toBe('wrote');
      controller.dispose();
    }
    controller = undefined;
  });

  it('a journaled pipeline run reads as running, not as a wrote flash', () => {
    controller = connected();
    controller.feed(agentEntry('pipeline.run'));
    expect(controller.state()).toBe('running');
    vi.advanceTimersByTime(WROTE_FLASH_MS + 1);
    expect(controller.state()).toBe('running');
  });

  it('a write in flight shows the held state; the wrote flash comes from the journal entry', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1, kind: 'write', method: 'POST', route: '/mcp/sessions/{session_id}/bookmarks' }));
    expect(controller.state()).toBe('reading');
    vi.advanceTimersByTime(HOLD_MS + 1);
    controller.feed(agentEntry('bookmark.create'));
    controller.request(requestEvent({ id: 1, kind: 'write', phase: 'end', status: 201 }));
    expect(controller.state()).toBe('wrote');
  });

  it('a journal entry resets the quiet clock', () => {
    controller = connected();
    controller.request(requestEvent({ id: 1 }));
    controller.request(requestEvent({ id: 1, phase: 'end', status: 200 }));
    vi.advanceTimersByTime(WORKING_DECAY_MS - 100);
    controller.feed(agentEntry('bookmark.create'));
    vi.advanceTimersByTime(WROTE_FLASH_MS + 1);
    expect(controller.state()).toBe('reading'); // would have rested without the reset
    vi.advanceTimersByTime(WORKING_DECAY_MS);
    expect(controller.state()).toBe('idle');
  });

  it('records lastAgentEntry and the client name from a journal entry', () => {
    controller = connected();
    const entry = agentEntry('session.open', { caller: { kind: 'agent', client: 'claude-desktop' } });
    controller.feed(entry);
    expect(controller.lastAgentEntry()).toEqual(entry);
    expect(controller.client()).toBe('claude-desktop');
  });

  it('never changes state for a human-caller entry, and does not record it as lastAgentEntry', () => {
    controller = connected();
    controller.feed(humanEntry('bookmark.create'));
    expect(controller.state()).toBe('idle');
    expect(controller.lastAgentEntry()).toBeNull();
    expect(controller.client()).toBeNull();
  });

  it('feeds entries from an optional activity accessor automatically, without duplicating already-seen ids', () => {
    const [entries, setEntries] = createSignal<ActivityEntry[]>([]);
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: () => false, activity: entries });

    const e1 = agentEntry('bookmark.create');
    setEntries([e1]);
    expect(controller.state()).toBe('wrote');
    expect(controller.lastAgentEntry()).toEqual(e1);

    vi.advanceTimersByTime(WROTE_FLASH_MS + HOLD_MS + 1);
    expect(controller.state()).toBe('reading');
    const e2 = agentEntry('pipeline.run');
    setEntries([e1, e2]);
    expect(controller.state()).toBe('running');
    expect(controller.lastAgentEntry()).toEqual(e2);
  });
});

describe('createAgentState — overrides', () => {
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

  it('raw overrides idle/reading/running/wrote while agentRawAccess is true', () => {
    const [rawAccess, setRawAccess] = createSignal(false);
    controller = createAgentState({ bridgeStatus: () => CONNECTED, agentRawAccess: rawAccess });

    controller.request(requestEvent({ id: 1 }));
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

    controller.request(requestEvent({ id: 1, kind: 'run', method: 'POST' })); // activity keeps flowing underneath
    expect(controller.state()).toBe('needs');

    // rawAccess is still true throughout — releasing "needs" falls back to
    // "raw", not to the activity-derived "running" underneath it.
    controller.setPending(false);
    expect(controller.state()).toBe('raw');
  });
});

describe('createAgentState activity effect (C-L3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-reads the journal only when the journal changes, not on hold/flash/decay transitions', () => {
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

    setEntries([agentEntry('bookmark.create')]);
    const afterFeed = reads;
    expect(controller.state()).toBe('wrote');

    // The flash ending, the hold expiring and the decay firing all write
    // `activityState`, which `reconcile()` reads. Without the untrack the
    // effect subscribes to its own write and re-walks the whole journal on
    // each of these.
    vi.advanceTimersByTime(HOLD_MS + WROTE_FLASH_MS + WORKING_DECAY_MS + 100);
    expect(controller.state()).toBe('idle');
    expect(reads).toBe(afterFeed);

    controller.dispose();
  });
});
