/** @jsxImportSource solid-js */
// @vitest-environment jsdom
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import type { ActivityEntry, FocusContext, McpStatus, NavRequest } from '@bridge/types';
import { PresencePanel } from './PresencePanel';
import { createAgentState } from './agentState';
import type { NavTarget, PresenceStore } from './presenceStore';

afterEach(cleanup);

const NOW = 1_700_000_100_000;

/**
 * A hand-built store rather than a mocked `createPresenceStore`: the panel only
 * ever reads the `PresenceStore` interface, so driving the signals directly is
 * both the narrower test and the one that fails if the interface drifts. The
 * agent controller is the real A1 one — it makes no bridge calls.
 */
function fakeStore(overrides: Partial<McpStatus> = {}) {
  const [status] = createSignal<McpStatus>({
    running: true,
    port: 40404,
    idleSecs: 1,
    agentRawAccess: false,
    anonymizerMode: 'external',
    effectiveAgentRaw: false,
    ...overrides,
  });
  const [entries, setEntries] = createSignal<readonly ActivityEntry[]>([]);
  const [focus, setFocus] = createSignal<FocusContext | null>(null);
  const [pendingNav, setPendingNav] = createSignal<readonly NavRequest[]>([]);
  const [held, setHeld] = createSignal<readonly number[]>([]);
  const [requireConfirm, setRequireConfirm] = createSignal(true);

  const agentRawAccess = () => status().agentRawAccess;
  // Same wiring as the real store: the orb's raw state follows the backend's
  // combined answer, not the checkbox alone.
  const effectiveAgentRaw = () => status().effectiveAgentRaw;
  const agent = createAgentState({ bridgeStatus: status, agentRawAccess: effectiveAgentRaw, activity: entries });

  const calls = {
    navigate: [] as NavTarget[],
    apply: [] as number[],
    hold: [] as number[],
    dismiss: [] as number[],
    clearFocus: 0,
    refreshStatus: 0,
    setRequireConfirm: [] as boolean[],
  };

  const store: PresenceStore = {
    status,
    refreshStatus: () => { calls.refreshStatus += 1; },
    agentRawAccess,
    effectiveAgentRaw,
    entries,
    focus,
    pendingNav,
    requireNavConfirmation: requireConfirm,
    setRequireNavConfirmation: (v) => {
      calls.setRequireConfirm.push(v);
      setRequireConfirm(v);
    },
    sessionName: (id) => (id === 's1' ? 'dumpstate_S911' : id),
    agent,
    applyNav: (id) => calls.apply.push(id),
    holdNav: (id) => {
      calls.hold.push(id);
      setHeld((c) => [...c, id]);
    },
    isNavHeld: (id) => held().includes(id),
    dismissNav: (id) => calls.dismiss.push(id),
    navigate: (t) => calls.navigate.push(t),
    clearFocus: async () => {
      calls.clearFocus += 1;
      setFocus(null);
    },
    dispose: () => agent.dispose(),
  };

  return { store, calls, setEntries, setFocus, setPendingNav };
}

function navRequest(id: number, overrides: Partial<NavRequest> = {}): NavRequest {
  return {
    id,
    sessionId: 's1',
    line: 42,
    analysisId: null,
    reason: 'look at the enumeration failure',
    requestedBy: { kind: 'agent', client: 'claude-code' },
    ts: NOW,
    ...overrides,
  };
}

describe('<PresencePanel> — orb stage', () => {
  it('leads the panel with the orb stage and no panel-local collapse control', () => {
    const { container } = render(() => <PresencePanel store={fakeStore().store} />);
    const stage = container.querySelector('[data-testid="agent-stage"]');
    expect(stage).toBeTruthy();
    expect(stage!.querySelector('[class*="orb"]')).toBeTruthy();
    expect(container.querySelector('header')).toBeNull();
    // Hiding the panel is the shell's per-region collapse, not a button here.
    expect(stage!.querySelector('button')).toBeNull();
    // The stage is the panel's first block, so it sits at the pane's top edge.
    const panel = container.querySelector('section[aria-label="Agent presence"]')!;
    expect(panel.firstElementChild).toBe(stage);
  });
});

describe('<PresencePanel> — orb state', () => {
  it('renders the idle orb when connected and quiet', () => {
    const { store } = fakeStore();
    const { container } = render(() => <PresencePanel store={store} now={() => NOW} />);
    expect(container.querySelector('.orb--idle')).toBeTruthy();
    expect(container.querySelector('[data-state="idle"]')).toBeTruthy();
  });

  it('renders the raw orb and the banner only when agents effectively read raw', () => {
    const off = fakeStore();
    const first = render(() => <PresencePanel store={off.store} now={() => NOW} />);
    expect(first.container.querySelector('[data-testid="raw-banner"]')).toBeNull();
    first.unmount();

    const on = fakeStore({ agentRawAccess: true, effectiveAgentRaw: true });
    const second = render(() => <PresencePanel store={on.store} now={() => NOW} />);
    expect(second.container.querySelector('.orb--raw')).toBeTruthy();
    expect(second.container.querySelector('[data-testid="raw-banner"]')!.textContent).toContain(
      'Raw access ON',
    );
    second.unmount();

    // Anonymizer mode None opens the same door with the checkbox still off:
    // the warning is keyed off the backend's `effectiveAgentRaw`, and names
    // the gate that is actually open.
    const modeNone = fakeStore({ agentRawAccess: false, anonymizerMode: 'none', effectiveAgentRaw: true });
    const third = render(() => <PresencePanel store={modeNone.store} now={() => NOW} />);
    expect(third.container.querySelector('.orb--raw')).toBeTruthy();
    const banner = third.container.querySelector('[data-testid="raw-banner"]')!;
    expect(banner.textContent).toContain('Anonymizer OFF');
    expect(banner.textContent).toContain('reads un-anonymized log text');
  });

  it('renders the detached orb when the bridge is not running', () => {
    const { store } = fakeStore({ running: false, idleSecs: null });
    const { container } = render(() => <PresencePanel store={store} now={() => NOW} />);
    expect(container.querySelector('.orb--detached')).toBeTruthy();
  });

  it('shows the needs-you state while a request is pending', () => {
    const { store, setPendingNav } = fakeStore();
    const { container } = render(() => <PresencePanel store={store} now={() => NOW} />);
    setPendingNav([navRequest(1)]);
    store.agent.setPending(true);
    expect(container.querySelector('.orb--needs')).toBeTruthy();
    expect(container.textContent).toContain('needs you');
  });
});

