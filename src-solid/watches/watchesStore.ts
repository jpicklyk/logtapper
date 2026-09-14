/**
 * Watches store (L2): per-session watch list, create/cancel, `watch-match`
 * running-count wiring, and `watch-update` lifecycle (create/cancel, from
 * either caller — this is what makes an agent-created watch appear here
 * without the panel doing anything, exactly as React's `useWatchList` doc
 * comment describes).
 *
 * Lifetime: owns a `createRoot` (same pattern as `bookmarksStore.ts` /
 * `sectionsStore.ts`). `dispose()` unlistens both subscriptions (including a
 * `listen()` promise that settles after disposal) and tears the root down.
 *
 * ## Three claims from the task brief that turned out not to hold
 *
 * Checked against the actual backend contract (`core/watch.rs`,
 * `services/watches.rs`, `commands/watch.rs`) and React's own reference
 * (`components/WatchesPanel/`) before writing any code, per this phase's
 * "verify before acting" rule — mirrors what F0 found for `bookmarksStore`
 * and L1 found for tail-mode.
 *
 * 1. **No pause/resume, no edit.** `WatchSession::cancel()` only ever flips
 *    `active` true→false — there is no reactivate, and no `update_watch`
 *    command exists at all. React's `WatchRow.tsx` confirms this is not an
 *    oversight: a cancelled watch renders greyed out with no button, and
 *    `CreateWatchForm.tsx` is create-only. This store exposes exactly
 *    `create`/`cancel`, matching what the backend and React both actually
 *    support — not the "edit, delete, pause and resume" the task-scope
 *    listed.
 * 2. **No caller field on `WatchInfo`.** Unlike `Bookmark.createdBy` /
 *    `Analysis.createdBy`, `WatchInfo` (`{ watchId, sessionId, totalMatches,
 *    active, criteria }`) carries no attribution at all. "Who" is only ever
 *    recorded in the activity journal (`ctx.journal("watch.create", ...)`
 *    with `caller: Ui | Agent`, summary `"watch {watch_id}"`). This store has
 *    no journal access and does not attempt the correlation itself; see
 *    `App.tsx`'s `watchCaller`, which mirrors the pre-existing
 *    `lastRunCaller` pattern (same file, built for the exact same problem on
 *    `pipeline.run`) rather than inventing a second way to do it.
 * 3. **No per-match line numbers anywhere reachable.** `WatchMatchEvent` is
 *    `{ watchId, sessionId, newMatches, totalMatches }` — counts only.
 *    `evaluate_watches` (`commands/watch.rs`) returns `(watch_id,
 *    new_match_count, total_matches)` tuples; it never surfaces which lines
 *    matched. `HighlightKind` (the closed, backend-generated enum
 *    `controller.setHighlights` requires) has no watch-specific variant, and
 *    nothing anywhere constructs a `ProcessorMatch` span today either — it is
 *    reserved, unused capacity, not a repurposable stand-in. The raw batch
 *    lines that *would* let a consumer compute matches client-side (mirroring
 *    L1's filter-AST hook) are delivered over a Tauri IPC `Channel` that is
 *    private to `viewer/createStreamSession.ts`'s closure; nothing outside
 *    that module (owned by `src-solid/stream/`, not this package) can
 *    subscribe to it. React's own `WatchesPanel`/`WatchRow` never attempt
 *    per-line highlighting either — they render `totalMatches` as a counter,
 *    nothing more. This store therefore never calls
 *    `controller.setHighlights` or `controller.scrollToLine`; there is
 *    nothing honest to pass either call. A future package could add this by
 *    extending `evaluate_watches` to report matched line numbers (a genuine,
 *    small backend change) and giving `createStreamSession` a second
 *    injectable hook alongside `appendFilterMatches` — out of scope here per
 *    the "no Rust" constraint and per not reaching into `src-solid/stream/`'s
 *    ownership.
 */
