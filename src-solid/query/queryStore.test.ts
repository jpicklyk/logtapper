import { describe, expect, it, vi } from 'vitest';
import type { FilterCriteria, SearchQuery } from '@bridge/types';
import { DEFAULT_QUERY_STATE, createQueryStore, toCriteria, toSearchQuery } from './queryStore';
import type { QueryState } from './queryStore';
import type { SessionStore, SessionEntry } from '../app/index';
import type { CacheManager, ViewerController } from '../viewer';

// The generated shapes' own field lists — kept independent of `toSearchQuery`/
// `toCriteria`'s implementation so a field silently dropped (or added) fails.
const SEARCH_QUERY_FIELDS: (keyof SearchQuery)[] = [
  'text', 'isRegex', 'caseSensitive', 'withinProcessor', 'minLevel', 'tags', 'startTime', 'endTime',
];
const FILTER_CRITERIA_FIELDS: (keyof FilterCriteria)[] = [
  'textSearch', 'regex', 'logLevels', 'tags', 'timeStart', 'timeEnd', 'pids', 'combine',
];

function state(over: Partial<QueryState> = {}): QueryState {
  return { ...DEFAULT_QUERY_STATE, ...over };
}

function fakeEntry(kind: SessionEntry['kind'] = 'file'): SessionEntry {
  return {
    load: {} as SessionEntry['load'],
    totalLines: 0,
    isIndexing: false,
    kind,
    dataSource: { invalidate: vi.fn() } as unknown as SessionEntry['dataSource'],
  };
}

function fakeSessions(entries: Record<string, SessionEntry>) {
  return {
    byId: vi.fn((id: string) => entries[id]),
    setSearchQueryProvider: vi.fn(),
  } as unknown as SessionStore;
}

function fakeCacheManager() {
  return { clearSession: vi.fn() } as unknown as CacheManager;
}

function fakeController() {
  return { setHighlights: vi.fn() } as unknown as ViewerController;
}

describe('toSearchQuery / toCriteria — exact field sets', () => {
  it('emits every SearchQuery field, none extra', () => {
    const q = toSearchQuery(state({ text: 'boot', tags: ['Alpha'] }), 'proc-1');
    expect(Object.keys(q).sort()).toEqual([...SEARCH_QUERY_FIELDS].sort());
  });

  it('defaults withinProcessor to null', () => {
    expect(toSearchQuery(state({ text: 'x' })).withinProcessor).toBeNull();
  });

  it('emits every FilterCriteria field, none extra', () => {
    const c = toCriteria(state({ text: 'boot', minLevel: 'Error', tags: ['Alpha'] }));
    expect(Object.keys(c).sort()).toEqual([...FILTER_CRITERIA_FIELDS].sort());
  });

  it('toCriteria never populates regex/ns-time fields the mini-language extractor owns', () => {
    const c = toCriteria(state({ text: 'x', isRegex: true }));
    expect(c.timeStart).toBeNull();
    expect(c.timeEnd).toBeNull();
    expect(c.pids).toBeNull();
  });
});

