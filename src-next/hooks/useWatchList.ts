import { useState, useEffect, useCallback, useRef } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { WatchInfo, WatchMatchEvent, WatchUpdateEvent } from '../bridge/types';
import { listWatches } from '../bridge/commands';
import { onWatchMatch, onWatchUpdate } from '../bridge/events';

export interface UseWatchListReturn {
  watches: WatchInfo[];
  refreshWatches: (sessionId: string) => Promise<void>;
}

/**
 * The watch list for ONE session, kept live.
 *
 * Local to the Watches panel — no other subtree reads it, so it stays here
 * rather than in a context. It owns three things: the initial `list_watches`
 * fetch, the running `totalMatches` counter (`watch-match`), and the
 * create/cancel lifecycle (`watch-update`).
 *
 * `watch-update` is what makes an **agent-created** watch appear: the backend
 * emits it from `services::watches` for either caller, so a watch created over
 * the MCP bridge shows up here without the user reopening the panel. Both
 * listeners match on `sessionId` before touching state — a watch belonging to a
 * background session must never land in this pane's list.
 */
export function useWatchList(sessionId: string | null): UseWatchListReturn {
  const [watches, setWatches] = useState<WatchInfo[]>([]);

  // The event handlers close over the session they were registered for. Reading
  // it from a ref rather than the effect's own `sessionId` would reintroduce the
  // broadcast-and-filter-by-ref pattern the bus rules forbid, so the effects
  // depend on `sessionId` directly and re-register when it changes.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const refreshWatches = useCallback(async (id: string): Promise<void> => {
    const list = await listWatches(id);
    // A refresh that resolves after the pane moved on belongs to the previous
    // session; dropping it here is cheaper than cancelling the in-flight call.
    if (sessionIdRef.current !== id) return;
    setWatches(list);
  }, []);

  // Load (and clear) the list when the pane's session changes.
  useEffect(() => {
    if (!sessionId) {
      setWatches([]);
      return;
    }
    refreshWatches(sessionId).catch(() => {});
  }, [sessionId, refreshWatches]);

  // Subscribe to watch-match events (StrictMode-safe)
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onWatchMatch((event: WatchMatchEvent) => {
      if (cancelled || event.sessionId !== sessionId) return;
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
  }, [sessionId]);

  // Subscribe to watch lifecycle events (StrictMode-safe). Emitted for UI and
  // agent mutations alike, so this is also how a watch the user just created
  // reaches the list.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onWatchUpdate((event: WatchUpdateEvent) => {
      if (cancelled || event.sessionId !== sessionId) return;
      // Upsert by watchId. Both actions carry the full `WatchInfo` — `cancelled`
      // differs only in `active: false` — so one merge handles create, cancel,
      // and a redelivery of either without duplicating a row. `totalMatches`
      // from the event wins: it is the backend's count at emit time, and a
      // `watch-match` that arrives afterwards overwrites it again.
      setWatches((prev) => {
        const i = prev.findIndex((w) => w.watchId === event.watch.watchId);
        if (i === -1) return [...prev, event.watch];
        const next = prev.slice();
        next[i] = event.watch;
        return next;
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId]);

  return { watches, refreshWatches };
}
