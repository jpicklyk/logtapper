/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import type { WatchInfo } from '@bridge/types';
import type { CallerLike } from '../ui';
import type { SessionStore } from '../app/index';
import { WatchesPanel } from './WatchesPanel';
import type { WatchesStore } from './watchesStore';

afterEach(cleanup);

function watchInfo(id: string, overrides: Partial<WatchInfo> = {}): WatchInfo {
  return {
    watchId: id,
    sessionId: 's1',
    totalMatches: 0,
    active: true,
    criteria: {
      textSearch: 'error',
      regex: null,
      logLevels: null,
      tags: null,
      timeStart: null,
      timeEnd: null,
      pids: null,
      combine: 'and',
    },
    ...overrides,
  };
}

function fakeSessions(focusedId: string | null): SessionStore {
  return { focusedId: () => focusedId } as unknown as SessionStore;
}

/** A hand-built `WatchesStore` double — the panel is tested as a renderer
 *  over the store's public surface, not against the real store (that is
 *  `watchesStore.test.ts`'s job). */
function fakeStore(overrides: { active?: WatchInfo[]; cancelled?: WatchInfo[]; loading?: boolean } = {}): WatchesStore & {
  create: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const activeList = overrides.active ?? [];
  const cancelledList = overrides.cancelled ?? [];
  return {
    list: () => [...activeList, ...cancelledList],
    active: () => activeList,
    cancelled: () => cancelledList,
    loading: () => overrides.loading ?? false,
    create: vi.fn(() => Promise.resolve(watchInfo('new'))),
    cancel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  };
}

describe('WatchesPanel', () => {
  it('shows an empty-state message when there is no focused session', () => {
    render(() => <WatchesPanel store={fakeStore()} sessions={fakeSessions(null)} />);
    expect(screen.getByText(/open a file or start a stream/i)).toBeTruthy();
  });

  it('shows an empty-state message when the focused session has no watches', () => {
    render(() => <WatchesPanel store={fakeStore()} sessions={fakeSessions('s1')} />);
    expect(screen.getByText(/no watches yet/i)).toBeTruthy();
  });

  it('renders active watches with their criteria and match count', () => {
    const w = watchInfo('w1', { totalMatches: 7 });
    render(() => <WatchesPanel store={fakeStore({ active: [w] })} sessions={fakeSessions('s1')} />);
    expect(screen.getAllByTestId('watch-row')).toHaveLength(1);
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText(/text:error/)).toBeTruthy();
  });

  it('renders a "Cancelled" section separately from active watches', () => {
    const active = watchInfo('a');
    const cancelled = watchInfo('b', { active: false });
    render(() => <WatchesPanel store={fakeStore({ active: [active], cancelled: [cancelled] })} sessions={fakeSessions('s1')} />);
    expect(screen.getAllByTestId('watch-row')).toHaveLength(2);
    expect(screen.getByText('Cancelled')).toBeTruthy();
  });

  it('the header count reflects only active watches', () => {
    render(() => (
      <WatchesPanel
        store={fakeStore({ active: [watchInfo('a'), watchInfo('b')], cancelled: [watchInfo('c', { active: false })] })}
        sessions={fakeSessions('s1')}
      />
    ));
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('shows a CallerBadge only for an agent-attributed watch', () => {
    const human = watchInfo('a');
    const agent = watchInfo('b');
    const callerFor = (watchId: string): CallerLike | null =>
      watchId === 'b' ? { kind: 'agent', client: 'claude-code' } : { kind: 'ui' };
    render(() => (
      <WatchesPanel store={fakeStore({ active: [human, agent] })} sessions={fakeSessions('s1')} callerFor={callerFor} />
    ));
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.queryByText('You')).toBeNull();
  });

  it('renders no badge at all when callerFor is omitted', () => {
    render(() => <WatchesPanel store={fakeStore({ active: [watchInfo('a')] })} sessions={fakeSessions('s1')} />);
    expect(screen.queryByText('Agent')).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
  });

  it('cancelling an active watch (after confirm) calls store.cancel with its own sessionId/watchId', () => {
    const w = watchInfo('w1', { sessionId: 's1' });
    const store = fakeStore({ active: [w] });
    render(() => <WatchesPanel store={store} sessions={fakeSessions('s1')} />);
    fireEvent.click(screen.getByTitle('Cancel watch'));
    fireEvent.click(screen.getByText('Confirm'));
    expect(store.cancel).toHaveBeenCalledWith('s1', 'w1');
  });

  it('a cancelled watch shows no cancel control', () => {
    render(() => <WatchesPanel store={fakeStore({ cancelled: [watchInfo('a', { active: false })] })} sessions={fakeSessions('s1')} />);
    expect(screen.queryByTitle('Cancel watch')).toBeNull();
  });

  it('the "+" button toggles the create form, and submitting calls store.create for the focused session', async () => {
    const store = fakeStore();
    render(() => <WatchesPanel store={store} sessions={fakeSessions('s1')} />);
    fireEvent.click(screen.getByTitle('Create watch'));
    expect(screen.getByTestId('create-watch-form')).toBeTruthy();

    fireEvent.input(screen.getByPlaceholderText('Text search…'), { target: { value: 'boot' } });
    fireEvent.click(screen.getByText('Create'));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.create).toHaveBeenCalledWith('s1', expect.objectContaining({ textSearch: 'boot' }));
  });
});
