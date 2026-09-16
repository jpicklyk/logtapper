/**
 * Bookmarks store (W7): per-session bookmark list, category grouping,
 * create/update/delete, `bookmark-update` wiring, and markdown export reuse.
 *
 * Lifetime: owns a `createRoot` (same pattern as `sections/sectionsStore.ts`,
 * `analyses/analysesStore.ts`). `dispose()` unlistens the update subscription
 * (including a `listen()` promise that settles after disposal) and tears the
 * root down.
 *
 * ## Deviations from the literal task-scope surface
 *
 * - **Fetch is lazy, gated on focus.** The panel only ever shows the focused
 *   session's bookmarks (same as React's `BookmarkPanel` via
 *   `useFocusedSession()`), so a `createEffect` on `sessions.focusedId()`
 *   with a `fetchedIds` guard — exactly `sectionsStore.ts`'s fetch-effect
 *   shape — is "lazy on first read" in practice: the only way this app ever
 *   reads a session's bookmarks is once that session is focused.
 * - **`bookmark-update` is applied directly from the event payload**, not by
 *   re-calling `listBookmarks` (unlike `analysesStore.ts`'s coalesced
 *   refetch). The payload already carries the full `Bookmark` — a second
 *   round-trip would be redundant — and this mirrors React's `useBookmarks.ts`
 *   reducer exactly. "Dedupe" falls out of the reducer's own idempotency:
 *   `created` only appends when the id is not already present (React's exact
 *   check), and `updated`/`deleted` are naturally idempotent (replacing or
 *   filtering by id twice converges to the same result) — see
 *   `bookmarksStore.test.ts`'s "update dedupe" suite.
 * - **The initial fetch merges rather than replaces.** `sessions.add()`
 *   focusing a session kicks off `listBookmarks` asynchronously; a
 *   `bookmark-update` `created` event can land (and be applied) before that
 *   fetch resolves. A plain replace on resolution would silently drop it —
 *   see `mergeFetched` and the "fetch race" test below.
 * - **No settings integration.** `src-solid` has no settings store yet (W8).
 *   Categories are grouped from whatever `bookmark.category` values are
 *   present, using the six fixed ids `@bridge/types`' `BookmarkCategory`
 *   already declares (mirroring React's `DEFAULT_BOOKMARK_CATEGORIES`);
 *   an id outside that set groups under its own label, same as React's
 *   "Other" fallback for an unrecognised id. Colour is a purpose-built
 *   `--bookmark-1`..`--bookmark-6` domain token per category slot
 *   (`styles/tokens.css`), assigned by declared order — one token per
 *   default category, no settings-driven colour picker needed.
 */
import { createEffect, createRoot, createSignal, getOwner, runWithOwner, untrack } from 'solid-js';
import type { Accessor, Owner } from 'solid-js';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  listBookmarks as listBookmarksCmd,
  createBookmark as createBookmarkCmd,
  updateBookmark as updateBookmarkCmd,
  deleteBookmark as deleteBookmarkCmd,
} from '@bridge/commands';
import { onBookmarkUpdate } from '@bridge/events';
import type { Bookmark, BookmarkCategory, BookmarkUpdateEvent, CreatedBy } from '@bridge/types';
import { exportBookmarksAsMarkdown } from '@bookmarkPanel/exportMarkdown';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import type { SessionStore } from '../app/index';
import type { ViewerController } from '../viewer';

export interface BookmarkCategoryOption {
  id: BookmarkCategory;
  label: string;
}

/** Mirrors React's `DEFAULT_BOOKMARK_CATEGORIES` ids/labels, in order. Order
 *  is load-bearing: it fixes which `--bookmark-N` token each id gets. */
export const BOOKMARK_CATEGORIES: readonly BookmarkCategoryOption[] = [
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'state-change', label: 'State Changes' },
  { id: 'timing', label: 'Timing' },
  { id: 'observation', label: 'Observations' },
  { id: 'custom', label: 'Other' },
];

