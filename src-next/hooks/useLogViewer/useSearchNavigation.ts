import { useCallback, useRef } from 'react';
import { emptyPage, type LinePage } from '../../bridge/types';
import { getLines } from '../../bridge/commands';
import { useViewerContext } from '../../context/ViewerContext';
import type { SharedLogViewerRefs } from './types';

/**
 * Scroll targeting, processor-view selection, and line fetching for the log
 * viewer.
 *
 * Search itself is NOT here. Query state, the `search-progress` subscription,
 * and match navigation are per-pane and owned by `PaneSearchContext`, which
 * addresses its jumps at a single pane. This hook used to carry a second,
 * global copy of that same accumulate-progress / jump-to-first-match algorithm
 * writing into a context nothing rendered; it was removed rather than kept in
 * sync. `jumpToLine` is the seam the pane provider scrolls through.
 */
export interface SearchNavigationResult {
  jumpToLine: (lineNum: number, paneId?: string, sessionId?: string) => void;
  jumpToEnd: () => void;
  fetchLines: (offset: number, count: number) => Promise<LinePage>;
  setProcessorView: (processorId: string) => void;
  clearProcessorView: () => void;
  reset: () => void;
}

export function useSearchNavigation(refs: SharedLogViewerRefs): SearchNavigationResult {
  const {
    setScrollToLine,
    setJumpSeq,
    setJumpPaneId,
    setJumpSessionId,
    setProcessorId,
  } = useViewerContext();

  const processorIdRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    setProcessorId(null);
    processorIdRef.current = null;
  }, [setProcessorId]);

  const jumpToLine = useCallback((lineNum: number, paneId?: string, sessionId?: string) => {
    setScrollToLine(lineNum);
    setJumpPaneId(paneId ?? null);
    setJumpSessionId(sessionId ?? null);
    setJumpSeq((s) => s + 1);
  }, [setScrollToLine, setJumpPaneId, setJumpSessionId, setJumpSeq]);

  const jumpToEnd = useCallback(() => {
    const total = refs.sessionRef.current?.totalLines ?? 0;
    if (total <= 0) return;
    setScrollToLine(total - 1);
    setJumpPaneId(null);
    setJumpSessionId(null);
    setJumpSeq((s) => s + 1);
  }, [refs.sessionRef, setScrollToLine, setJumpPaneId, setJumpSessionId, setJumpSeq]);

  const fetchLines = useCallback((offset: number, count: number): Promise<LinePage> => {
    const sess = refs.sessionRef.current;
    if (!sess) return Promise.resolve(emptyPage(offset));

    const pid = processorIdRef.current;
    const mode = pid
      ? { mode: 'Processor' as const }
      : { mode: 'Full' as const };

    return getLines({
      sessionId: sess.sessionId,
      mode,
      offset,
      count,
      context: 3,
      processorId: pid ?? null,
      search: null,
    });
  }, [refs.sessionRef]);

  const setProcessorView = useCallback((id: string) => {
    setProcessorId(id);
    processorIdRef.current = id;
  }, [setProcessorId]);

  const clearProcessorView = useCallback(() => {
    setProcessorId(null);
    processorIdRef.current = null;
  }, [setProcessorId]);

  return {
    jumpToLine,
    jumpToEnd,
    fetchLines,
    setProcessorView,
    clearProcessorView,
    reset,
  };
}
