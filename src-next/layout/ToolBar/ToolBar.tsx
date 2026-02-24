import React from 'react';
import clsx from 'clsx';
import styles from './ToolBar.module.css';

interface ToolBarItem {
  id: string;
  icon: React.ComponentType<{ size?: number | string }>;
  label: string;
  badge?: string | number;
}

interface ToolBarProps {
  topItems: ToolBarItem[];
  bottomItems?: ToolBarItem[];
  activeTopId: string | null;
  activeBottomId: string | null;
  onTopToggle: (id: string) => void;
  onBottomToggle?: (id: string) => void;
  position: 'left' | 'right';
}

export const ToolBar = React.memo(function ToolBar({
  topItems,
  bottomItems,
  activeTopId,
  activeBottomId,
  onTopToggle,
  onBottomToggle,
  position,
}: ToolBarProps) {
  return (
    <div className={clsx(styles.toolbar, styles[position])}>
      <div className={styles.topGroup}>
        {topItems.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeTopId;
          return (
            <button
              key={item.id}
              className={clsx(styles.button, active && styles.active)}
              onClick={() => onTopToggle(item.id)}
              title={item.label}
            >
              <Icon size={20} />
              {item.badge != null && (
                <span className={styles.badge}>{item.badge}</span>
              )}
            </button>
          );
        })}
      </div>
      {bottomItems && bottomItems.length > 0 && (
        <div className={styles.bottomGroup}>
          {bottomItems.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeBottomId;
            return (
              <button
                key={item.id}
                className={clsx(styles.button, active && styles.active)}
                onClick={() => onBottomToggle?.(item.id)}
                title={item.label}
              >
                <Icon size={20} />
                {item.badge != null && (
                  <span className={styles.badge}>{item.badge}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
