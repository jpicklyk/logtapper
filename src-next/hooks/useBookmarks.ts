import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { Bookmark, CreatedBy } from '../bridge/types';
import {
  createBookmark,
  listBookmarks,
  updateBookmark,
  deleteBookmark,
} from '../bridge/commands';
import { onBookmarkUpdate } from '../bridge/events';

export interface BookmarkState {
  bookmarks: Bookmark[];
  loading: boolean;
}

export function useBookmarks(sessionId: string | null) {
  const [state, setState] = useState<BookmarkState>({
    bookmarks: [],
    loading: false,
  });
  const currentSessionId = useRef<string | null>(null);

  // Load bookmarks when session changes
  useEffect(() => {
    if (!sessionId) {
      setState({ bookmarks: [], loading: false });
      currentSessionId.current = null;
      return;
    }

    currentSessionId.current = sessionId;
    setState((prev) => ({ ...prev, loading: true }));

    listBookmarks(sessionId)
      .then((bookmarks) => {
        if (currentSessionId.current === sessionId) {
          setState({ bookmarks, loading: false });
        }
      })
      .catch(() => {
        if (currentSessionId.current === sessionId) {
          setState({ bookmarks: [], loading: false });
        }
      });
  }, [sessionId]);

  // Subscribe to bookmark-update events (StrictMode-safe)
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    onBookmarkUpdate((payload) => {
      if (cancelled) return;
      if (payload.sessionId !== currentSessionId.current) return;

      setState((prev) => {
        switch (payload.action) {
          case 'created':
            if (prev.bookmarks.some((b) => b.id === payload.bookmark.id)) return prev;
            return { ...prev, bookmarks: [...prev.bookmarks, payload.bookmark] };
          case 'updated':
            return {
              ...prev,
              bookmarks: prev.bookmarks.map((b) =>
                b.id === payload.bookmark.id ? payload.bookmark : b,
              ),
            };
          case 'deleted':
            return {
              ...prev,
              bookmarks: prev.bookmarks.filter((b) => b.id !== payload.bookmark.id),
            };
          default:
            return prev;
        }
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const addBookmark = useCallback(
    async (lineNumber: number, label: string, note: string, createdBy: CreatedBy = 'User') => {
      if (!sessionId) return null;
      const bm = await createBookmark(sessionId, lineNumber, label, note, createdBy);
      return bm;
    },
    [sessionId],
  );

  const editBookmark = useCallback(
    async (bookmarkId: string, label?: string, note?: string) => {
      if (!sessionId) return null;
      const bm = await updateBookmark(sessionId, bookmarkId, label, note);
      return bm;
    },
    [sessionId],
  );

  const removeBookmark = useCallback(
    async (bookmarkId: string) => {
      if (!sessionId) return;
      await deleteBookmark(sessionId, bookmarkId);
    },
    [sessionId],
  );

  return {
    bookmarks: state.bookmarks,
    bookmarksLoading: state.loading,
    addBookmark,
    editBookmark,
    removeBookmark,
  };
}
