/** Public API of the sections navigator (W3). */
export { createSectionsStore, activeSectionIndexAt, linesForSelection, NOTICE_MS, OUTSIDE_FILTER_NOTICE } from './sectionsStore';
export type { SectionsStore, SectionsStoreDeps } from './sectionsStore';

export { SectionsPanel } from './SectionsPanel';
export type { SectionsPanelProps } from './SectionsPanel';

export { SectionTree, flattenRows } from './SectionTree';
export type { FlatRow, SectionTreeProps } from './SectionTree';
