/**
 * The packs store: the **remote** half of marketplace access that `src-solid`
 * lacked entirely before this package (2c/P1) — browsing a source's catalog,
 * installing/uninstalling packs and standalone processors, and update
 * detection. The **local** half (already-installed processors/packs for a
 * session's own chain) stays owned by `analyzers/analyzerStore.ts`
 * (`catalog()`/`packs()`/`refreshCatalog()`) and `settings/SourcesTab.tsx`
 * (marketplace *source* CRUD) — this store does not duplicate either.
 *
 * React's reference is `hooks/useMarketplace.ts` (307 ln) +
 * `context/MarketplaceContext.tsx` (195 ln). This is a single Solid store
 * rather than a hook/context split — Solid has no render-tree context to
 * split "shared" state across (see `analyzerStore.ts`'s module doc for the
 * same reasoning), and there is exactly one mount point (`PacksPanel`, inside
 * the `settings` surface's Advanced-adjacent Packs tab) so nothing here needs
 * to survive a panel unmount independently of anything else.
 *
 * The one-catalog-fetch-per-source browse (`fetchEntries`) is the "supersede
 * stale async work" shape F0 exists for: switching the browsed source twice
 * in quick succession must not let the first fetch's late resolution clobber
 * the second's — guarded with `../reactive`'s `createGenerationGuard()`
 * rather than a new ad hoc counter.
 *
 * Installing executes third-party processor YAML. This store never installs
 * a pack directly from a catalog row — `installPack`/`installProcessor` are
 * the "really do it" calls; `PacksPanel` gates them behind an expanded
 * preview of the pack's member processors (name + description), so nothing
 * here builds a one-click path that hides what is being added.
 */
import { batch, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import {
  fetchMarketplace,
  installFromMarketplace,
  installPackFromMarketplace,
  uninstallPackFromMarketplace,
  uninstallProcessor,
  listPacks,
  listProcessors,
  checkUpdates as checkUpdatesCmd,
  getPendingUpdates,
  getPendingPackUpdates,
  updateProcessor as updateProcessorCmd,
  updateAllFromSource as updateAllFromSourceCmd,
  saveSourcesToDisk,
} from '@bridge/commands';
import type {
  Source,
  MarketplaceEntry,
  MarketplacePackEntry,
  MarketplaceFetchResult,
  PackSummary,
  ProcessorSummary,
  UpdateAvailable,
  PackUpdateAvailable,
  UpdateCheckResult,
  UpdateResult,
  SourceError,
} from '@bridge/types';
import { createGenerationGuard } from '../reactive';

/** Bridge commands this store calls, injected so tests never touch real IPC
 *  or the network. Mirrors `AnalyzerCommands`'s injection shape. */
export interface PacksCommands {
  fetchMarketplace(sourceName: string): Promise<MarketplaceFetchResult>;
  installFromMarketplace(
    sourceName: string,
    entry: { id: string; name: string; path: string; version: string; sha256: string },
  ): Promise<ProcessorSummary>;
  installPackFromMarketplace(
    sourceName: string,
    packEntry: {
      id: string; name: string; version: string; description: string | null; path: string;
      tags: string[]; sha256: string; category: string | null; processor_ids: string[];
    },
  ): Promise<PackSummary>;
  uninstallPackFromMarketplace(sourceName: string, packId: string): Promise<void>;
  uninstallProcessor(processorId: string): Promise<void>;
  listPacks(): Promise<PackSummary[]>;
  listProcessors(): Promise<ProcessorSummary[]>;
  checkUpdates(): Promise<UpdateCheckResult>;
  getPendingUpdates(): Promise<UpdateAvailable[]>;
  getPendingPackUpdates(): Promise<PackUpdateAvailable[]>;
  updateProcessor(processorId: string, entry: { name: string; path: string; version: string; sha256: string }): Promise<UpdateResult>;
  updateAllFromSource(sourceName: string): Promise<UpdateResult[]>;
  saveSourcesToDisk(): Promise<void>;
}

const defaultCommands: PacksCommands = {
  fetchMarketplace,
  installFromMarketplace,
  installPackFromMarketplace,
  uninstallPackFromMarketplace,
  uninstallProcessor,
  listPacks,
  listProcessors,
  checkUpdates: checkUpdatesCmd,
  getPendingUpdates,
  getPendingPackUpdates,
  updateProcessor: updateProcessorCmd,
  updateAllFromSource: updateAllFromSourceCmd,
  saveSourcesToDisk,
};

/** Map a `MarketplacePackEntry` (camelCase DTO) to the
 *  `install_pack_from_marketplace` payload shape (backend field is
 *  snake_case `processor_ids`). Shared by install and update — updating a
 *  pack is just re-installing it from the same entry, same as React's
 *  `toPackInstallPayload`. */
function toPackInstallPayload(entry: MarketplacePackEntry): {
  id: string; name: string; version: string; description: string | null; path: string;
  tags: string[]; sha256: string; category: string | null; processor_ids: string[];
} {
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    description: entry.description,
    path: entry.path,
    tags: entry.tags,
    sha256: entry.sha256,
    category: entry.category,
    processor_ids: entry.processorIds,
  };
}

