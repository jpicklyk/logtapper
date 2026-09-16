/** @jsxImportSource solid-js */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { ActivityEntry } from '@bridge/types';
import { ActivityFeed, CLOCK_TICK_MS, actionLabel, groupBySession, navTargetFor, relativeTime } from './ActivityFeed';

// vitest `globals` is off, so the library's auto-cleanup never registers.
afterEach(cleanup);

const NOW = 1_700_000_100_000;

function entry(overrides: Partial<ActivityEntry> & { id: number }): ActivityEntry {
  return {
    ts: NOW - 5_000,
    caller: { kind: 'agent', client: 'claude-code' },
    action: 'bookmark.create',
    sessionId: 's1',
    summary: 'line 42: ANR',
    ...overrides,
  };
}

const names: Record<string, string> = { s1: 'dumpstate_S911', s2: 'logcat_run2' };
const sessionName = (id: string) => names[id] ?? id;

describe('navTargetFor', () => {
  it.each([
    ['bookmark.create', 'line 42: ANR', { sessionId: 's1', line: 42 }],
    ['bookmark.update', 'bookmark bk-9', { sessionId: 's1', bookmarkId: 'bk-9' }],
    ['bookmark.delete', 'bookmark bk-9', { sessionId: 's1', bookmarkId: 'bk-9' }],
    ['analysis.publish', 'artifact a-1: USB fails', { sessionId: 's1', analysisId: 'a-1' }],
    ['analysis.update', 'artifact a-1', { sessionId: 's1', analysisId: 'a-1' }],
    ['watch.create', 'watch w-3', { sessionId: 's1', watchId: 'w-3' }],
    ['watch.cancel', 'watch w-3', { sessionId: 's1', watchId: 'w-3' }],
    ['focus.set', 'line 100: look here', { sessionId: 's1', line: 100 }],
    ['nav.request', 'check this (line 77)', { sessionId: 's1', line: 77 }],
    ['pipeline.run', '3 processors', { sessionId: 's1' }],
    ['session.open', 'opened dumpstate_S911', { sessionId: 's1' }],
  ])('maps %s to its target', (action, summary, expected) => {
    expect(navTargetFor(entry({ id: 1, action, summary }))).toEqual(expected);
  });

  it('returns null for workspace-scoped actions with no session', () => {
    expect(
      navTargetFor(entry({ id: 1, action: 'pack.install', sessionId: null, summary: 'pack x' })),
    ).toBeNull();
  });

  it('returns null for an unknown action even when a session is present', () => {
    expect(navTargetFor(entry({ id: 1, action: 'theme.write', summary: 'slug' }))).toBeNull();
  });

  it('falls back to the session when the summary format does not match', () => {
    expect(navTargetFor(entry({ id: 1, action: 'bookmark.create', summary: 'unparsable' }))).toEqual(
      { sessionId: 's1' },
    );
  });
});

describe('actionLabel / relativeTime', () => {
  it('uses the human verb when known and the dotted name otherwise', () => {
    expect(actionLabel('analysis.publish')).toBe('published analysis');
    expect(actionLabel('made.up')).toBe('made.up');
  });

  it('scales the unit with the age', () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe('5s ago');
    expect(relativeTime(NOW - 120_000, NOW)).toBe('2m ago');
    expect(relativeTime(NOW - 7_200_000, NOW)).toBe('2h ago');
    expect(relativeTime(NOW - 172_800_000, NOW)).toBe('2d ago');
  });
});

describe('groupBySession', () => {
  it('groups by session, newest first within and between groups', () => {
    const groups = groupBySession(
      [
        entry({ id: 1, sessionId: 's1' }),
        entry({ id: 2, sessionId: 's2' }),
        entry({ id: 5, sessionId: 's1' }),
        entry({ id: 3, sessionId: null, action: 'pack.install', summary: 'pack x' }),
      ],
      sessionName,
    );
    expect(groups.map((g) => g.name)).toEqual(['dumpstate_S911', 'Workspace', 'logcat_run2']);
    expect(groups[0].entries.map((e) => e.id)).toEqual([5, 1]);
  });
});

