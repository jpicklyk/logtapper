import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { bus } from '../events/bus';
import type { WorkspaceIdentity, WorkspaceListState } from '../bridge/workspaceTypes';
import {
  createEmptyWorkspace, createEmptyListState,
  getActiveWorkspace, formatTitle, WORKSPACE_STORAGE_KEY,
} from '../bridge/workspaceTypes';
import { storageGetJSON, storageSetJSON } from '../utils';

// ---------------------------------------------------------------------------
// Context value
// ---------------------------------------------------------------------------

export interface WorkspaceContextValue {
  /** All open workspaces. */
  workspaces: WorkspaceIdentity[];
  /** ID of the active workspace, or null if none. */
  activeId: string | null;
  /** The active workspace entry, or null. */
  activeWorkspace: WorkspaceIdentity | null;

  // Workspace list mutations
  /** Add a new empty workspace and make it active. Returns the new workspace ID. */
  addWorkspace: () => string;
  /** Add a workspace with a given identity (e.g. from opening a .ltw file). */
  addWorkspaceEntry: (ws: WorkspaceIdentity) => void;
  /** Switch the active workspace. */
  setActiveId: (id: string) => void;
  /** Remove a workspace from the list. */
  removeWorkspace: (id: string) => void;

  // Active workspace mutations
  /** Mark the active workspace dirty. Idempotent. */
  markDirty: () => void;
  /** Mark the active workspace clean after save. Sets name + filePath. */
  markClean: (name: string, filePath: string) => void;
  /** Update the name of a workspace. */
  renameWorkspace: (id: string, name: string) => void;
  /** Update the ltwPath of a workspace after save. */
  setWorkspacePath: (id: string, ltwPath: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

// ---------------------------------------------------------------------------
// Persistence helpers (exported for testing)
// ---------------------------------------------------------------------------

export function loadPersistedList(): WorkspaceListState {
  return storageGetJSON<WorkspaceListState>(WORKSPACE_STORAGE_KEY, createEmptyListState());
}

export function persistList(state: WorkspaceListState): void {
  storageSetJSON(WORKSPACE_STORAGE_KEY, state);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [listState, setListState] = useState<WorkspaceListState>(() => {
    const persisted = loadPersistedList();
    // Auto-create a default workspace on first run
    if (persisted.workspaces.length === 0) {
      const ws = createEmptyWorkspace();
      return { workspaces: [ws], activeId: ws.id };
    }
    return persisted;
  });

  // Persist on every list change
  useEffect(() => {
    persistList(listState);
  }, [listState]);

  // Update window title when active workspace changes
  const activeWsForTitle = getActiveWorkspace(listState);
  useEffect(() => {
    getCurrentWindow().setTitle(formatTitle(activeWsForTitle));
  }, [activeWsForTitle?.name, activeWsForTitle?.dirty]);

  // --- Helpers ---

  const updateWorkspace = useCallback((id: string, updater: (ws: WorkspaceIdentity) => WorkspaceIdentity) => {
    setListState(prev => {
      const idx = prev.workspaces.findIndex(w => w.id === id);
      if (idx === -1) return prev;
      const updated = updater(prev.workspaces[idx]);
      if (updated === prev.workspaces[idx]) return prev; // no change
      const next = [...prev.workspaces];
      next[idx] = updated;
      return { ...prev, workspaces: next };
    });
  }, []);

  // --- Workspace list mutations ---

  const addWorkspace = useCallback((): string => {
    const ws = createEmptyWorkspace();
    setListState(prev => ({
      workspaces: [...prev.workspaces, ws],
      activeId: ws.id,
    }));
    return ws.id;
  }, []);

  const addWorkspaceEntry = useCallback((ws: WorkspaceIdentity) => {
    setListState(prev => ({
      workspaces: [...prev.workspaces, ws],
      activeId: ws.id,
    }));
  }, []);

  const setActiveId = useCallback((id: string) => {
    setListState(prev => prev.activeId === id ? prev : { ...prev, activeId: id });
  }, []);

  const removeWorkspace = useCallback((id: string) => {
    setListState(prev => {
      const remaining = prev.workspaces.filter(w => w.id !== id);
      let nextActiveId = prev.activeId;
      if (prev.activeId === id) {
        // Activate the previous workspace, or the first remaining, or null
        const removedIdx = prev.workspaces.findIndex(w => w.id === id);
        if (remaining.length > 0) {
          nextActiveId = remaining[Math.min(removedIdx, remaining.length - 1)].id;
        } else {
          nextActiveId = null;
        }
      }
      return { workspaces: remaining, activeId: nextActiveId };
    });
  }, []);

  // --- Active workspace mutations ---

  const markDirty = useCallback(() => {
    setListState(prev => {
      if (!prev.activeId) return prev;
      const idx = prev.workspaces.findIndex(w => w.id === prev.activeId);
      if (idx === -1 || prev.workspaces[idx].dirty) return prev;
      const next = [...prev.workspaces];
      next[idx] = { ...next[idx], dirty: true };
      return { ...prev, workspaces: next };
    });
  }, []);

  const markClean = useCallback((name: string, filePath: string) => {
    setListState(prev => {
      if (!prev.activeId) return prev;
      const idx = prev.workspaces.findIndex(w => w.id === prev.activeId);
      if (idx === -1) return prev;
      const next = [...prev.workspaces];
      next[idx] = { ...next[idx], name, filePath, dirty: false };
      return { ...prev, workspaces: next };
    });
  }, []);

  const renameWorkspace = useCallback((id: string, name: string) => {
    updateWorkspace(id, ws => ws.name === name ? ws : { ...ws, name });
  }, [updateWorkspace]);

  const setWorkspacePath = useCallback((id: string, ltwPath: string) => {
    updateWorkspace(id, ws => ws.filePath === ltwPath ? ws : { ...ws, filePath: ltwPath });
  }, [updateWorkspace]);

  // --- Listen for workspace:mutated events ---

  useEffect(() => {
    bus.on('workspace:mutated', markDirty);
    return () => { bus.off('workspace:mutated', markDirty); };
  }, [markDirty]);

  const value = useMemo<WorkspaceContextValue>(() => {
    const active = getActiveWorkspace(listState);
    return {
      workspaces: listState.workspaces,
      activeId: listState.activeId,
      activeWorkspace: active,
      addWorkspace,
      addWorkspaceEntry,
      setActiveId,
      removeWorkspace,
      markDirty,
      markClean,
      renameWorkspace,
      setWorkspacePath,
    };
  }, [listState, addWorkspace, addWorkspaceEntry, setActiveId, removeWorkspace,
       markDirty, markClean, renameWorkspace, setWorkspacePath]);

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useWorkspaceContext(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspaceContext must be used within a WorkspaceProvider');
  return ctx;
}

/** The active workspace entry (name, filePath, dirty, id), or null. */
export function useWorkspaceIdentity(): WorkspaceIdentity | null {
  return useWorkspaceContext().activeWorkspace;
}

/** The full workspace list. */
export function useWorkspaceList(): WorkspaceIdentity[] {
  return useWorkspaceContext().workspaces;
}

/** The active workspace ID. */
export function useActiveWorkspaceId(): string | null {
  return useWorkspaceContext().activeId;
}
