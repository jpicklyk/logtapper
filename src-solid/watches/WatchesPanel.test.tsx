/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import type { WatchInfo } from '@bridge/types';
import type { CallerLike } from '../ui';
import type { SessionStore } from '../app/index';
import { WatchesPanel } from './WatchesPanel';
import type { WatchesStore } from './watchesStore';
import styles from './watches.module.css';

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
 *  `watchesStore.test.ts`'s job).
 *
 *  Signal-backed, and `applyMatch` **replaces** the `WatchInfo` object the way
 *  the real store's `watch-match` handler does (`{ ...w, totalMatches }`) —
 *  that object replacement is precisely what used to re-create the row
 *  (review C-M5), so a double that mutated in place would test nothing. */
function fakeStore(overrides: { active?: WatchInfo[]; cancelled?: WatchInfo[]; loading?: boolean } = {}): WatchesStore & {
  create: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  applyMatch: (watchId: string, totalMatches: number) => void;
  setActive: (watchId: string, active: boolean) => void;
} {
  const [all, setAll] = createSignal<readonly WatchInfo[]>([
    ...(overrides.active ?? []),
    ...(overrides.cancelled ?? []),
  ]);
  const replace = (watchId: string, fields: Partial<WatchInfo>): void => {
    setAll((prev) => prev.map((w) => (w.watchId === watchId ? { ...w, ...fields } : w)));
  };
  const active = (): WatchInfo[] => all().filter((w) => w.active);
  const cancelled = (): WatchInfo[] => all().filter((w) => !w.active);
  return {
    list: () => [...all()],
    active,
    cancelled,
    activeIds: () => active().map((w) => w.watchId),
    cancelledIds: () => cancelled().map((w) => w.watchId),
    byId: (_sessionId: string, watchId: string) => all().find((w) => w.watchId === watchId),
    loading: () => overrides.loading ?? false,
    create: vi.fn(() => Promise.resolve(watchInfo('new'))),
    cancel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
    applyMatch: (watchId, totalMatches) => replace(watchId, { totalMatches }),
    setActive: (watchId, isActive) => replace(watchId, { active: isActive }),
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

  // ── C-M5: the row must survive a match-count update ────────────────────
  describe('a watch-match update keeps the row (C-M5)', () => {
    it('plays the flash animation on an increment instead of remounting', () => {
      const store = fakeStore({ active: [watchInfo('w1', { totalMatches: 3 })] });
      render(() => <WatchesPanel store={store} sessions={fakeSessions('s1')} />);
      const count = (): Element => screen.getByTestId('watch-row').querySelector(`.${styles.matchCount}`)!;
      expect(count().classList.contains(styles.matchCountFlash)).toBe(false);

      store.applyMatch('w1', 4);

      expect(count().textContent).toBe('4');
      // Before the fix the row was disposed and re-created, so the flash
      // effect restarted with `prev === undefined` and never fired.
      expect(count().classList.contains(styles.matchCountFlash)).toBe(true);
    });

    it('leaves an in-progress cancel confirmation standing', () => {
      const store = fakeStore({ active: [watchInfo('w1', { totalMatches: 3 })] });
      render(() => <WatchesPanel store={store} sessions={fakeSessions('s1')} />);
      fireEvent.click(screen.getByTitle('Cancel watch'));
      expect(screen.getByText('Confirm')).toBeTruthy();

      store.applyMatch('w1', 9);

      // The row kept its local `confirming()` signal, so the user reaching
      // for Confirm still has it (the whole point of the arm-then-confirm).
      expect(screen.getByText('Confirm')).toBeTruthy();
      fireEvent.click(screen.getByText('Confirm'));
      expect(store.cancel).toHaveBeenCalledWith('s1', 'w1');
    });

    it('still moves a watch to the Cancelled section when it is cancelled', () => {
      const store = fakeStore({ active: [watchInfo('w1')] });
      render(() => <WatchesPanel store={store} sessions={fakeSessions('s1')} />);
      expect(screen.queryByText('Cancelled')).toBeNull();

      store.setActive('w1', false);

      expect(screen.getByText('Cancelled')).toBeTruthy();
      expect(screen.getAllByTestId('watch-row')).toHaveLength(1);
      expect(screen.queryByTitle('Cancel watch')).toBeNull();
    });
  });
});
