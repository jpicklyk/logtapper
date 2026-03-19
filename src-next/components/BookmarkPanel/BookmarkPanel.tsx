import React, { useCallback, useMemo, useState } from 'react';
import { ChevronRight, Download } from 'lucide-react';
import type { Bookmark } from '../../bridge/types';
import { useFocusedSession, useViewerActions } from '../../context';
import { useBookmarks, useSettings } from '../../hooks';
import type { BookmarkCategoryDef } from '../../hooks';
import BookmarkItem from './BookmarkItem';
import { exportBookmarksAsMarkdown } from './exportMarkdown';
import styles from './BookmarkPanel.module.css';

// ── Category helpers ──────────────────────────────────────────────────────

const FALLBACK_CONFIG = { color: '#484f58', label: 'Other' };

function getCategoryConfig(
  cat: string,
  categories: BookmarkCategoryDef[],
): { color: string; label: string } {
  const def = categories.find((c) => c.id === cat);
  return def ? { color: def.color, label: def.label } : FALLBACK_CONFIG;
}

// ── Category group ─────────────────────────────────────────────────────────

interface CategoryGroupProps {
  category: string;
  bookmarks: Bookmark[];
  categories: BookmarkCategoryDef[];
  onJump: (lineNum: number) => void;
  onEdit: (id: string, label?: string, note?: string, category?: string) => void;
  onDelete: (id: string) => void;
}

const CategoryGroup = React.memo(function CategoryGroup({
  category,
  bookmarks,
  categories,
  onJump,
  onEdit,
  onDelete,
}: CategoryGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { color, label } = getCategoryConfig(category, categories);

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
  const { settings } = useSettings();
  const categories = settings.bookmarkCategories;
  const [exportLabel, setExportLabel] = useState<'export' | 'copied'>('export');

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

  // Ordered list of present categories — follows settings order
  const orderedCategories = useMemo(() => {
    const present = new Set(grouped.keys());
    const ordered: string[] = [];
    for (const cat of categories) {
      if (present.has(cat.id)) ordered.push(cat.id);
    }
    // Any unknown categories not in settings come last
    for (const cat of present) {
      if (!categories.some((c) => c.id === cat)) ordered.push(cat);
    }
    return ordered;
  }, [grouped, categories]);

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

  const handleExport = useCallback(async () => {
    const markdown = exportBookmarksAsMarkdown(bookmarks, {
      sourceName: session?.sourceName ?? undefined,
      totalLines: session?.totalLines,
    });
    try {
      await navigator.clipboard.writeText(markdown);
      setExportLabel('copied');
      setTimeout(() => setExportLabel('export'), 2000);
    } catch {
      // clipboard write failed — silently ignore
    }
  }, [bookmarks, session]);

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
        {bookmarks.length > 0 && (
          <button
            className={styles.exportBtn}
            onClick={handleExport}
            title="Copy bookmarks as Markdown"
            type="button"
          >
            {exportLabel === 'copied' ? 'Copied!' : <Download size={12} />}
          </button>
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
              categories={categories}
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
