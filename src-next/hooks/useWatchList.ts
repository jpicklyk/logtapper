import { useState, useEffect, useCallback } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { WatchInfo, WatchMatchEvent } from '../bridge/types';
import { listWatches } from '../bridge/commands';
import { onWatchMatch } from '../bridge/events';

export interface UseWatchListReturn {
  watches: WatchInfo[];
  refreshWatches: (sessionId: string) => Promise<void>;
}

export function useWatchList(): UseWatchListReturn {
  const [watches, setWatches] = useState<WatchInfo[]>([]);

  // Subscribe to watch-match events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onWatchMatch((event: WatchMatchEvent) => {
      if (cancelled) return;
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

  const refreshWatches = useCallback(async (sessionId: string): Promise<void> => {
    const list = await listWatches(sessionId);
    setWatches(list);
  }, []);

  return { watches, refreshWatches };
}
