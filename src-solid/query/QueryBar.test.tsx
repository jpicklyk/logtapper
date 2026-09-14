/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { SearchSummary } from '@bridge/types';
import { Show, createSignal } from 'solid-js';
import { QueryBar } from './QueryBar';
import { FilterScan } from './filterScan';
import { DEFAULT_QUERY_STATE, toSearchQuery } from './queryStore';
import type { QueryState, QueryStore } from './queryStore';
import { createViewerController } from '../viewer';
import type { ViewerController } from '../viewer';

const bridge = vi.hoisted(() => ({
  searchLogs: vi.fn(),
  createFilter: vi.fn(),
  getFilteredLines: vi.fn(),
  cancelFilter: vi.fn(() => Promise.resolve()),
  closeFilter: vi.fn(() => Promise.resolve()),
  getLines: vi.fn(),
}));

vi.mock('@bridge/commands', () => bridge);
vi.mock('@bridge/events', () => ({
  onFilterProgress: vi.fn(() => Promise.resolve((() => {}) as UnlistenFn)),
  onSearchProgress: vi.fn(() => Promise.resolve((() => {}) as UnlistenFn)),
}));

afterEach(cleanup);

function emptySummary(): SearchSummary {
  return { totalMatches: 0, matchLineNums: [], byLevel: {}, byTag: {} };
}

/** An in-memory `QueryStore` scoped to one session — enough to drive `QueryBar`
 *  without pulling in the session store / cache manager `createQueryStore` needs.
 *  Invalidation semantics are `queryStore.test.ts`'s job, not this component's. */
function createTestStore(initial: Partial<QueryState> = {}): QueryStore {
  let state: QueryState = { ...DEFAULT_QUERY_STATE, ...initial };
  return {
    state: () => state,
    update: (_sid, patch) => { state = { ...state, ...patch }; },
    clear: () => { state = { ...DEFAULT_QUERY_STATE }; },
    searchQueryProvider: () =>
      state.mode === 'search' && state.text.trim() ? toSearchQuery(state) : null,
    dispose: () => {},
  };
}

function mount(overrides: { store?: QueryStore; controller?: ViewerController; active?: boolean } = {}) {
  const store = overrides.store ?? createTestStore();
  const controller = overrides.controller ?? createViewerController({ focusSession: () => {} });
  render(() => (
    <QueryBar sessionId="s1" store={store} controller={controller} active={overrides.active} />
  ));
  return { store, controller };
}

