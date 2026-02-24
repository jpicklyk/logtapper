import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { CacheManager, type WritableViewCache, type CacheController } from './CacheManager';
import { DataSourceRegistry, type DataSourceRegistrar } from '../viewport/DataSourceRegistry';

/** Default total line budget — matches SETTING_DEFAULTS.fileCacheBudget. */
const DEFAULT_BUDGET = 100_000;

/** Read the persisted fileCacheBudget from localStorage at startup. Falls back to DEFAULT_BUDGET. */
function readPersistedBudget(): number {
  try {
    const raw = localStorage.getItem('logtapper_settings');
    if (!raw) return DEFAULT_BUDGET;
    const parsed = JSON.parse(raw) as { fileCacheBudget?: unknown };
    const v = parsed.fileCacheBudget;
    return typeof v === 'number' && v > 0 ? v : DEFAULT_BUDGET;
  } catch {
    return DEFAULT_BUDGET;
  }
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
 * When viewId changes, the old handle is released and a new one is allocated.
 * @param sessionId  Optional session ID — enables session-level broadcast via CacheManager.
 */
export function useViewCache(viewId: string | null, sessionId?: string | null): WritableViewCache | null {
  const ctx = useContext(CacheManagerContext);
  const mgr = ctx?.manager ?? null;
  const prevIdRef = useRef<string | null>(null);
  const handleRef = useRef<WritableViewCache | null>(null);

  if (!mgr || !viewId) {
    // Release any existing handle
    if (prevIdRef.current && mgr) {
      mgr.releaseView(prevIdRef.current);
    }
    prevIdRef.current = null;
    handleRef.current = null;
  } else if (prevIdRef.current !== viewId) {
    // Allocate on first call or when viewId changes
    if (prevIdRef.current) {
      mgr.releaseView(prevIdRef.current);
    }
    handleRef.current = mgr.allocateView(viewId, sessionId ?? undefined);
    prevIdRef.current = viewId;
  }

  // Release handle on unmount to prevent ghost handles consuming budget.
  // Must always be called (Rules of Hooks) — guard body with refs.
  useEffect(() => {
    return () => {
      if (prevIdRef.current && mgr) {
        mgr.releaseView(prevIdRef.current);
        prevIdRef.current = null;
        handleRef.current = null;
      }
    };
  }, [mgr, viewId]);

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
