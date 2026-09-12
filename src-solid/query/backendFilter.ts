/**
 * `FilterNode` → backend pre-filter extractor.
 *
 * A framework-free port of the extraction half of React's
 * `src-next/hooks/useLogViewer/useFilterScan.ts`. The comments below are the
 * original's, because the *reasoning* is the asset here — every branch encodes
 * a false-positive/false-negative decision that is not obvious from the code.
 *
 * Extracts the tightest `FilterCriteria` that is a *superset* of the full
 * expression — meaning every line the JS filter would match is also matched by
 * the backend pre-filter, but the backend may include false positives.
 *
 * The caller always runs JS `matchesFilter()` on the backend candidates when
 * `needsJsPass` is true. When `needsJsPass` is false the backend result is
 * exact.
 *
 * Returns null when the backend cannot reduce the search space at all (e.g., a
 * top-level NOT, a bare `tid:`, a heterogeneous OR) — in that case the caller
 * falls back to a full JS scan of all lines.
 */
import type { FilterNode } from '@filter/index';
import type { FilterCriteria, LogLevel } from '@bridge/types';

const BACKEND_LEVEL_MAP: Partial<Record<string, LogLevel>> = {
  V: 'Verbose', VERBOSE: 'Verbose',
  D: 'Debug',   DEBUG: 'Debug',
  I: 'Info',    INFO: 'Info',
  W: 'Warn',    WARN: 'Warn', WARNING: 'Warn',
  E: 'Error',   ERROR: 'Error',
  F: 'Fatal',   FATAL: 'Fatal',
};

export interface BackendFilter {
  criteria: FilterCriteria;
  /**
   * When true the backend result is only a superset — the caller must
   * re-validate every candidate page with JS `matchesFilter()`. When false the
   * backend result is exact.
   */
  needsJsPass: boolean;
}

/** Every `FilterCriteria` field is required (nullable) on the wire — this is the
 *  "nothing set" base that partial-criteria literals below spread onto. */
export const EMPTY_CRITERIA: FilterCriteria = {
  textSearch: null,
  regex: null,
  logLevels: null,
  tags: null,
  timeStart: null,
  timeEnd: null,
  pids: null,
  combine: 'and',
};

/** Returns a single-field criteria, or null when the field has no backend equivalent. */
function fromLeaf(field: string, value: string): BackendFilter | null {
  switch (field) {
    case 'level': {
      const level = BACKEND_LEVEL_MAP[value.toUpperCase()];
      if (!level) return null;
      return { criteria: { ...EMPTY_CRITERIA, logLevels: [level] }, needsJsPass: false };
    }
    case 'pid': {
      const n = parseInt(value, 10);
      if (isNaN(n)) return null;
      return { criteria: { ...EMPTY_CRITERIA, pids: [n] }, needsJsPass: false };
    }
    case 'tag':
      // Backend does case-insensitive substring — same semantics as frontend.
      return { criteria: { ...EMPTY_CRITERIA, tags: [value] }, needsJsPass: false };
    case 'message':
    case 'raw':
      // Backend textSearch checks the raw line (which contains message as a
      // suffix). Use it as a pre-filter superset; JS confirms the exact field.
      return { criteria: { ...EMPTY_CRITERIA, textSearch: value }, needsJsPass: true };
    // tid: has no FilterCriteria equivalent. Neither does package: — its value
    // is a name that only resolves to pids at scan time, so it stays a JS-only
    // concern and the whole expression falls back to a full JS scan.
    default:
      return null;
  }
}

/** Merge source criteria fields into target (union semantics per field). */
function merge(target: FilterCriteria, source: FilterCriteria): void {
  if (source.logLevels) target.logLevels = [...(target.logLevels ?? []), ...source.logLevels];
  if (source.pids)      target.pids      = [...(target.pids      ?? []), ...source.pids];
  if (source.tags)      target.tags      = [...(target.tags      ?? []), ...source.tags];
  // Keep the longer (more specific) textSearch — a longer needle produces
  // fewer false positives from the backend pre-filter.
  if (source.textSearch && (!target.textSearch || source.textSearch.length > target.textSearch.length))
    target.textSearch = source.textSearch;
}

function fromNode(n: FilterNode): BackendFilter | null {
  if (n.kind === 'not') {
    // NOT cannot be expressed as a superset in FilterCriteria — the complement
    // of a filter could match almost every line, giving no useful reduction.
    // Signal that the full file must be JS-scanned.
    return null;
  }

  if (n.kind === 'field') return fromLeaf(n.field, n.value);

  if (n.kind === 'text') {
    // Backend textSearch is raw-line only; frontend also checks tag and
    // message. For standard log formats message is a suffix of raw, so they're
    // equivalent — but mark needsJsPass to be safe.
    return { criteria: { ...EMPTY_CRITERIA, textSearch: n.value }, needsJsPass: true };
  }

  if (n.kind === 'or') {
    // For OR we need ALL branches represented in the backend; if any branch is
    // uncovered the backend would miss lines from that branch (false
    // negatives). Partial OR extraction is not safe.
    const childResults = n.children.map(fromNode);
    if (childResults.some((r) => r === null)) return null;
    const merged: FilterCriteria = { ...EMPTY_CRITERIA, combine: 'or' };
    let needsJs = false;
    for (const r of childResults as BackendFilter[]) {
      merge(merged, r.criteria);
      if (r.needsJsPass) needsJs = true;
    }
    return { criteria: merged, needsJsPass: needsJs };
  }

  if (n.kind === 'and') {
    // For AND we can take a partial extraction: if some children cannot be
    // expressed in FilterCriteria we simply omit them and let the JS pass
    // handle them. The result is a superset (backend may return some false
    // positives for the uncovered children).
    const merged: FilterCriteria = { ...EMPTY_CRITERIA };
    let anyExtracted = false;
    let needsJs = false;
    for (const child of n.children) {
      const r = fromNode(child);
      if (r === null) {
        needsJs = true; // this child needs JS evaluation
      } else {
        // A heterogeneous OR child (e.g. `level:E | tag:Activity`) has
        // combine='or' with multiple field types. Merging it into the AND
        // criteria would silently convert it to AND semantics, producing false
        // negatives. Skip it and let the JS pass handle it.
        const isHeterogeneousOr = r.criteria.combine === 'or' &&
          [r.criteria.logLevels, r.criteria.pids, r.criteria.tags, r.criteria.textSearch].filter(Boolean).length > 1;
        if (isHeterogeneousOr) {
          needsJs = true;
        } else {
          merge(merged, r.criteria);
          if (r.needsJsPass) needsJs = true;
          anyExtracted = true;
        }
      }
    }
    if (!anyExtracted) return null;
    // Multiple different field types → AND semantics between them.
    const fieldCount = [merged.logLevels, merged.pids, merged.tags, merged.textSearch].filter(Boolean).length;
    if (fieldCount > 1) merged.combine = 'and';
    return { criteria: merged, needsJsPass: needsJs };
  }

  return null;
}

/**
 * Extract the tightest backend-expressible superset of `node`.
 *
 * Pure — no IPC, no reactivity. `null` means "the backend cannot reduce this at
 * all; scan every line in JS".
 */
export function buildBackendFilter(node: FilterNode): BackendFilter | null {
  return fromNode(node);
}
