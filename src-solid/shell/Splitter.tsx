/** @jsxImportSource solid-js */
import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { RegionId } from './surfaces';
import styles from './shell.module.css';

/** The columns a splitter can resize — `rail` is fixed, `viewer` takes the rest. */
export type ResizableRegion = Exclude<RegionId, 'rail' | 'viewer'>;

export const RESIZABLE_REGIONS: readonly ResizableRegion[] = ['navigator', 'details', 'presence'];

export const DEFAULT_REGION_WIDTH: Record<ResizableRegion, number> = {
  navigator: 280,
  details: 420,
  presence: 340,
};

export const MIN_REGION_WIDTH: Record<ResizableRegion, number> = {
  navigator: 180,
  details: 280,
  presence: 220,
};

export const MAX_REGION_WIDTH = 900;

/** Keyboard resize step, in px, for the separator's arrow keys. */
const KEY_STEP = 16;

/**
 * Widths are per workspace (brief §6.2: "an investigation opened on the
 * ultra-wide comes back the same way"). `localStorage` is this phase's store;
 * moving them into `.ltw` app-state is a parity-phase item.
 */
export const WIDTHS_STORAGE_PREFIX = 'logtapper-shell-widths';

export function widthsStorageKey(workspaceId: string): string {
  return `${WIDTHS_STORAGE_PREFIX}:${workspaceId}`;
}

export type WidthMap = Partial<Record<ResizableRegion, number>>;

function isResizable(value: string): value is ResizableRegion {
  return (RESIZABLE_REGIONS as readonly string[]).includes(value);
}

function readStored(workspaceId: string): WidthMap {
  try {
    const raw = localStorage.getItem(widthsStorageKey(workspaceId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: WidthMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isResizable(key) && typeof value === 'number' && Number.isFinite(value)) {
        out[key] = clamp(key, value);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStored(workspaceId: string, widths: WidthMap): void {
  try {
    localStorage.setItem(widthsStorageKey(workspaceId), JSON.stringify(widths));
  } catch {
    // Quota exceeded or storage disabled — the session keeps the in-memory widths.
  }
}

function clamp(region: ResizableRegion, px: number): number {
  return Math.max(MIN_REGION_WIDTH[region], Math.min(MAX_REGION_WIDTH, Math.round(px)));
}

export interface RegionWidths {
  /** Current width in px, clamped, falling back to the region default. */
  width(region: ResizableRegion): number;
  /** Set during a drag — signal only, not persisted. */
  setWidth(region: ResizableRegion, px: number): void;
  /** Persist the current widths for the active workspace (drag end / reset). */
  commit(): void;
  /** Back to the default width, persisted immediately. */
  reset(region: ResizableRegion): void;
}

/**
 * Per-workspace width store. Switching workspace reloads that workspace's
 * widths rather than carrying the previous one's over.
 */
export function createRegionWidths(workspaceId: Accessor<string>): RegionWidths {
  const [widths, setWidths] = createSignal<WidthMap>(readStored(workspaceId()));

  createEffect(
    on(
      workspaceId,
      (id) => setWidths(readStored(id)),
      { defer: true },
    ),
  );

  return {
    width: (region) => widths()[region] ?? DEFAULT_REGION_WIDTH[region],
    setWidth: (region, px) => setWidths((prev) => ({ ...prev, [region]: clamp(region, px) })),
    commit: () => writeStored(workspaceId(), widths()),
    reset: (region) => {
      setWidths((prev) => {
        const next = { ...prev };
        delete next[region];
        return next;
      });
      writeStored(workspaceId(), widths());
    },
  };
}

export interface SplitterProps {
  region: ResizableRegion;
  widths: RegionWidths;
  /**
   * Which side of the viewer the region sits on. `'start'` (left of the viewer,
   * handle on the region's trailing edge) grows with a rightward drag;
   * `'end'` (right of the viewer) grows with a leftward drag.
   */
  side: 'start' | 'end';
}

/**
 * Pointer-resizable column boundary. No drag library: pointer capture is not
 * required because the move/up listeners live on `window` for the drag's
 * lifetime, which also keeps the drag alive over iframes and the viewer canvas.
 */
export function Splitter(props: SplitterProps) {
  // The drag-active look is `:active` in CSS rather than a signal: the button
  // stays "active" on the handle for the whole press even once the pointer
  // leaves it, which is exactly the window-listener drag's lifetime.
  let drag: { move: (event: PointerEvent) => void; up: () => void } | null = null;

  const stopDrag = () => {
    if (!drag) return;
    window.removeEventListener('pointermove', drag.move);
    window.removeEventListener('pointerup', drag.up);
    window.removeEventListener('pointercancel', drag.up);
    drag = null;
  };

  onCleanup(stopDrag);

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag();

    const startX = event.clientX;
    const startWidth = props.widths.width(props.region);
    const direction = props.side === 'start' ? 1 : -1;
    const region = props.region;

    const onMove = (moveEvent: PointerEvent) => {
      props.widths.setWidth(region, startWidth + direction * (moveEvent.clientX - startX));
    };
    const onUp = () => {
      stopDrag();
      props.widths.commit();
    };

    drag = { move: onMove, up: onUp };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const direction = props.side === 'start' ? 1 : -1;
    let delta = 0;
    if (event.key === 'ArrowLeft') delta = -KEY_STEP * direction;
    else if (event.key === 'ArrowRight') delta = KEY_STEP * direction;
    else return;
    event.preventDefault();
    props.widths.setWidth(props.region, props.widths.width(props.region) + delta);
    props.widths.commit();
  };

  return (
    <div
      class={styles.splitter}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${props.region}`}
      aria-valuenow={props.widths.width(props.region)}
      aria-valuemin={MIN_REGION_WIDTH[props.region]}
      aria-valuemax={MAX_REGION_WIDTH}
      tabindex={0}
      data-side={props.side}
      onPointerDown={onPointerDown}
      onDblClick={() => props.widths.reset(props.region)}
      onKeyDown={onKeyDown}
    />
  );
}
