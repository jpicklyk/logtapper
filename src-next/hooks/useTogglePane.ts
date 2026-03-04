import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Manages a togglable pane with tab switching.
 *
 * Encapsulates the correct toggle contract:
 * - toggle(tab) when pane is hidden → open pane, set tab
 * - toggle(tab) when pane is visible and showing a different tab → switch tab, stay open
 * - toggle(tab) when pane is visible and already showing that tab → close pane
 * - toggle() with no arg → flip visibility
 * - open(tab) → always open, always switch
 *
 * Uses refs for synchronous state reads so toggle callbacks are stable ([]-deps)
 * and never nest setState calls.
 */
export interface TogglePaneState<T extends string> {
  visible: boolean;
  tab: T;
  toggle: (tab?: T) => void;
  open: (tab: T) => void;
  setVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setTab: React.Dispatch<React.SetStateAction<T>>;
}

export function useTogglePane<T extends string>(
  initialVisible: boolean,
  initialTab: T,
): TogglePaneState<T> {
  const [visible, setVisible] = useState(initialVisible);
  const [tab, setTab] = useState<T>(initialTab);

  const visibleRef = useRef(visible);
  const tabRef = useRef(tab);
  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => { tabRef.current = tab; }, [tab]);

  const toggle = useCallback((t?: T) => {
    if (t === undefined) {
      setVisible((prev) => !prev);
      return;
    }
    if (visibleRef.current && tabRef.current === t) {
      setVisible(false);
    } else {
      setTab(t);
      setVisible(true);
    }
  }, []);

  const open = useCallback((t: T) => {
    setTab(t);
    setVisible(true);
  }, []);

  return { visible, tab, toggle, open, setVisible, setTab };
}
