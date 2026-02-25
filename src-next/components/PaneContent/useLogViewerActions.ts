import { useCallback, useRef } from 'react';
import type { LineWindow } from '../../bridge/types';
import { getLines } from '../../bridge/commands';
import { useSessionForPane, useProcessorId, useSearchQuery } from '../../context';

/**
 * Provides the fetchLines callback for file-mode rendering.
 * Uses the session associated with the given pane, not the global focused session.
 */
export function useLogViewerActions(paneId: string) {
  const session = useSessionForPane(paneId);
  const processorId = useProcessorId();
  const search = useSearchQuery();

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const processorIdRef = useRef(processorId);
  processorIdRef.current = processorId;
  const searchRef = useRef(search);
  searchRef.current = search;

  const fetchLines = useCallback(
    (offset: number, count: number): Promise<LineWindow> => {
      const sess = sessionRef.current;
      if (!sess) return Promise.resolve({ totalLines: 0, lines: [] });

      const pid = processorIdRef.current;
      const mode = pid ? { mode: 'Processor' as const } : { mode: 'Full' as const };

      return getLines({
        sessionId: sess.sessionId,
        mode,
        offset,
        count,
        context: 3,
        processorId: pid ?? undefined,
        search: searchRef.current ?? undefined,
      });
    },
    [],
  );

  return { fetchLines };
}
