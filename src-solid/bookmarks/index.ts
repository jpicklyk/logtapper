/**
 * Public API of the bookmarks module (Principle 9 — import from here, never
 * from an internal file).
 */

export {
  createBookmarksStore,
  BOOKMARK_CATEGORIES,
  LINE_DISPLAY_BASE,
  categoryLabel,
  categoryAccentVar,
  formatLineRange,
  formatLineLabel,
} from './bookmarksStore';
export type {
  BookmarksStore,
  BookmarksStoreDeps,
  BookmarksCommands,
  BookmarkCategoryOption,
  CreateBookmarkInput,
  UpdateBookmarkInput,
  CategoryGroup,
} from './bookmarksStore';

export { BookmarksPanel } from './BookmarksPanel';
export type { BookmarksPanelProps } from './BookmarksPanel';

export { CreateBookmarkDialog } from './CreateBookmarkDialog';
export type { CreateBookmarkDialogProps } from './CreateBookmarkDialog';
