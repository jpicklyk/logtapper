import React, { useCallback } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';
import styles from './TabBar.module.css';

interface TabBarTab {
  id: string;
  label: string;
  closable?: boolean;
}

interface TabBarProps {
  tabs: TabBarTab[];
  activeTabId: string;
  onActivate: (tabId: string) => void;
  onClose?: (tabId: string) => void;
  size?: 'sm' | 'md';
}

export const TabBar = React.memo(function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  size = 'md',
}: TabBarProps) {
  return (
    <div className={clsx(styles.bar, styles[size])}>
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          onActivate={onActivate}
          onClose={onClose}
        />
      ))}
    </div>
  );
});

interface TabButtonProps {
  tab: TabBarTab;
  active: boolean;
  onActivate: (tabId: string) => void;
  onClose?: (tabId: string) => void;
}

const TabButton = React.memo(function TabButton({
  tab,
  active,
  onActivate,
  onClose,
}: TabButtonProps) {
  const handleClick = useCallback(() => onActivate(tab.id), [onActivate, tab.id]);
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose?.(tab.id);
    },
    [onClose, tab.id],
  );

  return (
    <button
      className={clsx(styles.tab, active && styles.active)}
      onClick={handleClick}
      title={tab.label}
    >
      <span className={styles.label}>{tab.label}</span>
      {tab.closable && (
        <span
          className={styles.close}
          onClick={handleClose}
          role="button"
          tabIndex={-1}
        >
          <X size={12} />
        </span>
      )}
    </button>
  );
});
