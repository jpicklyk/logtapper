import { useEffect, useRef } from 'react';
import { bus } from '../events';
import type { ToastItem } from '../ui';
import { nextToastId } from './useToast';
import { isLts } from './workspace/restorePlan';

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
      if (!isLts(e.label)) return;
      addToastRef.current({
        id: nextToastId('lts-import'),
        title: 'Importing session',
        message: e.label,
      });
    };
    const onAlreadyOpen = (e: { label: string }) => {
      addToastRef.current({
        id: nextToastId('lts-already-open'),
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
