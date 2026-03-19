import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  editor:     '#f0a500',   // amber — editor
};

/** Tab types that support double-click to rename. */
const RENAMABLE_TYPES = new Set(['editor']);

interface TabBarProps {
  tabs: TabBarTab[];
  activeTabId: string;
  paneId: string;
  /** The specific logviewer tab that owns the focused session — only this tab
   *  shows the blue underline focus marker across the entire application. */
  focusedLogviewerTabId?: string | null;
  onActivate: (tabId: string) => void;
  onClose?: (tabId: string) => void;
  onAdd?: () => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onRename?: (tabId: string, newLabel: string) => void;
  size?: 'sm' | 'md';
}

export const TabBar = React.memo(function TabBar({
  tabs,
  activeTabId,
  paneId,
  focusedLogviewerTabId,
  onActivate,
  onClose,
  onAdd,
  onRename,
  size = 'md',
}: TabBarProps) {
  return (
    <div className={clsx(styles.bar, styles[size])}>
      {tabs.map((tab) => (
        <SortableTabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          focused={tab.id === focusedLogviewerTabId}
          paneId={paneId}
          tabColor={TAB_COLORS[tab.type ?? ''] ?? TAB_COLORS.logviewer}
          onActivate={onActivate}
          onClose={onClose}
          onRename={RENAMABLE_TYPES.has(tab.type ?? '') ? onRename : undefined}
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
  focused: boolean;
  paneId: string;
  tabColor: string;
  onActivate: (tabId: string) => void;
  onClose?: (tabId: string) => void;
  onRename?: (tabId: string, newLabel: string) => void;
}

const SortableTabButton = React.memo(function SortableTabButton({
  tab,
  active,
  focused,
  paneId,
  tabColor,
  onActivate,
  onClose,
  onRename,
}: SortableTabButtonProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

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

  // ── Inline rename ──────────────────────────────────────────────────────
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onRename) return;
      e.stopPropagation();
      committedRef.current = false;
      setEditValue(tab.label);
      setEditing(true);
    },
    [onRename, tab.label],
  );

  // Auto-focus and select-all when entering edit mode.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitRename = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== tab.label) {
      onRename?.(tab.id, trimmed);
    }
    setEditing(false);
  }, [editValue, tab.id, tab.label, onRename]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRename();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setEditing(false);
      }
    },
    [commitRename],
  );

  // Prevent drag system from capturing pointer events on the input.
  const handleInputPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <button
      ref={setNodeRef}
      style={style}
      className={clsx(styles.tab, active && styles.active, focused && styles.focused, isDragging && styles.dragging)}
      onClick={handleClick}
      title={tab.label}
      {...attributes}
    >
      {/* Drag handle — only this zone initiates drag and shows grab cursor */}
      <span className={styles.dragHandle} {...listeners} />
      {editing ? (
        <input
          ref={inputRef}
          className={styles.labelInput}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
          onPointerDown={handleInputPointerDown}
          spellCheck={false}
        />
      ) : (
        <span className={styles.label} onDoubleClick={handleDoubleClick}>{tab.label}</span>
      )}
      {tab.closable && !editing && (
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
