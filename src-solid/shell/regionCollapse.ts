import { createEffect, createSignal, on } from 'solid-js';
import type { Accessor } from 'solid-js';
import { RESIZABLE_REGIONS } from './Splitter';
import type { ResizableRegion } from './Splitter';

/**
 * Human-readable name for a resizable region, for the collapse/expand controls'
 * labels ("Collapse Details", "Expand Agent"). The region ids are layout slots,
 * not surfaces — `presence` holds the `Agent` surface — so the labels are
 * spelled out here rather than derived from the id.
 */
export const REGION_TITLE: Record<ResizableRegion, string> = {
  navigator: 'Navigator',
  details: 'Details',
  analyses: 'Analyses',
  presence: 'Agent',
};

/**
 * Collapse state is per workspace, the same as the region widths next door
 * (`Splitter.ts`'s `WIDTHS_STORAGE_PREFIX`): an investigation comes back
 * arranged the way it was left. `localStorage` is the per-machine store; the
 * `.ltw` blob carries it between machines (see {@link RegionCollapse.toEntries}).
 */
export const COLLAPSED_STORAGE_PREFIX = 'logtapper-shell-collapsed';

export function collapsedStorageKey(workspaceId: string): string {
  return `${COLLAPSED_STORAGE_PREFIX}:${workspaceId}`;
}

/**
 * Prefix that marks a `SolidLayout.collapsed` entry as a region rather than the
 * open-drawer id that field carried on its own before regions could collapse.
 * See {@link RegionCollapse.toEntries}.
 */
export const REGION_ENTRY_PREFIX = 'region:';

function isResizable(value: string): value is ResizableRegion {
  return (RESIZABLE_REGIONS as readonly string[]).includes(value);
}

function readStored(workspaceId: string): Set<ResizableRegion> {
  const out = new Set<ResizableRegion>();
  try {
    const raw = localStorage.getItem(collapsedStorageKey(workspaceId));
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return out;
    for (const value of parsed) {
      if (typeof value === 'string' && isResizable(value)) out.add(value);
    }
    return out;
  } catch {
    return out;
  }
}

function writeStored(workspaceId: string, collapsed: ReadonlySet<ResizableRegion>): void {
  try {
    localStorage.setItem(
      collapsedStorageKey(workspaceId),
      JSON.stringify(RESIZABLE_REGIONS.filter((region) => collapsed.has(region))),
    );
  } catch {
    // Quota exceeded or storage disabled — the session keeps the in-memory state.
  }
}

export interface RegionCollapse {
  /** Whether this region renders as a narrow strip instead of a column. */
  isCollapsed(region: ResizableRegion): boolean;
  /** Flip one region, persisted immediately (there is no drag to commit at). */
  toggle(region: ResizableRegion): void;
  /** Set one region explicitly, persisted immediately. */
  set(region: ResizableRegion, collapsed: boolean): void;
  /**
   * The collapsed regions as `region:<id>` strings, in `RESIZABLE_REGIONS`
   * order — exactly what `SolidLayout.collapsed` appends after the open-drawer
   * id. That field predates this store and carried the drawer id alone, so the
   * prefix is what lets `App.tsx`'s port tell the two apart in one array
   * without a schema bump: the first entry *without* it is the drawer.
   */
  toEntries(): string[];
  /**
   * Seed from a restored `.ltw` blob's `collapsed` array. Entries without the
   * `region:` prefix (the drawer id) and unknown region ids (a future region, a
   * hand-edited file) are ignored rather than throwing.
   *
   * The region entries are *authoritative*: unlike `RegionWidths.applyColumns`,
   * where a missing key means "this blob knows nothing about that region", a
   * missing region entry here is real information — the user had that column
   * open when they saved. So this replaces the set rather than merging into it,
   * and restoring a workspace saved with everything expanded expands
   * everything. The one cost is a blob written before this feature existed: it
   * carries no region entries and therefore expands every column on restore.
   *
   * Deliberately does not write `localStorage`, for the same reason
   * `applyColumns` does not: this is a restore of a blob that may have come
   * from another machine, not an arrangement the user made on this one, and
   * stamping it into the per-machine cache would make that fallback lie.
   */
  applyEntries(entries: readonly string[]): void;
}

/**
 * Per-workspace collapse store. Switching workspace reloads that workspace's
 * collapsed set rather than carrying the previous one's over — same shape and
 * same `{ defer: true }` reload as `createRegionWidths`.
 */
export function createRegionCollapse(workspaceId: Accessor<string>): RegionCollapse {
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<ResizableRegion>>(
    readStored(workspaceId()),
  );

  createEffect(
    on(
      workspaceId,
      (id) => setCollapsed(readStored(id)),
      { defer: true },
    ),
  );

  const write = (next: ReadonlySet<ResizableRegion>): void => {
    setCollapsed(next);
    writeStored(workspaceId(), next);
  };

  const set = (region: ResizableRegion, value: boolean): void => {
    const current = collapsed();
    if (current.has(region) === value) return;
    const next = new Set(current);
    if (value) next.add(region);
    else next.delete(region);
    write(next);
  };

  return {
    isCollapsed: (region) => collapsed().has(region),
    toggle: (region) => set(region, !collapsed().has(region)),
    set,
    toEntries: () => {
      const current = collapsed();
      return RESIZABLE_REGIONS.filter((region) => current.has(region)).map(
        (region) => `${REGION_ENTRY_PREFIX}${region}`,
      );
    },
    applyEntries: (entries) => {
      const next = new Set<ResizableRegion>();
      for (const entry of entries) {
        if (!entry.startsWith(REGION_ENTRY_PREFIX)) continue;
        const id = entry.slice(REGION_ENTRY_PREFIX.length);
        if (isResizable(id)) next.add(id);
      }
      setCollapsed(next);
    },
  };
}