describe('<ActivityFeed>', () => {
  it('renders a group header per session with its entry count', () => {
    const { container } = render(() => (
      <ActivityFeed
        entries={[entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3, sessionId: 's2' })]}
        sessionName={sessionName}
        now={() => NOW}
      />
    ));
    const groups = container.querySelectorAll('[data-session]');
    expect(groups.length).toBe(2);
    expect(groups[0].textContent).toContain('logcat_run2');
    expect(container.textContent).toContain('2 entries');
    expect(container.textContent).toContain('1 entry');
  });

  it('falls back to the session id when the name is unknown', () => {
    const { container } = render(() => (
      <ActivityFeed entries={[entry({ id: 1, sessionId: 'sX' })]} sessionName={sessionName} now={() => NOW} />
    ));
    expect(container.textContent).toContain('sX');
  });

  it('marks the caller badge as agent or human', () => {
    const { container } = render(() => (
      <ActivityFeed
        entries={[entry({ id: 1 }), entry({ id: 2, caller: { kind: 'ui' } })]}
        sessionName={sessionName}
        now={() => NOW}
      />
    ));
    const badges = [...container.querySelectorAll('[data-caller]')].map((b) =>
      b.getAttribute('data-caller'),
    );
    expect(badges.sort()).toEqual(['agent', 'human']);
    expect(container.textContent).toContain('claude-code');
    expect(container.textContent).toContain('you');
  });

  it('calls onNavigate with the entry target when a clickable row is activated', () => {
    const onNavigate = vi.fn();
    const { container } = render(() => (
      <ActivityFeed entries={[entry({ id: 1 })]} sessionName={sessionName} onNavigate={onNavigate} now={() => NOW} />
    ));
    const button = container.querySelector('button');
    expect(button).toBeTruthy();
    button!.click();
    expect(onNavigate).toHaveBeenCalledWith({ sessionId: 's1', line: 42 });
  });

  it('renders a row with no resolvable target as non-clickable', () => {
    const { container } = render(() => (
      <ActivityFeed
        entries={[entry({ id: 1, action: 'pack.install', sessionId: null, summary: 'pack x' })]}
        sessionName={sessionName}
        now={() => NOW}
      />
    ));
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('installed pack');
  });

  it('shows an empty state with no entries', () => {
    const { container } = render(() => (
      <ActivityFeed entries={[]} sessionName={sessionName} now={() => NOW} />
    ));
    expect(container.textContent).toContain('No agent activity yet.');
  });
});

describe('<ActivityFeed> DOM identity (C-M6)', () => {
  it('keeps the existing group and row nodes when a new entry arrives', () => {
    const [entries, setEntries] = createSignal<readonly ActivityEntry[]>([
      entry({ id: 1, sessionId: 's1' }),
      entry({ id: 2, sessionId: 's2' }),
    ]);
    const { container } = render(() => (
      <ActivityFeed entries={entries()} sessionName={sessionName} now={() => NOW} />
    ));

    const before = [...container.querySelectorAll('[data-session]')];
    const s1RowsBefore = [...container.querySelectorAll('[data-session="s1"] li')];
    expect(before.length).toBe(2);
    expect(s1RowsBefore.length).toBe(1);

    // One more entry in an existing session: the section for that session and
    // the rows already in it must be the same nodes, not re-created ones —
    // otherwise focus inside a row is lost on every journaled action.
    setEntries((prev) => [...prev, entry({ id: 3, sessionId: 's1' })]);

    const after = [...container.querySelectorAll('[data-session]')];
    expect(after.length).toBe(2);
    expect(new Set(after.map((el) => el.getAttribute('data-session')))).toEqual(new Set(['s1', 's2']));
    for (const node of before) expect(after).toContain(node);
    const s1RowsAfter = [...container.querySelectorAll('[data-session="s1"] li')];
    expect(s1RowsAfter.length).toBe(2);
    for (const row of s1RowsBefore) expect(s1RowsAfter).toContain(row);
    expect(container.querySelector('[data-session="s1"]')!.textContent).toContain('2 entries');
  });

  it('creates a section for a session seen for the first time', () => {
    const [entries, setEntries] = createSignal<readonly ActivityEntry[]>([entry({ id: 1, sessionId: 's1' })]);
    const { container } = render(() => (
      <ActivityFeed entries={entries()} sessionName={sessionName} now={() => NOW} />
    ));
    const s1 = container.querySelector('[data-session="s1"]');

    setEntries((prev) => [...prev, entry({ id: 2, sessionId: 's2' })]);

    expect(container.querySelectorAll('[data-session]').length).toBe(2);
    expect(container.querySelector('[data-session="s1"]')).toBe(s1);
    expect(container.querySelector('[data-session="s2"]')).toBeTruthy();
  });
});

describe('<ActivityFeed> clock (C-L9)', () => {
  it('re-renders the relative timestamps on its own when no clock is injected', () => {
    vi.useFakeTimers();
    try {
      const base = Date.now();
      const { container } = render(() => (
        <ActivityFeed entries={[entry({ id: 1, ts: base })]} sessionName={sessionName} />
      ));
      expect(container.querySelector('time')!.textContent).toBe('0s ago');

      vi.advanceTimersByTime(CLOCK_TICK_MS + 1_000);
      expect(container.querySelector('time')!.textContent).not.toBe('0s ago');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the clock pinned when one is injected', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(() => (
        <ActivityFeed entries={[entry({ id: 1, ts: NOW - 5_000 })]} sessionName={sessionName} now={() => NOW} />
      ));
      vi.advanceTimersByTime(CLOCK_TICK_MS * 4);
      expect(container.querySelector('time')!.textContent).toBe('5s ago');
    } finally {
      vi.useRealTimers();
    }
  });
});
