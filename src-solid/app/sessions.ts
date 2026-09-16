/**
 * The one session store per app: every open backend session, its data source,
 * its indexing progress, and which one the viewer is looking at.
 *
 * Before W0b `App.tsx` held a single `dataSource`/`sessionId` pair and rebuilt
 * it on every open. The store replaces that with a keyed record, so a second
 * open (a multi-session `.lts`, or an agent's `POST /mcp/open_file`) adds a tab
 * instead of replacing the view.
 *
 * Lifetime: the store owns a `createRoot` (same pattern as
 * `presence/presenceStore.ts` and `viewer/controller.ts`), so it can be built
 * outside a component body. `dispose()` unlistens every Tauri subscription —
 * including ones whose `listen()` promise settles after disposal — disposes
 * every data source, releases every view cache, and tears the root down.
 *
 * What the store deliberately does NOT own: the *query* (W2 injects it via
 * {@link SessionStore.setSearchQueryProvider}) and the *view mode / line sets*
 * (W0a's `ViewerController` owns those; the data source reads them through the
 * controller on every fetch, so a mode or filter change never rebuilds it).
 */
import { batch, createEffect, createMemo, createRoot, createSignal, on, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getLines, getSessionMetadata, setFocusedSession } from '@bridge/commands';
import {
  onBridgeSessionClosed,
  onBridgeSessionOpened,
  onFileIndexComplete,
  onFileIndexProgress,
} from '@bridge/events';
import type { LoadResult, SearchQuery } from '@bridge/types';
import { createCacheDataSource } from '../viewer';
import type { CacheDataSource, CacheManager, DataSourceRegistry, ViewerController } from '../viewer';

/** A file-backed session or a live ADB stream. Drives the shell's `data-mode`. */
export type SessionEntryKind = 'file' | 'live';

/** One open session. `load` is the backend's answer verbatim; the rest is live state. */
export interface SessionEntry {
  load: LoadResult;
  /** Authoritative line count: starts at `load.totalLines`, grows while indexing. */
  totalLines: number;
  isIndexing: boolean;
  kind: SessionEntryKind;
  dataSource: CacheDataSource;
}

/** Returns the query to send with every `get_lines` for a session, or `null`. */
export type SearchQueryProvider = (sessionId: string) => SearchQuery | null;

export interface SessionStoreDeps {
  cacheManager: CacheManager;
  registry: DataSourceRegistry;
  controller: ViewerController;
}

export interface SessionStore {
  /** Session ids in the order they were added. */
  order: Accessor<readonly string[]>;
  /** The session the viewer is showing, or `null` when none is open. */
  focusedId: Accessor<string | null>;
  byId(sessionId: string): SessionEntry | undefined;
  focused: Accessor<SessionEntry | undefined>;

  /**
   * Register an already-loaded session. Idempotent by `sessionId` — a repeat
   * (the `session-opened` echo of our own open, or an agent reopening the same
   * deterministic id) returns the existing entry and builds nothing.
   * The first session added also becomes the focused one.
   */
  add(load: LoadResult): SessionEntry;

  /**
   * Reopen an already-open session with a fresh parse — the "reopen as…"
   * control's entry point. The backend's session id is deterministic per
   * path, so this targets the SAME id {@link SessionStore.add} would just
   * dedupe against; `add` is idempotent by design (a bridge open echo must
   * build nothing), so a real reparse needs an explicit call that actually
   * does the work: dispose the stale data source, clear this session's
   * cached lines (`cacheManager.clearSession` — clears content but keeps the
   * view's budget allocation, unlike closing), reset the controller's line
   * sets/highlights exactly like the open edge does ({@link resetSessionView}
   * — the same sweep `remove` does on close), unconditionally bump the
   * controller's revision for this session (unlike the open edge, this is
   * swapping content the user is already looking at — the bump is what
   * makes `viewer/cacheBinding.ts`'s revision-keyed effect discard its fetch
   * generation, bump its cache version and force an immediate refetch; a new
   * `dataSource` object alone re-registers `FetchScheduler`'s `onFetch`
   * callback but does not itself trigger a fetch), and rebuild the entry
   * (`totalLines`/`isIndexing`/`kind`/`dataSource`) from the fresh
   * `LoadResult`.
   *
   * Falls back to {@link SessionStore.add} if the id is not actually open —
   * the control this backs only exists for an already-open focused session,
   * but a caller racing a close should not silently lose the reopen.
   */
  replace(load: LoadResult): SessionEntry;

