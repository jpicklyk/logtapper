/**
 * Public API of `src-solid/watches/` (L2). Everything outside this directory
 * imports from this barrel only. Internal files (`CriteriaChips.tsx`,
 * `CreateWatchForm.tsx`) import each other/the store directly.
 */
export { createWatchesStore } from './watchesStore';
export type { WatchesCommands, WatchesStore, WatchesStoreDeps } from './watchesStore';

export { WatchesPanel } from './WatchesPanel';
export type { WatchesPanelProps } from './WatchesPanel';
