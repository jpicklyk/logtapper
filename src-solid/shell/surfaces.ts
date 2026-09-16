import type { Mode } from './mode';
import type { Tier } from './tier';
import { TIERS } from './tier';

/** The surfaces of brief §4. A surface is a destination, not a component. */
export type SurfaceId =
  | 'workspace-home'
  | 'viewer'
  | 'sections'
  | 'analyzers'
  | 'device-state'
  | 'analyses'
  | 'watches'
  | 'stream-controls'
  | 'timeline'
  | 'presence'
  | 'export'
  | 'settings';

/** Persistent grid regions, in left-to-right order. `rail` is always present. */
export type RegionId = 'rail' | 'navigator' | 'viewer' | 'details' | 'analyses' | 'presence';

/** Columns the shell lays out, in order. `viewer` is never absent. */
export const REGION_ORDER: readonly RegionId[] = ['navigator', 'viewer', 'details', 'analyses', 'presence'];

export type Placement =
  | { readonly kind: 'region'; readonly region: RegionId }
  | { readonly kind: 'rail' }
  | { readonly kind: 'drawer' };

const R = (region: RegionId): Placement => ({ kind: 'region', region });
const RAIL: Placement = { kind: 'rail' };
const DRAWER: Placement = { kind: 'drawer' };

/** One placement per tier, indexed by `TIERS` (compact, standard, wide, ultrawide). */
export type TierPlacements = readonly [Placement, Placement, Placement, Placement];

export interface SurfaceDef {
  readonly id: SurfaceId;
  readonly title: string;
  /** Two letters for the icon rail. Chosen by hand, not derived from the
   *  title: `Sections`/`Settings` and `Analyzers`/`Analyses` share a prefix. */
  readonly glyph: string;
  /** One line from brief §4, shown by the shell's placeholder panels. */
  readonly description: string;
  readonly modes: readonly Mode[];
  readonly placement: TierPlacements;
}

const BOTH: readonly Mode[] = ['postmortem', 'live'];
const POSTMORTEM: readonly Mode[] = ['postmortem'];
const LIVE: readonly Mode[] = ['live'];

/**
 * Brief §4 crossed with §6.2.
 *
 * Compact keeps every surface reachable: the navigator surfaces and presence
 * collapse to the rail, the analyzer-family surfaces become drawers. Standard
 * is three columns, so presence and analyses share `details` with the
 * analyzer surfaces; wide and ultra-wide promote presence AND analyses to
 * their own columns (analyses sits between details and presence), so a
 * published analysis reads in a pane of its own instead of a card under the
 * analyzers.
 */
