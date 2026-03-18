import React, { useCallback, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Bookmark } from '../../bridge/types';
import { useFocusedSession, useViewerActions } from '../../context';
import { useBookmarks } from '../../hooks';
import BookmarkItem from './BookmarkItem';
import styles from './BookmarkPanel.module.css';

// ── Category config ────────────────────────────────────────────────────────

const CATEGORY_CONFIG: Record<string, { color: string; label: string }> = {
  'error':       { color: 'var(--error, #f85149)',      label: 'Errors'        },
  'warning':     { color: 'var(--warning, #d29922)',    label: 'Warnings'      },
  'state-change':{ color: 'var(--accent, #58a6ff)',     label: 'State Changes' },
  'timing':      { color: 'var(--success, #3fb950)',    label: 'Timing'        },
  'observation': { color: 'var(--text-muted, #8b949e)', label: 'Observations'  },
  'custom':      { color: 'var(--text-dimmed, #484f58)', label: 'Other'        },
};

const CATEGORY_ORDER = ['error', 'warning', 'state-change', 'timing', 'observation', 'custom'];

function getCategoryConfig(cat: string): { color: string; label: string } {
  return CATEGORY_CONFIG[cat] ?? CATEGORY_CONFIG['custom'];
}

// ── Category group ─────────────────────────────────────────────────────────

interface CategoryGroupProps {
  category: string;
  bookmarks: Bookmark[];
  onJump: (lineNum: number) => void;
  onEdit: (id: string, label?: string, note?: string, category?: string) => void;
  onDelete: (id: string) => void;
}

const CategoryGroup = React.memo(function CategoryGroup({
  category,
  bookmarks,
  onJump,
  onEdit,
  onDelete,
}: CategoryGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { color, label } = getCategoryConfig(category);

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  return (
    <div className={styles.categoryGroup}>
      <button
        className={styles.categoryHeader}
        onClick={toggleCollapsed}
        type="button"
        aria-expanded={!collapsed}
      >
        <span className={styles.categoryDot} style={{ background: color }} />
        <span className={styles.categoryLabel}>{label}</span>
        <span className={styles.categoryCount}>{bookmarks.length}</span>
        <ChevronRight
          size={12}
          className={`${styles.chevron}${collapsed ? '' : ` ${styles.chevronOpen}`}`}
        />
      </button>
      {!collapsed && (
        <div className={styles.categoryItems}>
          {bookmarks.map((b) => (
            <BookmarkItem
              key={b.id}
              bookmark={b}
              accentColor={color}
              onJump={onJump}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
});

// ── Main panel ─────────────────────────────────────────────────────────────

const BookmarkPanel = React.memo(function BookmarkPanel() {
  const session = useFocusedSession();
  const sessionId = session?.sessionId ?? null;
  const { bookmarks, bookmarksLoading, editBookmark, removeBookmark } = useBookmarks(sessionId);
  const { jumpToLine } = useViewerActions();

  // Group bookmarks by category, sorted by line number within each group
  const grouped = useMemo(() => {
    const groups = new Map<string, Bookmark[]>();
    const sorted = [...bookmarks].sort((a, b) => a.lineNumber - b.lineNumber);
    for (const b of sorted) {
      const cat = b.category ?? 'custom';
      const arr = groups.get(cat) ?? [];
      arr.push(b);
      groups.set(cat, arr);
    }
    return groups;
  }, [bookmarks]);

  // Ordered list of present categories
  const orderedCategories = useMemo(() => {
    const present = new Set(grouped.keys());
    const ordered: string[] = [];
    for (const cat of CATEGORY_ORDER) {
      if (present.has(cat)) ordered.push(cat);
    }
    // Any unknown categories not in CATEGORY_ORDER come last
    for (const cat of present) {
      if (!CATEGORY_ORDER.includes(cat)) ordered.push(cat);
    }
    return ordered;
  }, [grouped]);

  const handleJump = useCallback((lineNum: number) => {
    jumpToLine(lineNum);
  }, [jumpToLine]);

  const handleEdit = useCallback((
    id: string,
    label?: string,
    note?: string,
    category?: string,
  ) => {
    editBookmark(id, label, note, category);
  }, [editBookmark]);

  const handleDelete = useCallback((id: string) => {
    removeBookmark(id);
  }, [removeBookmark]);

  if (!sessionId) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>No session loaded.</div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.headerLabel}>Bookmarks</span>
        {bookmarks.length > 0 && (
          <span className={styles.headerCount}>{bookmarks.length}</span>
        )}
      </div>

      {/* List area */}
      <div className={styles.list}>
        {bookmarksLoading && bookmarks.length === 0 && (
          <div className={styles.empty}>Loading{'\u2026'}</div>
        )}

        {!bookmarksLoading && bookmarks.length === 0 && (
          <div className={styles.empty}>
            {'No bookmarks yet.\nRight-click a line or press Ctrl+B to bookmark.'}
          </div>
        )}

        {orderedCategories.map((cat) => {
          const items = grouped.get(cat);
          if (!items || items.length === 0) return null;
          return (
            <CategoryGroup
              key={cat}
              category={cat}
              bookmarks={items}
              onJump={handleJump}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          );
        })}
      </div>
    </div>
  );
});

export default BookmarkPanel;
