import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastItem } from '../ui';

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 8000;

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Schedule auto-dismiss for a toast
  const scheduleAutoDismiss = useCallback((id: string) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
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
      setToasts((prev) => {
        const next = [...prev, toast];
        // Drop oldest if over cap
        if (next.length > MAX_TOASTS) {
          const removed = next.shift()!;
          const timer = timersRef.current.get(removed.id);
          if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(removed.id);
          }
        }
        return next;
      });
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
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}
