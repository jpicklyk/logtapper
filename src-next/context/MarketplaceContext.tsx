import { createContext, useContext, useReducer, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import type { Source, UpdateAvailable, PackUpdateAvailable } from '../bridge/types';
import { getPendingUpdates, getPendingPackUpdates, checkUpdates as checkUpdatesCmd, listSources } from '../bridge/commands';
import { bus } from '../events/bus';

// ── State ─────────────────────────────────────────────────────────────────────

interface MarketplaceState {
  sources: Source[];
  sourcesLoading: boolean;
  pendingUpdates: UpdateAvailable[];
  pendingPackUpdates: PackUpdateAvailable[];
  updatesLoading: boolean;
}

const initialState: MarketplaceState = {
  sources: [],
  sourcesLoading: false,
  pendingUpdates: [],
  pendingPackUpdates: [],
  updatesLoading: false,
};

// ── Actions ───────────────────────────────────────────────────────────────────

type MarketplaceAction =
  | { type: 'sources:loading' }
  | { type: 'sources:loaded'; sources: Source[] }
  | { type: 'sources:loaded-error' }
  | { type: 'updates:loading' }
  | { type: 'updates:loaded'; updates: UpdateAvailable[] }
  | { type: 'updates:loaded-error' }
  | { type: 'updates:decremented'; processorId: string }
  | { type: 'pack-updates:loaded'; packUpdates: PackUpdateAvailable[] }
  | { type: 'pack-updates:decremented'; packId: string };

// ── Reducer ───────────────────────────────────────────────────────────────────

function marketplaceReducer(state: MarketplaceState, action: MarketplaceAction): MarketplaceState {
  switch (action.type) {
    case 'sources:loading':
      return { ...state, sourcesLoading: true };
    case 'sources:loaded':
      return { ...state, sourcesLoading: false, sources: action.sources };
    case 'sources:loaded-error':
      return { ...state, sourcesLoading: false };
    case 'updates:loading':
      return { ...state, updatesLoading: true };
    case 'updates:loaded':
      return { ...state, updatesLoading: false, pendingUpdates: action.updates };
    case 'updates:loaded-error':
      return { ...state, updatesLoading: false };
    case 'updates:decremented': {
      const next = state.pendingUpdates.filter((u) => u.processorId !== action.processorId);
      if (next.length === state.pendingUpdates.length) return state;
      return { ...state, pendingUpdates: next };
    }
    case 'pack-updates:loaded':
      return { ...state, pendingPackUpdates: action.packUpdates };
    case 'pack-updates:decremented': {
      const next = state.pendingPackUpdates.filter((u) => u.packId !== action.packId);
      if (next.length === state.pendingPackUpdates.length) return state;
      return { ...state, pendingPackUpdates: next };
    }
    default:
      return state;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

export interface MarketplaceContextValue extends MarketplaceState {
  dispatch: React.Dispatch<MarketplaceAction>;
  setSources: (sources: Source[]) => void;
}

const MarketplaceContext = createContext<MarketplaceContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function MarketplaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(marketplaceReducer, initialState);

  // Seed pending updates and sources on mount
  useEffect(() => {
    let cancelled = false;

    getPendingUpdates()
      .then((updates) => { if (!cancelled) dispatch({ type: 'updates:loaded', updates }); })
      .catch(() => { if (!cancelled) dispatch({ type: 'updates:loaded-error' }); });

    getPendingPackUpdates()
      .then((packUpdates) => { if (!cancelled) dispatch({ type: 'pack-updates:loaded', packUpdates }); })
      .catch(() => { /* startup pending packs are best-effort — check_updates is the primary path */ });

    listSources()
      .then((sources) => { if (!cancelled) dispatch({ type: 'sources:loaded', sources }); })
      .catch(() => { if (!cancelled) dispatch({ type: 'sources:loaded-error' }); });

    return () => { cancelled = true; };
  }, []);

  // Subscribe to bus events
  useEffect(() => {
    let cancelled = false;

    const refreshUpdates = (onError?: () => void) => {
      checkUpdatesCmd()
        .then((result) => {
          if (!cancelled) {
            dispatch({ type: 'updates:loaded', updates: result.updates });
            dispatch({ type: 'pack-updates:loaded', packUpdates: result.packUpdates });
          }
        })
        .catch(() => { if (!cancelled) onError?.(); });
    };

    const handleSourcesChanged = () => {
      if (cancelled) return;
      dispatch({ type: 'updates:loading' });
      refreshUpdates(() => dispatch({ type: 'updates:loaded-error' }));
      // Also refresh sources list (last_checked timestamps may have changed)
      listSources()
        .then((sources) => { if (!cancelled) dispatch({ type: 'sources:loaded', sources }); })
        .catch(() => {});
    };

    const handleProcessorUpdated = (e: { processorId: string }) => {
      if (cancelled) return;
      dispatch({ type: 'updates:decremented', processorId: e.processorId });
    };

    const handleProcessorInstalled = () => {
      if (cancelled) return;
      refreshUpdates();
    };

    const handlePackUpdated = (e: { packId: string }) => {
      if (cancelled) return;
      dispatch({ type: 'pack-updates:decremented', packId: e.packId });
    };

    bus.on('marketplace:sources-changed', handleSourcesChanged);
    bus.on('marketplace:processor-updated', handleProcessorUpdated);
    bus.on('marketplace:processor-installed', handleProcessorInstalled);
    bus.on('marketplace:pack-updated', handlePackUpdated);

    return () => {
      cancelled = true;
      bus.off('marketplace:sources-changed', handleSourcesChanged);
      bus.off('marketplace:processor-updated', handleProcessorUpdated);
      bus.off('marketplace:processor-installed', handleProcessorInstalled);
      bus.off('marketplace:pack-updated', handlePackUpdated);
    };
  }, []);

  const setSources = useCallback(
    (sources: Source[]) => dispatch({ type: 'sources:loaded', sources }),
    [],
  );

  const value = useMemo<MarketplaceContextValue>(
    () => ({ ...state, dispatch, setSources }),
    [state, dispatch, setSources],
  );

  return (
    <MarketplaceContext.Provider value={value}>
      {children}
    </MarketplaceContext.Provider>
  );
}

export function useMarketplaceContext(): MarketplaceContextValue {
  const ctx = useContext(MarketplaceContext);
  if (!ctx) {
    throw new Error('useMarketplaceContext must be used within a MarketplaceProvider');
  }
  return ctx;
}

// @visibleForTesting
export { marketplaceReducer, initialState };
