import { useEffect, useRef } from 'react';
import { bus } from '../events/bus';
import type { ToastItem } from '../ui';

let toastCounter = 0;

/**
 * Subscribes to the `session:loading` bus event and shows a toast notification
 * whenever a `.lts` file import starts, giving the user immediate feedback
 * even when files are already open in other panes.
 */
export function useLtsImportToast(addToast: (toast: ToastItem) => void): void {
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;

  useEffect(() => {
    const handler = (e: { label: string }) => {
      if (!e.label.endsWith('.lts')) return;
      addToastRef.current({
        id: `lts-import-${++toastCounter}`,
        title: 'Importing session',
        message: e.label,
      });
    };
    bus.on('session:loading', handler);
    return () => { bus.off('session:loading', handler); };
  }, []);
}
