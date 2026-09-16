/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { SearchSummary } from '@bridge/types';
import { Show, createSignal } from 'solid-js';
import { QueryBar } from './QueryBar';
import { FilterScan } from './filterScan';
import { createLiveFilterBindings } from './liveFilterBindings';
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

/** A `QueryStore` double that keeps a distinct `QueryState` per session — the
 *  single-state `createTestStore` above cannot express two bars at once. */
function createPerSessionStore(initial: Record<string, Partial<QueryState>>): QueryStore {
  const states = new Map<string, QueryState>();
  const stateFor = (sid: string): QueryState => {
    let state = states.get(sid);
    if (!state) {
      state = { ...DEFAULT_QUERY_STATE, ...(initial[sid] ?? {}) };
      states.set(sid, state);
    }
    return state;
  };
  return {
    state: stateFor,
    update: (sid, patch) => { states.set(sid, { ...stateFor(sid), ...patch }); },
    clear: (sid) => { states.delete(sid); },
    searchQueryProvider: (sid) => {
      const state = stateFor(sid);
      return state.mode === 'search' && state.text.trim() ? toSearchQuery(state) : null;
    },
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

  // H4: the binding used to be a single last-write-wins signal, so the second
  // pane's bar re-pointed it at a session that was not streaming and the
  // running capture's filtered view silently stopped growing. Driven through
  // the real registry, so this covers the QueryBar half and the resolution
  // half together.
  it('two panes bind under their own session ids; the capture keeps matching (H4)', () => {
    const controller = createViewerController({ focusSession: () => {} });
    const store = createPerSessionStore({});
    // s1 is the live capture; s2 is a file opened in the split.
    const bindings = createLiveFilterBindings(() => 's1');

    const live = render(() => (
      <QueryBar sessionId="s1" store={store} controller={controller} bindLiveFilter={bindings.bind} />
    ));
    const split = render(() => (
      <QueryBar sessionId="s2" store={store} controller={controller} bindLiveFilter={bindings.bind} />
    ));

    expect(bindings.boundSessions().sort()).toEqual(['s1', 's2']);
    // Opening the split did not steal the capture's binding.
    expect(bindings.hooks.filterSessionId()).toBe('s1');

    // Closing the split leaves the capture bound, rather than clearing it.
    split.unmount();
    expect(bindings.boundSessions()).toEqual(['s1']);
    expect(bindings.hooks.filterSessionId()).toBe('s1');

    live.unmount();
    expect(bindings.boundSessions()).toEqual([]);
    expect(bindings.hooks.filterSessionId()).toBeNull();
  });

  // ── M2: a remount must restore the ENGINES, not just the inputs ───────────

  it('replays a persisted filter expression into the scan at mount', async () => {
    bridge.createFilter.mockResolvedValue({ filterId: 'f1', sessionId: 's1', totalLines: 100 });
    const store = createPerSessionStore({ s1: { mode: 'filter', expr: 'level:E' } });
    mount({ store });

    // The input shows the expression *and* the scan is actually running for it
    // — before, the bar displayed an active expression over an unfiltered
    // viewer until the user pressed Enter again.
    expect((screen.getByPlaceholderText(/package:com.example/) as HTMLInputElement).value).toBe('level:E');
    await vi.waitFor(() => expect(bridge.createFilter).toHaveBeenCalledTimes(1));
    expect(bridge.createFilter).toHaveBeenCalledWith('s1', expect.objectContaining({ logLevels: ['Error'] }));
  });

  it('does not start a scan at mount when no expression was persisted', async () => {
    mount();
    await Promise.resolve();
    expect(bridge.createFilter).not.toHaveBeenCalled();
  });

  it('replays persisted matchesOnly into the runner, so narrowing is on from the first hit', async () => {
    vi.useFakeTimers();
    try {
      bridge.searchLogs.mockResolvedValue({
        totalMatches: 2, matchLineNums: [10, 20], byLevel: {}, byTag: {},
      } satisfies SearchSummary);
      const controller = createViewerController({ focusSession: () => {} });
      const lineSetSpy = vi.spyOn(controller, 'setLineSet');
      const store = createPerSessionStore({ s1: { mode: 'search', matchesOnly: true } });
      mount({ store, controller });

      fireEvent.input(screen.getByPlaceholderText(/Search logs/), { target: { value: 'crash' } });
      await vi.advanceTimersByTimeAsync(300);

      // The button looked active at mount; before M2 the runner's own flag was
      // still false, so the hits were never published and the first click on
      // an already-lit button turned narrowing OFF.
      expect(lineSetSpy).toHaveBeenCalledWith('s1', 'search', new Set([10, 20]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases both line-set keys it owns when the bar unmounts', () => {
    const controller = createViewerController({ focusSession: () => {} });
    const lineSetSpy = vi.spyOn(controller, 'setLineSet');
    const { unmount } = render(() => (
      <QueryBar sessionId="s1" store={createPerSessionStore({})} controller={controller} />
    ));

    lineSetSpy.mockClear();
    unmount();

    // Disposing the engines clears their own state only; the controller keeps
    // whatever was last published for a session whose bar is gone (M2).
    expect(lineSetSpy).toHaveBeenCalledWith('s1', 'search', null);
    expect(lineSetSpy).toHaveBeenCalledWith('s1', 'filter', null);
  });

  // M7: search-mode failures had no surface at all — the bar read "Searching…"
  // forever, while filter mode showed the equivalent rejection inline.
  it('surfaces a rejected search inline instead of showing "Searching…" forever', async () => {
    vi.useFakeTimers();
    try {
      bridge.searchLogs.mockRejectedValue(new Error('regex parse error: unclosed ['));
      mount({ store: createTestStore({ mode: 'search' }) });

      fireEvent.input(screen.getByPlaceholderText(/Search logs/), { target: { value: '[' } });
      await vi.advanceTimersByTimeAsync(300);

      expect(screen.getByText(/regex parse error/)).toBeTruthy();
      expect(screen.getByText('Search failed')).toBeTruthy();
      expect(screen.queryByText('Searching…')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
