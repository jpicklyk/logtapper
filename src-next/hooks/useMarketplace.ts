import { useState, useCallback, useRef } from 'react';
import type {
  Source,
  MarketplaceEntry,
  UpdateAvailable,
  UpdateCheckResult,
  UpdateResult,
  ProcessorSummary,
} from '../bridge/types';
import {
  listSources,
  addSource as addSourceCmd,
  removeSource as removeSourceCmd,
  fetchMarketplace,
  installFromMarketplace,
  uninstallProcessor as uninstallProcessorCmd,
  checkUpdates as checkUpdatesCmd,
  updateProcessor as updateProcessorCmd,
  updateAllFromSource as updateAllCmd,
  saveSourcesToDisk,
} from '../bridge/commands';
import { useMarketplaceContext } from '../context/MarketplaceContext';
import { bus } from '../events/bus';

export interface MarketplaceState {
  // Sources
  sources: Source[];
  sourcesLoading: boolean;
  loadSources(): Promise<void>;
  addSource(source: Source): Promise<void>;
  removeSource(name: string): Promise<void>;

  // Browse
  selectedSource: string | null;
  selectSource(name: string | null): void;
  entries: MarketplaceEntry[];
  entriesLoading: boolean;
  entriesError: string | null;
  fetchEntries(sourceName: string): Promise<void>;
  installEntry(sourceName: string, entry: MarketplaceEntry): Promise<ProcessorSummary>;
  uninstallEntry(processorId: string): Promise<void>;

  // Updates
  pendingUpdates: UpdateAvailable[];
  updatesLoading: boolean;
  updateResults: Map<string, UpdateResult>;
  checkUpdates(): Promise<void>;
  updateOne(processorId: string): Promise<void>;
  updateAllFromSource(sourceName: string): Promise<void>;
}

export function useMarketplace(): MarketplaceState {
  // Shared state from context (survives panel unmount)
  const ctx = useMarketplaceContext();
  const { sources, sourcesLoading, pendingUpdates, updatesLoading, dispatch, setSources } = ctx;

  // Browse (local — only needed while MarketplacePanel is mounted)
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [entries, setEntries] = useState<MarketplaceEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);

  // Updates (local — per-processor result tracking)
  const [updateResults, setUpdateResults] = useState<Map<string, UpdateResult>>(new Map());

  // Refs for stable callbacks
  const pendingUpdatesRef = useRef(pendingUpdates);
  pendingUpdatesRef.current = pendingUpdates;

  const loadSources = useCallback(async () => {
    dispatch({ type: 'sources:loading' });
    try {
      const result = await listSources();
      setSources(result);
    } catch {
      dispatch({ type: 'sources:loaded-error' });
    }
  }, [dispatch, setSources]);

  const addSource = useCallback(async (source: Source) => {
    await addSourceCmd(source);
    const result = await listSources();
    setSources(result);
    bus.emit('marketplace:sources-changed', undefined);
  }, [setSources]);

  const removeSource = useCallback(async (name: string) => {
    await removeSourceCmd(name);
    const result = await listSources();
    setSources(result);
    bus.emit('marketplace:sources-changed', undefined);
  }, [setSources]);

  const selectSource = useCallback((name: string | null) => {
    setSelectedSource(name);
  }, []);

  const fetchEntries = useCallback(async (sourceName: string) => {
    setEntriesLoading(true);
    setEntriesError(null);
    try {
      const result = await fetchMarketplace(sourceName);
      setEntries(result);
    } catch (e) {
      setEntriesError(String(e));
      setEntries([]);
    } finally {
      setEntriesLoading(false);
    }
  }, []);

  const installEntry = useCallback(
    async (sourceName: string, entry: MarketplaceEntry): Promise<ProcessorSummary> => {
      const summary = await installFromMarketplace(sourceName, entry);
      bus.emit('marketplace:processor-installed', { processorId: summary.id, sourceName });
      return summary;
    },
    [],
  );

  const uninstallEntry = useCallback(async (processorId: string): Promise<void> => {
    await uninstallProcessorCmd(processorId);
    bus.emit('marketplace:processor-uninstalled', { processorId });
  }, []);

  const checkUpdates = useCallback(async () => {
    dispatch({ type: 'updates:loading' });
    try {
      const result: UpdateCheckResult = await checkUpdatesCmd();
      dispatch({ type: 'updates:loaded', updates: result.updates });
      await saveSourcesToDisk();
      // Refresh sources to get updated last_checked timestamps
      const refreshed = await listSources();
      setSources(refreshed);
    } catch {
      dispatch({ type: 'updates:loaded-error' });
    }
  }, [dispatch, setSources]);

  const updateOne = useCallback(async (processorId: string) => {
    const update = pendingUpdatesRef.current.find((u) => u.processorId === processorId);
    if (!update) return;
    try {
      const result = await updateProcessorCmd(processorId, {
        name: update.entry.name,
        path: update.entry.path,
        version: update.entry.version,
        sha256: update.entry.sha256,
      });
      setUpdateResults((prev) => {
        const next = new Map(prev);
        next.set(processorId, result);
        return next;
      });
      if (result.success) {
        bus.emit('marketplace:processor-updated', {
          processorId,
          oldVersion: result.oldVersion,
          newVersion: result.newVersion,
        });
      }
    } catch (e) {
      setUpdateResults((prev) => {
        const next = new Map(prev);
        next.set(processorId, {
          processorId,
          oldVersion: update.installedVersion,
          newVersion: update.availableVersion,
          success: false,
          error: String(e),
        });
        return next;
      });
    }
  }, []);

  const updateAllFromSource = useCallback(async (sourceName: string) => {
    try {
      const results = await updateAllCmd(sourceName);
      setUpdateResults((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          next.set(r.processorId, r);
        }
        return next;
      });
      const successIds = new Set(results.filter((r) => r.success).map((r) => r.processorId));
      if (successIds.size > 0) {
        // Context decrements via bus events — no local setPendingUpdates needed
        for (const r of results) {
          if (r.success) {
            bus.emit('marketplace:processor-updated', {
              processorId: r.processorId,
              oldVersion: r.oldVersion,
              newVersion: r.newVersion,
            });
          }
        }
      }
    } catch {
      // Network or source errors are surfaced via updateResults per-processor
    }
  }, []);

  return {
    sources,
    sourcesLoading,
    loadSources,
    addSource,
    removeSource,
    selectedSource,
    selectSource,
    entries,
    entriesLoading,
    entriesError,
    fetchEntries,
    installEntry,
    uninstallEntry,
    pendingUpdates,
    updatesLoading,
    updateResults,
    checkUpdates,
    updateOne,
    updateAllFromSource,
  };
}
