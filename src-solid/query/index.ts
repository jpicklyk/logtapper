/**
 * `src-solid/query/` — the query surface: W2a's scan engine, W2b's query
 * store, search runner and the one query bar. Nothing outside this directory
 * imports the internal modules directly.
 */
export { buildBackendFilter, EMPTY_CRITERIA } from './backendFilter';
export type { BackendFilter } from './backendFilter';

export { FilterScan, DEFAULT_PAGE_SIZE } from './filterScan';
export type { FilterScanCommands, FilterScanDeps, FilterScanPhase } from './filterScan';

export { createQueryStore, toSearchQuery, toCriteria, DEFAULT_QUERY_STATE } from './queryStore';
export type { QueryMode, QueryState, QueryStore, QueryStoreDeps } from './queryStore';

export { createLiveFilterBindings } from './liveFilterBindings';
export type { LiveFilterBindings, LiveFilterTarget } from './liveFilterBindings';

export { createSearchRunner } from './search';
export type {
  SearchPhase,
  SearchRunner,
  SearchRunnerCommands,
  SearchRunnerDeps,
} from './search';

export { QueryBar } from './QueryBar';
export type { QueryBarProps } from './QueryBar';