export const SURFACES: readonly SurfaceDef[] = [
  {
    id: 'workspace-home',
    title: 'Workspace',
    glyph: 'WO',
    description: 'Sessions, packs, recent analyses, agent activity, open and attach actions.',
    modes: BOTH,
    placement: [RAIL, RAIL, RAIL, RAIL],
  },
  {
    id: 'viewer',
    title: 'Viewer',
    glyph: 'VW',
    description: 'Virtualized log view with one query bar: level, tag, time and regex chips.',
    modes: BOTH,
    placement: [R('viewer'), R('viewer'), R('viewer'), R('viewer')],
  },
  {
    id: 'sections',
    title: 'Sections',
    glyph: 'SC',
    description: 'Bugreport and dumpstate section navigator.',
    modes: POSTMORTEM,
    placement: [RAIL, R('navigator'), R('navigator'), R('navigator')],
  },
  {
    id: 'analyzers',
    title: 'Analyzers',
    glyph: 'AZ',
    description: 'The active analyzer set and its results; replaces chain, dashboard and library.',
    modes: BOTH,
    placement: [DRAWER, R('details'), R('details'), R('details')],
  },
  {
    id: 'device-state',
    title: 'Device state',
    glyph: 'DS',
    description: "The analyzers' understanding of the device: cursor-tied post-mortem, now in live.",
    modes: BOTH,
    placement: [DRAWER, R('details'), R('details'), R('details')],
  },
  {
    id: 'analyses',
    title: 'Analyses',
    glyph: 'AN',
    description: 'Line-anchored findings, agent- or human-authored, with their reader.',
    modes: POSTMORTEM,
    placement: [DRAWER, R('details'), R('analyses'), R('analyses')],
  },
  // Bookmarks are not a surface of their own any more: they are workspace
  // content (saved in the `.ltw` beside the sessions) and stacked under the
  // sections tree they kept getting pushed off-screen by, so `BookmarksPanel`
  // now renders inside `workspace-home` (see `workspace/WorkspaceHome.tsx`).
  {
    id: 'watches',
    title: 'Watches',
    glyph: 'WA',
    description: 'Match badges, pause and resume, and the agent subscriptions in effect.',
    modes: LIVE,
    placement: [RAIL, R('navigator'), R('navigator'), R('navigator')],
  },
  {
    id: 'stream-controls',
    title: 'Stream',
    glyph: 'ST',
    description: 'Device picker, package filter, start and stop, save capture.',
    modes: LIVE,
    placement: [RAIL, R('navigator'), R('navigator'), R('navigator')],
  },
  {
    id: 'timeline',
    title: 'Timeline',
    glyph: 'TL',
    description: 'On-demand scrub strip inside the viewer, not a standing pane.',
    modes: POSTMORTEM,
    placement: [R('viewer'), R('viewer'), R('viewer'), R('viewer')],
  },
  {
    id: 'presence',
    title: 'Agent',
    glyph: 'AG',
    description: 'Agent status, activity feed, consent prompts and focus handoff.',
    modes: BOTH,
    placement: [RAIL, R('details'), R('presence'), R('presence')],
  },
  {
    id: 'export',
    title: 'Export',
    glyph: 'EX',
    description: 'Share a capture or a finding; the anonymize option is always explicit.',
    modes: BOTH,
    placement: [RAIL, RAIL, RAIL, RAIL],
  },
  {
    id: 'settings',
    title: 'Settings',
    glyph: 'SE',
    description: 'MCP integration and agent access first, then packs and PII detectors.',
    modes: BOTH,
    placement: [RAIL, RAIL, RAIL, RAIL],
  },
];

const BY_ID = new Map<SurfaceId, SurfaceDef>(SURFACES.map((def) => [def.id, def]));

export function surfaceById(id: SurfaceId): SurfaceDef | undefined {
  return BY_ID.get(id);
}

export function existsInMode(id: SurfaceId, mode: Mode): boolean {
  return BY_ID.get(id)?.modes.includes(mode) ?? false;
}

/**
 * Where a surface lives for this mode and tier, or `null` when the surface does
 * not exist in the mode at all (brief §3: "panes are not tied to mode" is the
 * complaint; the mode-to-surface map is the fix).
 */
export function placementFor(surface: SurfaceId, mode: Mode, tier: Tier): Placement | null {
  const def = BY_ID.get(surface);
  if (!def || !def.modes.includes(mode)) return null;
  return def.placement[TIERS.indexOf(tier)];
}

function matching(mode: Mode, tier: Tier, predicate: (p: Placement) => boolean): SurfaceDef[] {
  return SURFACES.filter((def) => {
    const placement = placementFor(def.id, mode, tier);
    return placement !== null && predicate(placement);
  });
}

/** Surfaces docked in one region, in `SURFACES` order. */
export function regionSurfaces(region: RegionId, mode: Mode, tier: Tier): SurfaceDef[] {
  return matching(mode, tier, (p) => p.kind === 'region' && p.region === region);
}

/** Surfaces that live on the icon rail for this mode and tier. */
export function railSurfaces(mode: Mode, tier: Tier): SurfaceDef[] {
  return matching(mode, tier, (p) => p.kind === 'rail');
}

/** Surfaces that open as an overlay drawer for this mode and tier. */
export function drawerSurfaces(mode: Mode, tier: Tier): SurfaceDef[] {
  return matching(mode, tier, (p) => p.kind === 'drawer');
}

/**
 * The columns the shell actually renders, in order. A region with no surfaces
 * is dropped, which is how standard loses its `presence` column (presence moves
 * into `details`) and how compact collapses to rail + viewer.
 */
export function activeRegions(mode: Mode, tier: Tier): RegionId[] {
  return REGION_ORDER.filter(
    (region) => region === 'viewer' || regionSurfaces(region, mode, tier).length > 0,
  );
}
