import { useState, useCallback, useRef } from 'react';
import { getLines, getPackagePids, searchLogs } from '../../bridge/commands';
import { parseFilter, matchesFilter, extractPackageNames, FilterParseError, type FilterNode } from '../../../src/filter';
import { useViewerContext } from '../../context/ViewerContext';
import type { CacheController } from '../../cache';
import type { SharedLogViewerRefs } from './types';

export interface FilterScanResult {
  filterScanning: boolean;
  filteredLineNums: number[] | null;
  filterParseError: string | null;
  timeFilterLineNums: number[] | null;
  setStreamFilter: (expr: string) => Promise<void>;
  setTimeFilter: (start: string, end: string) => Promise<void>;
  /** Append newly matched line numbers from an ADB batch. Called via ref by useStreamSession. */
  appendMatches: (lineNums: number[]) => void;
  reset: () => void;
}

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

  const appendMatches = useCallback((lineNums: number[]) => {
    if (lineNums.length > 0) {
      setFilteredLineNums((prev) => [...(prev ?? []), ...lineNums]);
    }
  }, []);

  const reset = useCallback(() => {
    setFilterParseError(null);
    setFilterScanning(false);
    setFilteredLineNums(null);
    refs.filterAstRef.current = null;
    refs.packagePidsRef.current = new Map();
    setTimeFilterLineNums(null);
  }, [refs.filterAstRef, refs.packagePidsRef]);

  const setStreamFilter = useCallback(async (expr: string) => {
    setStreamFilterCtx(expr);
    const gen = ++filterScanGenRef.current;

    if (!expr.trim()) {
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
      const sess = refs.sessionRef.current;
      if (!sess) return;

      setFilterScanning(true);
      const BATCH = 5000;
      const matches: number[] = [];
      let offset = 0;
      let total = Infinity;

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
          for (const line of window.lines) {
            if (matchesFilter(ast, line, pids)) matches.push(line.lineNum);
          }
          offset += window.lines.length;
          if (window.lines.length === 0) break;
        } catch {
          break;
        }
      }
      if (filterScanGenRef.current === gen) {
        setFilteredLineNums(matches.length > 0 ? matches : null);
        setFilterScanning(false);
      }
    }
  }, [cacheManager, setStreamFilterCtx, refs.filterAstRef, refs.packagePidsRef,
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

  return {
    filterScanning,
    filteredLineNums,
    filterParseError,
    timeFilterLineNums,
    setStreamFilter,
    setTimeFilter,
    appendMatches,
    reset,
  };
}
