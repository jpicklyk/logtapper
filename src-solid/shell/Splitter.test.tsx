/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { cleanup, render } from '@solidjs/testing-library';
import {
  DEFAULT_REGION_WIDTH,
  MIN_REGION_WIDTH,
  Splitter,
  createRegionWidths,
  widthsStorageKey,
} from './Splitter';

// vitest `globals` is off, so @solidjs/testing-library's auto-cleanup never registers.
afterEach(cleanup);
beforeEach(() => localStorage.clear());

/** jsdom has no PointerEvent; a MouseEvent dispatched under the pointer type name is enough. */
function pointer(type: string, clientX: number): MouseEvent {
  return new MouseEvent(type, { clientX, bubbles: true, button: 0 });
}

function readStored(workspaceId: string): Record<string, number> {
  return JSON.parse(localStorage.getItem(widthsStorageKey(workspaceId)) ?? '{}') as Record<
    string,
    number
  >;
}

/**
 * Solid flushes effects when the root's update cycle ends, so the store's
 * workspace-change effect is only subscribed once `createRoot` has returned.
 */
function inRoot<T>(build: () => T): [T, () => void] {
  let value!: T;
  let dispose!: () => void;
  createRoot((disposer) => {
    dispose = disposer;
    value = build();
  });
  return [value, dispose];
}

describe('createRegionWidths', () => {
  it('falls back to defaults, clamps, and persists only on commit', () => {
    const [widths, dispose] = inRoot(() => createRegionWidths(() => 'ws-a'));
    expect(widths.width('navigator')).toBe(DEFAULT_REGION_WIDTH.navigator);

    widths.setWidth('navigator', 10);
    expect(widths.width('navigator')).toBe(MIN_REGION_WIDTH.navigator);
    expect(localStorage.getItem(widthsStorageKey('ws-a'))).toBeNull();

    widths.setWidth('navigator', 320);
    widths.commit();
    expect(readStored('ws-a').navigator).toBe(320);

    widths.reset('navigator');
    expect(widths.width('navigator')).toBe(DEFAULT_REGION_WIDTH.navigator);
    expect(readStored('ws-a').navigator).toBeUndefined();

    dispose();
  });

  it('keeps widths per workspace and reloads them on switch', () => {
    localStorage.setItem(widthsStorageKey('ws-b'), JSON.stringify({ details: 500 }));

    const [workspace, setWorkspace] = createSignal('ws-a');
    const [widths, dispose] = inRoot(() => createRegionWidths(workspace));

    widths.setWidth('details', 300);
    widths.commit();
    expect(readStored('ws-a').details).toBe(300);

    setWorkspace('ws-b');
    expect(widths.width('details')).toBe(500);

    setWorkspace('ws-a');
    expect(widths.width('details')).toBe(300);

    dispose();
  });

  it('ignores corrupt stored payloads', () => {
    localStorage.setItem(widthsStorageKey('ws-c'), '{ not json');
    const [widths, dispose] = inRoot(() => createRegionWidths(() => 'ws-c'));
    expect(widths.width('presence')).toBe(DEFAULT_REGION_WIDTH.presence);
    dispose();
  });

  it('toColumns reports only the regions with an explicit width', () => {
    const [widths, dispose] = inRoot(() => createRegionWidths(() => 'ws-cols'));
    expect(widths.toColumns()).toEqual({});

    widths.setWidth('navigator', 333);
    expect(widths.toColumns()).toEqual({ navigator: 333 });

    dispose();
  });

  it('applyColumns seeds a dragged width through a save/restore round trip', () => {
    const [widths, dispose] = inRoot(() => createRegionWidths(() => 'ws-roundtrip'));
    widths.setWidth('details', 501);
    widths.commit();

    const blob = widths.toColumns();
    expect(blob).toEqual({ details: 501 });

    // Simulate a fresh shell instance (e.g. reopening on another machine)
    // restoring from the saved blob rather than from localStorage.
    const [fresh, disposeFresh] = inRoot(() => createRegionWidths(() => 'ws-elsewhere'));
    fresh.applyColumns(blob);
    expect(fresh.width('details')).toBe(501);

    dispose();
    disposeFresh();
  });

  it('applyColumns leaves a region the blob has no entry for at its localStorage fallback', () => {
    localStorage.setItem(widthsStorageKey('ws-fallback'), JSON.stringify({ navigator: 260 }));
    const [widths, dispose] = inRoot(() => createRegionWidths(() => 'ws-fallback'));
    expect(widths.width('navigator')).toBe(260);

    // The restored blob only carries `details` — `navigator` must keep the
    // per-machine value already loaded, not fall back to the hardcoded default.
    widths.applyColumns({ details: 400 });
    expect(widths.width('navigator')).toBe(260);
    expect(widths.width('details')).toBe(400);

    dispose();
  });

  it('applyColumns ignores unrecognised keys and does not write localStorage', () => {
    const [widths, dispose] = inRoot(() => createRegionWidths(() => 'ws-ignore'));
    widths.applyColumns({ rail: 999, navigator: 300 });
    expect(widths.width('navigator')).toBe(300);
    // A future/unknown region name must not throw or leak into a resizable slot.
    expect(Object.keys(widths.toColumns())).toEqual(['navigator']);
    // `apply` seeds from a restore, not a drag on this machine — it must not
    // stamp the per-machine cache (see `RegionWidths.applyColumns`'s doc).
    expect(localStorage.getItem(widthsStorageKey('ws-ignore'))).toBeNull();
    dispose();
  });
});

