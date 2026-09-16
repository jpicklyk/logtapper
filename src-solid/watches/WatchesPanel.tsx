/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import type { FilterCriteria, WatchInfo } from '@bridge/types';
import { CallerBadge, normalizeCaller } from '../ui';
import type { CallerLike } from '../ui';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import type { SessionStore } from '../app/index';
import { CreateWatchForm } from './CreateWatchForm';
import { CriteriaChips } from './CriteriaChips';
import type { WatchesStore } from './watchesStore';
import styles from './watches.module.css';

export interface WatchesPanelProps {
  store: WatchesStore;
  sessions: SessionStore;
  /**
   * Resolves a watch's caller from the activity journal, for the "agent
   * subscriptions visible" part of the brief. Mirrors `App.tsx`'s existing
   * `lastRunCaller` (same file, same technique for `pipeline.run` — see
   * `watchesStore.ts`'s doc comment point 2 for why `WatchInfo` itself
   * carries no caller and this has to be resolved externally). Optional so
   * the panel renders without it in tests; omitting it just means no badge.
   */
  callerFor?: (watchId: string, sessionId: string) => CallerLike | null;
}

interface WatchRowProps {
  /** An accessor, not a value: the row is keyed by `watchId` (see the `<For>`
   *  below), so a `watch-match` count update must reach the *existing* row
   *  rather than replace it — review C-M5. */
  watch: () => WatchInfo;
  caller: CallerLike | null;
  onCancel: () => void;
}

function WatchRow(props: WatchRowProps): JSX.Element {
  const [confirming, setConfirming] = createSignal(false);
  const [flashing, setFlashing] = createSignal(false);
  // Only an agent-originated watch gets a badge — see this module's own
  // panel doc: the brief's ask is "agent subscriptions visible", not "every
  // watch's caller" the way Bookmarks shows one for every row.
  const showBadge = createMemo(() => props.caller !== null && normalizeCaller(props.caller) === 'agent');

  // Brief flash on every increment — parity with React's `WatchRow`. Guarded
  // by `prev !== undefined` so mounting on an already-nonzero count (a watch
  // fetched via `list_watches` after the fact) never flashes.
  createEffect(
    on(
      () => props.watch().totalMatches,
      (curr, prev) => {
        if (prev !== undefined && curr > prev) {
          setFlashing(true);
          const timer = setTimeout(() => setFlashing(false), 600);
          onCleanup(() => clearTimeout(timer));
        }
      },
    ),
  );

  return (
    <div
      class={styles.watchRow}
      classList={{ [styles.watchRowCancelled]: !props.watch().active }}
      data-testid="watch-row"
    >
      <span
        class={styles.statusDot}
        classList={{
          [styles.statusDotActive]: props.watch().active,
          [styles.statusDotCancelled]: !props.watch().active,
        }}
      />
      <CriteriaChips criteria={props.watch().criteria} />
      <Show when={showBadge()}>
        <CallerBadge caller={props.caller!} />
      </Show>
      <span class={styles.matchCount} classList={{ [styles.matchCountFlash]: flashing() }}>
        {props.watch().totalMatches.toLocaleString()}
      </span>
      <Show when={props.watch().active}>
        <Show
          when={confirming()}
          fallback={
            <button
              type="button"
              class={styles.cancelBtn}
              title="Cancel watch"
              onClick={() => setConfirming(true)}
            >
              ×
            </button>
          }
        >
          <button
            type="button"
            class={styles.dangerLink}
            onClick={() => { setConfirming(false); props.onCancel(); }}
          >
            Confirm
          </button>
          <button type="button" class={styles.formCancelLink} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </Show>
      </Show>
    </div>
  );
}

