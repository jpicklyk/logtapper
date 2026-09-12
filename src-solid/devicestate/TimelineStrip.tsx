/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
// The one framework-free file under src-next/components/StateTimeline/ — pure
// line/viewport math, reused verbatim rather than reimplemented. See
// `deviceStateStore.ts`'s module doc for why this strip does not draw
// `ChartData`/`DataSeries` (Reporter-only, unreachable for a state tracker).
import { linePct } from '@statetimeline/timelineUtils';
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
 *  is fixed at the full range (`vpS=0, vpSpan=1`). */
function xPct(lineNum: number, maxLine: number): number {
  return parseFloat(linePct(lineNum, maxLine, 0, 1));
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

  const jumpAt = (clientX: number, rect: DOMRect): void => {
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1)));
    props.controller.scrollToLine(props.sessionId, Math.round(frac * maxLine()), { source: 'user' });
  };

  const startScrub: JSX.EventHandler<SVGSVGElement, PointerEvent> = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    jumpAt(event.clientX, rect);
    const onMove = (e: PointerEvent): void => jumpAt(e.clientX, rect);
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

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') setOpen(false);
  };
  window.addEventListener('keydown', onKeyDown);
  onCleanup(() => {
    window.removeEventListener('keydown', onKeyDown);
    stopScrub?.();
  });

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
                    aria-label={`${track.trackerName} timeline`}
                    aria-valuemin={0}
                    aria-valuemax={maxLine()}
                    aria-valuenow={cursorLine() ?? 0}
                    onPointerDown={startScrub}
                  >
                    <line x1={0} y1={8} x2={100} y2={8} class={styles.timelineBaseline} />
                    <For each={track.transitions}>
                      {(t) => {
                        const x = xPct(t.lineNum, maxLine());
                        return <line x1={x} y1={2} x2={x} y2={14} class={styles.timelineTick} />;
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