const CATEGORY_INDEX = new Map<string, number>(BOOKMARK_CATEGORIES.map((c, i) => [c.id, i]));

export function categoryLabel(id: string): string {
  return BOOKMARK_CATEGORIES.find((c) => c.id === id)?.label ?? 'Other';
}

/** `--bookmark-1`..`--bookmark-6` (`styles/tokens.css`) are this package's
 *  purpose-built domain tokens, one per default category in declared order.
 *  An id outside the default six (there is no live category editor yet)
 *  falls back to the last slot, same as React's "Other" bucket. */
export function categoryAccentVar(id: string): string {
  const idx = CATEGORY_INDEX.get(id) ?? BOOKMARK_CATEGORIES.length - 1;
  return `var(--bookmark-${idx + 1})`;
}

/**
 * Display base for a bookmark line number.
 *
 * Backend line numbers are 0-based; the viewer gutter prints `lineNum + 1`
 * (`viewer/Row.tsx`), so every bookmark surface — the row's line chip, the
 * create dialog's heading, the default label, and React's markdown export —
 * shows the 1-based number. The three places that used to restate the `+ 1`
 * and the `L…–…` format independently now all come through the two helpers
 * below, so there is one base and one format for this module.
 *
 * (Analyses deliberately do NOT share this base: `editor/lineRefs.ts`'s
 * `lineRefText` must render the *raw* `lineNumber`, because the rehype pass
 * matches that exact text where it appears in an author's markdown prose.
 * Unifying the two bases is a change to `editor/`, which this package does not
 * own — see the implementation notes.)
 */
export const LINE_DISPLAY_BASE = 1;

/** `L42` / `L42–46` — the bookmark line chip, in display base. */
export function formatLineRange(lineNumber: number, endLine?: number | null): string {
  const start = lineNumber + LINE_DISPLAY_BASE;
  return endLine != null && endLine > lineNumber
    ? `L${start}–${endLine + LINE_DISPLAY_BASE}`
    : `L${start}`;
}

/** `Line 42` — the create dialog's heading/placeholder and the default label. */
export function formatLineLabel(lineNumber: number): string {
  return `Line ${lineNumber + LINE_DISPLAY_BASE}`;
}

export interface BookmarksCommands {
  listBookmarks: typeof listBookmarksCmd;
  createBookmark: typeof createBookmarkCmd;
  updateBookmark: typeof updateBookmarkCmd;
  deleteBookmark: typeof deleteBookmarkCmd;
}

const DEFAULT_COMMANDS: BookmarksCommands = {
  listBookmarks: listBookmarksCmd,
  createBookmark: createBookmarkCmd,
  updateBookmark: updateBookmarkCmd,
  deleteBookmark: deleteBookmarkCmd,
};

export interface BookmarksStoreDeps {
  sessions: SessionStore;
  controller: ViewerController;
  /** Injected for tests; defaults to the real `onBookmarkUpdate`. */
  listen?: typeof onBookmarkUpdate;
  /** Injected for tests; defaults to the real bridge commands. */
  commands?: Partial<BookmarksCommands>;
}

export interface CreateBookmarkInput {
  line: number;
  endLine?: number;
  category?: string;
  note?: string;
  label?: string;
  createdBy?: CreatedBy;
}

export interface UpdateBookmarkInput {
  label?: string;
  note?: string;
  category?: string;
}

export interface CategoryGroup {
  id: string;
  label: string;
  count: number;
  bookmarks: Bookmark[];
}

