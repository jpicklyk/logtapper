import { storageGetJSON, storageSetJSON } from '../utils/index';

/**
 * localStorage for the DEFAULT processor chain — the template a new session
 * inherits. Per-session chains are persisted by the backend's per-session
 * `pipeline-meta.json` (pushed via `setSessionPipelineMeta`), never here.
 *
 * Shared by `usePipelineCommands` (reads the seed) and `usePipelineWiring`
 * (writes on every chain edit); it lives in its own module so the reader and
 * the writer cannot drift apart on the key names or the validation rules.
 */
const LS_KEY = 'logtapper_pipeline_chain';
const LS_DISABLED_KEY = 'logtapper_pipeline_disabled';

/** Persisted chain, filtered to processors that are still installed. */
export function loadChainFromStorage(validIds: Set<string>): string[] {
  const parsed = storageGetJSON<unknown>(LS_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return (parsed as unknown[]).filter((id): id is string => typeof id === 'string' && validIds.has(id));
}

/** Persisted disabled set, filtered to IDs that are actually in the chain. */
export function loadDisabledFromStorage(chainIds: Set<string>): string[] {
  const parsed = storageGetJSON<unknown>(LS_DISABLED_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return (parsed as unknown[]).filter((id): id is string => typeof id === 'string' && chainIds.has(id));
}

export function saveChainToStorage(chain: string[], disabled: string[]): void {
  storageSetJSON(LS_KEY, chain);
  storageSetJSON(LS_DISABLED_KEY, disabled);
}
