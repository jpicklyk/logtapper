import { createContext, useContext, useCallback, useMemo, type ReactNode } from 'react';
import type {
  Bookmark, CreatedBy, AnalysisArtifact, AnalysisSection,
  FilterCriteria, WatchInfo,
} from '../bridge/types';
import {
  createBookmark, updateBookmark, deleteBookmark,
  publishAnalysis, updateAnalysis, deleteAnalysis,
  createWatch, cancelWatch,
} from '../bridge/commands';
import { bus } from '../events/bus';

// ---------------------------------------------------------------------------
// Context value
// ---------------------------------------------------------------------------

export interface SessionActionsContextValue {
  /** The session ID these actions operate on. Null when no session is bound. */
  sessionId: string | null;

  // Bookmark mutations
  addBookmark: (
    lineNumber: number, label: string, note: string,
    createdBy?: CreatedBy, lineNumberEnd?: number, snippet?: string[],
    category?: string, tags?: string[],
  ) => Promise<Bookmark | null>;
  editBookmark: (
    bookmarkId: string, label?: string, note?: string,
    category?: string, tags?: string[],
  ) => Promise<Bookmark | null>;
  removeBookmark: (bookmarkId: string) => Promise<void>;

  // Analysis mutations
  publishSessionAnalysis: (title: string, sections: AnalysisSection[]) => Promise<AnalysisArtifact | null>;
  updateSessionAnalysis: (
    artifactId: string, title?: string, sections?: AnalysisSection[],
  ) => Promise<AnalysisArtifact | null>;
  deleteSessionAnalysis: (artifactId: string) => Promise<void>;

  // Watch mutations
  addWatch: (criteria: FilterCriteria) => Promise<WatchInfo | null>;
  removeWatch: (watchId: string) => Promise<void>;
}

const SessionActionsContext = createContext<SessionActionsContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface SessionActionsProviderProps {
  sessionId: string | null;
  children: ReactNode;
}

/**
 * Per-session action surface. Provides mutation callbacks scoped to one session.
 * All mutations automatically emit `workspace:mutated` for dirty tracking.
 *
 * Mount alongside `SessionDataProvider` — they share the same sessionId.
 * Actions are stable callbacks (they read sessionId from a ref, not a dep).
 */
export function SessionActionsProvider({ sessionId, children }: SessionActionsProviderProps) {
  // Use a ref pattern so callbacks never need to be recreated when sessionId changes.
  // This keeps the context value stable and prevents consumer re-renders.
  const sessionIdRef = useMemo(() => ({ current: sessionId }), []);
  sessionIdRef.current = sessionId;

  const markDirty = useCallback(() => {
    bus.emit('workspace:mutated', undefined);
  }, []);

  // --- Bookmark actions ---

  const addBookmarkAction = useCallback(async (
    lineNumber: number, label: string, note: string,
    createdBy: CreatedBy = 'User', lineNumberEnd?: number, snippet?: string[],
    category?: string, tags?: string[],
  ): Promise<Bookmark | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    try {
      const result = await createBookmark(sid, lineNumber, label, note, createdBy, lineNumberEnd, snippet, category, tags);
      markDirty();
      return result;
    } catch (e) {
      console.error('[SessionActions] addBookmark error:', e);
      return null;
    }
  }, [markDirty]);

  const editBookmarkAction = useCallback(async (
    bookmarkId: string, label?: string, note?: string,
    category?: string, tags?: string[],
  ): Promise<Bookmark | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    try {
      const result = await updateBookmark(sid, bookmarkId, label, note, category, tags);
      markDirty();
      return result;
    } catch (e) {
      console.error('[SessionActions] editBookmark error:', e);
      return null;
    }
  }, [markDirty]);

  const removeBookmarkAction = useCallback(async (bookmarkId: string): Promise<void> => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await deleteBookmark(sid, bookmarkId);
    markDirty();
  }, [markDirty]);

  // --- Analysis actions ---

  const publishSessionAnalysisAction = useCallback(async (
    title: string, sections: AnalysisSection[],
  ): Promise<AnalysisArtifact | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    const art = await publishAnalysis(sid, title, sections);
    if (art) {
      bus.emit('analysis:published-local', { artifactId: art.id });
      markDirty();
    }
    return art;
  }, [markDirty]);

  const updateSessionAnalysisAction = useCallback(async (
    artifactId: string, title?: string, sections?: AnalysisSection[],
  ): Promise<AnalysisArtifact | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    const art = await updateAnalysis(sid, artifactId, title, sections);
    if (art) markDirty();
    return art;
  }, [markDirty]);

  const deleteSessionAnalysisAction = useCallback(async (artifactId: string): Promise<void> => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await deleteAnalysis(sid, artifactId);
    markDirty();
  }, [markDirty]);

  // --- Watch actions ---

  const addWatchAction = useCallback(async (criteria: FilterCriteria): Promise<WatchInfo | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    return await createWatch(sid, criteria);
    // Watches don't mark dirty — they're transient monitoring, not saved artifacts
  }, []);

  const removeWatchAction = useCallback(async (watchId: string): Promise<void> => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await cancelWatch(sid, watchId);
  }, []);

  // --- Context value (stable — all callbacks use refs) ---

  const value = useMemo<SessionActionsContextValue>(() => ({
    sessionId,
    addBookmark: addBookmarkAction,
    editBookmark: editBookmarkAction,
    removeBookmark: removeBookmarkAction,
    publishSessionAnalysis: publishSessionAnalysisAction,
    updateSessionAnalysis: updateSessionAnalysisAction,
    deleteSessionAnalysis: deleteSessionAnalysisAction,
    addWatch: addWatchAction,
    removeWatch: removeWatchAction,
  }), [sessionId, addBookmarkAction, editBookmarkAction, removeBookmarkAction,
       publishSessionAnalysisAction, updateSessionAnalysisAction, deleteSessionAnalysisAction,
       addWatchAction, removeWatchAction]);

  return (
    <SessionActionsContext.Provider value={value}>
      {children}
    </SessionActionsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useSessionActions(): SessionActionsContextValue {
  const ctx = useContext(SessionActionsContext);
  if (!ctx) throw new Error('useSessionActions must be used within a SessionActionsProvider');
  return ctx;
}

/** Bookmark mutation actions for the enclosing session. */
export function useSessionBookmarkActions() {
  const { addBookmark, editBookmark, removeBookmark } = useSessionActions();
  return { addBookmark, editBookmark, removeBookmark };
}

/** Analysis mutation actions for the enclosing session. */
export function useSessionAnalysisActions() {
  const { publishSessionAnalysis, updateSessionAnalysis, deleteSessionAnalysis } = useSessionActions();
  return { publishSessionAnalysis, updateSessionAnalysis, deleteSessionAnalysis };
}

/** Watch mutation actions for the enclosing session. */
export function useSessionWatchActions() {
  const { addWatch, removeWatch } = useSessionActions();
  return { addWatch, removeWatch };
}
