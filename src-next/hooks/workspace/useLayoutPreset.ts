import { useEffect, useRef, useState } from 'react';
import type { LayoutPreset } from './workspaceTypes';

export interface UseLayoutPresetOptions {
  onEnterCompact: () => void;
  onLeaveCompact: () => void;
}

export interface UseLayoutPresetResult {
  containerRef: React.RefObject<HTMLDivElement>;
  preset: LayoutPreset;
}

export function useLayoutPreset(options: UseLayoutPresetOptions): UseLayoutPresetResult {
  const containerRef = useRef<HTMLDivElement>(null!);
  const [preset, setPreset] = useState<LayoutPreset>('standard');
  const presetRef = useRef<LayoutPreset>('standard');

  // Read from a ref inside the effect to avoid re-subscribing the
  // ResizeObserver when the options object changes on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w === 0) return;
      const next: LayoutPreset = w < 900 ? 'compact' : w < 1800 ? 'standard' : 'wide';
      if (next !== presetRef.current) {
        const prev = presetRef.current;
        presetRef.current = next;
        setPreset(next);

        if (next === 'compact') {
          optionsRef.current.onEnterCompact();
        } else if (prev === 'compact') {
          optionsRef.current.onLeaveCompact();
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { containerRef, preset };
}
