import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { bus } from '../events/bus';
import type { WorkspaceIdentity } from '../bridge/workspaceTypes';
import { createEmptyIdentity, WORKSPACE_STORAGE_KEY } from '../bridge/workspaceTypes';

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

export function loadPersistedIdentity(): WorkspaceIdentity {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceIdentity;
      // On app restart, a previously-dirty workspace stays dirty
      // (crash recovery — user never saved)
      return parsed;
    }
  } catch { /* ignore corrupt localStorage */ }
  return createEmptyIdentity();
}

export function persistIdentity(identity: WorkspaceIdentity): void {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(identity));
  } catch { /* localStorage full — non-critical */ }
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
  const identityRef = useRef(identity);
  identityRef.current = identity;
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
    const handler = () => {
      setIdentity(prev => prev.dirty ? prev : { ...prev, dirty: true });
    };
    bus.on('workspace:mutated', handler);
    return () => { bus.off('workspace:mutated', handler); };
  }, []);

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
