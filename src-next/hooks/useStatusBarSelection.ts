import { useEffect, useState } from 'react';
import { bus } from '../events';
import type { AppEvents } from '../events/events';

export interface StatusBarSelection {
  anchor: number | null;
  range: [number, number] | null;
}

const EMPTY: StatusBarSelection = { anchor: null, range: null };

/**
 * Subscribes to `selection:changed` bus events and returns selection state
 * for the given pane. Resets when paneId changes.
 */
export function useStatusBarSelection(paneId: string | null): StatusBarSelection {
  const [selection, setSelection] = useState<StatusBarSelection>(EMPTY);

  useEffect(() => {
    // Reset on pane switch.
    setSelection(EMPTY);

    if (!paneId) return;

    const handler = (ev: AppEvents['selection:changed']) => {
      if (ev.paneId !== paneId) return;
      setSelection(prev => {
        if (prev.anchor === ev.anchor &&
            prev.range?.[0] === ev.range?.[0] &&
            prev.range?.[1] === ev.range?.[1]) return prev;
        return { anchor: ev.anchor, range: ev.range };
      });
    };

    bus.on('selection:changed', handler);
    return () => { bus.off('selection:changed', handler); };
  }, [paneId]);

  return selection;
}
