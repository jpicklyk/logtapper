import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import styles from './DropdownMenu.module.css';

export type MenuItem =
  | { id: string; label: string; icon?: LucideIcon; shortcut?: string; disabled?: boolean }
  | { separator: true };

export interface DropdownMenuProps {
  trigger: React.ReactNode;
  items: MenuItem[];
  onSelect: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const DropdownMenu = React.memo<DropdownMenuProps>(function DropdownMenu({
  trigger,
  items,
  onSelect,
  open,
  onOpenChange,
}) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null);

  // Capture trigger rect once when menu opens (useLayoutEffect avoids flicker).
  // Clamp position so the panel stays within the viewport.
  useLayoutEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const top = rect.bottom + 4;
      // Align left edge to trigger; if it would overflow the right edge, flip to right-align.
      const panelWidth = 220; // min-width from CSS + padding buffer
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
        zIndex: 1050, // TODO: use z-index token (--z-dropdown) once CSS var() works in inline styles
      });
    } else {
      setPanelStyle(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !panelRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        onOpenChange(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [open, onOpenChange]);

  return (
    <>
      <div
        ref={triggerRef}
        className={styles.triggerWrapper}
        onClick={() => onOpenChange(!open)}
      >
        {trigger}
      </div>
      {open && panelStyle != null &&
        createPortal(
          <div
            ref={panelRef}
            className={styles.panel}
            style={panelStyle}
            data-webkit-app-region="no-drag"
          >
            {items.map((item, index) => {
              if ('separator' in item) {
                return <div key={index} className={styles.separator} />;
              }
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={styles.item}
                  disabled={item.disabled}
                  onClick={() => {
                    onSelect(item.id);
                    onOpenChange(false);
                  }}
                >
                  {Icon && <Icon className={styles.icon} size={16} />}
                  <span className={styles.label}>{item.label}</span>
                  {item.shortcut && (
                    <span className={styles.shortcut}>{item.shortcut}</span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
});
