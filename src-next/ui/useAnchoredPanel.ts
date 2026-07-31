import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';

export interface UseAnchoredPanelOptions {
  open: boolean;
  onClose: () => void;
  /** Panel width in px — used to flip the panel right-aligned when it would
   *  overflow the viewport's right edge, and to clamp it off the left edge. */
  panelWidth: number;
  /** Gap between the trigger's bottom edge and the panel, in px. */
  gap?: number;
  zIndex?: number;
}

export interface UseAnchoredPanelResult<
  TriggerEl extends HTMLElement,
  PanelEl extends HTMLElement,
> {
  triggerRef: React.RefObject<TriggerEl | null>;
  panelRef: React.RefObject<PanelEl | null>;
  /** Fixed-position style for the portaled panel, or null while closed. */
  panelStyle: React.CSSProperties | null;
}

/**
 * Shared positioning/dismissal logic for a trigger + portaled panel pair
 * (dropdown menus, popovers, switchers). Positions the panel below the
 * trigger, flipping right-aligned and clamping to the viewport edges, and
 * closes on outside click or Escape while open.
 *
 * Render the panel via `createPortal` at `document.body` using `panelStyle`,
 * and attach `triggerRef` / `panelRef` to the trigger and panel elements.
 */
export function useAnchoredPanel<
  TriggerEl extends HTMLElement = HTMLElement,
  PanelEl extends HTMLElement = HTMLElement,
>({
  open,
  onClose,
  panelWidth,
  gap = 4,
  zIndex = 1050,
}: UseAnchoredPanelOptions): UseAnchoredPanelResult<TriggerEl, PanelEl> {
  const triggerRef = useRef<TriggerEl>(null);
  const panelRef = useRef<PanelEl>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null);

  // Capture trigger rect once when the panel opens (useLayoutEffect avoids flicker).
  // Clamp position so the panel stays within the viewport.
  useLayoutEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const top = rect.bottom + gap;
      // Align left edge to trigger; if it would overflow the right edge, flip to right-align.
      let left = rect.left;
      if (left + panelWidth > window.innerWidth) {
        left = rect.right - panelWidth;
      }
      // Clamp so it never goes off-screen left either.
      if (left < 4) left = 4;
      setPanelStyle({
        position: 'fixed',
        top,
        left,
        zIndex, // TODO: use z-index token (--z-dropdown) once CSS var() works in inline styles
      });
    } else {
      setPanelStyle(null);
    }
  }, [open, panelWidth, gap, zIndex]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !panelRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [open, onClose]);

  return { triggerRef, panelRef, panelStyle };
}
