import { useCallback, useState } from 'react';
import { bus } from '../../events/bus';

export interface FocusTrackingHandle {
  focusedLogviewerTabId: string | null;
  setFocusedLogviewerTabId: React.Dispatch<React.SetStateAction<string | null>>;
  focusLogviewerTab: (tabId: string, paneId: string) => void;
}

export function useFocusTracking(
  paneSessionMapRef: React.MutableRefObject<Map<string, string>>,
): FocusTrackingHandle {
  const [focusedLogviewerTabId, setFocusedLogviewerTabId] = useState<string | null>(null);

  const focusLogviewerTab = useCallback((tabId: string, paneId: string) => {
    const sessionId = paneSessionMapRef.current.get(paneId) ?? null;
    bus.emit('session:focused', { sessionId, paneId });
    setFocusedLogviewerTabId(tabId);
  }, []);

  return {
    focusedLogviewerTabId,
    setFocusedLogviewerTabId,
    focusLogviewerTab,
  };
}