export interface PacksStoreDeps {
  /** Read-only: the configured marketplace sources, owned by `settingsStore`
   *  (`SourcesTab` remains the only place that adds/removes one — see the
   *  module doc). */
  sources: Accessor<Source[]>;
  /** Called after `checkUpdates()` succeeds, so `settingsStore`'s
   *  `lastChecked` timestamps stay current. Mirrors React's
   *  `useMarketplace.checkUpdates` re-fetching `listSources()`. */
  refreshSources?: () => void;
  /** Injected for tests; defaults to the real bridge wrappers. */
  commands?: Partial<PacksCommands>;
}

export interface PacksStore {
  // ── Sources (read-only passthrough — see module doc) ────────────────────
  sources: Accessor<Source[]>;

  // ── Browse ───────────────────────────────────────────────────────────────
  selectedSource: Accessor<string | null>;
  entries: Accessor<MarketplaceEntry[]>;
  packEntries: Accessor<MarketplacePackEntry[]>;
  entriesLoading: Accessor<boolean>;
  entriesError: Accessor<string | null>;
  /** Fetch `sourceName`'s catalog (processors + packs in one round trip).
   *  Generation-guarded: a fast second call always wins over a slow first
   *  one, even if the first resolves later. */
  fetchEntries(sourceName: string): Promise<void>;

  // ── Installed (local truth this store keeps in sync with, not owns) ─────
  installedPacks: Accessor<PackSummary[]>;
  installedProcessors: Accessor<ProcessorSummary[]>;
  refreshInstalled(): Promise<void>;

  // ── Mutations ────────────────────────────────────────────────────────────
  /** True while `id` (a `MarketplaceEntry.id` or `MarketplacePackEntry.id`)
   *  has an install/uninstall/update in flight. */
  isPending(id: string): boolean;
  /** The last mutation error for `id`, if any. Cleared at the start of the
   *  next attempt on that same id. */
  errorFor(id: string): string | undefined;
  installPack(sourceName: string, entry: MarketplacePackEntry): Promise<PackSummary>;
  /** `sourceName` must be the source `entry`/`packId` was browsed from —
   *  see implementation-notes for why the backend cannot recover this on its
   *  own (it re-derives each member processor's qualified id from the
   *  `sourceName` argument, not from anything persisted at install time). */
  uninstallPack(sourceName: string, packId: string): Promise<void>;
  installProcessor(sourceName: string, entry: MarketplaceEntry): Promise<ProcessorSummary>;
  uninstallProcessor(processorId: string): Promise<void>;

