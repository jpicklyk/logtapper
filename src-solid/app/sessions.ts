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
import { batch, createEffect, createMemo, createRoot, createSignal, on } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getLines, setFocusedSession } from '@bridge/commands';
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
  /** Drop a session: dispose its source, release its view cache, refocus a neighbour. */
  remove(sessionId: string): void;
  setFocused(sessionId: string | null): void;
  updateTotal(sessionId: string, totalLines: number, isIndexing?: boolean): void;

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

    const remove = (sessionId: string): void => {
      const entry = entries[sessionId];
      if (!entry) return;

      entry.dataSource.dispose();
      cacheManager.releaseView(viewIdFor(sessionId));

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
    track(
      onFileIndexComplete(({ sessionId, totalLines }) => {
        if (!disposed) updateTotal(sessionId, totalLines, false);
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

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      for (const fn of unlisteners) fn();
      unlisteners.length = 0;
      for (const id of order()) {
        entries[id]?.dataSource.dispose();
        cacheManager.releaseView(viewIdFor(id));
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
      remove,
      setFocused: setFocusedId,
      updateTotal,
      markPendingClose: (sessionId) => { pendingClose.add(sessionId); },
      releasePendingClose: (sessionId) => { pendingClose.delete(sessionId); },
      setSearchQueryProvider: (provider) => { searchQuery = provider; },
      dispose,
    };
  });
}
