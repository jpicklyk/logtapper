import { createSignal, createMemo, createEffect, on, onCleanup, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { sessionScrollPositions } from '@viewport/sessionScrollPositions';

/**
 * Solid port of `src-next/viewport/useVirtualBase.ts`.
 *
 * Manages the "virtual base" offset that keeps the scroller's height inside the
 * browser's 2^25 px DOM limit for very large files.
 *
 * Ownership: `createVirtualBase` creates effects, so it MUST be called inside a
 * component body or an explicit `createRoot`. Its effects are torn down with the
 * owner; there is no manual dispose.
 */

/** Chrome/Edge cap DOM scrollHeight at 2^25 px. */
export const MAX_BROWSER_SCROLL_PX = 33_554_428;

/** Fallback row height when `--viewer-row-h` has not been measured yet. */
export const DEFAULT_ROW_HEIGHT = 22;

/** A non-reactive mirror of a signal, for reads inside DOM callbacks. */
export interface Ref<T> { value: T }

export interface VirtualBaseOptions {
  /** `dataSource.sourceId` — changing it resets (or restores) the window. */
  sourceId: Accessor<string>;
  /** Streaming tail mode: entering it pins the window back to line 0. */
  tailMode?: Accessor<boolean | undefined>;
  /** Runtime row height (`--viewer-row-h`). Accessor or constant; default 22. */
  rowHeight?: Accessor<number> | number;
  /**
   * When given, the window position is persisted to the `sessionScrollPositions`
   * singleton on teardown / session switch, and restored on the next mount.
   */
  sessionId?: Accessor<string | undefined>;
  /** Explicit restore position; overrides the `sessionScrollPositions` lookup. */
  initialVirtualBase?: Accessor<number | undefined>;
}

export interface VirtualBase {
  /** Reactive window offset — the first file line rendered at relative index 0. */
  virtualBase: Accessor<number>;
  /** Writes both the signal and `current.value`. */
  setVirtualBase: (base: number) => void;
  /** Non-reactive mirror (the React `virtualBaseRef`), safe inside DOM handlers. */
  current: Ref<number>;
  /** `floor(2^25 / rowHeight)` — reactive, because rowHeight is a runtime value. */
  maxVirtualLines: Accessor<number>;
  /** Deferred scroll target consumed by the render layer after a rebase. */
  pendingScrollTarget: Ref<number | null>;
}

export function createVirtualBase(options: VirtualBaseOptions): VirtualBase {
  const { sourceId, tailMode, sessionId, initialVirtualBase } = options;

  const rowHeight: Accessor<number> =
    typeof options.rowHeight === 'function'
      ? options.rowHeight
      : () => options.rowHeight as number | undefined ?? DEFAULT_ROW_HEIGHT;

  /** Restore position for the *current* source, read untracked (matches the React ref). */
  const restorePoint = (): number => {
    const explicit = initialVirtualBase?.();
    if (explicit != null) return explicit;
    if (sessionId) return sessionScrollPositions.get(sessionId() ?? '');
    return 0;
  };

  const initial = untrack(restorePoint);
  const [virtualBase, setBase] = createSignal(initial);
  const current: Ref<number> = { value: initial };
  const pendingScrollTarget: Ref<number | null> = { value: null };

  const setVirtualBase = (base: number): void => {
    current.value = base;
    setBase(base);
  };

  const maxVirtualLines = createMemo(() =>
    Math.floor(MAX_BROWSER_SCROLL_PX / Math.max(1, rowHeight())),
  );

  // ── Persist on teardown / session switch ────────────────────────────────
  // Created FIRST so its cleanup (which saves the outgoing session's position)
  // runs before the sourceId reset below reads the map back. Mirrors the H4 fix
  // in LogViewer.tsx: never written at setup time, only on cleanup.
  if (sessionId) {
    createEffect(
      on(sessionId, (id) => {
        onCleanup(() => {
          if (id) sessionScrollPositions.set(id, current.value);
        });
      }),
    );
  }

  // ── Reset (or restore) the virtual window when the data source changes ──
  // `CacheDataSource.sourceId` is `${sessionId}:${'filtered' | 'full'}`, so a
  // change means one of two very different things:
  //
  //  - the *session* changed: restore that session's saved window position.
  //  - only the line-set half flipped (a filter applied or cleared, same
  //    session): the saved position is a **file-line** offset and is nonsense in
  //    the new rendered index space. Restoring it on a 4 M-line file (saved base
  //    ≈ 2.2 M) against a 120-match filter leaves `renderCount` clamped to 0 —
  //    a permanently blank viewer with no way back but closing the tab. Reset.
  const sourceSession = (id: string): string => {
    const i = id.lastIndexOf(':');
    return i === -1 ? id : id.slice(0, i);
  };

  let previousSourceId = untrack(sourceId);
  createEffect(
    on(sourceId, (id) => {
      const previous = previousSourceId;
      previousSourceId = id;
      const lineSetFlipped = id !== previous && sourceSession(id) === sourceSession(previous);
      setVirtualBase(lineSetFlipped ? 0 : untrack(restorePoint));
      pendingScrollTarget.value = null;
    }),
  );

  // ── Pin to line 0 when entering tail mode (streaming) ───────────────────
  if (tailMode) {
    createEffect(
      on(tailMode, (tail) => {
        if (tail) setVirtualBase(0);
      }),
    );
  }

  return { virtualBase, setVirtualBase, current, maxVirtualLines, pendingScrollTarget };
}