  /** Drop a session: dispose its source, release its view cache, refocus a neighbour. */
  remove(sessionId: string): void;
  setFocused(sessionId: string | null): void;
  updateTotal(sessionId: string, totalLines: number, isIndexing?: boolean): void;

  /**
   * Flip a session's `kind` between `'live'` and `'file'` — called by
   * `stream/streamStore.ts` when its ADB stream starts (already implied by
   * `add()`, since a fresh stream's `LoadResult.isStreaming` is `true`) and,
   * more importantly, when it stops. A stopped stream's session stays open
   * (the backend keeps its retained lines as a static log — see
   * `stop_adb_stream`'s doc comment), but it is no longer *live*: `kind`
   * drives both the shell's `data-mode` (`shell/mode.ts`) and
   * `LogViewer`'s `tailMode` (`App.tsx`), so leaving it at `'live'` after a
   * stop would strand the session in tail-follow with no more lines ever
   * coming, and would keep live-only surfaces (watches, stream-controls)
   * showing for a capture that is now exactly like any other opened file.
   * No-op for a session id that isn't open.
   */
  setStreamingKind(sessionId: string, streaming: boolean): void;

  /**
   * Mark a close as ours, so the backend's `session-closed` echo is not
   * mistaken for a foreign (agent-initiated) close and does not remove the
   * entry twice. Cleared when that echo arrives.
   */
  markPendingClose(sessionId: string): void;

  /**
   * Release a claim made by {@link markPendingClose} when the close command
   * failed and no echo will ever arrive — otherwise a later, genuinely foreign
   * `session-closed` for a reused id would be swallowed.
   */
  releasePendingClose(sessionId: string): void;

  /**
   * W2 plugs the query bar in here. Kept as an injected accessor rather than a
   * constructor dependency so the query package can land without touching this
   * file: the store is built before any query state exists.
   */
  setSearchQueryProvider(provider: SearchQueryProvider): void;

  dispose(): void;
}

/** One view-cache handle per session; the id is the cache manager's key. */
export function viewIdFor(sessionId: string): string {
  return `solid-session:${sessionId}`;
}

/** The line-set keys {@link resetSessionView} clears. `matched` is W4a's
 *  analyzer "show matched lines" set; the other three are section scope,
 *  the filter result and the search result. */
const VIEW_LINE_SET_KEYS = ['section', 'filter', 'search', 'matched'] as const;

/**
 * Forget a session's rendered index space and highlight overrides.
 *
 * Backend session ids are deterministic per path, so closing a file and
 * reopening it lands on the *same* id — and would otherwise inherit whatever
 * filter, section scope, search set or highlight map the previous open left on
 * the controller, including `buildSource`'s `…:filtered` sourceId.
 *
 * Lives here, and is called from {@link SessionStore.add}, because the open
 * edge has two entrances: `app/actions.ts`'s `openPath` and the bridge's
 * `session-opened` event (an agent's `POST /mcp/open_file`). Only the first
 * used to reset, so an agent open → filter → agent close → agent reopen came
 * back already filtered to the previous open's match set (review A-M2).
 * `actions.ts` still calls it on the close edge.
 *
 * Writes only what is actually set. `setLineSet`/`setHighlights` each `bump()`
 * the session's revision, and a bump is what throws away the viewport cache
 * the viewer has warmed (the defect D2-H1 fixed in `sectionsStore`) — so
 * clearing four already-null line sets on every open would reintroduce that
 * cost for no reason. Reads are untracked: a caller inside a reactive scope
 * must not end up subscribed to the session's line sets.
 */
