/**
 * Per-session query state: what the one query bar (`QueryBar.tsx`) shows and
 * what `search.ts` / `FilterScan` (W2a) run against.
 *
 * The store holds exactly the fields the bar edits — it does not run a search
 * or a filter scan itself. Those engines are owned by `QueryBar` (one live
 * instance per focused session, since the bar unmounts with its session — see
 * `App.tsx`'s `<Show when={store.focused()}>`), and read state back out via
 * `state(sessionId)`.
 *
 * Two backend shapes are derived here, both emitting every wire field so a
 * caller never has to remember which are optional:
 *  - `toSearchQuery` — the free-text search half, sent to `search_logs` and
 *    (via {@link QueryStore.searchQueryProvider}) to every `get_lines` call so
 *    the viewer renders highlight spans on the visible lines.
 *  - `toCriteria` — the `FilterCriteria` shape the same level/tag chips would
 *    produce directly. Filter *mode* itself never calls this: the mini-language
 *    expression goes straight to `FilterScan.setExpression`, which extracts its
 *    own (superset) criteria via W2a's `buildBackendFilter`. `toCriteria` is
 *    exposed for shape parity with `toSearchQuery` and is unit-tested for it;
 *    nothing in this package currently sends it to `createFilter`.
 */
import { createSignal, createRoot, getOwner, runWithOwner } from 'solid-js';
import type { Accessor, Owner } from 'solid-js';
import type { FilterCriteria, LogLevel, SearchQuery } from '@bridge/types';
import { EMPTY_CRITERIA } from './backendFilter';
import type { CacheManager, ViewerController } from '../viewer';
import type { SessionStore, SearchQueryProvider } from '../app/index';

export type QueryMode = 'search' | 'filter';

export interface QueryState {
  /** Search mode: the free-text query. Filter mode: unused (see `expr`). */
  text: string;
  isRegex: boolean;
  caseSensitive: boolean;
  minLevel: LogLevel | null;
  tags: string[] | null;
  /** "HH:MM" or "HH:MM:SS", local time-of-day bounds. Search mode only. */
  startTime: string | null;
  endTime: string | null;
  mode: QueryMode;
  /** Filter mode's mini-language expression, committed on Enter. */
  expr: string;
  /** When on, the matched/hit set also narrows what the viewer renders. */
  matchesOnly: boolean;
}

export const DEFAULT_QUERY_STATE: QueryState = Object.freeze({
  text: '',
  isRegex: false,
  caseSensitive: false,
  minLevel: null,
  tags: null,
  startTime: null,
  endTime: null,
  mode: 'search',
  expr: '',
  matchesOnly: false,
});

/** Every `SearchQuery` field, always present. `withinProcessor` defaults to `null`. */
export function toSearchQuery(state: QueryState, withinProcessor: string | null = null): SearchQuery {
  return {
    text: state.text,
    isRegex: state.isRegex,
    caseSensitive: state.caseSensitive,
    withinProcessor,
    minLevel: state.minLevel,
    tags: state.tags,
    startTime: state.startTime,
    endTime: state.endTime,
  };
}

/** Every `FilterCriteria` field, always present. See the module doc for why this
 *  is not what filter mode actually scans with. */
export function toCriteria(state: QueryState): FilterCriteria {
  const text = state.text.trim() || null;
  return {
    ...EMPTY_CRITERIA,
    textSearch: state.isRegex ? null : text,
    regex: state.isRegex ? text : null,
    logLevels: state.minLevel ? [state.minLevel] : null,
    tags: state.tags,
  };
}

function sameStrArray(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Field-by-field equality — the two objects are always freshly built. */
function sameSearchQuery(a: SearchQuery | null, b: SearchQuery | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.text === b.text &&
    a.isRegex === b.isRegex &&
    a.caseSensitive === b.caseSensitive &&
    a.withinProcessor === b.withinProcessor &&
    a.minLevel === b.minLevel &&
    sameStrArray(a.tags, b.tags) &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime
  );
}

export interface QueryStoreDeps {
  cacheManager: CacheManager;
  controller: ViewerController;
  sessions: SessionStore;
}

export interface QueryStore {
  state(sessionId: string): QueryState;
  update(sessionId: string, patch: Partial<QueryState>): void;
  clear(sessionId: string): void;
  /** The `SearchQuery` this session's `get_lines` calls should carry, or `null`
   *  outside search mode / with empty text. Wired into `sessions.setSearchQueryProvider`. */
  searchQueryProvider: SearchQueryProvider;
  dispose(): void;
}

export function createQueryStore(deps: QueryStoreDeps): QueryStore {
  const { cacheManager, controller, sessions } = deps;

  return createRoot((disposeRoot) => {
    const owner = getOwner() as Owner;
    const signals = new Map<string, [Accessor<QueryState>, (v: QueryState) => void]>();

    const entryFor = (sessionId: string): [Accessor<QueryState>, (v: QueryState) => void] => {
      let entry = signals.get(sessionId);
      if (!entry) {
        entry = runWithOwner(owner, () => createSignal<QueryState>({ ...DEFAULT_QUERY_STATE })) as [
          Accessor<QueryState>,
          (v: QueryState) => void,
        ];
        signals.set(sessionId, entry);
      }
      return entry;
    };

    const state = (sessionId: string): QueryState => entryFor(sessionId)[0]();

    // A plain function, not an `Accessor`: `sessions.ts` calls it from inside a
    // `getLines` promise callback, outside any tracking scope — reactivity there
    // would be a lie (the W0b precedent this mirrors exactly).
    const searchQueryProvider: SearchQueryProvider = (sessionId) => {
      const s = state(sessionId);
      if (s.mode !== 'search' || !s.text.trim()) return null;
      return toSearchQuery(s);
    };
    sessions.setSearchQueryProvider(searchQueryProvider);

    /**
     * Clear the render cache and bump the controller's revision when the
     * *published* search query actually changed identity — mirrors React's
     * `useSearchCacheInvalidation`'s two guards: skip while streaming (search
     * highlights never apply to streamed batches), skip when nothing that
     * feeds `toSearchQuery` moved (a mode/expr/matchesOnly-only change).
     *
     * `setHighlights(sessionId, null)` is the "documented setter that bumps
     * revision" the task calls for, reused rather than adding controller API.
     * Nothing writes controller highlights yet (W6/W7 land later) so this is
     * inert beyond the bump today — worth a look if a future surface's
     * highlights and a live search coexist on the same session.
     */
    const maybeInvalidate = (sessionId: string, before: SearchQuery | null): void => {
      const after = searchQueryProvider(sessionId);
      if (sameSearchQuery(before, after)) return;
      const entry = sessions.byId(sessionId);
      if (!entry || entry.kind === 'live') return;
      cacheManager.clearSession(sessionId);
      entry.dataSource.invalidate();
      controller.setHighlights(sessionId, null);
    };

    const update = (sessionId: string, patch: Partial<QueryState>): void => {
      const [get, set] = entryFor(sessionId);
      const before = searchQueryProvider(sessionId);
      set({ ...get(), ...patch });
      maybeInvalidate(sessionId, before);
    };

    const clear = (sessionId: string): void => {
      const [, set] = entryFor(sessionId);
      const before = searchQueryProvider(sessionId);
      set({ ...DEFAULT_QUERY_STATE });
      maybeInvalidate(sessionId, before);
    };

    return {
      state,
      update,
      clear,
      searchQueryProvider,
      dispose: () => {
        signals.clear();
        disposeRoot();
      },
    };
  });
}