  // ── Updates ──────────────────────────────────────────────────────────────
  pendingUpdates: Accessor<UpdateAvailable[]>;
  pendingPackUpdates: Accessor<PackUpdateAvailable[]>;
  updatesLoading: Accessor<boolean>;
  /** Sources that failed to fetch during the last `checkUpdates()`. */
  updateErrors: Accessor<SourceError[]>;
  checkUpdates(): Promise<void>;
  updateOne(processorId: string): Promise<void>;
  updateAllFromSource(sourceName: string): Promise<void>;
  updatePack(sourceName: string, entry: MarketplacePackEntry): Promise<void>;

  dispose(): void;
}

export function createPacksStore(deps: PacksStoreDeps): PacksStore {
  const commands: PacksCommands = { ...defaultCommands, ...deps.commands };

  const [selectedSource, setSelectedSource] = createSignal<string | null>(null);
  const [entries, setEntries] = createSignal<MarketplaceEntry[]>([]);
  const [packEntries, setPackEntries] = createSignal<MarketplacePackEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = createSignal(false);
  const [entriesError, setEntriesError] = createSignal<string | null>(null);
  const fetchGuard = createGenerationGuard();

  const [installedPacks, setInstalledPacks] = createSignal<PackSummary[]>([]);
  const [installedProcessors, setInstalledProcessors] = createSignal<ProcessorSummary[]>([]);

  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set());
  const [itemErrors, setItemErrors] = createSignal<Record<string, string>>({});

  const [pendingUpdates, setPendingUpdates] = createSignal<UpdateAvailable[]>([]);
  const [pendingPackUpdates, setPendingPackUpdates] = createSignal<PackUpdateAvailable[]>([]);
  const [updatesLoading, setUpdatesLoading] = createSignal(false);
  const [updateErrors, setUpdateErrors] = createSignal<SourceError[]>([]);

  let disposed = false;

  const fetchEntries = async (sourceName: string): Promise<void> => {
    setSelectedSource(sourceName);
    setEntriesLoading(true);
    setEntriesError(null);
    const token = fetchGuard.bump();
    try {
      const result = await commands.fetchMarketplace(sourceName);
      if (disposed || !fetchGuard.isCurrent(token)) return;
      batch(() => {
        setEntries(result.processors);
        setPackEntries(result.packs);
        setEntriesLoading(false);
      });
    } catch (e) {
      if (disposed || !fetchGuard.isCurrent(token)) return;
      batch(() => {
        setEntriesError(String(e));
        setEntries([]);
        setPackEntries([]);
        setEntriesLoading(false);
      });
    }
  };

  const refreshInstalled = async (): Promise<void> => {
    const [packsList, procList] = await Promise.all([commands.listPacks(), commands.listProcessors()]);
    if (disposed) return;
    batch(() => {
      setInstalledPacks(packsList);
      setInstalledProcessors(procList);
    });
  };
  // Seed installed state immediately — the Advanced/library view and the
  // "already added" badges on curated pack cards must not wait for a browse
  // fetch, which needs a selected source the user may never pick.
  void refreshInstalled();

  const isPending = (id: string): boolean => pending().has(id);
  const errorFor = (id: string): string | undefined => itemErrors()[id];

  /** Run one mutation for `id`: marks it pending, clears its previous error,
   *  and on success refreshes installed state. Every install/uninstall goes
   *  through this so the pending/error bookkeeping never drifts between call
   *  sites. The analyzer catalog is NOT notified from here: the backend
   *  emits `catalog-update` for every install/uninstall/update from either
   *  caller, and `App.tsx`'s single listener on it refreshes both stores —
   *  a UI-initiated install reaches the analyzers the same way an agent's
   *  does. */
  function withMutation<T>(id: string, run: () => Promise<T>): Promise<T> {
    setPending((s) => new Set(s).add(id));
    setItemErrors((errs) => {
      if (!(id in errs)) return errs;
      const next = { ...errs };
      delete next[id];
      return next;
    });
    return run()
      .then(async (value) => {
        await refreshInstalled();
        return value;
      })
      .catch((e: unknown) => {
        if (!disposed) setItemErrors((errs) => ({ ...errs, [id]: String(e) }));
        throw e;
      })
      .finally(() => {
        if (disposed) return;
        setPending((s) => {
          if (!s.has(id)) return s;
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      });
  }

  const installPack = (sourceName: string, entry: MarketplacePackEntry): Promise<PackSummary> =>
    withMutation(entry.id, () => commands.installPackFromMarketplace(sourceName, toPackInstallPayload(entry)));

  const uninstallPack = (sourceName: string, packId: string): Promise<void> =>
    withMutation(packId, () => commands.uninstallPackFromMarketplace(sourceName, packId));

  const installProcessor = (sourceName: string, entry: MarketplaceEntry): Promise<ProcessorSummary> =>
    withMutation(entry.id, () =>
      commands.installFromMarketplace(sourceName, {
        id: entry.id, name: entry.name, path: entry.path, version: entry.version, sha256: entry.sha256,
      }));

  const uninstallProcessorFn = (processorId: string): Promise<void> =>
    withMutation(processorId, () => commands.uninstallProcessor(processorId));

  const checkUpdates = async (): Promise<void> => {
    setUpdatesLoading(true);
    try {
      const result = await commands.checkUpdates();
      if (disposed) return;
      batch(() => {
        setPendingUpdates(result.updates);
        setPendingPackUpdates(result.packUpdates);
        setUpdateErrors(result.errors);
        setUpdatesLoading(false);
      });
      await commands.saveSourcesToDisk();
      deps.refreshSources?.();
    } catch {
      if (!disposed) setUpdatesLoading(false);
    }
  };

  const updateOne = async (processorId: string): Promise<void> => {
    const update = pendingUpdates().find((u) => u.processorId === processorId);
    if (!update) return;
    await withMutation(processorId, () =>
      commands.updateProcessor(processorId, {
        name: update.entry.name, path: update.entry.path, version: update.entry.version, sha256: update.entry.sha256,
      }));
    if (!disposed) setPendingUpdates((list) => list.filter((u) => u.processorId !== processorId));
  };

  const updateAllFromSource = async (sourceName: string): Promise<void> => {
    const ids = pendingUpdates().filter((u) => u.sourceName === sourceName).map((u) => u.processorId);
    setPending((s) => {
      const next = new Set(s);
      for (const id of ids) next.add(id);
      return next;
    });
    try {
      const results = await commands.updateAllFromSource(sourceName);
      if (disposed) return;
      const succeededIds = new Set(results.filter((r) => r.success).map((r) => r.processorId));
      await refreshInstalled();
      if (disposed) return;
      setPendingUpdates((list) => list.filter((u) => !succeededIds.has(u.processorId)));
    } finally {
      if (!disposed) {
        setPending((s) => {
          const next = new Set(s);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    }
  };

  const updatePack = async (sourceName: string, entry: MarketplacePackEntry): Promise<void> => {
    await withMutation(entry.id, () => commands.installPackFromMarketplace(sourceName, toPackInstallPayload(entry)));
    if (!disposed) setPendingPackUpdates((list) => list.filter((u) => u.packId !== entry.id));
  };

  const dispose = (): void => {
    disposed = true;
  };

  return {
    sources: deps.sources,
    selectedSource,
    entries,
    packEntries,
    entriesLoading,
    entriesError,
    fetchEntries,
    installedPacks,
    installedProcessors,
    refreshInstalled,
    isPending,
    errorFor,
    installPack,
    uninstallPack,
    installProcessor,
    uninstallProcessor: uninstallProcessorFn,
    pendingUpdates,
    pendingPackUpdates,
    updatesLoading,
    updateErrors,
    checkUpdates,
    updateOne,
    updateAllFromSource,
    updatePack,
    dispose,
  };
}
