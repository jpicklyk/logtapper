import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type {
  FilterCriteria,
  FilteredLinesResult,
  ViewLine,
} from '../bridge/types';
import {
  createFilter,
  getFilteredLines,
  cancelFilter,
  closeFilter,
} from '../bridge/commands';
import { onFilterProgress } from '../bridge/events';

export interface FilterState {
  /** Active filter ID, or null if no filter is active. */
  filterId: string | null;
  /** Whether the backend is still scanning lines. */
  scanning: boolean;
  /** Total matches found so far. */
  totalMatches: number;
  /** Lines scanned so far (for progress display). */
  linesScanned: number;
  /** Total lines in the source (denominator for progress). */
  totalLines: number;
  /** Most recently fetched page of filtered lines. */
  lines: ViewLine[];
  /** Status of the filter: 'scanning' | 'complete' | 'cancelled' | null. */
  status: string | null;
}

const INITIAL_STATE: FilterState = {
  filterId: null,
  scanning: false,
  totalMatches: 0,
  linesScanned: 0,
  totalLines: 0,
  lines: [],
  status: null,
};

export function useFilter() {
  const [state, setState] = useState<FilterState>(INITIAL_STATE);
  const activeFilterId = useRef<string | null>(null);

  // Subscribe to filter-progress events
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onFilterProgress((payload) => {
      if (cancelled) return;
      // Only update if this is our active filter
      if (payload.filterId !== activeFilterId.current) return;

      setState((prev) => ({
        ...prev,
        totalMatches: payload.matchedSoFar,
        linesScanned: payload.linesScanned,
        totalLines: payload.totalLines,
        scanning: !payload.done,
        status: payload.done ? 'complete' : 'scanning',
      }));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const startFilter = useCallback(
    async (sessionId: string, criteria: FilterCriteria) => {
      // Cancel any existing filter first
      if (activeFilterId.current) {
        try {
          await closeFilter(activeFilterId.current);
        } catch {
          // ignore
        }
      }

      const result = await createFilter(sessionId, criteria);
      activeFilterId.current = result.filterId;

      setState({
        filterId: result.filterId,
        scanning: true,
        totalMatches: 0,
        linesScanned: 0,
        totalLines: result.totalLines,
        lines: [],
        status: 'scanning',
      });

      return result.filterId;
    },
    [],
  );

  const fetchPage = useCallback(
    async (offset: number, count: number): Promise<FilteredLinesResult | null> => {
      const fid = activeFilterId.current;
      if (!fid) return null;

      const result = await getFilteredLines(fid, offset, count);
      setState((prev) => ({
        ...prev,
        lines: result.lines,
        totalMatches: result.totalMatches,
        status: result.status,
      }));
      return result;
    },
    [],
  );

  const cancel = useCallback(async () => {
    const fid = activeFilterId.current;
    if (!fid) return;

    await cancelFilter(fid);
    setState((prev) => ({
      ...prev,
      scanning: false,
      status: 'cancelled',
    }));
  }, []);

  const clear = useCallback(async () => {
    const fid = activeFilterId.current;
    if (fid) {
      try {
        await closeFilter(fid);
      } catch {
        // ignore
      }
    }
    activeFilterId.current = null;
    setState(INITIAL_STATE);
  }, []);

  return {
    filter: state,
    startFilter,
    fetchPage,
    cancelFilter: cancel,
    clearFilter: clear,
  };
}
