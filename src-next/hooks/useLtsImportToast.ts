import { useEffect, useRef } from 'react';
import { bus } from '../events/bus';
import type { ToastItem } from '../ui';

let toastCounter = 0;

/**
 * Subscribes to the `session:loading` bus event and shows a toast notification
 * whenever a `.lts` file import starts, giving the user immediate feedback
 * even when files are already open in other panes.
 *
 * Deduplicates by tabId to prevent double-toasting from StrictMode double-mount.
 */
export function useLtsImportToast(addToast: (toast: ToastItem) => void): void {
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;
  const seenTabsRef = useRef(new Set<string>());

  useEffect(() => {
    const onLoading = (e: { label: string; tabId: string }) => {
      if (!e.label.endsWith('.lts')) return;
      if (seenTabsRef.current.has(e.tabId)) return;
      seenTabsRef.current.add(e.tabId);
      addToastRef.current({
        id: `lts-import-${++toastCounter}`,
        title: 'Importing session',
        message: e.label,
      });
    };
    const onAlreadyOpen = (e: { label: string }) => {
      addToastRef.current({
        id: `lts-already-open-${++toastCounter}`,
        title: 'Already imported',
        message: `${e.label} is already open`,
      });
    };
    bus.on('session:loading', onLoading);
    bus.on('file:lts-already-open', onAlreadyOpen);
    return () => {
      bus.off('session:loading', onLoading);
      bus.off('file:lts-already-open', onAlreadyOpen);
    };
  }, []);
}
