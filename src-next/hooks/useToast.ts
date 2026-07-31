import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastItem } from '../ui';

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 8000;

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Mirrors `toasts` so addToast/dismissToast/auto-dismiss can compute their
  // next list without reading it inside a setState updater. Synced at render
  // time (safety net) AND immediately after every setToasts call below (the
  // L7 pattern from useCenterTree.ts) — multiple mutations can happen
  // synchronously within the same event before React re-renders, so the
  // render-time sync alone is not enough to keep it current between them.
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  // Schedule auto-dismiss for a toast
  const scheduleAutoDismiss = useCallback((id: string) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      let next: ToastItem[] | undefined;
      setToasts((prev) => {
        next = prev.filter((t) => t.id !== id);
        return next;
      });
      if (next !== undefined) toastsRef.current = next;
    }, AUTO_DISMISS_MS);
    timersRef.current.set(id, timer);
  }, []);

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const addToast = useCallback(
    (toast: ToastItem) => {
      // Pre-compute the over-cap eviction from toastsRef.current and clear the
      // evicted toast's timer BEFORE calling setState, instead of mutating
      // timersRef from inside the setState updater — StrictMode double-invokes
      // updaters, which would clear (and delete the map entry for) the same
      // timer twice (U14 fix).
      const next = [...toastsRef.current, toast];
      if (next.length > MAX_TOASTS) {
        const removed = next.shift()!;
        const timer = timersRef.current.get(removed.id);
        if (timer) {
          clearTimeout(timer);
          timersRef.current.delete(removed.id);
        }
      }
      toastsRef.current = next;
      setToasts(next);
      scheduleAutoDismiss(toast.id);
    },
    [scheduleAutoDismiss],
  );

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    let next: ToastItem[] | undefined;
    setToasts((prev) => {
      next = prev.filter((t) => t.id !== id);
      return next;
    });
    if (next !== undefined) toastsRef.current = next;
  }, []);

  return { toasts, addToast, dismissToast };
}