export function resetSessionView(controller: ViewerController, sessionId: string): void {
  untrack(() => {
    // `lineNumbers` is `undefined` exactly when every line set is null.
    if (controller.lineNumbers(sessionId) !== undefined) {
      for (const key of VIEW_LINE_SET_KEYS) controller.setLineSet(sessionId, key, null);
    }
    if (controller.highlights(sessionId) !== null) controller.setHighlights(sessionId, null);
  });
}

function kindOf(load: LoadResult): SessionEntryKind {
  return load.isStreaming ? 'live' : 'file';
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const { cacheManager, registry, controller } = deps;

  return createRoot((disposeRoot) => {
    const [entries, setEntries] = createStore<Record<string, SessionEntry>>({});
    const [order, setOrder] = createSignal<readonly string[]>([]);
    const [focusedId, setFocusedId] = createSignal<string | null>(null);

    /** Ids this app is closing itself — see {@link SessionStore.markPendingClose}. */
    const pendingClose = new Set<string>();

    let searchQuery: SearchQueryProvider = () => null;
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    /** Unlisten-safe subscribe: a promise that settles after `dispose()` unlistens itself. */
    const track = (pending: Promise<UnlistenFn>): void => {
      void pending
        .then((fn) => {
          if (disposed) fn();
          else unlisteners.push(fn);
        })
        .catch(() => undefined);
    };

    const byId = (sessionId: string): SessionEntry | undefined => entries[sessionId];
    const focused = createMemo(() => {
      const id = focusedId();
      return id === null ? undefined : entries[id];
    });

    const buildSource = (load: LoadResult): CacheDataSource => {
      const id = load.sessionId;
      const source = createCacheDataSource({
        sessionId: id,
        viewCache: cacheManager.allocateView(viewIdFor(id), id),
        // Read through the controller and the query provider on every fetch:
        // changing either must not rebuild the source (the cache binding
        // resets on `revision` / `sourceId` instead).
        fetchLines: (offset, count) =>
          getLines({
            sessionId: id,
            mode: controller.viewMode(id),
            offset,
            count,
            context: 0,
            processorId: null,
            search: searchQuery(id),
          }),
        getLineNumbers: () => controller.lineNumbers(id),
        registry,
      });
      source.updateTotalLines(load.totalLines);
      return source;
    };

    const add = (load: LoadResult): SessionEntry => {
      const existing = entries[load.sessionId];
      if (existing) return existing;

      // Open edge, for BOTH entrances (UI and bridge) — see `resetSessionView`.
      // Before `buildSource`, so the first fetch cannot capture a stale
      // `sourceId` from the previous open of this same deterministic id.
      resetSessionView(controller, load.sessionId);

      const entry: SessionEntry = {
        load,
        totalLines: load.totalLines,
        isIndexing: load.isIndexing,
        kind: kindOf(load),
        dataSource: buildSource(load),
      };

      batch(() => {
        setEntries(load.sessionId, entry);
        setOrder((previous) => [...previous, load.sessionId]);
        if (focusedId() === null) setFocusedId(load.sessionId);
      });
      // Always hand back the store's own (proxied) entry, never the literal
      // above — so `add(x) === byId(x.sessionId)` holds on both the fresh and
      // the deduped path, and a caller that keeps the value stays reactive.
      return entries[load.sessionId];
    };

    const replace = (load: LoadResult): SessionEntry => {
      const sessionId = load.sessionId;
      const existing = entries[sessionId];
      if (!existing) return add(load);

      existing.dataSource.dispose();
      // Content only — `releaseView` would also drop the view's budget
      // allocation, and `remove`/`add` already isn't called here.
      cacheManager.clearSession(sessionId);
      // Same sweep the open edge runs in `add` (and `remove` on close): a
      // stale filter/section/search set or highlight map from the previous
      // parse of this id must not survive into the reparsed one.
      resetSessionView(controller, sessionId);
      // `resetSessionView` only bumps the controller's revision when it
      // actually clears a line set or highlight map — correct for `add`
      // (nothing was ever rendered from this id yet, so there is nothing on
      // screen to invalidate), but WRONG here: a plain, unfiltered session
      // (the common case — a logcat with no section/search/highlight state
      // ever set) reopened as a different type would then leave
      // `viewer/cacheBinding.ts`'s revision-keyed reset effect never firing,
      // and `FetchScheduler.onFetch` only re-registers its callback — it does
      // not itself trigger a fetch (that needs `reportScroll` or
      // `forceFetch`). The result would be a viewer still showing the STALE
      // pre-reopen lines until the user happened to scroll. `replace`, unlike
      // `add`, is always swapping content the user is already looking at, so
      // it must force that reset unconditionally. `setViewMode` is the
      // controller's only other revision-bumping setter and bumps
      // unconditionally regardless of whether the value actually changes
      // (see its own doc comment) — reusing it here, re-set to its own
      // current value, is a real API call rather than a new one-off
      // "just bump the counter" method for a single caller.
      controller.setViewMode(sessionId, controller.viewMode(sessionId));

      const entry: SessionEntry = {
        load,
        totalLines: load.totalLines,
        isIndexing: load.isIndexing,
        kind: kindOf(load),
        dataSource: buildSource(load),
      };
      setEntries(sessionId, entry);
      // Same reason `add` hands back the store's own proxied entry rather
      // than the literal above.
      return entries[sessionId];
    };

    const remove = (sessionId: string): void => {
      const entry = entries[sessionId];
      if (!entry) return;

      entry.dataSource.dispose();
      cacheManager.releaseView(viewIdFor(sessionId));
      // The controller keeps a `SessionState` per session — the three/four
      // line-set `number[]`s (one entry per matched line on a large file) and
      // the highlight `Map` — plus a `sessionScrollPositions` entry. Nothing
      // used to delete either, so an agent's open/close loop over many logs
      // retained all of it for the app's lifetime (review A-M1).
      controller.forgetSession(sessionId);

      const previousOrder = order();
      const index = previousOrder.indexOf(sessionId);
      const nextOrder = previousOrder.filter((id) => id !== sessionId);
      // Refocus the tab that slid into this one's place, else the one before it.
      const neighbour = nextOrder[index] ?? nextOrder[index - 1] ?? null;

      batch(() => {
        setEntries(produce((draft) => { delete draft[sessionId]; }));
        setOrder(nextOrder);
        if (focusedId() === sessionId) setFocusedId(neighbour);
      });
    };

    const updateTotal = (sessionId: string, totalLines: number, isIndexing?: boolean): void => {
      const entry = entries[sessionId];
      if (!entry) return;
      entry.dataSource.updateTotalLines(totalLines);
      batch(() => {
        setEntries(sessionId, 'totalLines', totalLines);
        if (isIndexing !== undefined) setEntries(sessionId, 'isIndexing', isIndexing);
      });
    };

    const setStreamingKind = (sessionId: string, streaming: boolean): void => {
      if (!entries[sessionId]) return;
      setEntries(sessionId, 'kind', streaming ? 'live' : 'file');
    };

    // ── Backend subscriptions ────────────────────────────────────────────
    // A bridge-opened session becomes a tab here; `add` is idempotent, so the
    // echo of an open this app started itself is a no-op.
    track(onBridgeSessionOpened((load) => { if (!disposed) add(load); }));

    // A close we started echoes back as `session-closed`; `pendingClose` is how
    // that echo is told apart from an agent closing a session out from under us.
    track(
      onBridgeSessionClosed(({ sessionId }) => {
        if (disposed) return;
        if (pendingClose.delete(sessionId)) return;
        remove(sessionId);
      }),
    );

    track(
      onFileIndexProgress(({ sessionId, indexedLines }) => {
        if (!disposed) updateTotal(sessionId, indexedLines, true);
      }),
    );
    // The `LoadResult` a large file was opened with can carry null timestamps
    // (the index had not reached a timestamped line yet), and nothing pushes
    // later values. React re-reads them from `get_session_metadata` once
    // indexing completes (`useFileInfo.ts`); mirror that so the session-info
    // popover's time range fills in instead of staying blank for big files.
    const refreshTimestamps = (sessionId: string): void => {
      void getSessionMetadata(sessionId)
        .then((meta) => {
          // Untracked on purpose: a promise callback is no reactive scope, and
          // the entry may have been closed while the IPC was in flight.
          if (disposed || !untrack(() => entries[sessionId])) return;
          batch(() => {
            setEntries(sessionId, 'load', 'firstTimestamp', meta.firstTimestamp);
            setEntries(sessionId, 'load', 'lastTimestamp', meta.lastTimestamp);
          });
        })
        .catch(() => undefined);
    };

    track(
      onFileIndexComplete(({ sessionId, totalLines }) => {
        if (disposed) return;
        updateTotal(sessionId, totalLines, false);
        if (entries[sessionId]) refreshTimestamps(sessionId);
      }),
    );

    // Focus mirror: tell the backend which session the human is looking at, so
    // `GET /mcp/sessions` can mark it `focused`. `defer: true` — the initial
    // `null` is not a change, and fire-and-forget because UI focus must never
    // block on IPC.
    createEffect(
      on(
        focusedId,
        (id) => {
          void setFocusedSession(id).catch(() => undefined);
        },
        { defer: true },
      ),
    );

    // Cache budget mirror. `CacheManager.allocateView` hands out `'focused'`
    // only while it has no focused view — i.e. to the *first* session ever
    // opened — and every later one gets `'visible'`, so without this the first
    // file keeps 60% of the budget for the app's lifetime while the session
    // the user is actually reading thrashes its LRU (review A-M3). React pairs
    // every viewer with `useCacheFocus(viewId)`; this is that pairing, once,
    // at the store instead of per component.
    //
    // `setFocus` is single-valued, so the *primary* pane (this signal) is what
    // it follows. S1's secondary pane deliberately keeps its `'visible'`
    // allocation: it is the reference pane, it is usually scrolled to one
    // place, and letting it win the budget by being mounted later would
    // invert exactly the priority this fixes. `ViewerSplit`'s picker moving a
    // session into the primary pane (tab focus) is what promotes it.
    // Not deferred: the first `add()` sets focus synchronously, and that view
    // must be the focused one from its first fetch.
    createEffect(
      on(focusedId, (id) => {
        if (id !== null && entries[id]) cacheManager.setFocus(viewIdFor(id));
      }),
    );

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      for (const fn of unlisteners) fn();
      unlisteners.length = 0;
      for (const id of order()) {
        entries[id]?.dataSource.dispose();
        cacheManager.releaseView(viewIdFor(id));
        controller.forgetSession(id);
      }
      pendingClose.clear();
      batch(() => {
        setEntries(produce((draft) => { for (const key of Object.keys(draft)) delete draft[key]; }));
        setOrder([]);
        setFocusedId(null);
      });
      disposeRoot();
    };

    return {
      order,
      focusedId,
      byId,
      focused,
      add,
      replace,
      remove,
      setFocused: setFocusedId,
      updateTotal,
      setStreamingKind,
      markPendingClose: (sessionId) => { pendingClose.add(sessionId); },
      releasePendingClose: (sessionId) => { pendingClose.delete(sessionId); },
      setSearchQueryProvider: (provider) => { searchQuery = provider; },
      dispose,
    };
  });
}
