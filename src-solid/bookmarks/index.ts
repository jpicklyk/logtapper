/**
 * Public API of the bookmarks module (Principle 9 — import from here, never
 * from an internal file).
 */

export {
  createBookmarksStore,
  BOOKMARK_CATEGORIES,
  categoryLabel,
  categoryAccentVar,
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
