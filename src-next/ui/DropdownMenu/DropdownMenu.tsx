import React, { useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { useAnchoredPanel } from '../useAnchoredPanel';
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
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { triggerRef, panelRef, panelStyle } = useAnchoredPanel<HTMLDivElement, HTMLDivElement>({
    open,
    onClose: handleClose,
    panelWidth: 220, // min-width from CSS + padding buffer
  });

  return (
    <>
      <div
        ref={triggerRef}
        className={styles.triggerWrapper}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenChange(!open);
          }
        }}
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
