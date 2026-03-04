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
  checkUpdates as checkUpdatesCmd,
  updateProcessor as updateProcessorCmd,
  updateAllFromSource as updateAllCmd,
  getPendingUpdates,
  saveSourcesToDisk,
} from '../bridge/commands';
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

  // Updates
  pendingUpdates: UpdateAvailable[];
  updatesLoading: boolean;
  updateResults: Map<string, UpdateResult>;
  checkUpdates(): Promise<void>;
  updateOne(processorId: string): Promise<void>;
  updateAllFromSource(sourceName: string): Promise<void>;
  pendingUpdateCount: number;
}

export function useMarketplace(): MarketplaceState {
  // Sources
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);

  // Browse
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [entries, setEntries] = useState<MarketplaceEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);

  // Updates
  const [pendingUpdates, setPendingUpdates] = useState<UpdateAvailable[]>([]);
  const [updatesLoading, setUpdatesLoading] = useState(false);
  const [updateResults, setUpdateResults] = useState<Map<string, UpdateResult>>(new Map());

  // Refs for stable callbacks
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    try {
      const result = await listSources();
      setSources(result);
      // Also load pending updates from startup check
      const pending = await getPendingUpdates();
      if (pending.length > 0) {
        setPendingUpdates(pending);
      }
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  const addSource = useCallback(async (source: Source) => {
    await addSourceCmd(source);
    const result = await listSources();
    setSources(result);
    bus.emit('marketplace:sources-changed', undefined);
  }, []);

  const removeSource = useCallback(async (name: string) => {
    await removeSourceCmd(name);
    const result = await listSources();
    setSources(result);
    bus.emit('marketplace:sources-changed', undefined);
  }, []);

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
      const summary = await installFromMarketplace(sourceName, entry.id);
      bus.emit('marketplace:processor-installed', { processorId: summary.id, sourceName });
      return summary;
    },
    [],
  );

  const checkUpdates = useCallback(async () => {
    setUpdatesLoading(true);
    try {
      const result: UpdateCheckResult = await checkUpdatesCmd();
      setPendingUpdates(result.updates);
      await saveSourcesToDisk();
      // Refresh sources to get updated last_checked timestamps
      const refreshed = await listSources();
      setSources(refreshed);
    } finally {
      setUpdatesLoading(false);
    }
  }, []);

  const updateOne = useCallback(async (processorId: string) => {
    const update = pendingUpdates.find((u) => u.processorId === processorId);
    if (!update) return;
    try {
      const result = await updateProcessorCmd(processorId);
      setUpdateResults((prev) => {
        const next = new Map(prev);
        next.set(processorId, result);
        return next;
      });
      if (result.success) {
        setPendingUpdates((prev) => prev.filter((u) => u.processorId !== processorId));
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
  }, [pendingUpdates]);

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
        setPendingUpdates((prev) => prev.filter((u) => !successIds.has(u.processorId)));
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
    pendingUpdates,
    updatesLoading,
    updateResults,
    checkUpdates,
    updateOne,
    updateAllFromSource,
    pendingUpdateCount: pendingUpdates.length,
  };
}
