import { createSignal, createMemo, createEffect, on, onCleanup, getOwner, batch, untrack } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { DataSource } from '@viewport/DataSource';
import type { Ref } from './virtualBase';

/**
 * Solid port of `src-next/viewport/useScrollControls.ts`.
 *
 * Owns tail-mode auto-scroll state, the "N new lines" badge and the streaming
 * `onAppend` subscription. Does NOT scroll the element to the bottom on new
 * lines — that stays in the render layer because it needs `virtualBase`.
 *
 * Ownership: the constructor creates effects, so `new ScrollControls(...)` MUST
 * run inside a component body or an explicit `createRoot`. When an owner exists
 * the instance registers its own `onCleanup(() => this.detach())`; otherwise the
 * caller must call `detach()` by hand.
 *
 * The scroll container is not passed to the constructor — the render layer calls
 * `attach(el)` from a `ref`/`onMount`, which replaces the React hook's
 * "element as a dependency" trick for the deferred-mount case.
 */

const AT_BOTTOM_THRESHOLD = 60;

export interface ScrollControlsOptions {
  /** Streaming tail mode. */
  tailMode: Accessor<boolean | undefined>;
  /** Authoritative total from the session (used in file mode). */
  totalLines: Accessor<number>;
  /**
   * Size of the active line set (filter / search / section / matched), or
   * `undefined` when no line set is active — React's `effectiveTotalLines`.
   *
   * When a line set is active it IS the rendered index space, in tail mode as
   * much as in file mode: `CacheDataSource.getLine(i)` indexes positionally into
   * it. Trusting the stream total there sizes a filtered live capture to the
   * unfiltered session (300 k rows for 500 matches), and every row past the
   * line set's end is a skeleton no fetch can ever resolve.
   */
  renderedLineCount?: Accessor<number | undefined>;
  /** Current data source; re-subscribes to `onAppend` when it changes. */
  dataSource: Accessor<DataSource>;
  /**
   * Optional append hook, kept for parity with the React signature.
   * P3 should leave this undefined: `createCacheBinding` already bumps
   * `cacheVersion` from its own `onAppend` subscription, so passing
   * `bumpCacheVersion` here would double-bump.
   */
  bumpCacheVersion?: () => void;
}

export class ScrollControls {
  /** Reactive auto-scroll flag. */
  readonly autoScroll: Accessor<boolean>;
  /** Reactive "N new lines" badge count. */
  readonly newLinesCount: Accessor<number>;
  /**
   * How many rows exist in the rendered index space: the line set's length when
   * one is active, else the stream total in tail mode / `totalLines` in file mode.
   */
  readonly liveTotalLines: Accessor<number>;
  /** Non-reactive mirrors, for reads inside DOM listeners. */
  readonly autoScrollRef: Ref<boolean> = { value: true };
  readonly userScrollingDownRef: Ref<boolean> = { value: false };

  private readonly _setAutoScroll: Setter<boolean>;
  private readonly _setNewLines: Setter<number>;
  private readonly _setStreamTotal: Setter<number>;
  private _pointerDown = false;
  private _el: HTMLElement | null = null;
  private _teardown: (() => void) | null = null;