export interface BookmarksStore {
  list(sessionId: string): Bookmark[];
  loading(sessionId: string): boolean;
  /** The last `listBookmarks` failure for `sessionId`, or `null`. */
  error(sessionId: string): string | null;
  /** Clear that error and re-run the fetch for `sessionId`. */
  retry(sessionId: string): void;
  /** Bookmarks for `sessionId`, grouped by category (declared-order default
   *  categories first, any other ids after), sorted by line within a group. */
  categories(sessionId: string): CategoryGroup[];
  create(sessionId: string, input: CreateBookmarkInput): Promise<Bookmark>;
  update(bookmarkId: string, patch: UpdateBookmarkInput): Promise<Bookmark>;
  remove(bookmarkId: string): Promise<void>;
  /** Markdown for `sessionId`'s current bookmarks, via the reused pure
   *  `exportBookmarksAsMarkdown`. The caller decides what to do with it
   *  (the panel copies it to the clipboard). */
  exportMarkdown(sessionId: string): string;
  /** Route a clicked bookmark through the controller: `scrollToLine` with the
   *  bookmark's own `sessionId`, highlighting the range when it has one. The
   *  panel and the create dialog never touch `ViewerController` directly. */
  jumpTo(bookmark: Bookmark): void;
  /** The controller's current cursor line, when it is on `sessionId` — the
   *  create dialog's pre-fill. `null` when there is no cursor on that session. */
  cursorLine(sessionId: string): number | null;
  dispose(): void;
}

interface SessionBookmarksState {
  bookmarks: Accessor<Bookmark[]>;
  setBookmarks: (fn: (prev: Bookmark[]) => Bookmark[]) => void;
  loading: Accessor<boolean>;
  setLoading: (v: boolean) => void;
  error: Accessor<string | null>;
  setError: (v: string | null) => void;
}

/** Stable identity for "this session has no bookmarks (yet)" — a fresh `[]`
 *  per call would make every consuming memo re-run on every read. */
const NO_BOOKMARKS: Bookmark[] = [];

/** Union by id, `fetched` winning on a conflict (it is the server's answer).
 *  Any id in `current` but absent from `fetched` is kept — a `bookmark-update`
 *  `created` event can land while the initial `listBookmarks` for that
 *  session is still in flight, and a plain replace on resolution would
 *  silently drop it. A `deleted` event racing the same window is the
 *  unhandled edge of this trade-off: a bookmark removed after the fetch
 *  snapshot but before it resolves briefly reappears until the next update. */
function mergeFetched(current: readonly Bookmark[], fetched: readonly Bookmark[]): Bookmark[] {
  const byId = new Map(current.map((b) => [b.id, b] as const));
  for (const b of fetched) byId.set(b.id, b);
  return [...byId.values()];
}

function createSessionBookmarksState(): SessionBookmarksState {
  const [bookmarks, setBookmarksSignal] = createSignal<Bookmark[]>([]);
  const [loading, setLoadingSignal] = createSignal(false);
  const [error, setErrorSignal] = createSignal<string | null>(null);
  return {
    bookmarks,
    setBookmarks: (fn) => setBookmarksSignal((prev) => fn(prev)),
    loading,
    setLoading: (v) => setLoadingSignal(v),
    error,
    setError: (v) => setErrorSignal(v),
  };
}

