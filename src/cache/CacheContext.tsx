import { createContext, useContext, useRef, type ReactNode } from 'react';
import { CacheManager, type ViewCacheHandle } from './CacheManager';

/** Default total line budget. */
const DEFAULT_BUDGET = 100_000;

const CacheManagerContext = createContext<CacheManager | null>(null);

interface CacheProviderProps {
  budget?: number;
  children: ReactNode;
}

/**
 * Wraps the app with a global CacheManager instance.
 * The CacheManager is created once and persists for the lifetime of the app.
 */
export function CacheProvider({ budget = DEFAULT_BUDGET, children }: CacheProviderProps) {
  const mgrRef = useRef<CacheManager | null>(null);
  if (mgrRef.current === null) {
    mgrRef.current = new CacheManager(budget);
  }
  return (
    <CacheManagerContext.Provider value={mgrRef.current}>
      {children}
    </CacheManagerContext.Provider>
  );
}

/** Access the global CacheManager. Throws if used outside CacheProvider. */
export function useCacheManager(): CacheManager {
  const mgr = useContext(CacheManagerContext);
  if (!mgr) {
    throw new Error('useCacheManager must be used within a CacheProvider');
  }
  return mgr;
}

/**
 * Get or create a ViewCacheHandle for a specific view ID.
 * The handle is allocated on first call and reused on subsequent renders.
 * When viewId changes, the old handle is released and a new one is allocated.
 */
export function useViewCache(viewId: string | null): ViewCacheHandle | null {
  const mgr = useContext(CacheManagerContext);
  const prevIdRef = useRef<string | null>(null);
  const handleRef = useRef<ViewCacheHandle | null>(null);

  if (!mgr || !viewId) {
    // Release any existing handle
    if (prevIdRef.current && mgr) {
      mgr.releaseView(prevIdRef.current);
    }
    prevIdRef.current = null;
    handleRef.current = null;
    return null;
  }

  // Allocate on first call or when viewId changes
  if (prevIdRef.current !== viewId) {
    if (prevIdRef.current) {
      mgr.releaseView(prevIdRef.current);
    }
    handleRef.current = mgr.allocateView(viewId);
    prevIdRef.current = viewId;
  }

  return handleRef.current;
}
