import { useRef, useState, useEffect, useCallback } from 'react';
import type React from 'react';

/**
 * Manages the "virtual base" offset used to keep the virtualizer's scrollHeight
 * inside the browser's 2^25 px DOM limit for very large files.
 *
 * Handles:
 * - Resetting (or restoring) virtualBase when the data source changes
 * - Resetting to 0 when entering tail mode (streaming)
 * - Syncing virtualBaseOutRef so parents can capture scroll position during render
 */
export function useVirtualBase(
  sourceId: string,
  initialVirtualBase?: number,
  tailMode?: boolean,
  virtualBaseOutRef?: React.MutableRefObject<number>,
): {
  virtualBase: number;
  virtualBaseRef: React.MutableRefObject<number>;
  setVirtualBase: (base: number) => void;
  pendingScrollTarget: React.MutableRefObject<number | null>;
} {
  const [virtualBase, setVirtualBaseState] = useState(initialVirtualBase ?? 0);
  const virtualBaseRef = useRef(initialVirtualBase ?? 0);
  const pendingScrollTarget = useRef<number | null>(null);

  // Stable ref so the sourceId-reset effect always reads the up-to-date prop value
  // without needing it in its dependency array.
  const initialVirtualBaseRef = useRef(initialVirtualBase ?? 0);
  initialVirtualBaseRef.current = initialVirtualBase ?? 0;

  // Sync virtualBaseOutRef synchronously during render so the parent captures
  // the current position before any effects fire on a session switch.
  if (virtualBaseOutRef) virtualBaseOutRef.current = virtualBase;

  const setVirtualBase = useCallback((base: number) => {
    virtualBaseRef.current = base;
    setVirtualBaseState(base);
  }, []);

  // Reset the virtual window when a new data source is loaded.
  // Uses initialVirtualBase to restore a previously-saved scroll position.
  useEffect(() => {
    const base = initialVirtualBaseRef.current;
    virtualBaseRef.current = base;
    setVirtualBaseState(base);
    pendingScrollTarget.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  // Reset to line 0 when entering tail mode (streaming).
  useEffect(() => {
    if (tailMode) {
      virtualBaseRef.current = 0;
      setVirtualBaseState(0);
    }
  }, [tailMode]);

  return { virtualBase, virtualBaseRef, setVirtualBase, pendingScrollTarget };
}
