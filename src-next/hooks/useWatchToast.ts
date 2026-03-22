import { useEffect, useRef } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { WatchMatchEvent, FilterCriteria } from '../bridge/types';
import { onWatchMatch } from '../bridge/events';
import { listWatches } from '../bridge/commands';
import type { ToastItem } from '../ui';

let toastCounter = 0;

/** Build a short human-readable summary of filter criteria. */
function describeCriteria(criteria: FilterCriteria): string {
  const parts: string[] = [];
  if (criteria.textSearch) parts.push(`text:${criteria.textSearch}`);
  if (criteria.regex) parts.push(`/${criteria.regex}/`);
  if (criteria.logLevels?.length) {
    const short: Record<string, string> = {
      Verbose: 'V', Debug: 'D', Info: 'I', Warn: 'W', Error: 'E', Fatal: 'F',
    };
    parts.push(criteria.logLevels.map((l) => short[l] ?? l).join(','));
  }
  if (criteria.tags?.length) parts.push(`tag:${criteria.tags.join(',')}`);
  if (criteria.pids?.length) parts.push(`pid:${criteria.pids.join(',')}`);
  return parts.join(' ') || 'watch';
}

const DEBOUNCE_MS = 2000;

/**
 * Subscribes directly to the Tauri `watch-match` event at AppShell level
 * so it runs regardless of whether the Watches panel is open. Debounces
 * rapid-fire match events into a single toast per 2-second window per watch.
 */
export function useWatchToast(addToast: (toast: ToastItem) => void) {
  // Accumulated matches per watch during debounce window
  const accRef = useRef<Map<string, { newMatches: number; totalMatches: number }>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cache of watchId -> criteria for toast messages
  const criteriaMapRef = useRef<Map<string, FilterCriteria>>(new Map());
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    const flushToasts = () => {
      const acc = accRef.current;
      if (acc.size === 0) return;

      for (const [watchId, data] of acc) {
        const criteria = criteriaMapRef.current.get(watchId);
        const summary = criteria ? describeCriteria(criteria) : watchId.slice(0, 8);
        const id = `watch-toast-${++toastCounter}`;
        addToastRef.current({
          id,
          title: 'Watch Match',
          message: `+${data.newMatches} match${data.newMatches > 1 ? 'es' : ''} \u2014 ${summary} (${data.totalMatches} total)`,
        });
      }
      acc.clear();
    };

    const scheduleFlush = () => {
      if (timerRef.current) return; // already scheduled
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flushToasts();
      }, DEBOUNCE_MS);
    };

    onWatchMatch((event: WatchMatchEvent) => {
      if (cancelled) return;
      if (event.newMatches === 0) return;

      const existing = accRef.current.get(event.watchId);
      if (existing) {
        existing.newMatches += event.newMatches;
        existing.totalMatches = event.totalMatches;
      } else {
        accRef.current.set(event.watchId, {
          newMatches: event.newMatches,
          totalMatches: event.totalMatches,
        });
      }

      // Lazily populate criteria map if we don't have this watch yet
      if (!criteriaMapRef.current.has(event.watchId)) {
        listWatches(event.sessionId)
          .then((watches) => {
            if (cancelled) return;
            for (const w of watches) {
              criteriaMapRef.current.set(w.watchId, w.criteria);
            }
          })
          .catch(() => {
            // ignore
          });
      }

      scheduleFlush();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      accRef.current.clear();
    };
  }, []);
}
