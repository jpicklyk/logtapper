import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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

/** Remove a pre-seed entry (call on load failure or stale-generation abort). */
export function clearPreSeed(sessionId: string): void {
  preSeedStore.delete(sessionId);
}

/** Default total line budget — matches SETTING_DEFAULTS.fileCacheBudget. */
const DEFAULT_BUDGET = 250_000;

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
 * The handle is allocated on first commit and reused on subsequent renders.
 * When viewId changes (tab switch), the OLD handle is intentionally kept in
 * the manager so the inactive tab retains its cached lines. The old handle will
 * be explicitly released via releaseSessionViews() when that session is closed.
 * @param sessionId  Optional session ID — enables session-level broadcast via CacheManager.
 */
export function useViewCache(viewId: string | null, sessionId?: string | null): WritableViewCache | null {
  const ctx = useContext(CacheManagerContext);
  const mgr = ctx?.manager ?? null;
  const [handle, setHandle] = useState<WritableViewCache | null>(null);

  // Allocation — and its side effects on the shared, module-level CacheManager
  // (registering a handle, possibly becoming the focused view, and
  // _redistribute()'s LRU eviction pressure on OTHER views' cached lines) —
  // must run in a committed effect, not render. A render that starts but is
  // discarded (a StrictMode double-render across an abandoned pass, or a
  // concurrent-mode interrupt) would otherwise leave a ghost handle in the
  // CacheManager forever: there is deliberately no unmount cleanup here (see
  // note below), so nothing would ever release it (U12 fix).
  //
  // This does not regress LogViewer's first-paint contract: LogViewer already
  // creates its CacheDataSource (the thing consumers actually read from) in
  // its own useEffect keyed on `viewCache`, and gates rendering on
  // `if (!dataSource) return null` until that effect has run — so the handle
  // was already effectively "one effect tick late" from the consumer's
  // perspective even when allocation happened synchronously in render.
  useEffect(() => {
    if (!mgr || !viewId) {
      setHandle(null);
      return;
    }
    console.debug('[useViewCache] allocating handle', { viewId, sessionId });
    // allocateView is idempotent for an already-registered viewId (returns the
    // existing handle without re-registering or redistributing), so this is
    // also safe as a re-acquire after a viewId → null → viewId interlude.
    const h = mgr.allocateView(viewId, sessionId ?? undefined);
    setHandle(h);

    // Consume any lines pre-seeded for this session before the handle existed.
    if (sessionId) {
      const preSeed = preSeedStore.get(sessionId);
      if (preSeed) {
        console.debug('[useViewCache] consuming pre-seed', { sessionId, lineCount: preSeed.length });
        h.put(preSeed);
        preSeedStore.delete(sessionId);
      }
    }
  }, [mgr, viewId, sessionId]);

  // NOTE: No unmount cleanup here — handles are released by releaseSessionViews()
  // when a session is explicitly closed. Since viewId = 'view-${sessionId}' is
  // session-scoped, at most one handle exists per session and ghost handles cannot
  // accumulate. The old unmount-cleanup approach caused a race: when a pane with the
  // LAST tab is removed (collapsed after a drag), pane-A unmounts and its cleanup
  // cleared the shared handle object that pane-C had already acquired during the
  // same render cycle, leaving pane-C with an empty, deregistered ghost handle.

  return handle;
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