import { createEffect, createRoot, createSignal, getOwner, runWithOwner } from 'solid-js';
import type { Accessor, Owner } from 'solid-js';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  createWatch as createWatchCmd,
  cancelWatch as cancelWatchCmd,
  listWatches as listWatchesCmd,
} from '@bridge/commands';
import { onWatchMatch, onWatchUpdate } from '@bridge/events';
import type { FilterCriteria, WatchInfo, WatchMatchEvent, WatchUpdateEvent } from '@bridge/types';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import type { SessionStore } from '../app/index';

export interface WatchesCommands {
  createWatch: typeof createWatchCmd;
  cancelWatch: typeof cancelWatchCmd;
  listWatches: typeof listWatchesCmd;
}

const DEFAULT_COMMANDS: WatchesCommands = {
  createWatch: createWatchCmd,
  cancelWatch: cancelWatchCmd,
  listWatches: listWatchesCmd,
};

export interface WatchesStoreDeps {
  sessions: SessionStore;
  /** Injected for tests; defaults to the real `onWatchMatch`. */
  listenMatch?: typeof onWatchMatch;
  /** Injected for tests; defaults to the real `onWatchUpdate`. */
  listenUpdate?: typeof onWatchUpdate;
  /** Injected for tests; defaults to the real bridge commands. */
  commands?: Partial<WatchesCommands>;
}

export interface WatchesStore {
  list(sessionId: string): WatchInfo[];
  /** `list(sessionId)` filtered to `active === true`, in fetch/event order. */
  active(sessionId: string): WatchInfo[];
  /** `list(sessionId)` filtered to `active === false`. */
  cancelled(sessionId: string): WatchInfo[];
  loading(sessionId: string): boolean;
  create(sessionId: string, criteria: FilterCriteria): Promise<WatchInfo>;
  /** Cancel is terminal — see this module's doc comment, point 1. */
  cancel(sessionId: string, watchId: string): Promise<void>;
  dispose(): void;
}

interface SessionWatchesState {
  watches: Accessor<WatchInfo[]>;
  setWatches: (fn: (prev: WatchInfo[]) => WatchInfo[]) => void;
  loading: Accessor<boolean>;
  setLoading: (v: boolean) => void;
}

/** Union by id, `fetched` winning on a conflict (it is the server's answer).
 *  Any id in `current` but absent from `fetched` is kept — a `watch-update`
 *  `created` event can land while the initial `listWatches` for that session
 *  is still in flight, and a plain replace on resolution would silently drop
 *  it. Mirrors `bookmarksStore.ts`'s `mergeFetched` exactly (same race, same
 *  fix). */
function mergeFetched(current: readonly WatchInfo[], fetched: readonly WatchInfo[]): WatchInfo[] {
  const byId = new Map(current.map((w) => [w.watchId, w] as const));
  for (const w of fetched) byId.set(w.watchId, w);
  return [...byId.values()];
}

function createSessionWatchesState(): SessionWatchesState {
  const [watches, setWatchesSignal] = createSignal<WatchInfo[]>([]);
  const [loading, setLoadingSignal] = createSignal(false);
  return {
    watches,
    setWatches: (fn) => setWatchesSignal((prev) => fn(prev)),
    loading,
    setLoading: (v) => setLoadingSignal(v),
  };
}