/** The `watches` shell surface (L2, live-mode only, `shell/surfaces.ts`):
 *  list, create, and cancel watches for the focused (live) session, with
 *  live match-count badges and agent-attribution badges.
 *
 * Deliberately does NOT touch `ViewerController` — see `watchesStore.ts`'s
 * doc comment point 3 for the full accounting of why: `watch-match` carries
 * no line numbers anywhere in the pipeline, so there is nothing honest to
 * pass `setHighlights`/`scrollToLine`. React's own `WatchesPanel`/`WatchRow`
 * make the same choice.
 */
export function WatchesPanel(props: WatchesPanelProps): JSX.Element {
  const [showCreate, setShowCreate] = createSignal(false);

  const sessionId = createMemo(() => props.sessions.focusedId());
  // Ids, not `WatchInfo[]` (review C-M5). `<For>` keys by value identity and
  // `watch-match` replaces the row object on every count update, so iterating
  // the objects disposed and re-created the row on each match: the flash
  // effect restarted with `prev === undefined` (so the animation this code
  // exists for never played) and an in-progress Confirm prompt reset itself
  // at exactly the moment watches are firing. Ids are stable strings, so the
  // row survives and reads its own `WatchInfo` back from the store.
  const activeIds = createMemo(() => (sessionId() ? props.store.activeIds(sessionId()!) : []));
  const cancelledIds = createMemo(() => (sessionId() ? props.store.cancelledIds(sessionId()!) : []));
  const hasWatches = createMemo(() => activeIds().length + cancelledIds().length > 0);

  /** A watch by id, for a row that outlives any single `WatchInfo` object.
   *  Called from the `<For>` body, where the id is by construction still in
   *  the list. Keeps the last value it saw so the one render between a watch
   *  disappearing and its row being disposed reads the row it is showing
   *  rather than throwing. */
  const watchFor = (watchId: string, sid: string): (() => WatchInfo) => {
    let last = props.store.byId(sid, watchId)!;
    return () => {
      const found = props.store.byId(sid, watchId);
      if (found) last = found;
      return last;
    };
  };

  const handleCreate = async (criteria: FilterCriteria): Promise<void> => {
    const sid = sessionId();
    if (!sid) return;
    await props.store.create(sid, criteria);
    setShowCreate(false);
  };

  const handleCancel = (sid: string, watchId: string): void => {
    void props.store.cancel(sid, watchId);
  };

  return (
    <div class={styles.panel} data-testid="watches-panel">
      <Show
        when={sessionId()}
        fallback={<div class={styles.empty}>Open a file or start a stream to use watches</div>}
      >
        {(sid) => (
          <>
            <header class={styles.header}>
              <span class={styles.headerLabel}>Watches</span>
              <Show when={activeIds().length > 0}>
                <span class={styles.watchCount}>{activeIds().length}</span>
              </Show>
              <button
                type="button"
                class={styles.addBtn}
                title={showCreate() ? 'Cancel' : 'Create watch'}
                onClick={() => setShowCreate((v) => !v)}
              >
                +
              </button>
            </header>

            <Show when={showCreate()}>
              <CreateWatchForm onSubmit={handleCreate} onCancel={() => setShowCreate(false)} />
            </Show>

            <Show when={!hasWatches() && !showCreate()}>
              <div class={styles.empty}>
                <span>No watches yet</span>
                <span class={styles.emptySub}>Create a watch to track patterns in the live stream</span>
              </div>
            </Show>

            <div class={styles.content}>
              <For each={activeIds()}>
                {(watchId) => (
                  <WatchRow
                    watch={watchFor(watchId, sid())}
                    caller={props.callerFor?.(watchId, sid()) ?? null}
                    onCancel={() => handleCancel(sid(), watchId)}
                  />
                )}
              </For>

              <Show when={cancelledIds().length > 0}>
                <div class={styles.sectionLabel}>Cancelled</div>
                <For each={cancelledIds()}>
                  {(watchId) => (
                    <WatchRow
                      watch={watchFor(watchId, sid())}
                      caller={props.callerFor?.(watchId, sid()) ?? null}
                      onCancel={() => handleCancel(sid(), watchId)}
                    />
                  )}
                </For>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
