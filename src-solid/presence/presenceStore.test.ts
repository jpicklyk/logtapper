// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry, AgentRequestEvent, FocusContext, McpStatus, NavRequest } from '@bridge/types';
import {
  NAV_CONFIRM_STORAGE_KEY,
  createPresenceStore,
  mergeEntries,
} from './presenceStore';
import type { NavTarget, PresenceStore } from './presenceStore';

// The store is the only module that talks to the bridge, so both bridge
// modules are mocked wholesale: the command mocks hand back fixtures and the
// event mocks capture the callbacks so a test can fire an event by hand.
const getMcpStatusMock = vi.fn<() => Promise<McpStatus>>();
const getActivityMock = vi.fn<(limit?: number) => Promise<ActivityEntry[]>>();
const getFocusMock = vi.fn<() => Promise<FocusContext | null>>();
const setFocusMock = vi.fn<(input: unknown) => Promise<FocusContext | null>>();
const getExportAllSessionsInfoMock = vi.fn();

vi.mock('@bridge/commands', () => ({
  getMcpStatus: () => getMcpStatusMock(),
  getActivity: (limit?: number) => getActivityMock(limit),
  getFocus: () => getFocusMock(),
  setFocus: (input: unknown) => setFocusMock(input),
  getExportAllSessionsInfo: () => getExportAllSessionsInfoMock(),
}));

interface Listeners {
  activity: ((e: ActivityEntry) => void)[];
  request: ((e: AgentRequestEvent) => void)[];
  focus: ((f: FocusContext | null) => void)[];
  nav: ((r: NavRequest) => void)[];
}
const listeners: Listeners = { activity: [], request: [], focus: [], nav: [] };
const unlistenCalls: string[] = [];

vi.mock('@bridge/events', () => ({
  onActivity: (cb: (e: ActivityEntry) => void) => {
    listeners.activity.push(cb);
    return Promise.resolve(() => unlistenCalls.push('activity'));
  },
  onAgentRequest: (cb: (e: AgentRequestEvent) => void) => {
    listeners.request.push(cb);
    return Promise.resolve(() => unlistenCalls.push('request'));
  },
  onFocusChanged: (cb: (f: FocusContext | null) => void) => {
    listeners.focus.push(cb);
    return Promise.resolve(() => unlistenCalls.push('focus'));
  },
  onNavigateRequest: (cb: (r: NavRequest) => void) => {
    listeners.nav.push(cb);
    return Promise.resolve(() => unlistenCalls.push('nav'));
  },
}));

function status(overrides: Partial<McpStatus> = {}): McpStatus {
  return { running: true, port: 40404, idleSecs: 1, agentRawAccess: false, ...overrides };
}

function entry(id: number, overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id,
    ts: 1_700_000_000_000 + id,
    caller: { kind: 'agent', client: 'claude-code' },
    action: 'bookmark.create',
    sessionId: 's1',
    summary: `line ${id}: note`,
    ...overrides,
  };
}

