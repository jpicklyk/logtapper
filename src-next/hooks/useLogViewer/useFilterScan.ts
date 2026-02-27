import { useState, useCallback, useRef } from 'react';
import {
  getLines,
  getPackagePids,
  searchLogs,
  createFilter,
  getFilteredLines,
  cancelFilter,
  closeFilter,
} from '../../bridge/commands';
import { onFilterProgress } from '../../bridge/events';
import { parseFilter, matchesFilter, extractPackageNames, FilterParseError, type FilterNode } from '../../../src/filter';
import { useViewerContext } from '../../context/ViewerContext';
import type { CacheController } from '../../cache';
import type { SharedLogViewerRefs } from './types';
import type { FilterCriteria, LogLevel } from '../../bridge/types';

export interface FilterScanResult {
  filterScanning: boolean;
  filteredLineNums: number[] | null;
  filterParseError: string | null;
  timeFilterLineNums: number[] | null;
  setStreamFilter: (expr: string) => Promise<void>;
  /** Cancel any active scan and clear results without changing the stored expression. */
  cancelStreamFilter: () => void;
  setTimeFilter: (start: string, end: string) => Promise<void>;
  /** Append newly matched line numbers from an ADB batch. Called via ref by useStreamSession. */
  appendMatches: (lineNums: number[]) => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// FilterNode → backend pre-filter extractor
//
// Extracts the tightest FilterCriteria that is a *superset* of the full
// expression — meaning every line the JS filter would match is also matched
// by the backend pre-filter, but the backend may include false positives.
//
// The caller always runs JS matchesFilter() on the backend candidates when
// needsJsPass is true. When needsJsPass is false the backend result is exact.
//
// Returns null when the backend cannot reduce the search space at all
// (e.g., a top-level NOT) — in that case the caller falls back to a full
// JS scan of all lines.
// ---------------------------------------------------------------------------

const BACKEND_LEVEL_MAP: Partial<Record<string, LogLevel>> = {
  V: 'Verbose', VERBOSE: 'Verbose',
  D: 'Debug',   DEBUG: 'Debug',
  I: 'Info',    INFO: 'Info',
  W: 'Warn',    WARN: 'Warn', WARNING: 'Warn',
  E: 'Error',   ERROR: 'Error',
  F: 'Fatal',   FATAL: 'Fatal',
};

interface BackendFilter {
  criteria: FilterCriteria;
  /** When true the backend result is exact — no JS second pass needed. */
  needsJsPass: boolean;
}

function buildBackendFilter(node: FilterNode): BackendFilter | null {
  // Returns a single-field criteria or null.
  function fromLeaf(field: string, value: string): BackendFilter | null {
    switch (field) {
      case 'level': {
        const level = BACKEND_LEVEL_MAP[value.toUpperCase()];
        if (!level) return null;
        return { criteria: { logLevels: [level] }, needsJsPass: false };
      }
      case 'pid': {
        const n = parseInt(value, 10);
        if (isNaN(n)) return null;
        return { criteria: { pids: [n] }, needsJsPass: false };
      }
      case 'tag':
        // Backend now does case-insensitive substring — same semantics as frontend.
        return { criteria: { tags: [value] }, needsJsPass: false };
      case 'message':
      case 'raw':
        // Backend textSearch checks the raw line (which contains message as a
        // suffix). Use it as a pre-filter superset; JS confirms the exact field.
        return { criteria: { textSearch: value }, needsJsPass: true };
      // tid: has no FilterCriteria equivalent.
      default:
        return null;
    }
  }

  // Merge source criteria fields into target (union semantics per field).
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
      // NOT cannot be expressed as a superset in FilterCriteria — the
      // complement of a filter could match almost every line, giving no
      // useful reduction. Signal that the full file must be JS-scanned.
      return null;
    }

    if (n.kind === 'field') return fromLeaf(n.field, n.value);

