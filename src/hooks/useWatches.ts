import { useState, useEffect, useCallback } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { FilterCriteria, WatchInfo, WatchMatchEvent } from '../bridge/types';
import { createWatch, cancelWatch, listWatches } from '../bridge/commands';
import { onWatchMatch } from '../bridge/events';

export interface UseWatchesReturn {
  watches: WatchInfo[];
  addWatch: (sessionId: string, criteria: FilterCriteria) => Promise<WatchInfo>;
  removeWatch: (sessionId: string, watchId: string) => Promise<void>;
  refreshWatches: (sessionId: string) => Promise<void>;
  /** Most recent watch-match event (useful for toast notifications). */
  lastMatchEvent: WatchMatchEvent | null;
}

export function useWatches(): UseWatchesReturn {
  const [watches, setWatches] = useState<WatchInfo[]>([]);
  const [lastMatchEvent, setLastMatchEvent] = useState<WatchMatchEvent | null>(null);

  // Subscribe to watch-match events — uses StrictMode-safe pattern
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onWatchMatch((event: WatchMatchEvent) => {
      if (cancelled) return;
      setLastMatchEvent(event);
      // Update the matching watch's totalMatches in our local state
      setWatches((prev) =>
        prev.map((w) =>
          w.watchId === event.watchId
            ? { ...w, totalMatches: event.totalMatches }
            : w,
        ),
      );
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const addWatch = useCallback(
    async (sessionId: string, criteria: FilterCriteria): Promise<WatchInfo> => {
      const info = await createWatch(sessionId, criteria);
      setWatches((prev) => [...prev, info]);
      return info;
    },
    [],
  );

  const removeWatch = useCallback(
    async (sessionId: string, watchId: string): Promise<void> => {
      await cancelWatch(sessionId, watchId);
      setWatches((prev) =>
        prev.map((w) =>
          w.watchId === watchId ? { ...w, active: false } : w,
        ),
      );
    },
    [],
  );

  const refreshWatches = useCallback(async (sessionId: string): Promise<void> => {
    const list = await listWatches(sessionId);
    setWatches(list);
  }, []);

  return { watches, addWatch, removeWatch, refreshWatches, lastMatchEvent };
}
