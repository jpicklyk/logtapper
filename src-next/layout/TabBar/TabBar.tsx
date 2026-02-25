import React, { useCallback } from 'react';
import { X, Plus } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import clsx from 'clsx';
import styles from './TabBar.module.css';

interface TabBarTab {
  id: string;
  label: string;
  closable?: boolean;
  type?: string;
}

const TAB_COLORS: Record<string, string> = {
  logviewer:  '#58a6ff',   // blue  — log viewer
  dashboard:  '#3fb950',   // green — processor dashboard
  scratch:    '#f0a500',   // amber — scratch pad
  editor:     '#f0a500',   // amber — editor
};

interface TabBarProps {
  tabs: TabBarTab[];
  activeTabId: string;
  paneId: string;
  onActivate: (tabId: string) => void;
  onClose?: (tabId: string) => void;
  onAdd?: () => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  size?: 'sm' | 'md';
}

export const TabBar = React.memo(function TabBar({
  tabs,
  activeTabId,
  paneId,
  onActivate,
  onClose,
  onAdd,
  size = 'md',
}: TabBarProps) {
  return (
    <div className={clsx(styles.bar, styles[size])}>
      {tabs.map((tab) => (
        <SortableTabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          paneId={paneId}
          tabColor={TAB_COLORS[tab.type ?? ''] ?? TAB_COLORS.logviewer}
          onActivate={onActivate}
          onClose={onClose}
        />
      ))}
      {onAdd && (
        <button className={styles.addTab} onClick={onAdd} title="New tab">
          <Plus size={12} />
        </button>
      )}
    </div>
  );
});

interface SortableTabButtonProps {
  tab: TabBarTab;
  active: boolean;
  paneId: string;
  tabColor: string;
  onActivate: (tabId: string) => void;
  onClose?: (tabId: string) => void;
}

const SortableTabButton = React.memo(function SortableTabButton({
  tab,
  active,
  paneId,
  tabColor,
  onActivate,
  onClose,
}: SortableTabButtonProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: tab.id,
    data: { type: 'tab', tabId: tab.id, paneId, label: tab.label },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : undefined,
    zIndex: isDragging ? 1 : undefined,
    '--tab-strip-color': tabColor,
  } as React.CSSProperties;

  const handleClick = useCallback(() => {
    if (!isDragging) onActivate(tab.id);
  }, [onActivate, tab.id, isDragging]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose?.(tab.id);
    },
    [onClose, tab.id],
  );

  return (
    <button
      ref={setNodeRef}
      style={style}
      className={clsx(styles.tab, active && styles.active, isDragging && styles.dragging)}
      onClick={handleClick}
      title={tab.label}
      {...attributes}
    >
      {/* Drag handle — only this zone initiates drag and shows grab cursor */}
      <span className={styles.dragHandle} {...listeners} />
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
