import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { bus } from '../events/bus';
import type { WorkspaceIdentity } from '../bridge/workspaceTypes';
import { createEmptyIdentity, WORKSPACE_STORAGE_KEY } from '../bridge/workspaceTypes';
import { storageGetJSON, storageSetJSON } from '../utils';

// ---------------------------------------------------------------------------
// Context value
// ---------------------------------------------------------------------------

export interface WorkspaceContextValue {
  /** Current workspace identity (name, filePath, dirty flag). */
  identity: WorkspaceIdentity;
  /** Mark the workspace as having unsaved changes. Idempotent. */
  markDirty: () => void;
  /** Mark the workspace as clean after a save/open. Sets name + filePath. */
  markClean: (name: string, filePath: string) => void;
  /** Reset identity to a fresh "Untitled" workspace. */
  resetIdentity: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

// ---------------------------------------------------------------------------
// Persistence helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Load workspace identity from localStorage (crash recovery). Preserves dirty flag. */
export function loadPersistedIdentity(): WorkspaceIdentity {
  return storageGetJSON<WorkspaceIdentity>(WORKSPACE_STORAGE_KEY, createEmptyIdentity());
}

export function persistIdentity(identity: WorkspaceIdentity): void {
  storageSetJSON(WORKSPACE_STORAGE_KEY, identity);
}

// ---------------------------------------------------------------------------
// Title bar (exported for testing)
// ---------------------------------------------------------------------------

export function formatTitle(identity: WorkspaceIdentity): string {
  const indicator = identity.dirty ? ' *' : '';
  return `${identity.name}${indicator} \u2014 LogTapper`;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<WorkspaceIdentity>(loadPersistedIdentity);

  // Persist on every identity change
  useEffect(() => {
    persistIdentity(identity);
  }, [identity]);

  // Update window title
  useEffect(() => {
    getCurrentWindow().setTitle(formatTitle(identity));
  }, [identity.name, identity.dirty]);

  // --- Callbacks (stable refs) ---

  const markDirty = useCallback(() => {
    setIdentity(prev => prev.dirty ? prev : { ...prev, dirty: true });
  }, []);

  const markClean = useCallback((name: string, filePath: string) => {
    setIdentity({ name, filePath, dirty: false });
  }, []);

  const resetIdentity = useCallback(() => {
    setIdentity(createEmptyIdentity());
  }, []);

  // --- Listen for workspace:mutated events ---

  useEffect(() => {
    bus.on('workspace:mutated', markDirty);
    return () => { bus.off('workspace:mutated', markDirty); };
  }, [markDirty]);

  const value = useMemo<WorkspaceContextValue>(() => ({
    identity,
    markDirty,
    markClean,
    resetIdentity,
  }), [identity, markDirty, markClean, resetIdentity]);

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

/** Narrow selector: returns only the workspace identity (name, filePath, dirty). */
export function useWorkspaceIdentity(): WorkspaceIdentity {
  return useWorkspaceContext().identity;
}
