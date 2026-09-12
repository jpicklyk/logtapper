/**
 * `src-solid/query/` — the query surface's framework-free core.
 *
 * W2a owns the scan engine here. The query bar UI (W2b) adds `queryStore.ts`,
 * `search.ts` and `QueryBar.tsx` behind this same barrel; nothing outside the
 * directory imports the internal modules directly.
 */
export { buildBackendFilter, EMPTY_CRITERIA } from './backendFilter';
export type { BackendFilter } from './backendFilter';

export { FilterScan, DEFAULT_PAGE_SIZE } from './filterScan';
export type { FilterScanCommands, FilterScanDeps, FilterScanPhase } from './filterScan';