describe('<PresencePanel> — shared focus', () => {
  it('renders the focus target and clears it on demand', async () => {
    const { store, calls, setFocus } = fakeStore();
    const { container } = render(() => <PresencePanel store={store} now={() => NOW} />);
    expect(container.querySelector('[data-testid="focus-indicator"]')).toBeNull();

    setFocus({
      sessionId: 's1',
      line: 48213,
      section: 'usb',
      selection: null,
      note: null,
      setBy: { kind: 'agent', client: 'claude-code' },
      ts: NOW,
    });
    const indicator = container.querySelector('[data-testid="focus-indicator"]')!;
    expect(indicator.textContent).toContain('dumpstate_S911 · line 48213 · usb');

    (indicator.querySelector('button') as HTMLButtonElement).click();
    expect(calls.clearFocus).toBe(1);
    expect(container.querySelector('[data-testid="focus-indicator"]')).toBeNull();
  });
});

describe('<PresencePanel> — navigation requests', () => {
  it('renders a card with apply / hold / dismiss wired to the store', () => {
    const { store, calls, setPendingNav } = fakeStore();
    const { container } = render(() => <PresencePanel store={store} now={() => NOW} />);
    setPendingNav([navRequest(7)]);

    const card = container.querySelector('[data-testid="nav-request"]')!;
    expect(card.textContent).toContain('look at the enumeration failure');
    expect(card.textContent).toContain('dumpstate_S911');
    expect(card.textContent).toContain('line 42');

    const [apply, hold, dismiss] = [...card.querySelectorAll('button')] as HTMLButtonElement[];
    apply.click();
    hold.click();
    dismiss.click();
    expect(calls.apply).toEqual([7]);
    expect(calls.hold).toEqual([7]);
    expect(calls.dismiss).toEqual([7]);
    expect(card.getAttribute('data-held')).toBe('true');
  });

  it('drives the confirmation toggle through the store', () => {
    const { store, calls } = fakeStore();
    const { container } = render(() => <PresencePanel store={store} now={() => NOW} />);
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    checkbox.click();
    expect(calls.setRequireConfirm).toEqual([false]);
  });
});

describe('<PresencePanel> — feed and placeholders', () => {
  it('mounts the activity feed and forwards clicks to store.navigate', () => {
    const { store, calls, setEntries } = fakeStore();
    const { container } = render(() => <PresencePanel store={store} now={() => NOW} />);
    setEntries([
      {
        id: 1,
        ts: NOW - 1_000,
        caller: { kind: 'agent', client: 'claude-code' },
        action: 'bookmark.create',
        sessionId: 's1',
        summary: 'line 42: ANR',
      },
    ]);

    const feed = container.querySelector('[data-testid="activity-feed"]')!;
    (feed.querySelector('button') as HTMLButtonElement).click();
    expect(calls.navigate).toEqual([{ sessionId: 's1', line: 42 }]);
  });

  it("shows only agent entries in the feed; the user's own actions are filtered out", () => {
    const { store, setEntries } = fakeStore();
    const { container } = render(() => <PresencePanel store={store} now={() => NOW} />);
    setEntries([
      { id: 1, ts: NOW - 2_000, caller: { kind: 'ui' }, action: 'session.open', sessionId: 's1', summary: 'opened app.log' },
      { id: 2, ts: NOW - 1_000, caller: { kind: 'agent', client: 'claude-code' }, action: 'query', sessionId: 's1', summary: 'searched ANR' },
      { id: 3, ts: NOW - 500, caller: { kind: 'ui' }, action: 'workspace.load', sessionId: null, summary: 'loaded workspace' },
    ]);
    const feed = container.querySelector('[data-testid="activity-feed"]')!;
    expect(feed.textContent).toContain('searched ANR');
    expect(feed.textContent).not.toContain('opened app.log');
    expect(feed.textContent).not.toContain('loaded workspace');
    expect(feed.querySelectorAll('[data-caller="human"]')).toHaveLength(0);
  });

  it('always renders the phase-2b consent placeholder', () => {
    const { store } = fakeStore();
    const { container } = render(() => <PresencePanel store={store} now={() => NOW} />);
    expect(container.querySelector('[data-testid="consent-placeholder"]')!.textContent).toContain(
      'Consent requests appear here',
    );
  });

  it('names the agent from the last agent entry, defaulting before any', () => {
    const { store, setEntries } = fakeStore();
    const { container } = render(() => <PresencePanel store={store} now={() => NOW} />);
    expect(container.textContent).toContain('Agent');

    setEntries([
      {
        id: 1,
        ts: NOW,
        caller: { kind: 'agent', client: 'claude-desktop' },
        action: 'session.open',
        sessionId: 's1',
        summary: 'opened x',
      },
    ]);
    expect(container.textContent).toContain('claude-desktop');
  });
});

