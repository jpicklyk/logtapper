/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import type { ProcessorSummary, StateSnapshot } from '@bridge/types';
import { DeviceStatePanel } from './DeviceStatePanel';
import type { DeviceStateStore, TransitionPosition } from './deviceStateStore';
import styles from './devicestate.module.css';

afterEach(cleanup);

function tracker(id: string, name = id): ProcessorSummary {
  return { id, name } as unknown as ProcessorSummary;
}

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return { lineNum: 42, timestamp: 0, fields: {}, initializedFields: [], sourceSections: [], ...overrides };
}

function fakeStore(overrides: Partial<DeviceStateStore> = {}): DeviceStateStore {
  return {
    trackers: vi.fn(() => [tracker('t1', 'USB state')]),
    selectedTracker: vi.fn(() => 't1'),
    setSelectedTracker: vi.fn(),
    hasCursor: vi.fn(() => true),
    snapshot: vi.fn(() => snapshot()),
    snapshotLoading: vi.fn(() => false),
    changes: vi.fn(() => ({})),
    transitionPosition: vi.fn<() => TransitionPosition | null>(() => ({ index: 1, total: 3 })),
    prevTransition: vi.fn(),
    nextTransition: vi.fn(),
    ...overrides,
  } as unknown as DeviceStateStore;
}

describe('DeviceStatePanel', () => {
  it('shows the no-trackers empty state when nothing is active', () => {
    const store = fakeStore({ trackers: vi.fn(() => []) });
    render(() => <DeviceStatePanel store={store} sessionId="s1" />);
    expect(screen.getByText(/no active state trackers/i)).toBeTruthy();
  });

  it('shows the no-cursor empty state before anything has been navigated to', () => {
    const store = fakeStore({ hasCursor: vi.fn(() => false) });
    render(() => <DeviceStatePanel store={store} sessionId="s1" />);
    expect(screen.getByText(/select a line in the viewer/i)).toBeTruthy();
  });

  it('shows a run-the-pipeline empty state when there is a cursor but no snapshot yet', () => {
    const store = fakeStore({ snapshot: vi.fn(() => null) });
    render(() => <DeviceStatePanel store={store} sessionId="s1" />);
    expect(screen.getByText(/run the pipeline to see state/i)).toBeTruthy();
  });

  it('shows a loading state while a snapshot fetch is in flight', () => {
    const store = fakeStore({ snapshot: vi.fn(() => null), snapshotLoading: vi.fn(() => true) });
    render(() => <DeviceStatePanel store={store} sessionId="s1" />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it('groups fields into initialized (known) and never-touched (unknown), divided', () => {
    const store = fakeStore({
      snapshot: vi.fn(() =>
        snapshot({
          fields: { active: true, count: 3, pending: null },
          initializedFields: ['active', 'count'],
        }),
      ),
    });
    const { container } = render(() => <DeviceStatePanel store={store} sessionId="s1" />);
    // Known fields render with real values; the unknown one renders "--" and
    // is separated from the known group by the divider.
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('TRUE')).toBeTruthy();
    expect(screen.getByText('count')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('pending')).toBeTruthy();
    expect(screen.getByText('--')).toBeTruthy();
    expect(container.querySelector('hr')).toBeTruthy();
  });

  it('renders a changed field with the flash class', () => {
    const storeChanged = fakeStore({
      snapshot: vi.fn(() => snapshot({ fields: { a: 1 }, initializedFields: ['a'] })),
      changes: vi.fn(() => ({ a: { from: 0, to: 1 } })),
    });
    render(() => <DeviceStatePanel store={storeChanged} sessionId="s1" />);
    const changedRow = screen.getByText('a').closest('div');
    expect(changedRow?.classList.contains(styles.fieldChanged)).toBe(true);
    cleanup();

    const storeUnchanged = fakeStore({
      snapshot: vi.fn(() => snapshot({ fields: { a: 1 }, initializedFields: ['a'] })),
    });
    render(() => <DeviceStatePanel store={storeUnchanged} sessionId="s1" />);
    const plainRow = screen.getByText('a').closest('div');
    expect(plainRow?.classList.contains(styles.fieldChanged)).toBe(false);
  });

  it('renders an empty-string field distinctly from an unset one', () => {
    const store = fakeStore({
      snapshot: vi.fn(() => snapshot({ fields: { note: '' }, initializedFields: ['note'] })),
    });
    render(() => <DeviceStatePanel store={store} sessionId="s1" />);
    expect(screen.getByText('(empty)')).toBeTruthy();
  });

  it('switching the tracker select calls setSelectedTracker', () => {
    const store = fakeStore({ trackers: vi.fn(() => [tracker('t1'), tracker('t2')]) });
    render(() => <DeviceStatePanel store={store} sessionId="s1" />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 't2' } });
    expect(store.setSelectedTracker).toHaveBeenCalledWith('s1', 't2');
  });

  it('shows the transition count and calls prev/next on click', () => {
    const store = fakeStore();
    render(() => <DeviceStatePanel store={store} sessionId="s1" />);
    expect(screen.getByText('1 / 3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '◀' }));
    expect(store.prevTransition).toHaveBeenCalledWith('s1');

    fireEvent.click(screen.getByRole('button', { name: '▶' }));
    expect(store.nextTransition).toHaveBeenCalledWith('s1');
  });

  it('disables transition buttons when there are no transitions', () => {
    const store = fakeStore({ transitionPosition: vi.fn(() => ({ index: 0, total: 0 })) });
    render(() => <DeviceStatePanel store={store} sessionId="s1" />);
    expect((screen.getByRole('button', { name: '◀' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '▶' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the line number and source-section chips', () => {
    const store = fakeStore({
      snapshot: vi.fn(() => snapshot({ lineNum: 1234, sourceSections: ['SurfaceFlinger'] })),
    });
    render(() => <DeviceStatePanel store={store} sessionId="s1" />);
    expect(screen.getByText(/at line 1,234/i)).toBeTruthy();
    expect(screen.getByText('SurfaceFlinger')).toBeTruthy();
  });
});
