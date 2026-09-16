/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
// `@timeline`'s framework-free timeline math — pure
// line/viewport math, reused verbatim rather than reimplemented. See
// `deviceStateStore.ts`'s module doc for why this strip does not draw
// `ChartData`/`DataSeries` (Reporter-only, unreachable for a state tracker).
import { linePct } from '@timeline';
import type { DeviceStateController, DeviceStateStore } from './deviceStateStore';
import styles from './devicestate.module.css';

export interface TimelineStripProps {
  store: DeviceStateStore;
  controller: DeviceStateController;
  sessionId: string;
  /** Session's total line count — the strip always shows the full range
   *  (no zoom/pan in this phase; `timelineUtils`' `doZoom`/`doPan` are ready
   *  for whoever adds that). */
  totalLines: number;
}

/** `linePct` returns a CSS percentage string (e.g. `"42.5000%"`); the strip
 *  draws in an SVG viewBox, so the numeric value is what's needed. Viewport
 *  is fixed at the full range (`vpS=0, vpSpan=1`).
 *
 *  Clamped to `0..100` (review C-L6): `linePct` does not clamp, and a
 *  transition recorded beyond the session's current `totalLines` — which is
 *  exactly what a live capture produces between an append and the next
 *  `totalLines` push — would otherwise draw outside the viewBox. */
function xPct(lineNum: number, maxLine: number): number {
  const pct = parseFloat(linePct(lineNum, maxLine, 0, 1));
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/**
 * On-demand timeline strip (W5): a toggle button that opens a compact,
 * hand-rolled-SVG strip with one track per active, timeline-enabled state
 * tracker — transition ticks plus a cursor marker. Click or drag anywhere in
 * a track jumps the viewer there; Esc collapses the strip.
 *
 * No pointer-capture API (jsdom does not implement it) — the drag listens on
 * `window` for the gesture's lifetime, the same pattern `shell/Splitter.tsx`
 * uses for exactly the same reason.
 */
export function TimelineStrip(props: TimelineStripProps) {
  const [open, setOpen] = createSignal(false);
  let stopScrub: (() => void) | undefined;

  const maxLine = createMemo(() => Math.max(props.totalLines - 1, 1));

  const tracks = createMemo(() => {
    const ids = props.store.trackers(props.sessionId).map((t) => t.id);
    const result = [];
    for (const id of ids) {
      const track = props.store.timeline(props.sessionId, id);
      if (track && track.transitions.length > 0) result.push(track);
    }
    return result;
  });

  const cursorLine = createMemo(() => {
    const cursor = props.controller.cursor();
    return cursor && cursor.sessionId === props.sessionId ? cursor.line : null;
  });

  const jumpTo = (line: number): void => {
    props.controller.scrollToLine(props.sessionId, Math.min(maxLine(), Math.max(0, line)), {
      source: 'user',
    });
  };

  const jumpAt = (clientX: number, track: SVGSVGElement): void => {
    // Measured per move, not captured at pointerdown (review C-L8): a scroll
    // or a resize mid-gesture moves the track under the pointer, and a stale
    // rect maps the rest of the drag to the wrong lines.
    const rect = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1)));
    jumpTo(Math.round(frac * maxLine()));
  };

  const startScrub: JSX.EventHandler<SVGSVGElement, PointerEvent> = (event) => {
    const track = event.currentTarget;
    jumpAt(event.clientX, track);
    const onMove = (e: PointerEvent): void => jumpAt(e.clientX, track);
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      stopScrub = undefined;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    stopScrub = onUp;
  };

  /** Keyboard operation for the `role="slider"` tracks (review C-L7): the
   *  role promises an operable widget, so Arrow/Page/Home/End move the cursor
   *  the way a real slider does. Step sizes are a share of the range, since
   *  one line out of a million is not a useful increment. */
  const onTrackKeyDown: JSX.EventHandler<SVGSVGElement, KeyboardEvent> = (event) => {
    const span = maxLine();
    const step = Math.max(1, Math.round(span / 100));
    const page = Math.max(1, Math.round(span / 10));
    const from = cursorLine() ?? 0;
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = from - step;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = from + step;
    else if (event.key === 'PageDown') next = from - page;
    else if (event.key === 'PageUp') next = from + page;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = span;
    if (next === null) return;
    event.preventDefault();
    jumpTo(next);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') setOpen(false);
  };
  // Registered from an effect, never the render body (review C-L4) — and only
  // while the strip is actually open, so Escape anywhere in the app does not
  // reach a collapsed strip. `onCleanup` inside a `createEffect` runs both on
  // the next re-run and on disposal.
  createEffect(() => {
    if (!open()) return;
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });
  onCleanup(() => stopScrub?.());

  return (
    <div class={styles.timelineWrap}>
      <button
        type="button"
        class={styles.timelineToggle}
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
      >
        Timeline {open() ? '▾' : '▸'}
      </button>
      <Show when={open()}>
        <div class={styles.timelineStrip} role="group" aria-label="Timeline">
          <Show when={tracks().length > 0} fallback={<div class={styles.timelineEmpty}>No transitions recorded</div>}>
            <For each={tracks()}>
              {(track) => (
                <div class={styles.timelineTrack}>
                  <span class={styles.timelineTrackLabel}>{track.trackerName}</span>
                  <svg
                    class={styles.timelineSvg}
                    viewBox="0 0 100 16"
                    preserveAspectRatio="none"
                    role="slider"
                    tabindex={0}
                    aria-label={`${track.trackerName} timeline`}
                    aria-valuemin={0}
                    aria-valuemax={maxLine()}
                    aria-valuenow={cursorLine() ?? 0}
                    onPointerDown={startScrub}
                    onKeyDown={onTrackKeyDown}
                  >
                    <line x1={0} y1={8} x2={100} y2={8} class={styles.timelineBaseline} />
                    <For each={track.transitions}>
                      {(t) => {
                        // An accessor, not a value computed once at row
                        // creation (review C-L6): `maxLine()` changes while a
                        // file finishes indexing or a stream appends, and the
                        // ticks have to move with it exactly as the cursor
                        // marker below already does.
                        const x = () => xPct(t.lineNum, maxLine());
                        return <line x1={x()} y1={2} x2={x()} y2={14} class={styles.timelineTick} />;
                      }}
                    </For>
                    <Show when={cursorLine() !== null}>
                      {(() => {
                        const x = () => xPct(cursorLine() as number, maxLine());
                        return <line x1={x()} y1={0} x2={x()} y2={16} class={styles.timelineCursor} />;
                      })()}
                    </Show>
                  </svg>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
