import { useEffect, useRef } from 'react';
import { bus } from '../events/bus';
import type { ToastItem } from '../ui';

let toastCounter = 0;

/**
 * Shows toast notifications for .lts file import events:
 * - "Importing session" when an import starts
 * - "Already imported" when the user tries to re-open an already-loaded .lts
 */
export function useLtsImportToast(addToast: (toast: ToastItem) => void): void {
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;

  useEffect(() => {
    const onLoading = (e: { label: string }) => {
      if (!e.label.endsWith('.lts')) return;
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
