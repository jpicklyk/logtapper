import { useEffect, useMemo, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { Bookmark } from '../bridge/types';
import { listBookmarks } from '../bridge/commands';
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

  return {
    bookmarks: state.bookmarks,
    bookmarksLoading: state.loading,
  };
}

/**
 * Derives a Set of all line numbers that have bookmarks (including range expansion).
 * Used by gutter markers for O(1) render lookup.
 */
export function useBookmarkLines(bookmarks: Bookmark[]): Set<number> {
  return useMemo(() => {
    const set = new Set<number>();
    for (const b of bookmarks) {
      if (b.lineNumberEnd != null && b.lineNumberEnd > b.lineNumber) {
        for (let i = b.lineNumber; i <= b.lineNumberEnd; i++) {
          set.add(i);
        }
      } else {
        set.add(b.lineNumber);
      }
    }
    return set;
  }, [bookmarks]);
}

/**
 * Returns a lookup function: (lineNum) => Bookmark | undefined.
 * Rebuilt only when bookmarks change. Range bookmarks are matched if lineNum
 * falls within [lineNumber, lineNumberEnd].
 */
export function useBookmarkLookup(bookmarks: Bookmark[]): (lineNum: number) => Bookmark | undefined {
  return useMemo(() => {
    const lineMap = new Map<number, Bookmark>();
    const ranges: Bookmark[] = [];
    for (const b of bookmarks) {
      if (b.lineNumberEnd != null && b.lineNumberEnd > b.lineNumber) {
        lineMap.set(b.lineNumber, b);
        ranges.push(b);
      } else {
        lineMap.set(b.lineNumber, b);
      }
    }
    return (lineNum: number): Bookmark | undefined => {
      const direct = lineMap.get(lineNum);
      if (direct) return direct;
      for (const r of ranges) {
        if (lineNum >= r.lineNumber && lineNum <= r.lineNumberEnd!) return r;
      }
      return undefined;
    };
  }, [bookmarks]);
}