describe('QueryBar', () => {
  it('rebinds to the new session when mounted under a keyed Show (the App.tsx contract)', () => {
    const [sid, setSid] = createSignal('s1');
    const seen: string[] = [];
    const store = createTestStore();
    const spiedStore: QueryStore = { ...store, state: (id) => { seen.push(id); return store.state(id); } };
    const controller = createViewerController({ focusSession: () => {} });
    render(() => (
      <Show when={sid()} keyed>
        {(id) => <QueryBar sessionId={id} store={spiedStore} controller={controller} />}
      </Show>
    ));
    expect(document.querySelector('[data-session-id]')?.getAttribute('data-session-id')).toBe('s1');

    setSid('s2');

    expect(document.querySelector('[data-session-id]')?.getAttribute('data-session-id')).toBe('s2');
    expect(seen).toContain('s2');
  });

  beforeEach(() => {
    bridge.searchLogs.mockReset().mockResolvedValue(emptySummary());
    bridge.createFilter.mockReset();
    bridge.getFilteredLines.mockReset();
    bridge.getLines.mockReset();
  });

  it('starts in search mode with the search input visible', () => {
    mount();
    expect(screen.getByPlaceholderText(/Search logs/)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/package:com.example/)).toBeNull();
  });

  it('mode switch swaps semantics: filter mode never calls searchLogs while typing', async () => {
    mount();
    fireEvent.click(screen.getByText('Filter'));

    expect(screen.getByPlaceholderText(/package:com.example/)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Search logs/)).toBeNull();

    fireEvent.input(screen.getByPlaceholderText(/package:com.example/), {
      target: { value: 'level:E' },
    });
    await Promise.resolve();
    expect(bridge.searchLogs).not.toHaveBeenCalled();
  });

  it('debounces search text and calls searchLogs once settled', async () => {
    vi.useFakeTimers();
    try {
      mount();
      const input = screen.getByPlaceholderText(/Search logs/);
      fireEvent.input(input, { target: { value: 'c' } });
      fireEvent.input(input, { target: { value: 'cr' } });
      fireEvent.input(input, { target: { value: 'crash' } });

      await vi.advanceTimersByTimeAsync(300);
      expect(bridge.searchLogs).toHaveBeenCalledTimes(1);
      expect(bridge.searchLogs).toHaveBeenCalledWith('s1', expect.objectContaining({ text: 'crash' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('filter-mode chip buttons insert their token into the expression input', () => {
    mount();
    fireEvent.click(screen.getByText('Filter'));
    const input = screen.getByPlaceholderText(/package:com.example/) as HTMLInputElement;

    fireEvent.click(screen.getByTitle('Filter by logcat tag (substring)'));
    expect(input.value).toBe('tag:');

    fireEvent.click(screen.getByTitle('Filter by level: V D I W E F'));
    expect(input.value).toBe('tag: level:E');
  });

  it('shows a parse error inline when the filter expression is malformed', async () => {
    mount();
    fireEvent.click(screen.getByText('Filter'));
    const input = screen.getByPlaceholderText(/package:com.example/);

    fireEvent.input(input, { target: { value: '(unclosed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText(/Missing closing/)).toBeTruthy();
    expect(bridge.createFilter).not.toHaveBeenCalled();
  });

  it('Ctrl+F focuses the search input only when the pane is active', () => {
    mount({ active: false });
    const input = screen.getByPlaceholderText(/Search logs/) as HTMLInputElement;
    input.blur();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(document.activeElement).not.toBe(input);
  });

  it('Ctrl+F focuses the search input when the pane is active', () => {
    mount({ active: true });
    const input = screen.getByPlaceholderText(/Search logs/) as HTMLInputElement;
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(input);
  });

  it('Enter/Shift+Enter navigate matches while the search input is focused', async () => {
    vi.useFakeTimers();
    try {
      bridge.searchLogs.mockResolvedValue({
        totalMatches: 2, matchLineNums: [10, 20], byLevel: {}, byTag: {},
      } satisfies SearchSummary);
      const controller = createViewerController({ focusSession: () => {} });
      const scrollSpy = vi.spyOn(controller, 'scrollToLine');
      mount({ controller, store: createTestStore({ mode: 'search' }) });

      const input = screen.getByPlaceholderText(/Search logs/);
      fireEvent.input(input, { target: { value: 'crash' } });
      await vi.advanceTimersByTimeAsync(300);
      scrollSpy.mockClear(); // drop the auto-jump-to-first-match call

      fireEvent.keyDown(input, { key: 'Enter' });
      expect(scrollSpy).toHaveBeenLastCalledWith('s1', 20, { highlight: true, select: expect.any(Array), source: 'search' });

      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      expect(scrollSpy).toHaveBeenLastCalledWith('s1', 10, { highlight: true, select: expect.any(Array), source: 'search' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('Esc clears the search text and focuses the viewer', () => {
    const controller = createViewerController({ focusSession: () => {} });
    const focusSpy = vi.spyOn(controller, 'focus');
    mount({ controller });

    const input = screen.getByPlaceholderText(/Search logs/) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'crash' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('');
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('bindLiveFilter (L4) is called once at mount with this session\'s own FilterScan, and unbound on unmount', () => {
    const controller = createViewerController({ focusSession: () => {} });
    const store = createTestStore();
    const unbind = vi.fn();
    const bindLiveFilter = vi.fn((_sessionId: string, _scan: FilterScan) => unbind);

    const { unmount } = render(() => (
      <QueryBar sessionId="s1" store={store} controller={controller} bindLiveFilter={bindLiveFilter} />
    ));

    expect(bindLiveFilter).toHaveBeenCalledTimes(1);
    const [sid, scan] = bindLiveFilter.mock.calls[0];
    expect(sid).toBe('s1');
    expect(scan).toBeInstanceOf(FilterScan);
    expect(unbind).not.toHaveBeenCalled();

    unmount();
    expect(unbind).toHaveBeenCalledTimes(1);
  });
});
