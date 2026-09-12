export { AppShell } from './AppShell';
export type { AppShellProps, RegionSlots, SurfaceSlots } from './AppShell';
export { createMode, modeForKind } from './mode';
export type { Mode, SessionKind } from './mode';
export { TIERS, TIER_MIN_WIDTH, TIER_QUERIES, createTier, tierForWidth } from './tier';
export type { Tier } from './tier';
export {
  REGION_ORDER,
  SURFACES,
  activeRegions,
  drawerSurfaces,
  existsInMode,
  placementFor,
  railSurfaces,
  regionSurfaces,
  surfaceById,
} from './surfaces';
export type { Placement, RegionId, SurfaceDef, SurfaceId, TierPlacements } from './surfaces';
export {
  DEFAULT_REGION_WIDTH,
  MAX_REGION_WIDTH,
  MIN_REGION_WIDTH,
  RESIZABLE_REGIONS,
  Splitter,
  WIDTHS_STORAGE_PREFIX,
  createRegionWidths,
  widthsStorageKey,
} from './Splitter';
export type { RegionWidths, ResizableRegion, SplitterProps } from './Splitter';
