import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { CacheManager, type WritableViewCache, type CacheController } from './CacheManager';
import { DataSourceRegistry, type DataSourceRegistrar } from '../viewport/DataSourceRegistry';
import { storageGetJSON } from '../utils';
import type { ViewLine } from '../bridge/types';

// ---------------------------------------------------------------------------
// Pre-seed store — allows optimistic line fetches to be stored before the
// ViewCacheHandle is allocated (e.g. while React propagates session state).
// useViewCache consumes and clears these when it allocates a new handle.
// ---------------------------------------------------------------------------
const preSeedStore = new Map<string, ViewLine[]>();

/** Store pre-fetched lines for a session before its ViewCacheHandle is allocated.
 *  useViewCache will consume these when it allocates the handle. */
export function preSeedSession(sessionId: string, lines: ViewLine[]): void {
  preSeedStore.set(sessionId, lines);
}

/** Default total line budget — matches SETTING_DEFAULTS.fileCacheBudget. */
const DEFAULT_BUDGET = 100_000;

/** Read the persisted fileCacheBudget from localStorage at startup. Falls back to DEFAULT_BUDGET. */
function readPersistedBudget(): number {
  const parsed = storageGetJSON<{ fileCacheBudget?: unknown }>('logtapper_settings', {});
  const v = parsed.fileCacheBudget;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_BUDGET;
}

interface CacheContextValue {
  manager: CacheManager;
  registry: DataSourceRegistry;
}

const CacheManagerContext = createContext<CacheContextValue | null>(null);

interface CacheProviderProps {
  budget?: number;
  children: ReactNode;
}

/**
 * Wraps the app with a global CacheManager + DataSourceRegistry.
 * Both are created once and persist for the lifetime of the app.
 */
export function CacheProvider({ budget, children }: CacheProviderProps) {
  const ctxRef = useRef<CacheContextValue | null>(null);
  if (ctxRef.current === null) {
    ctxRef.current = {
      manager: new CacheManager(budget ?? readPersistedBudget()),
      registry: new DataSourceRegistry(),
    };
  }

  // Propagate budget changes to the existing CacheManager instance
  useEffect(() => {
    if (budget !== undefined) {
      ctxRef.current?.manager.setTotalBudget(budget);
    }
  }, [budget]);

  return (
    <CacheManagerContext.Provider value={ctxRef.current}>
      {children}
    </CacheManagerContext.Provider>
  );
}

/** Access the global CacheManager. Throws if used outside CacheProvider. */
export function useCacheManager(): CacheController {
  const ctx = useContext(CacheManagerContext);
  if (!ctx) {
    throw new Error('useCacheManager must be used within a CacheProvider');
  }
  return ctx.manager;
}

/** Access the global DataSourceRegistry. Throws if used outside CacheProvider. */
export function useDataSourceRegistry(): DataSourceRegistrar {
  const ctx = useContext(CacheManagerContext);
  if (!ctx) {
    throw new Error('useDataSourceRegistry must be used within a CacheProvider');
  }
  return ctx.registry;
}

/**
 * Get or create a ViewCacheHandle for a specific view ID.
 * The handle is allocated on first call and reused on subsequent renders.
 * When viewId changes (tab switch), the OLD handle is intentionally kept in
 * the manager so the inactive tab retains its cached lines. The old handle will
 * be explicitly released via releaseSessionViews() when that session is closed.
 * @param sessionId  Optional session ID — enables session-level broadcast via CacheManager.
 */
export function useViewCache(viewId: string | null, sessionId?: string | null): WritableViewCache | null {
  const ctx = useContext(CacheManagerContext);
  const mgr = ctx?.manager ?? null;
  const prevIdRef = useRef<string | null>(null);
  const handleRef = useRef<WritableViewCache | null>(null);

  if (!mgr || !viewId) {
    // Manager unavailable or viewId cleared — null out local ref.
    // Do NOT release the old handle; it stays in the manager until
    // releaseSessionViews() is called when the session is actually closed.
    if (handleRef.current !== null) {
      console.debug('[useViewCache] nulling handle (no mgr or no viewId)', { viewId, prevId: prevIdRef.current });
    }
    handleRef.current = null;
  } else if (prevIdRef.current !== viewId) {
    // Allocate on first call or when viewId changes (tab switch).
    // Do NOT release the previous handle — the inactive tab should keep its
    // cached lines so switching back doesn't trigger a reload from disk.
    console.debug('[useViewCache] allocating handle (viewId changed)', { viewId, prevId: prevIdRef.current });
    handleRef.current = mgr.allocateView(viewId, sessionId ?? undefined);
    prevIdRef.current = viewId;
    // Consume any pre-seeded lines that arrived before this handle was allocated.
    if (sessionId) {
      const preSeed = preSeedStore.get(sessionId);
      if (preSeed) {
        console.debug('[useViewCache] consuming pre-seed', { sessionId, lineCount: preSeed.length });
        handleRef.current!.put(preSeed);
        preSeedStore.delete(sessionId);
      }
    }
  } else if (handleRef.current === null) {
    // viewId matches prevId but the local ref was cleared during a brief null
    // interlude (e.g. pane move before paneSessionMap updates: viewId goes
    // "view-abc" → null → "view-abc"). Re-acquire — allocateView returns the
    // existing handle if it's still in the manager, so cached lines survive.
    console.debug('[useViewCache] re-acquiring handle after null interlude', { viewId });
    handleRef.current = mgr.allocateView(viewId, sessionId ?? undefined);
  }

  // NOTE: No unmount cleanup here — handles are released by releaseSessionViews()
  // when a session is explicitly closed. Since viewId = 'view-${sessionId}' is
  // session-scoped, at most one handle exists per session and ghost handles cannot
  // accumulate. The old unmount-cleanup approach caused a race: when a pane with the
  // LAST tab is removed (collapsed after a drag), pane-A unmounts and its cleanup
  // cleared the shared handle object that pane-C had already acquired during the
  // same render cycle, leaving pane-C with an empty, deregistered ghost handle.

  return handleRef.current;
}

/**
 * Set focus on a view for cache budget prioritization (60% to focused pane).
 * Calls CacheManager.setFocus() on mount and when viewId changes.
 */
export function useCacheFocus(viewId: string | null): void {
  const ctx = useContext(CacheManagerContext);
  const mgr = ctx?.manager ?? null;

  useEffect(() => {
    if (mgr && viewId) {
      mgr.setFocus(viewId);
    }
  }, [mgr, viewId]);
}