describe('createQueryStore', () => {
  it('wires its provider into the session store', () => {
    const sessions = fakeSessions({ s1: fakeEntry() });
    createQueryStore({ cacheManager: fakeCacheManager(), controller: fakeController(), sessions });
    expect(sessions.setSearchQueryProvider).toHaveBeenCalledTimes(1);
    const provider = (sessions.setSearchQueryProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(provider('s1')).toBeNull();
  });

  it('state() starts at defaults and update() merges a patch', () => {
    const sessions = fakeSessions({ s1: fakeEntry() });
    const store = createQueryStore({ cacheManager: fakeCacheManager(), controller: fakeController(), sessions });
    expect(store.state('s1')).toEqual(DEFAULT_QUERY_STATE);
    store.update('s1', { text: 'crash', mode: 'search' });
    expect(store.state('s1')).toMatchObject({ text: 'crash', mode: 'search' });
  });

  it('searchQueryProvider returns null outside search mode or with empty text', () => {
    const sessions = fakeSessions({ s1: fakeEntry() });
    const store = createQueryStore({ cacheManager: fakeCacheManager(), controller: fakeController(), sessions });
    store.update('s1', { mode: 'filter', text: 'crash' });
    expect(store.searchQueryProvider('s1')).toBeNull();
    store.update('s1', { mode: 'search', text: '   ' });
    expect(store.searchQueryProvider('s1')).toBeNull();
    store.update('s1', { text: 'crash' });
    expect(store.searchQueryProvider('s1')).toMatchObject({ text: 'crash' });
  });

  it('invalidates the cache and bumps the controller revision on a real query-identity change', () => {
    const entry = fakeEntry();
    const sessions = fakeSessions({ s1: entry });
    const cacheManager = fakeCacheManager();
    const controller = fakeController();
    const store = createQueryStore({ cacheManager, controller, sessions });

    store.update('s1', { text: 'crash' });

    expect(cacheManager.clearSession).toHaveBeenCalledWith('s1');
    expect(entry.dataSource.invalidate).toHaveBeenCalledTimes(1);
    expect(controller.setHighlights).toHaveBeenCalledWith('s1', null);
  });

  it('does not invalidate when the published search query is unchanged', () => {
    const entry = fakeEntry();
    const sessions = fakeSessions({ s1: entry });
    const cacheManager = fakeCacheManager();
    const controller = fakeController();
    const store = createQueryStore({ cacheManager, controller, sessions });

    // mode/matchesOnly changes don't move `toSearchQuery`'s output while text
    // is empty — the provider stays `null` before and after.
    store.update('s1', { mode: 'filter' });
    store.update('s1', { matchesOnly: true });
    store.update('s1', { expr: 'level:E' });

    expect(cacheManager.clearSession).not.toHaveBeenCalled();
    expect(entry.dataSource.invalidate).not.toHaveBeenCalled();
    expect(controller.setHighlights).not.toHaveBeenCalled();
  });

  it('re-invalidates on every subsequent identity change, not just the first', () => {
    const entry = fakeEntry();
    const sessions = fakeSessions({ s1: entry });
    const cacheManager = fakeCacheManager();
    const controller = fakeController();
    const store = createQueryStore({ cacheManager, controller, sessions });

    store.update('s1', { text: 'a' });
    store.update('s1', { text: 'a' }); // identical — no-op
    store.update('s1', { text: 'b' });

    expect(cacheManager.clearSession).toHaveBeenCalledTimes(2);
  });

  it('skips invalidation while the session is streaming', () => {
    const entry = fakeEntry('live');
    const sessions = fakeSessions({ s1: entry });
    const cacheManager = fakeCacheManager();
    const controller = fakeController();
    const store = createQueryStore({ cacheManager, controller, sessions });

    store.update('s1', { text: 'crash' });

    expect(cacheManager.clearSession).not.toHaveBeenCalled();
    expect(entry.dataSource.invalidate).not.toHaveBeenCalled();
    expect(controller.setHighlights).not.toHaveBeenCalled();
    // The state itself still updates — only the cache-clear side effect is gated.
    expect(store.state('s1').text).toBe('crash');
  });

  it('clear() resets to defaults and invalidates like a query-identity change', () => {
    const entry = fakeEntry();
    const sessions = fakeSessions({ s1: entry });
    const cacheManager = fakeCacheManager();
    const controller = fakeController();
    const store = createQueryStore({ cacheManager, controller, sessions });

    store.update('s1', { text: 'crash' });
    store.clear('s1');

    expect(store.state('s1')).toEqual(DEFAULT_QUERY_STATE);
    // Once for the update, once for the clear — both are real identity changes.
    expect(entry.dataSource.invalidate).toHaveBeenCalledTimes(2);
    expect(cacheManager.clearSession).toHaveBeenCalledTimes(2);
  });

  it('keeps sessions independent', () => {
    const sessions = fakeSessions({ s1: fakeEntry(), s2: fakeEntry() });
    const store = createQueryStore({ cacheManager: fakeCacheManager(), controller: fakeController(), sessions });
    store.update('s1', { text: 'a' });
    expect(store.state('s2')).toEqual(DEFAULT_QUERY_STATE);
  });
});