    if (n.kind === 'text') {
      // Backend textSearch is raw-line only; frontend also checks tag and
      // message. For standard log formats message is a suffix of raw, so
      // they're equivalent — but mark needsJsPass to be safe.
      return { criteria: { textSearch: n.value }, needsJsPass: true };
    }

    if (n.kind === 'or') {
      // For OR we need ALL branches represented in the backend; if any
      // branch is uncovered the backend would miss lines from that branch
      // (false negatives). Partial OR extraction is not safe.
      const childResults = n.children.map(fromNode);
      if (childResults.some(r => r === null)) return null;
      const merged: FilterCriteria = { combine: 'or' };
      let needsJs = false;
      for (const r of childResults as BackendFilter[]) {
        merge(merged, r.criteria);
        if (r.needsJsPass) needsJs = true;
      }
      return { criteria: merged, needsJsPass: needsJs };
    }

    if (n.kind === 'and') {
      // For AND we can take a partial extraction: if some children cannot
      // be expressed in FilterCriteria we simply omit them and let the JS
      // pass handle them. The result is a superset (backend may return some
      // false positives for the uncovered children).
      const merged: FilterCriteria = {};
      let anyExtracted = false;
      let needsJs = false;
      for (const child of n.children) {
        const r = fromNode(child);
        if (r === null) {
          needsJs = true; // this child needs JS evaluation
        } else {
          // A heterogeneous OR child (e.g. `level:E | tag:Activity`) has
          // combine='or' with multiple field types. Merging it into the AND
          // criteria would silently convert it to AND semantics, producing
          // false negatives. Skip it and let the JS pass handle it.
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

  return fromNode(node);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFilterScan(cacheManager: CacheController, refs: SharedLogViewerRefs): FilterScanResult {
  const {
    setStreamFilter: setStreamFilterCtx,
    setTimeFilterStart: setTimeFilterStartCtx,
    setTimeFilterEnd: setTimeFilterEndCtx,
    filterScanning,
    filteredLineNums,
    filterParseError,
    setFilterScanning,
    setFilteredLineNums,
    setFilterParseError,
  } = useViewerContext();

  const [timeFilterLineNums, setTimeFilterLineNums] = useState<number[] | null>(null);

  const filterScanGenRef = useRef(0);

  // Active backend filter — cancelled when a new expression arrives.
  const activeFilterIdRef = useRef<string | null>(null);
  const filterUnlistenRef = useRef<(() => void) | null>(null);

  const cancelActiveBackendFilter = useCallback(() => {
    if (activeFilterIdRef.current) {
      cancelFilter(activeFilterIdRef.current).catch(() => {});
      closeFilter(activeFilterIdRef.current).catch(() => {});
      activeFilterIdRef.current = null;
    }
    filterUnlistenRef.current?.();
    filterUnlistenRef.current = null;
  }, []);

  const appendMatches = useCallback((lineNums: number[]) => {
    if (lineNums.length > 0) {
      setFilteredLineNums((prev) => [...(prev ?? []), ...lineNums]);
    }
  }, []);

  const reset = useCallback(() => {
    cancelActiveBackendFilter();
    setFilterParseError(null);
    setFilterScanning(false);
    setFilteredLineNums(null);
    refs.filterAstRef.current = null;
    refs.packagePidsRef.current = new Map();
    setTimeFilterLineNums(null);
  }, [cancelActiveBackendFilter, refs.filterAstRef, refs.packagePidsRef]);

  const setStreamFilter = useCallback(async (expr: string) => {
    setStreamFilterCtx(expr);
    const gen = ++filterScanGenRef.current;

    if (!expr.trim()) {
      cancelActiveBackendFilter();
      setFilterParseError(null);
      setFilteredLineNums(null);
      refs.filterAstRef.current = null;
      return;
    }

    let ast: FilterNode | null;
    try {
      ast = parseFilter(expr);
      setFilterParseError(null);
    } catch (e) {
      setFilterParseError(e instanceof FilterParseError ? e.message : String(e));
      refs.filterAstRef.current = null;
      setFilteredLineNums(null);
      return;
    }

    if (!ast) {
      refs.filterAstRef.current = null;
      setFilteredLineNums(null);
      return;
    }

    refs.filterAstRef.current = ast;

    const packageNames = extractPackageNames(ast);
    const serial = refs.streamDeviceSerialRef.current;
    if (serial && packageNames.length > 0) {
      const resolvePromises = packageNames
        .filter((pkg) => !refs.packagePidsRef.current.has(pkg))
        .map(async (pkg) => {
          try {
            const pids = await getPackagePids(serial, pkg);
            refs.packagePidsRef.current.set(pkg, pids);
          } catch {
            refs.packagePidsRef.current.set(pkg, []);
          }
        });
      await Promise.all(resolvePromises);
    }

    const pids = refs.packagePidsRef.current;

    if (refs.isStreamingRef.current) {
      // ── Streaming mode: filter cached lines in JS ─────────────────────────
      const nums: number[] = [];
      const sess = refs.sessionRef.current;
      if (sess) {
        for (const [lineNum, line] of cacheManager.getSessionEntries(sess.sessionId)) {
          if (matchesFilter(ast, line, pids)) nums.push(lineNum);
        }
      }
      nums.sort((a, b) => a - b);
      setFilteredLineNums(nums);
    } else {
      // ── File mode ─────────────────────────────────────────────────────────
      const sess = refs.sessionRef.current;
      if (!sess) return;

      // Cancel any previous backend filter before starting a new one.
      cancelActiveBackendFilter();

      setFilterScanning(true);

      // Extract the tightest backend pre-filter from the AST. This is always
      // a superset: the backend narrows the candidate pool, then JS applies
      // the full expression to confirm matches.
      //
      // Examples:
      //   level:E                → backend exact (needsJsPass=false)
      //   level:E tag:Activity   → backend filters to error lines only, JS checks tag
      //   tag:Activity           → null → full JS scan (backend can't help)
      //   !level:E               → null → full JS scan (NOT can't be a superset)
      const backendFilter = buildBackendFilter(ast);

      if (backendFilter) {
        // ── Backend + optional JS pass ─────────────────────────────────────
        // Rust scans the memory-mapped file natively on a background thread,
        // emitting filter-progress events. We fetch candidate ViewLines
        // progressively, optionally re-validate with JS, broadcast to cache,
        // and update filteredLineNums.
        const { criteria, needsJsPass } = backendFilter;

        let filterResult;
        try {
          filterResult = await createFilter(sess.sessionId, criteria);
        } catch (e) {
          console.error('[useFilterScan] createFilter failed:', e);
          setFilterScanning(false);
          return;
        }

        if (filterScanGenRef.current !== gen) {
          cancelFilter(filterResult.filterId).catch(() => {});
          closeFilter(filterResult.filterId).catch(() => {});
          return;
        }

        const filterId = filterResult.filterId;
        activeFilterIdRef.current = filterId;
        const matches: number[] = [];
        let lastFetched = 0;
        let listenerDone = false;
        let unlisten: (() => void) | null = null;

        const handleProgress = async (progress: { filterId: string; matchedSoFar: number; done: boolean }) => {
          if (listenerDone || progress.filterId !== filterId) return;
          if (filterScanGenRef.current !== gen) {
            listenerDone = true;
            cancelFilter(filterId).catch(() => {});
            closeFilter(filterId).catch(() => {});
            unlisten?.();
            return;
          }

          const newCount = progress.matchedSoFar - lastFetched;
          if (newCount > 0) {
            try {
              const page = await getFilteredLines(filterId, lastFetched, newCount);
              if (listenerDone || filterScanGenRef.current !== gen) return;
              lastFetched = progress.matchedSoFar;

              // JS second pass: only needed when the backend criteria is a
              // superset (e.g. backend filtered by level:E but user also
              // wants tag:Activity — JS confirms the tag).
              const confirmed = needsJsPass
                ? page.lines.filter(line => matchesFilter(ast, line, pids))
                : page.lines;

              if (confirmed.length > 0) {
                cacheManager.broadcastToSession(sess.sessionId, confirmed);
                for (const line of confirmed) matches.push(line.lineNum);
                setFilteredLineNums([...matches]);
              }
            } catch {
              // Ignore transient fetch errors; next progress event will retry.
            }
          }

          if (progress.done) {
            listenerDone = true;
            if (activeFilterIdRef.current === filterId) activeFilterIdRef.current = null;
            closeFilter(filterId).catch(() => {});
            unlisten?.();
            filterUnlistenRef.current = null;
            if (filterScanGenRef.current === gen) {
              setFilteredLineNums([...matches]);
              setFilterScanning(false);
            }
          }
        };

        onFilterProgress(handleProgress).then((fn) => {
          if (listenerDone) {
            fn(); // already done — unregister immediately
          } else {
            unlisten = fn;
            filterUnlistenRef.current = fn;
          }
        });

      } else {
        // ── JS fallback scan ───────────────────────────────────────────────
        // Used for expressions the backend can't reduce at all: top-level NOT,
        // tid:, fully heterogeneous ORs, etc.
        const BATCH = 20000;
        const FLUSH_EVERY = 3; // ~60K lines between UI updates
        const matches: number[] = [];
        let offset = 0;
        let total = Infinity;
        let batchCount = 0;

        while (offset < total) {
          if (filterScanGenRef.current !== gen) {
            setFilterScanning(false);
            return;
          }
          try {
            const window = await getLines({
              sessionId: sess.sessionId,
              mode: { mode: 'Full' },
              offset,
              count: BATCH,
              context: 0,
            });
            total = window.totalLines;
            const matchedLines: typeof window.lines = [];
            for (const line of window.lines) {
              if (matchesFilter(ast, line, pids)) {
                matches.push(line.lineNum);
                matchedLines.push(line);
              }
            }
            if (matchedLines.length > 0) {
              cacheManager.broadcastToSession(sess.sessionId, matchedLines);
            }
            batchCount++;
            const isFirstFlush = batchCount === 1 && matches.length > 0;
            if (isFirstFlush || (batchCount % FLUSH_EVERY === 0 && matches.length > 0)) {
              setFilteredLineNums([...matches]);
            }
            offset += window.lines.length;
            if (window.lines.length === 0) break;
          } catch {
            break;
          }
        }
        if (filterScanGenRef.current === gen) {
          setFilteredLineNums([...matches]);
          setFilterScanning(false);
        }
      }
    }
  }, [cancelActiveBackendFilter, cacheManager, setStreamFilterCtx, refs.filterAstRef, refs.packagePidsRef,
      refs.streamDeviceSerialRef, refs.isStreamingRef, refs.sessionRef]);

  const setTimeFilter = useCallback(async (start: string, end: string) => {
    setTimeFilterStartCtx(start);
    setTimeFilterEndCtx(end);

    if (!start.trim() && !end.trim()) {
      setTimeFilterLineNums(null);
      return;
    }

    const sess = refs.sessionRef.current;
    if (!sess) {
      setTimeFilterLineNums(null);
      return;
    }

    try {
      const summary = await searchLogs(sess.sessionId, {
        text: '',
        isRegex: false,
        caseSensitive: false,
        startTime: start.trim() || undefined,
        endTime: end.trim() || undefined,
      });
      setTimeFilterLineNums(summary.matchLineNums);
    } catch (e) {
      console.error('Time filter error:', e);
    }
  }, [setTimeFilterStartCtx, setTimeFilterEndCtx, refs.sessionRef]);

  const cancelStreamFilter = useCallback(() => {
    cancelActiveBackendFilter();
    setFilterScanning(false);
    setFilteredLineNums(null);
    setFilterParseError(null);
    refs.filterAstRef.current = null;
  }, [cancelActiveBackendFilter, refs.filterAstRef]);

  return {
    filterScanning,
    filteredLineNums,
    filterParseError,
    timeFilterLineNums,
    setStreamFilter,
    cancelStreamFilter,
    setTimeFilter,
    appendMatches,
    reset,
  };
}