export function createWatchesStore(deps: WatchesStoreDeps): WatchesStore {
  const commands: WatchesCommands = { ...DEFAULT_COMMANDS, ...deps.commands };
  const listenMatch = deps.listenMatch ?? onWatchMatch;
  const listenUpdate = deps.listenUpdate ?? onWatchUpdate;
  const { sessions } = deps;

  return createRoot((disposeRoot) => {
    const owner = getOwner() as Owner;
    const states = new Map<string, SessionWatchesState>();
    const fetchedIds = new Set<string>();
    let disposed = false;
    let unlistenMatch: UnlistenFn | null = null;
    let unlistenUpdate: UnlistenFn | null = null;

    const stateFor = (sessionId: string): SessionWatchesState => {
      let state = states.get(sessionId);
      if (!state) {
        state = runWithOwner(owner, createSessionWatchesState) as SessionWatchesState;
        states.set(sessionId, state);
      }
      return state;
    };

    // Fetch once per session id, the first time it is focused — mirrors
    // `bookmarksStore.ts`'s fetch effect exactly.
    createEffect(() => {
      const id = sessions.focusedId();
      if (!id || disposed || fetchedIds.has(id)) return;
      fetchedIds.add(id);
      const state = stateFor(id);
      state.setLoading(true);
      commands
        .listWatches(id)
        .then((list) => {
          if (!disposed) state.setWatches((current) => mergeFetched(current, list));
        })
        .catch(() => {
          fetchedIds.delete(id);
        })
        .finally(() => {
          if (!disposed) state.setLoading(false);
        });
    });

    /** Upsert by watchId — both `watch-update` actions carry the full
     *  `WatchInfo` (`cancelled` differs only in `active: false`), so one
     *  merge handles create, cancel, and a redelivery of either without
     *  duplicating a row. Mirrors React's `useWatchList` reducer exactly. */
    const upsert = (sessionId: string, watch: WatchInfo): void => {
      const state = stateFor(sessionId);
      state.setWatches((prev) => {
        const i = prev.findIndex((w) => w.watchId === watch.watchId);
        if (i === -1) return [...prev, watch];
        const next = prev.slice();
        next[i] = watch;
        return next;
      });
    };

    listenMatch((event: WatchMatchEvent) => {
      if (disposed) return;
      // Only touches a session whose list has already been fetched at least
      // once — a match for a session nothing has focused yet has no list to
      // update, and the eventual fetch-on-focus reads the current total
      // straight from `list_watches` anyway.
      const state = states.get(event.sessionId);
      if (!state) return;
      // Unconditional on `active`: a match evaluated server-side just before
      // a concurrent cancel can arrive after the `watch-update` (cancelled)
      // event that already flipped this row's `active` to false. The count
      // still applies — the match genuinely happened — and `active` stays
      // whatever the (later, authoritative) update event set it to.
      state.setWatches((prev) =>
        prev.map((w) => (w.watchId === event.watchId ? { ...w, totalMatches: event.totalMatches } : w)),
      );
    }).then((fn) => {
      if (disposed) fn();
      else unlistenMatch = fn;
    });

    listenUpdate((event: WatchUpdateEvent) => {
      if (!disposed) upsert(event.sessionId, event.watch);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenUpdate = fn;
    });

    const list = (sessionId: string): WatchInfo[] => stateFor(sessionId).watches();
    const loading = (sessionId: string): boolean => stateFor(sessionId).loading();
    const active = (sessionId: string): WatchInfo[] => list(sessionId).filter((w) => w.active);
    const cancelled = (sessionId: string): WatchInfo[] => list(sessionId).filter((w) => !w.active);

    const create = (sessionId: string, criteria: FilterCriteria): Promise<WatchInfo> =>
      commands.createWatch(sessionId, criteria).then((watch) => {
        // The `watch-update` (`created`) event may already have applied this
        // watch by the time the command resolves — `upsert` is idempotent
        // either way, same dedupe-by-id guarantee as `bookmarksStore.create`.
        if (!disposed) upsert(sessionId, watch);
        return watch;
      });

    // `cancel_watch` returns nothing on success; the state transition comes
    // from the `watch-update` (`cancelled`) event every mutation emits,
    // exactly as React's `handleCancel` relies on `watch-update` alone.
    const cancel = (sessionId: string, watchId: string): Promise<void> =>
      commands.cancelWatch(sessionId, watchId);

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      unlistenMatch?.();
      unlistenUpdate?.();
      states.clear();
      disposeRoot();
    };

    return { list, active, cancelled, loading, create, cancel, dispose };
  });
}