function navRequest(id: number, overrides: Partial<NavRequest> = {}): NavRequest {
  return {
    id,
    sessionId: 's1',
    line: 42,
    analysisId: null,
    reason: 'look at the enumeration failure',
    requestedBy: { kind: 'agent', client: 'claude-code' },
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

/** Let the mocked promises (and their `.then` chains) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let store: PresenceStore | null = null;
let navigated: NavTarget[] = [];

function build(options: { navigate?: (t: NavTarget) => void } = {}): PresenceStore {
  navigated = [];
  store = createPresenceStore({
    pollMs: 1_000_000, // effectively off; tests drive refreshes by hand
    navigate: options.navigate ?? ((t) => navigated.push(t)),
  });
  return store;
}

beforeEach(() => {
  listeners.activity = [];
  listeners.request = [];
  listeners.focus = [];
  listeners.nav = [];
  unlistenCalls.length = 0;
  localStorage.clear();
  getMcpStatusMock.mockResolvedValue(status());
  getActivityMock.mockResolvedValue([]);
  getFocusMock.mockResolvedValue(null);
  setFocusMock.mockResolvedValue(null);
  getExportAllSessionsInfoMock.mockResolvedValue({
    sessions: [
      { sessionId: 's1', sourceFilename: 'dumpstate_S911.txt', bookmarkCount: 0, analysisCount: 0 },
    ],
    totalProcessorCount: 0,
    totalPipelineProcessorCount: 0,
  });
});

afterEach(() => {
  store?.dispose();
  store = null;
});

describe('mergeEntries', () => {
  it('dedupes by id, keeps ascending order and caps the tail', () => {
    const merged = mergeEntries([entry(3), entry(1)], [entry(1), entry(2)], 10);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);

    const capped = mergeEntries([], [entry(1), entry(2), entry(3)], 2);
    expect(capped.map((e) => e.id)).toEqual([2, 3]);
  });

  it('returns the same array reference when nothing is new', () => {
    const previous = [entry(1)];
    expect(mergeEntries(previous, [entry(1)], 10)).toBe(previous);
  });
});

describe('createPresenceStore — journal', () => {
  it('seeds from getActivity and appends live entries without duplicating', async () => {
    getActivityMock.mockResolvedValue([entry(1), entry(2)]);
    const s = build();
    await flush();
    expect(s.entries().map((e) => e.id)).toEqual([1, 2]);

    listeners.activity[0](entry(3));
    listeners.activity[0](entry(2)); // re-delivery of a seeded entry
    expect(s.entries().map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('caps the journal at the configured limit, keeping the newest', async () => {
    store = createPresenceStore({ pollMs: 1_000_000, limit: 2 });
    await flush();
    listeners.activity[0](entry(1));
    listeners.activity[0](entry(2));
    listeners.activity[0](entry(3));
    expect(store.entries().map((e) => e.id)).toEqual([2, 3]);
  });

  it('survives a failing getActivity', async () => {
    getActivityMock.mockRejectedValue(new Error('no host'));
    const s = build();
    await flush();
    expect(s.entries()).toEqual([]);
  });
});

describe('createPresenceStore — status and raw access', () => {
  it('exposes agentRawAccess from the bridge status', async () => {
    getMcpStatusMock.mockResolvedValue(status({ agentRawAccess: true }));
    const s = build();
    await flush();
    expect(s.status()?.port).toBe(40404);
    expect(s.agentRawAccess()).toBe(true);
  });

  it('defaults agentRawAccess to false before the first status resolves', () => {
    const s = build();
    expect(s.agentRawAccess()).toBe(false);
  });

  it('resolves session names from the session list, falling back to the id', async () => {
    const s = build();
    await flush();
    expect(s.sessionName('s1')).toBe('dumpstate_S911.txt');
    expect(s.sessionName('unknown')).toBe('unknown');
  });
});

describe('createPresenceStore — focus', () => {
  const focus: FocusContext = {
    sessionId: 's1',
    line: 48213,
    section: 'usb',
    selection: null,
    note: null,
    setBy: { kind: 'agent', client: 'claude-code' },
    ts: 1_700_000_000_000,
  };

  it('seeds from getFocus and follows focus-changed, including a clear', async () => {
    getFocusMock.mockResolvedValue(focus);
    const s = build();
    await flush();
    expect(s.focus()?.line).toBe(48213);

    listeners.focus[0](null);
    expect(s.focus()).toBeNull();
  });

  it('clearFocus calls setFocus(null) and clears optimistically', async () => {
    getFocusMock.mockResolvedValue(focus);
    const s = build();
    await flush();

    await s.clearFocus();
    expect(setFocusMock).toHaveBeenCalledWith(null);
    expect(s.focus()).toBeNull();
  });
});

describe('createPresenceStore — navigation requests', () => {
  it('queues a request when confirmation is required and applies it on demand', async () => {
    const s = build();
    await flush();

    listeners.nav[0](navRequest(7));
    expect(s.pendingNav().map((r) => r.id)).toEqual([7]);
    expect(s.agent.state()).toBe('needs');
    expect(navigated).toEqual([]);

    s.applyNav(7);
    expect(navigated).toEqual([{ sessionId: 's1', line: 42 }]);
    expect(s.pendingNav()).toEqual([]);
    expect(s.agent.state()).not.toBe('needs');
  });

  it('holding keeps the request listed but stops the needs-you state', async () => {
    const s = build();
    await flush();

    listeners.nav[0](navRequest(7));
    s.holdNav(7);
    expect(s.pendingNav().map((r) => r.id)).toEqual([7]);
    expect(s.isNavHeld(7)).toBe(true);
    expect(s.agent.state()).not.toBe('needs');

    // A later request re-asserts attention even while one is held.
    listeners.nav[0](navRequest(8));
    expect(s.agent.state()).toBe('needs');
  });

  it('dismiss drops the request without navigating', async () => {
    const s = build();
    await flush();

    listeners.nav[0](navRequest(7));
    s.dismissNav(7);
    expect(s.pendingNav()).toEqual([]);
    expect(navigated).toEqual([]);
  });

  it('applies immediately when confirmation is off', async () => {
    const s = build();
    await flush();
    s.setRequireNavConfirmation(false);

    listeners.nav[0](navRequest(9, { line: null, analysisId: 'a-1' }));
    expect(s.pendingNav()).toEqual([]);
    expect(navigated).toEqual([{ sessionId: 's1', analysisId: 'a-1' }]);
  });

  it('turning confirmation off flushes whatever was already queued', async () => {
    const s = build();
    await flush();

    listeners.nav[0](navRequest(7));
    s.setRequireNavConfirmation(false);
    expect(navigated).toEqual([{ sessionId: 's1', line: 42 }]);
    expect(s.pendingNav()).toEqual([]);
    expect(s.agent.state()).not.toBe('needs');
  });

  it('persists the confirmation setting and reads it back on the next store', async () => {
    const first = build();
    await flush();
    first.setRequireNavConfirmation(false);
    expect(localStorage.getItem(NAV_CONFIRM_STORAGE_KEY)).toBe('false');
    first.dispose();

    const second = build();
    await flush();
    expect(second.requireNavConfirmation()).toBe(false);
  });

  it('defaults to requiring confirmation with no stored value', async () => {
    const s = build();
    await flush();
    expect(s.requireNavConfirmation()).toBe(true);
  });
});

describe('createPresenceStore — request lifecycle', () => {
  function requestEvent(overrides: Partial<AgentRequestEvent> = {}): AgentRequestEvent {
    return {
      id: 1,
      ts: 1_700_000_000_000,
      client: 'claude-cowork',
      method: 'GET',
      route: '/mcp/sessions/{session_id}/query',
      kind: 'read',
      phase: 'start',
      status: null,
      ...overrides,
    };
  }

  it('drives the orb from bridge request events, with no journal entry involved', async () => {
    const s = build();
    await flush();
    expect(s.agent.state()).toBe('idle');

    listeners.request[0](requestEvent());
    expect(s.agent.state()).toBe('reading');
    expect(s.agent.inFlight()).toBe(1);
    expect(s.agent.client()).toBe('claude-cowork');
    expect(s.entries()).toEqual([]);

    listeners.request[0](requestEvent({ phase: 'end', status: 200 }));
    expect(s.agent.inFlight()).toBe(0);
    // Still working — the agent is thinking between calls, not resting.
    expect(s.agent.state()).toBe('reading');
  });

  it('a request event does not trigger a status re-read', async () => {
    const s = build();
    await flush();
    const before = getMcpStatusMock.mock.calls.length;
    listeners.request[0](requestEvent());
    listeners.request[0](requestEvent({ phase: 'end', status: 200 }));
    await flush();
    expect(getMcpStatusMock.mock.calls.length).toBe(before);
    expect(s.agent.state()).toBe('reading');
  });

  it('ignores request events after dispose', async () => {
    const s = build();
    await flush();
    const fire = listeners.request[0];
    s.dispose();
    store = null;
    fire(requestEvent());
    expect(s.agent.inFlight()).toBe(0);
  });
});

describe('createPresenceStore — disposal', () => {
  it('unlistens every subscription and stops the poll', async () => {
    const s = build();
    await flush();
    expect(unlistenCalls).toEqual([]);

    s.dispose();
    store = null;
    expect(unlistenCalls.sort()).toEqual(['activity', 'focus', 'nav', 'request']);

    const before = getMcpStatusMock.mock.calls.length;
    await flush();
    expect(getMcpStatusMock.mock.calls.length).toBe(before);
  });

  it('ignores events that arrive after dispose', async () => {
    const s = build();
    await flush();
    const fire = listeners.activity[0];
    s.dispose();
    store = null;

    fire(entry(99));
    expect(s.entries().map((e) => e.id)).toEqual([]);
  });
});

describe('createPresenceStore — event-driven refresh (C-L2)', () => {
  it('collapses a burst of activity into one status re-read', async () => {
    const s = createPresenceStore({ pollMs: 1_000_000, refreshDebounceMs: 20 });
    store = s;
    await flush();
    const baseline = getMcpStatusMock.mock.calls.length;
    const namesBaseline = getExportAllSessionsInfoMock.mock.calls.length;

    for (let id = 1; id <= 10; id += 1) listeners.activity[0](entry(id));
    await flush();
    // Still inside the debounce window: no extra IPC yet.
    expect(getMcpStatusMock.mock.calls.length).toBe(baseline);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getMcpStatusMock.mock.calls.length).toBe(baseline + 1);
    // Names only re-read when a session.* entry was in the burst.
    expect(getExportAllSessionsInfoMock.mock.calls.length).toBe(namesBaseline);
    // Every entry still reached the journal — the debounce is on the refresh, not the ingest.
    expect(s.entries().length).toBe(10);
  });

  it('re-reads the session names when a session.* entry is anywhere in the burst', async () => {
    const s = createPresenceStore({ pollMs: 1_000_000, refreshDebounceMs: 20 });
    store = s;
    await flush();
    const namesBaseline = getExportAllSessionsInfoMock.mock.calls.length;

    listeners.activity[0](entry(1));
    listeners.activity[0](entry(2, { action: 'session.open', summary: 'opened x' }));
    listeners.activity[0](entry(3));

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getExportAllSessionsInfoMock.mock.calls.length).toBe(namesBaseline + 1);
  });

  it('refreshStatus() re-reads immediately, without waiting out the debounce', async () => {
    const s = build();
    await flush();
    const baseline = getMcpStatusMock.mock.calls.length;

    s.refreshStatus();
    expect(getMcpStatusMock.mock.calls.length).toBe(baseline + 1);
    await flush();
  });

  it('a debounced refresh scheduled before dispose never fires', async () => {
    const s = createPresenceStore({ pollMs: 1_000_000, refreshDebounceMs: 20 });
    store = s;
    await flush();
    const baseline = getMcpStatusMock.mock.calls.length;

    listeners.activity[0](entry(1));
    s.dispose();
    store = null;

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getMcpStatusMock.mock.calls.length).toBe(baseline);
  });
});

describe('createPresenceStore — dispose (C-L12)', () => {
  it('is idempotent: a second call unlistens nothing further and does not throw', async () => {
    const s = build();
    await flush();

    s.dispose();
    const afterFirst = unlistenCalls.length;
    expect(afterFirst).toBeGreaterThan(0);

    expect(() => s.dispose()).not.toThrow();
    expect(unlistenCalls.length).toBe(afterFirst);
    store = null;
  });
});