export function createBookmarksStore(deps: BookmarksStoreDeps): BookmarksStore {
  const commands: BookmarksCommands = { ...DEFAULT_COMMANDS, ...deps.commands };
  const listenFn = deps.listen ?? onBookmarkUpdate;
  const { sessions, controller } = deps;

  return createRoot((disposeRoot) => {
    const owner = getOwner() as Owner;
    const states = new Map<string, SessionBookmarksState>();
    const fetchedIds = new Set<string>();
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    // `states` is a plain Map, invisible to Solid: every *read* of it goes
    // through this tick so a consuming memo re-runs when a session's state
    // appears or is pruned (the `analysesStore.cacheVersion` pattern).
    const [statesTick, setStatesTick] = createSignal(0);

    const ensureState = (sessionId: string): SessionBookmarksState => {
      let state = states.get(sessionId);
      if (!state) {
        state = runWithOwner(owner, createSessionBookmarksState) as SessionBookmarksState;
        states.set(sessionId, state);
        setStatesTick((n) => n + 1);
      }
      return state;
    };

    /** Reactive read that never creates — so a render-time read cannot
     *  resurrect the state the prune sweep below just dropped. */
    const peekState = (sessionId: string): SessionBookmarksState | null => {
      statesTick();
      return states.get(sessionId) ?? null;
    };

    const [retryTick, setRetryTick] = createSignal(0);

    // Fetch once per session id, the first time it is focused — mirrors
    // `sectionsStore.ts`'s fetch effect exactly.
    createEffect(() => {
      retryTick();
      const id = sessions.focusedId();
      if (!id || disposed || fetchedIds.has(id)) return;
      fetchedIds.add(id);
      const state = ensureState(id);
      state.setLoading(true);
      commands
        .listBookmarks(id)
        .then((bookmarks) => {
          if (disposed) return;
          state.setBookmarks((current) => mergeFetched(current, bookmarks));
          state.setError(null);
        })
        .catch((e: unknown) => {
          if (disposed) return;
          // Without this the panel showed "No bookmarks yet." and nothing ever
          // retried: the effect's only dependency (`focusedId`) had not changed.
          fetchedIds.delete(id);
          state.setError(String(e));
        })
        .finally(() => {
          if (!disposed) state.setLoading(false);
        });
    });

    // ── Session cleanup ──────────────────────────────────────────────────
    // The same prune sweep `analyzers/analyzerStore.ts` runs: diff the
    // per-session records against `sessions.order()` and drop the stale ones.
    // `app/sessions.ts` removes a session on both a user close and a foreign
    // (`session-closed`) one, and neither notified this store.
    createEffect(() => {
      const known = new Set(sessions.order());
      for (const id of [...fetchedIds]) if (!known.has(id)) fetchedIds.delete(id);
      const stale = [...states.keys()].filter((id) => !known.has(id));
      if (stale.length === 0) return;
      for (const id of stale) states.delete(id);
      setStatesTick((n) => n + 1);
    });

    /** Which session currently holds this bookmark id, or `null`. Scans the
     *  (small, per-session) in-memory lists rather than requiring callers to
     *  pass a session id they may not have handy for `update`/`remove`. */
    const ownerSessionOf = (bookmarkId: string): string | null => {
      for (const [sessionId, state] of states) {
        if (state.bookmarks().some((b) => b.id === bookmarkId)) return sessionId;
      }
      return null;
    };

    const applyEvent = (event: BookmarkUpdateEvent): void => {
      // Membership gate. `applyEvent` used to call `stateFor` unconditionally,
      // so a `bookmark-update` for a session this UI does not have — an agent's
      // session, or ours a moment after it closed — minted a fresh
      // `SessionBookmarksState` that no panel could ever show and
      // `ownerSessionOf` then scanned on every update/remove, for the app's
      // lifetime. A `created` needs the session to be open; an
      // `updated`/`deleted` needs a state that already exists (there is
      // nothing to update otherwise).
      if (event.action === 'created') {
        if (!sessions.byId(event.sessionId)) return;
      } else if (!states.has(event.sessionId)) {
        return;
      }
      const state = ensureState(event.sessionId);
      switch (event.action) {
        case 'created':
          state.setBookmarks((prev) =>
            prev.some((b) => b.id === event.bookmark.id) ? prev : [...prev, event.bookmark],
          );
          break;
        case 'updated':
          state.setBookmarks((prev) => prev.map((b) => (b.id === event.bookmark.id ? event.bookmark : b)));
          break;
        case 'deleted':
          state.setBookmarks((prev) => prev.filter((b) => b.id !== event.bookmark.id));
          break;
      }
    };

    listenFn((event) => {
      if (!disposed) applyEvent(event);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    const list = (sessionId: string): Bookmark[] => peekState(sessionId)?.bookmarks() ?? NO_BOOKMARKS;
    const loading = (sessionId: string): boolean => peekState(sessionId)?.loading() ?? false;
    const error = (sessionId: string): string | null => peekState(sessionId)?.error() ?? null;

    const retry = (sessionId: string): void => {
      fetchedIds.delete(sessionId);
      untrack(() => states.get(sessionId)?.setError(null));
      setRetryTick((n) => n + 1);
    };

    const categories = (sessionId: string): CategoryGroup[] => {
      const sorted = [...list(sessionId)].sort((a, b) => a.lineNumber - b.lineNumber);
      const byId = new Map<string, Bookmark[]>();
      for (const b of sorted) {
        const cat = b.category ?? 'custom';
        const bucket = byId.get(cat);
        if (bucket) bucket.push(b);
        else byId.set(cat, [b]);
      }
      const groups: CategoryGroup[] = [];
      for (const def of BOOKMARK_CATEGORIES) {
        const items = byId.get(def.id);
        if (items) groups.push({ id: def.id, label: def.label, count: items.length, bookmarks: items });
      }
      for (const [id, items] of byId) {
        if (!CATEGORY_INDEX.has(id)) groups.push({ id, label: categoryLabel(id), count: items.length, bookmarks: items });
      }
      return groups;
    };

    const create = (sessionId: string, input: CreateBookmarkInput): Promise<Bookmark> => {
      const label = input.label?.trim() || formatLineLabel(input.line);
      return commands
        .createBookmark(
          sessionId,
          input.line,
          label,
          input.note ?? '',
          input.createdBy ?? 'User',
          input.endLine,
          undefined,
          input.category,
        )
        .then((bookmark) => {
          if (!disposed) {
            ensureState(sessionId).setBookmarks((prev) =>
              prev.some((b) => b.id === bookmark.id) ? prev : [...prev, bookmark],
            );
          }
          return bookmark;
        });
    };

    const update = (bookmarkId: string, patch: UpdateBookmarkInput): Promise<Bookmark> => {
      const sessionId = ownerSessionOf(bookmarkId);
      if (!sessionId) return Promise.reject(new Error(`Unknown bookmark: ${bookmarkId}`));
      return commands.updateBookmark(sessionId, bookmarkId, patch.label, patch.note, patch.category).then((bookmark) => {
        if (!disposed) ensureState(sessionId).setBookmarks((prev) => prev.map((b) => (b.id === bookmark.id ? bookmark : b)));
        return bookmark;
      });
    };

    const remove = (bookmarkId: string): Promise<void> => {
      const sessionId = ownerSessionOf(bookmarkId);
      // Symmetric with `update`: resolving here told a caller the delete
      // succeeded when nothing was ever sent to the backend, so a UI that
      // closes its confirmation on resolve reported a deletion that did not
      // happen.
      if (!sessionId) return Promise.reject(new Error(`Unknown bookmark: ${bookmarkId}`));
      return commands.deleteBookmark(sessionId, bookmarkId).then(() => {
        if (!disposed) ensureState(sessionId).setBookmarks((prev) => prev.filter((b) => b.id !== bookmarkId));
      });
    };

    const exportMarkdown = (sessionId: string): string => {
      const entry = sessions.byId(sessionId);
      // `totalLines` was copied from the React call site but
      // `exportBookmarksAsMarkdown` never reads it — `ExportContext.sourceName`
      // is the only field with an effect.
      return exportBookmarksAsMarkdown(list(sessionId), { sourceName: entry?.load.sourceName });
    };

    const jumpTo = (bookmark: Bookmark): void => {
      controller.scrollToLine(bookmark.sessionId, bookmark.lineNumber, {
        highlight: true,
        select: bookmark.lineNumberEnd != null ? [bookmark.lineNumber, bookmark.lineNumberEnd] : undefined,
        source: 'user',
      });
    };

    const cursorLine = (sessionId: string): number | null => {
      const cursor = controller.cursor();
      return cursor && cursor.sessionId === sessionId ? cursor.line : null;
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      unlisten?.();
      states.clear();
      disposeRoot();
    };

    return { list, loading, error, retry, categories, create, update, remove, exportMarkdown, jumpTo, cursorLine, dispose };
  });
}
