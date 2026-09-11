import { useState, useEffect } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { ActivityEntry } from '../bridge/types';
import { getActivity } from '../bridge/commands';
import { onActivity } from '../bridge/events';

/** How many entries to keep in memory. The backend journal is itself a bounded
 *  ring (500); this is the smaller tail a status surface needs. */
const MAX_ENTRIES = 200;

export interface UseActivityFeedReturn {
  /** Journaled actions, oldest first, capped at {@link MAX_ENTRIES}. */
  entries: ActivityEntry[];
  /** The most recent entry, or `null` before the first fetch resolves. */
  latest: ActivityEntry | null;
  /** How many entries are currently held (never more than {@link MAX_ENTRIES}). */
  count: number;
}

/**
 * The shared UI + agent action journal.
 *
 * One fetch on mount, then live appends from the `activity` Tauri event — the
 * same entries, so there is no second source to reconcile. Every mutation from
 * either caller lands here; reads are never journaled, so this stays quiet while
 * the user is only looking around.
 *
 * Deliberately local state, not a context: the only consumer today is the MCP
 * status pill's tooltip. The feed panel proper belongs to the UI redesign, and
 * promoting this to a context before a second unrelated subtree needs it would
 * be hoisting for its own sake.
 */
export function useActivityFeed(): UseActivityFeedReturn {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    // Ids are monotonic for the life of the process, so an append that races the
    // initial fetch is deduped by id rather than by arrival order — which is the
    // only thing that makes "fetch once, then listen" safe without a lock.
    const merge = (incoming: ActivityEntry[]) =>
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const added = incoming.filter((e) => !seen.has(e.id));
        if (added.length === 0) return prev;
        const next = [...prev, ...added].sort((a, b) => a.id - b.id);
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      });

    onActivity((entry) => {
      if (cancelled) return;
      merge([entry]);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    getActivity(MAX_ENTRIES)
      .then((list) => {
        if (cancelled) return;
        merge(list);
      })
      .catch(() => {
        // The journal is a nicety; a failed read must not break the status bar.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return {
    entries,
    latest: entries.length > 0 ? entries[entries.length - 1] : null,
    count: entries.length,
  };
}