  constructor(options: ScrollControlsOptions) {
    const { tailMode, totalLines, dataSource, bumpCacheVersion } = options;
    const renderedLineCount = options.renderedLineCount;

    const [autoScroll, setAutoScroll] = createSignal(true);
    const [newLinesCount, setNewLines] = createSignal(0);
    const [streamTotal, setStreamTotal] = createSignal(untrack(() => dataSource().totalLines));
    this.autoScroll = autoScroll;
    this.newLinesCount = newLinesCount;
    this._setAutoScroll = setAutoScroll;
    this._setNewLines = setNewLines;
    this._setStreamTotal = setStreamTotal;

    this.liveTotalLines = createMemo(() => {
      const rendered = renderedLineCount?.();
      if (rendered != null) return rendered;
      return tailMode() ? streamTotal() : totalLines();
    });

    // ── Re-enable auto-scroll when entering tail mode ────────────────────
    createEffect(
      on(tailMode, (tail) => {
        if (!tail) return;
        this.autoScrollRef.value = true;
        this.userScrollingDownRef.value = false;
        batch(() => {
          setAutoScroll(true);
          setNewLines(0);
        });
      }),
    );

    // ── Subscribe to streaming appends ───────────────────────────────────
    createEffect(
      on(dataSource, (ds) => {
        setStreamTotal(ds.totalLines);
        if (!ds.onAppend) return;
        const unsubscribe = ds.onAppend((_lines, total) => {
          // Lines are already in the ViewCacheHandle via broadcastToSession();
          // only the total needs to reach the render layer.
          batch(() => {
            setStreamTotal(total);
            bumpCacheVersion?.();
          });
        });
        onCleanup(unsubscribe);
      }),
    );

    // ── Badge: count new lines while scrolled away from the bottom ───────
    let prevTotal = untrack(this.liveTotalLines);
    createEffect(
      on([this.liveTotalLines, tailMode], ([live, tail]) => {
        if (tail && !this.autoScrollRef.value) {
          const delta = live - prevTotal;
          if (delta > 0) setNewLines((n) => n + delta);
        }
        prevTotal = live;
      }),
    );

    if (getOwner()) onCleanup(() => this.detach());
  }

  /** The element currently wired for scroll/keyboard/pointer interaction. */
  get element(): HTMLElement | null {
    return this._el;
  }

  /** Wire listeners onto the scroll container. Re-attaching swaps elements. */
  attach(el: HTMLElement): void {
    if (this._el === el) return;
    this.detach();
    this._el = el;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        this.userScrollingDownRef.value = false;
        this._disable();
      } else if (e.deltaY > 0) {
        this.userScrollingDownRef.value = true;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) {
        this.userScrollingDownRef.value = false;
        this._disable();
      } else if (['ArrowDown', 'PageDown', 'End'].includes(e.key)) {
        this.userScrollingDownRef.value = true;
      }
    };

    const onPointerDown = () => { this._pointerDown = true; };
    const onPointerUp = () => { this._pointerDown = false; };

    const onScroll = () => {
      // Neither branch below can fire while auto-scroll is on and no pointer is
      // down (the first needs `_pointerDown`, the second `!autoScrollRef`), so
      // bail before touching layout: tail mode scrolls itself on every batch and
      // `scrollHeight` is a forced reflow on a tree the append just dirtied.
      if (this.autoScrollRef.value && !this._pointerDown) return;

      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;

      // Scrollbar drags produce no wheel/keyboard events — pointer state is the
      // proxy for user-initiated scrollbar interaction.
      if (this._pointerDown && !nearBottom && this.autoScrollRef.value) {
        this._disable();
      }

      // Re-enable: the user scrolled (wheel/key/scrollbar drag) back to bottom.
      if (nearBottom && !this.autoScrollRef.value && (this.userScrollingDownRef.value || this._pointerDown)) {
        this.userScrollingDownRef.value = false;
        this.autoScrollRef.value = true;
        batch(() => {
          this._setAutoScroll(true);
          this._setNewLines(0);
        });
      }
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    this._teardown = () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }

  /** Remove every listener attached by `attach`. Idempotent. */
  detach(): void {
    this._teardown?.();
    this._teardown = null;
    this._el = null;
    this._pointerDown = false;
  }

  /** Re-enable auto-scroll, clear the badge, jump the element to the bottom. */
  resetAutoScroll(): void {
    this.autoScrollRef.value = true;
    batch(() => {
      this._setAutoScroll(true);
      this._setNewLines(0);
    });
    if (this._el) this._el.scrollTop = this._el.scrollHeight;
  }

  /** Turn auto-scroll off (used by explicit "pause" affordances). */
  disableAutoScroll(): void {
    this._disable();
  }

  /** Externally drive the stream total (e.g. a batch applied outside onAppend). */
  setStreamTotal(total: number): void {
    this._setStreamTotal(total);
  }

  private _disable(): void {
    this.autoScrollRef.value = false;
    this._setAutoScroll(false);
  }
}
