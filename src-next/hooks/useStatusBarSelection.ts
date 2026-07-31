import { useEffect, useState } from 'react';
import { bus } from '../events';
import type { AppEvents } from '../events/events';

export interface StatusBarSelection {
  anchor: number | null;
  range: [number, number] | null;
}

const EMPTY: StatusBarSelection = { anchor: null, range: null };

export type SelectionMatch =
  | { paneId: string | null }
  | { sessionId: string | null };

export interface UseSelectionOptions {
  /**
   * When true, an event that targets a different pane/session actively
   * clears the current selection to EMPTY. When false (default) such
   * events are ignored — the selection only resets when the match key
   * itself changes (pane/session switch).
   */
  clearOnMismatch?: boolean;
}

/**
 * Subscribes to `selection:changed` bus events and returns selection state
 * for the given pane or session. Resets to EMPTY when the match key
 * (paneId/sessionId) changes. The referential bail-out in the handler
 * avoids re-renders when an event repeats the same anchor/range.
 */
export function useSelection(
  match: SelectionMatch,
  opts: UseSelectionOptions = {},
): StatusBarSelection {
  const key = 'paneId' in match ? match.paneId : match.sessionId;
  const byPane = 'paneId' in match;
  const clearOnMismatch = opts.clearOnMismatch ?? false;

  const [selection, setSelection] = useState<StatusBarSelection>(EMPTY);

  useEffect(() => {
    // Reset on pane/session switch.
    setSelection(EMPTY);

    if (!key) return;

    const handler = (ev: AppEvents['selection:changed']) => {
      const matches = byPane ? ev.paneId === key : ev.sessionId === key;
      if (!matches) {
        if (clearOnMismatch) {
          setSelection((prev) => (prev === EMPTY ? prev : EMPTY));
        }
        return;
      }
      setSelection((prev) => {
        if (prev.anchor === ev.anchor &&
            prev.range?.[0] === ev.range?.[0] &&
            prev.range?.[1] === ev.range?.[1]) return prev;
        return { anchor: ev.anchor, range: ev.range };
      });
    };

    bus.on('selection:changed', handler);
    return () => { bus.off('selection:changed', handler); };
  }, [key, byPane, clearOnMismatch]);

  return selection;
}

/**
 * Subscribes to `selection:changed` bus events and returns selection state
 * for the given pane. Resets when paneId changes. Thin wrapper over
 * `useSelection` for the common pane-keyed case.
 */
export function useStatusBarSelection(paneId: string | null): StatusBarSelection {
  return useSelection({ paneId });
}
