import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { bus } from '../events/bus';
import type { WorkspaceIdentity, WorkspaceListState } from '../bridge/workspaceTypes';
import {
  createEmptyWorkspace, createEmptyListState,
  getActiveWorkspace, formatTitle, WORKSPACE_STORAGE_KEY,
} from '../bridge/workspaceTypes';
import { storageGetJSON, storageSetJSON } from '../utils';
import { getAppState, saveAppState } from '../bridge/commands';
import { reconcileWorkspaceList } from '../hooks/workspace/reconcileWorkspaceList';
import { buildAppStatePayload } from '../hooks/workspace/appStatePayload';
import type { AppStateFile } from '../bridge/types';

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
  /** Record a completed auto-save: sets filePath (so switch-back can reload)
   *  plus the `autoSavePath` / `lastAutoSaveAt` recovery fields. Does not touch
   *  the dirty flag — an auto-save is not a user save. */
  recordAutoSave: (id: string, autoSavePath: string, savedAt: number) => void;

  // Startup hydration (option 1C — app-state.json is authoritative)
  /** True once the one-shot disk hydration has resolved. The startup restore
   *  orchestrator (Q2) must await this before reading any `.ltw`. */
  hydrated: boolean;
  /** Reconcile the current in-memory list against the authoritative on-disk
   *  state and apply the result. Normally driven by the internal hydration
   *  effect; exposed for the orchestrator. */
  hydrateFromDisk: (diskState: AppStateFile) => void;
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

  // True once the one-shot disk hydration below has resolved.
  const [hydrated, setHydrated] = useState(false);

  // Lets the hydration effect read the current (synchronously-seeded) list
  // without adding listState to its dependency array (it must run once).
  const listStateRef = useRef(listState);
  listStateRef.current = listState;

  // Persist on every list change. localStorage is the fast bootstrap mirror
  // (kept exactly as before); after hydration we ALSO write through to the
  // authoritative app-state.json so every list change (rename, dirty flip,
  // setWorkspacePath, recordAutoSave) reaches disk — not just the six lifecycle
  // ops. The disk write is gated on `hydrated` so the synchronous localStorage
  // seed cannot clobber the authoritative disk state before it is read.
  useEffect(() => {
    persistList(listState);
    if (hydrated) {
      saveAppState(buildAppStatePayload(listState.workspaces, listState.activeId))
        .catch((e: unknown) => console.warn('[WorkspaceProvider] Failed to write app-state.json:', e));
    }
  }, [listState, hydrated]);

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

  const recordAutoSave = useCallback((id: string, autoSavePath: string, savedAt: number) => {
    updateWorkspace(id, ws => ({
      ...ws,
      // Point filePath at the recovery file so a workspace switch can reload it
      // (only reached when the workspace had no explicit .ltw, i.e. filePath was
      // null). Deliberately does not touch `dirty` — this is not a user save.
      filePath: autoSavePath,
      autoSavePath,
      lastAutoSaveAt: savedAt,
    }));
  }, [updateWorkspace]);

  // --- Startup hydration: app-state.json is authoritative (option 1C) ---

  const hydrateFromDisk = useCallback((diskState: AppStateFile) => {
    const { state, migrated, createDefault } = reconcileWorkspaceList(listStateRef.current, diskState);
    // createDefault means both sides were empty. The synchronous seed above
    // already created the default workspace, so keep it as-is.
    if (!createDefault) setListState(state);
    if (migrated) {
      // Disk was empty but memory had a list (every existing user, and fresh
      // installs whose default we just seeded): write it through once. Idempotent.
      saveAppState(buildAppStatePayload(state.workspaces, state.activeId))
        .catch((e: unknown) => console.warn('[WorkspaceProvider] Initial app-state write failed:', e));
    }
    setHydrated(true);
  }, []);

  // One-shot: read the authoritative disk state and reconcile. StrictMode-safe
  // via the cancelled guard (CLAUDE.md async-listener pattern) so the double
  // mount does not apply hydration twice.
  useEffect(() => {
    let cancelled = false;
    getAppState()
      .then((diskState) => {
        if (cancelled) return;
        hydrateFromDisk(diskState);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Even on failure, signal completion so the startup orchestrator (Q2)
        // is not left waiting forever; the localStorage seed stands.
        console.warn('[WorkspaceProvider] Disk hydration failed:', e);
        setHydrated(true);
      });
    return () => { cancelled = true; };
  }, [hydrateFromDisk]);

  // --- Listen for workspace:mutated events ---

  useEffect(() => {
    bus.on('workspace:mutated', markDirty);
    return () => { bus.off('workspace:mutated', markDirty); };
  }, [markDirty]);

  // --- Record background auto-saves onto the workspace entry ---

  useEffect(() => {
    const onAutoSaved = (payload: { workspaceId: string; path: string; savedAt: number }) => {
      recordAutoSave(payload.workspaceId, payload.path, payload.savedAt);
    };
    bus.on('workspace:auto-saved', onAutoSaved);
    return () => { bus.off('workspace:auto-saved', onAutoSaved); };
  }, [recordAutoSave]);

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
      recordAutoSave,
      hydrated,
      hydrateFromDisk,
    };
  }, [listState, addWorkspace, addWorkspaceEntry, setActiveId, removeWorkspace,
       markDirty, markClean, renameWorkspace, setWorkspacePath, recordAutoSave,
       hydrated, hydrateFromDisk]);

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