describe('Splitter', () => {
  it('resizes on drag, persists on release, and resets on double-click', () => {
    let widths!: ReturnType<typeof createRegionWidths>;
    const { container } = render(() => {
      widths = createRegionWidths(() => 'ws-drag');
      return <Splitter region="navigator" widths={widths} side="start" />;
    });

    const handle = container.querySelector('[role="separator"]');
    expect(handle).toBeTruthy();

    handle!.dispatchEvent(pointer('pointerdown', 400));
    window.dispatchEvent(pointer('pointermove', 460));
    expect(widths.width('navigator')).toBe(DEFAULT_REGION_WIDTH.navigator + 60);
    // Not written until the drag ends.
    expect(localStorage.getItem(widthsStorageKey('ws-drag'))).toBeNull();

    window.dispatchEvent(pointer('pointerup', 460));
    expect(readStored('ws-drag').navigator).toBe(DEFAULT_REGION_WIDTH.navigator + 60);

    // Listeners are gone once the drag ended.
    window.dispatchEvent(pointer('pointermove', 900));
    expect(widths.width('navigator')).toBe(DEFAULT_REGION_WIDTH.navigator + 60);

    handle!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(widths.width('navigator')).toBe(DEFAULT_REGION_WIDTH.navigator);
    expect(readStored('ws-drag').navigator).toBeUndefined();
  });

  it('grows a trailing region when dragged left', () => {
    let widths!: ReturnType<typeof createRegionWidths>;
    const { container } = render(() => {
      widths = createRegionWidths(() => 'ws-end');
      return <Splitter region="presence" widths={widths} side="end" />;
    });

    const handle = container.querySelector('[role="separator"]')!;
    handle.dispatchEvent(pointer('pointerdown', 1000));
    window.dispatchEvent(pointer('pointermove', 940));
    expect(widths.width('presence')).toBe(DEFAULT_REGION_WIDTH.presence + 60);
    window.dispatchEvent(pointer('pointerup', 940));
  });

  it('resizes with the arrow keys and persists immediately', () => {
    let widths!: ReturnType<typeof createRegionWidths>;
    const { container } = render(() => {
      widths = createRegionWidths(() => 'ws-keys');
      return <Splitter region="details" widths={widths} side="end" />;
    });

    const handle = container.querySelector('[role="separator"]')!;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(widths.width('details')).toBe(DEFAULT_REGION_WIDTH.details + 16);
    expect(readStored('ws-keys').details).toBe(DEFAULT_REGION_WIDTH.details + 16);
  });
});
