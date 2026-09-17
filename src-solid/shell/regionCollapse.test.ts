import { beforeEach, describe, expect, it } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import {
  COLLAPSED_STORAGE_PREFIX,
  REGION_ENTRY_PREFIX,
  REGION_TITLE,
  collapsedStorageKey,
  createRegionCollapse,
} from './regionCollapse';
import { RESIZABLE_REGIONS } from './Splitter';

beforeEach(() => localStorage.clear());

/**
 * Solid flushes effects when the root's update cycle ends, so the store's
 * workspace-change effect is only subscribed once `createRoot` has returned —
 * same harness as `Splitter.test.tsx`'s.
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

function readStored(workspaceId: string): unknown {
  const raw = localStorage.getItem(collapsedStorageKey(workspaceId));
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

describe('createRegionCollapse', () => {
  it('names every resizable region', () => {
    expect(Object.keys(REGION_TITLE).sort()).toEqual([...RESIZABLE_REGIONS].sort());
  });

  it('keys storage per workspace', () => {
    expect(collapsedStorageKey('ws-a')).toBe(`${COLLAPSED_STORAGE_PREFIX}:ws-a`);
  });

  it('toggles and persists to the active workspace key', () => {
    const [collapse, dispose] = inRoot(() => createRegionCollapse(() => 'ws-a'));

    expect(collapse.isCollapsed('details')).toBe(false);
    collapse.toggle('details');
    expect(collapse.isCollapsed('details')).toBe(true);
    // No drag to commit at, unlike the widths next door: a click is the whole
    // gesture, so it persists immediately.
    expect(readStored('ws-a')).toEqual(['details']);

    collapse.toggle('details');
    expect(collapse.isCollapsed('details')).toBe(false);
    expect(readStored('ws-a')).toEqual([]);

    dispose();
  });

  it('keeps the collapsed set per workspace and reloads it on switch', () => {
    localStorage.setItem(collapsedStorageKey('ws-b'), JSON.stringify(['presence']));

    const [workspace, setWorkspace] = createSignal('ws-a');
    const [collapse, dispose] = inRoot(() => createRegionCollapse(workspace));

    collapse.set('navigator', true);
    expect(collapse.isCollapsed('navigator')).toBe(true);

    setWorkspace('ws-b');
    expect(collapse.isCollapsed('navigator')).toBe(false);
    expect(collapse.isCollapsed('presence')).toBe(true);

    setWorkspace('ws-a');
    expect(collapse.isCollapsed('navigator')).toBe(true);
    expect(collapse.isCollapsed('presence')).toBe(false);

    dispose();
  });

  it('survives corrupt or hostile stored payloads', () => {
    localStorage.setItem(collapsedStorageKey('ws-a'), '{not json');
    const [broken, disposeBroken] = inRoot(() => createRegionCollapse(() => 'ws-a'));
    expect(broken.toEntries()).toEqual([]);
    disposeBroken();

    localStorage.setItem(collapsedStorageKey('ws-c'), JSON.stringify(['details', 'bogus', 7]));
    const [mixed, disposeMixed] = inRoot(() => createRegionCollapse(() => 'ws-c'));
    expect(mixed.toEntries()).toEqual([`${REGION_ENTRY_PREFIX}details`]);
    disposeMixed();
  });

  it('round-trips through the prefixed .ltw entries and ignores the rest', () => {
    const [collapse, dispose] = inRoot(() => createRegionCollapse(() => 'ws-a'));

    // A real `SolidLayout.collapsed`: the bare drawer id, then the regions.
    collapse.applyEntries(['analyzers', 'region:analyses', 'region:presence', 'region:bogus']);

    expect(collapse.toEntries()).toEqual([
      `${REGION_ENTRY_PREFIX}analyses`,
      `${REGION_ENTRY_PREFIX}presence`,
    ]);
    expect(collapse.isCollapsed('navigator')).toBe(false);

    // Entries are authoritative — a blob saved with nothing collapsed restores
    // as nothing collapsed, which is the whole reason the drawer id needed a
    // prefix to tell it apart from a region.
    collapse.applyEntries(['analyzers']);
    expect(collapse.toEntries()).toEqual([]);

    dispose();
  });

  it('does not stamp a restored blob into the per-machine cache', () => {
    const [collapse, dispose] = inRoot(() => createRegionCollapse(() => 'ws-a'));

    collapse.applyEntries(['region:presence']);
    expect(collapse.isCollapsed('presence')).toBe(true);
    // Same reasoning as `RegionWidths.applyColumns`: a restore may carry an
    // arrangement made on another machine, so the local fallback is left alone
    // until the user folds something away here themselves.
    expect(localStorage.getItem(collapsedStorageKey('ws-a'))).toBeNull();

    dispose();
  });
});
