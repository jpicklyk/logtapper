import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { createPacksStore } from './packsStore';
import type { PacksCommands } from './packsStore';
import type {
  MarketplaceEntry, MarketplacePackEntry, MarketplaceFetchResult, PackSummary, ProcessorSummary,
  Source, UpdateAvailable, PackUpdateAvailable, UpdateCheckResult, UpdateResult, UpdatesAvailableEvent,
} from '@bridge/types';

function noSources() {
  const [sources] = createSignal<Source[]>([]);
  return sources;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const packEntry: MarketplacePackEntry = {
  id: 'wifi-pack', name: 'WiFi Pack', version: '1.0.0', description: 'WiFi diagnostics',
  path: 'packs/wifi.pack.yaml', tags: ['wifi'], sha256: 'abc', category: 'network',
  processorIds: ['wifi-state', 'wlan-disconnect'],
};

const procEntry: MarketplaceEntry = {
  id: 'wifi-state', name: 'WiFi State', version: '1.4.0', description: 'Tracks WiFi state',
  path: 'processors/wifi_state.yaml', tags: ['wifi'], sha256: 'def', category: 'network',
  license: 'MIT', processorType: 'state_tracker', sourceTypes: ['logcat'], deprecated: false,
};

function fetchResult(overrides: Partial<MarketplaceFetchResult> = {}): MarketplaceFetchResult {
  return { processors: [procEntry], packs: [packEntry], ...overrides };
}

function packSummary(id = 'wifi-pack'): PackSummary {
  return { id, name: 'WiFi Pack', version: '1.0.0', description: 'WiFi diagnostics', tags: ['wifi'], category: 'network', license: null, repository: null, deprecated: false, processorIds: ['wifi-state'] };
}

function procSummary(id = 'wifi-state'): ProcessorSummary {
  return {
    id, name: 'WiFi State', version: '1.4.0', description: 'Tracks WiFi state', tags: ['wifi'], builtin: false,
    processorType: 'state_tracker', group: null, varsMeta: [], hasSchema: false, trackerSections: [], sourceTypes: ['logcat'],
    deprecated: false,
  } as ProcessorSummary;
}

function baseCommands(overrides: Partial<PacksCommands> = {}): PacksCommands {
  return {
    fetchMarketplace: vi.fn(() => Promise.resolve(fetchResult())),
    installFromMarketplace: vi.fn(() => Promise.resolve(procSummary())),
    installPackFromMarketplace: vi.fn(() => Promise.resolve(packSummary())),
    uninstallPackFromMarketplace: vi.fn(() => Promise.resolve()),
    uninstallProcessor: vi.fn(() => Promise.resolve()),
    listPacks: vi.fn(() => Promise.resolve([])),
    listProcessors: vi.fn(() => Promise.resolve([])),
    checkUpdates: vi.fn(() => Promise.resolve({ updates: [], packUpdates: [], errors: [] } as UpdateCheckResult)),
    getPendingUpdates: vi.fn(() => Promise.resolve([])),
    getPendingPackUpdates: vi.fn(() => Promise.resolve([])),
    updateProcessor: vi.fn(() => Promise.resolve({ processorId: 'wifi-state', oldVersion: '1.0.0', newVersion: '1.1.0', success: true, error: null } as UpdateResult)),
    updateAllFromSource: vi.fn(() => Promise.resolve([])),
    saveSourcesToDisk: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe('packsStore', () => {
  it('seeds installed packs/processors at construction without a selected source', async () => {
    const listPacks = vi.fn(() => Promise.resolve([packSummary()]));
    const listProcessors = vi.fn(() => Promise.resolve([procSummary()]));
    const store = createPacksStore({ sources: noSources(), commands: baseCommands({ listPacks, listProcessors }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.installedPacks()).toEqual([packSummary()]);
    expect(store.installedProcessors()).toEqual([procSummary()]);
    store.dispose();
  });

  it('fetchEntries populates entries and packEntries, toggling entriesLoading', async () => {
    const commands = baseCommands();
    const store = createPacksStore({ sources: noSources(), commands });
    expect(store.entriesLoading()).toBe(false);
    const p = store.fetchEntries('official');
    expect(store.entriesLoading()).toBe(true);
    await p;
    expect(store.entriesLoading()).toBe(false);
    expect(store.selectedSource()).toBe('official');
    expect(store.entries()).toEqual([procEntry]);
    expect(store.packEntries()).toEqual([packEntry]);
    expect(commands.fetchMarketplace).toHaveBeenCalledWith('official');
    store.dispose();
  });

  it('fetchEntries surfaces a rejection as entriesError and clears stale entries', async () => {
    const fetchMarketplace = vi.fn(() => Promise.reject(new Error('network down')));
    const store = createPacksStore({ sources: noSources(), commands: baseCommands({ fetchMarketplace }) });
    await store.fetchEntries('official');
    expect(store.entriesError()).toBe('Error: network down');
    expect(store.entries()).toEqual([]);
    expect(store.packEntries()).toEqual([]);
    expect(store.entriesLoading()).toBe(false);
    store.dispose();
  });

  it('out-of-order completion: a fast second fetchEntries call wins over a slow first one', async () => {
    const slow = deferred<MarketplaceFetchResult>();
    const fast = deferred<MarketplaceFetchResult>();
    const fetchMarketplace = vi.fn()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(() => fast.promise);
    const store = createPacksStore({ sources: noSources(), commands: baseCommands({ fetchMarketplace }) });

    const slowCall = store.fetchEntries('slow-source');
    const fastCall = store.fetchEntries('fast-source');

    // Fast call's fetch resolves first...
    fast.resolve(fetchResult({ processors: [], packs: [] }));
    await fastCall;
    expect(store.entries()).toEqual([]);
    expect(store.entriesLoading()).toBe(false);

    // ...then the slow call's late resolution must be discarded, not clobber the fast result.
    slow.resolve(fetchResult({ processors: [procEntry] }));
    await slowCall;
    expect(store.entries()).toEqual([]);
    expect(store.selectedSource()).toBe('fast-source');
    store.dispose();
  });

  it('installPack maps processorIds to the snake_case payload and refreshes installed state', async () => {
    const listPacks = vi.fn(() => Promise.resolve([packSummary()]));
    const commands = baseCommands({ listPacks });
    const store = createPacksStore({ sources: noSources(), commands });
    await store.installPack('official', packEntry);
    expect(commands.installPackFromMarketplace).toHaveBeenCalledWith('official', {
      id: 'wifi-pack', name: 'WiFi Pack', version: '1.0.0', description: 'WiFi diagnostics',
      path: 'packs/wifi.pack.yaml', tags: ['wifi'], sha256: 'abc', category: 'network',
      processor_ids: ['wifi-state', 'wlan-disconnect'],
    });
    // Seed at construction + one post-mutation refresh.
    expect(listPacks).toHaveBeenCalledTimes(2);
    expect(store.installedPacks()).toEqual([packSummary()]);
    expect(store.isPending('wifi-pack')).toBe(false);
    store.dispose();
  });

  it('isPending is true only while a mutation for that id is in flight, and errorFor records a rejection', async () => {
    const install = deferred<PackSummary>();
    const installPackFromMarketplace = vi.fn(() => install.promise);
    const store = createPacksStore({ sources: noSources(), commands: baseCommands({ installPackFromMarketplace }) });

    const call = store.installPack('official', packEntry);
    expect(store.isPending('wifi-pack')).toBe(true);
    install.reject(new Error('checksum mismatch'));
    await expect(call).rejects.toThrow('checksum mismatch');
    expect(store.isPending('wifi-pack')).toBe(false);
    expect(store.errorFor('wifi-pack')).toBe('Error: checksum mismatch');
    store.dispose();
  });

  it('uninstallPack passes the exact sourceName/packId it was given through to the backend', async () => {
    const commands = baseCommands();
    const store = createPacksStore({ sources: noSources(), commands });
    await store.uninstallPack('official', 'wifi-pack');
    expect(commands.uninstallPackFromMarketplace).toHaveBeenCalledWith('official', 'wifi-pack');
    store.dispose();
  });

  it('installProcessor and uninstallProcessor both refresh installed state', async () => {
    const commands = baseCommands();
    const store = createPacksStore({ sources: noSources(), commands });
    await store.installProcessor('official', procEntry);
    await store.uninstallProcessor('wifi-state');
    expect(commands.installFromMarketplace).toHaveBeenCalledWith('official', {
      id: 'wifi-state', name: 'WiFi State', path: 'processors/wifi_state.yaml', version: '1.4.0', sha256: 'def',
    });
    expect(commands.uninstallProcessor).toHaveBeenCalledWith('wifi-state');
    // Seed at construction + one refresh per mutation. The analyzer catalog
    // is refreshed by `App.tsx`'s `catalog-update` listener, not from here —
    // there is no callback dep left to notify.
    expect(commands.listProcessors).toHaveBeenCalledTimes(3);
    store.dispose();
  });

  it('checkUpdates loads updates + pack updates + errors, then persists sources and refreshes them', async () => {
    const update: UpdateAvailable = {
      processorId: 'wifi-state', processorName: 'WiFi State', sourceName: 'official',
      installedVersion: '1.0.0', availableVersion: '1.1.0', entry: procEntry,
    };
    const packUpdate: PackUpdateAvailable = {
      packId: 'wifi-pack', packName: 'WiFi Pack', sourceName: 'official',
      installedVersion: '1.0.0', availableVersion: '1.1.0', newProcessorIds: [], entry: packEntry,
    };
    const checkUpdates = vi.fn(() => Promise.resolve({
      updates: [update], packUpdates: [packUpdate], errors: [{ sourceName: 'broken', error: 'timeout' }],
    } as UpdateCheckResult));
    const refreshSources = vi.fn();
    const commands = baseCommands({ checkUpdates });
    const store = createPacksStore({ sources: noSources(), commands, refreshSources });
    await store.checkUpdates();
    expect(store.pendingUpdates()).toEqual([update]);
    expect(store.pendingPackUpdates()).toEqual([packUpdate]);
    expect(store.updateErrors()).toEqual([{ sourceName: 'broken', error: 'timeout' }]);
    expect(store.updatesLoading()).toBe(false);
    expect(commands.saveSourcesToDisk).toHaveBeenCalled();
    expect(refreshSources).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('checkUpdates failure clears the loading flag and reports itself (D1-M12)', async () => {
    const checkUpdates = vi.fn(() => Promise.reject(new Error('offline')));
    const store = createPacksStore({ sources: noSources(), commands: baseCommands({ checkUpdates }) });
    await store.checkUpdates();
    expect(store.updatesLoading()).toBe(false);
    // `updateErrors` only ever comes from a check that DID return, so without
    // its own channel a wholesale failure rendered as "No pending updates."
    expect(store.updateErrors()).toEqual([]);
    expect(store.updatesError()).toBe('Error: offline');
    store.dispose();
  });

  it('a later successful checkUpdates clears the previous wholesale failure', async () => {
    const checkUpdates = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('offline')))
      .mockImplementationOnce(() => Promise.resolve({ updates: [], packUpdates: [], errors: [] } as UpdateCheckResult));
    const store = createPacksStore({ sources: noSources(), commands: baseCommands({ checkUpdates }) });
    await store.checkUpdates();
    expect(store.updatesError()).toBe('Error: offline');
    await store.checkUpdates();
    expect(store.updatesError()).toBeNull();
    store.dispose();
  });

  it('a refresh that fails AFTER a successful install is not reported as the install failing (D1-M11)', async () => {
    let installed = false;
    const listPacks = vi.fn(() => {
      // The refresh `withMutation` runs on success.
      if (installed) return Promise.reject(new Error('listing died'));
      return Promise.resolve([] as PackSummary[]);
    });
    const installPackFromMarketplace = vi.fn(() => {
      installed = true;
      return Promise.resolve(packSummary());
    });
    const store = createPacksStore({
      sources: noSources(),
      commands: baseCommands({ listPacks, installPackFromMarketplace }),
    });
    await Promise.resolve();

    await expect(store.installPack('official', packEntry)).resolves.toEqual(packSummary());
    // The card must not show an install error under a pack that installed fine.
    expect(store.errorFor('wifi-pack')).toBeUndefined();
    expect(store.isPending('wifi-pack')).toBe(false);
    store.dispose();
  });

  it('refreshSources is exposed for the panel that has no other handle on settings (D1-H1)', async () => {
    const refreshSources = vi.fn();
    const store = createPacksStore({ sources: noSources(), commands: baseCommands(), refreshSources });
    store.refreshSources();
    expect(refreshSources).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('refreshSources is a no-op when the host wired none', () => {
    const store = createPacksStore({ sources: noSources(), commands: baseCommands() });
    expect(() => store.refreshSources()).not.toThrow();
    store.dispose();
  });

  it('updateOne updates a single processor and removes it from pendingUpdates on success', async () => {
    const update: UpdateAvailable = {
      processorId: 'wifi-state', processorName: 'WiFi State', sourceName: 'official',
      installedVersion: '1.0.0', availableVersion: '1.1.0', entry: procEntry,
    };
    const checkUpdates = vi.fn(() => Promise.resolve({ updates: [update], packUpdates: [], errors: [] } as UpdateCheckResult));
    const commands = baseCommands({ checkUpdates });
    const store = createPacksStore({ sources: noSources(), commands });
    await store.checkUpdates();
    await store.updateOne('wifi-state');
    expect(commands.updateProcessor).toHaveBeenCalledWith('wifi-state', {
      name: 'WiFi State', path: 'processors/wifi_state.yaml', version: '1.4.0', sha256: 'def',
    });
    expect(store.pendingUpdates()).toEqual([]);
    store.dispose();
  });

  it('updateOne is a no-op when the processorId has no pending update', async () => {
    const commands = baseCommands();
    const store = createPacksStore({ sources: noSources(), commands });
    await store.updateOne('nonexistent');
    expect(commands.updateProcessor).not.toHaveBeenCalled();
    store.dispose();
  });

  it('updateAllFromSource only clears the ids that actually succeeded', async () => {
    const a: UpdateAvailable = { processorId: 'a', processorName: 'A', sourceName: 'official', installedVersion: '1.0.0', availableVersion: '1.1.0', entry: procEntry };
    const b: UpdateAvailable = { processorId: 'b', processorName: 'B', sourceName: 'official', installedVersion: '1.0.0', availableVersion: '1.1.0', entry: procEntry };
    const other: UpdateAvailable = { processorId: 'c', processorName: 'C', sourceName: 'other-source', installedVersion: '1.0.0', availableVersion: '1.1.0', entry: procEntry };
    const checkUpdates = vi.fn(() => Promise.resolve({ updates: [a, b, other], packUpdates: [], errors: [] } as UpdateCheckResult));
    const updateAllFromSource = vi.fn(() => Promise.resolve([
      { processorId: 'a', oldVersion: '1.0.0', newVersion: '1.1.0', success: true, error: null },
      { processorId: 'b', oldVersion: '1.0.0', newVersion: '1.1.0', success: false, error: 'conflict' },
    ] as UpdateResult[]));
    const commands = baseCommands({ checkUpdates, updateAllFromSource });
    const store = createPacksStore({ sources: noSources(), commands });
    await store.checkUpdates();
    await store.updateAllFromSource('official');
    expect(updateAllFromSource).toHaveBeenCalledWith('official');
    const remaining = store.pendingUpdates().map((u) => u.processorId).sort();
    expect(remaining).toEqual(['b', 'c']);
    store.dispose();
  });

  it('updatePack re-installs from the update entry and removes it from pendingPackUpdates', async () => {
    const packUpdate: PackUpdateAvailable = {
      packId: 'wifi-pack', packName: 'WiFi Pack', sourceName: 'official',
      installedVersion: '1.0.0', availableVersion: '1.1.0', newProcessorIds: ['wlan-disconnect'], entry: packEntry,
    };
    const checkUpdates = vi.fn(() => Promise.resolve({ updates: [], packUpdates: [packUpdate], errors: [] } as UpdateCheckResult));
    const commands = baseCommands({ checkUpdates });
    const store = createPacksStore({ sources: noSources(), commands });
    await store.checkUpdates();
    await store.updatePack('official', packEntry);
    expect(commands.installPackFromMarketplace).toHaveBeenCalledWith('official', expect.objectContaining({ id: 'wifi-pack' }));
    expect(store.pendingPackUpdates()).toEqual([]);
    store.dispose();
  });

  it('dispose() prevents a late fetchEntries resolution from writing state', async () => {
    const pending = deferred<MarketplaceFetchResult>();
    const fetchMarketplace = vi.fn(() => pending.promise);
    const store = createPacksStore({ sources: noSources(), commands: baseCommands({ fetchMarketplace }) });
    const call = store.fetchEntries('official');
    store.dispose();
    pending.resolve(fetchResult());
    await call;
    expect(store.entries()).toEqual([]);
  });

  it('exposes the injected sources accessor unchanged', () => {
    const [sources] = createSignal<Source[]>([{ name: 'official', type: 'github', repo: 'jpicklyk/logtapper', enabled: true, autoUpdate: true }]);
    const store = createPacksStore({ sources, commands: baseCommands() });
    expect(store.sources()).toEqual([{ name: 'official', type: 'github', repo: 'jpicklyk/logtapper', enabled: true, autoUpdate: true }]);
    store.dispose();
  });

  describe('startup update prompt', () => {
    const procUpdate = (id: string, sourceName = 'official'): UpdateAvailable =>
      ({ processorId: id, processorName: id, sourceName, installedVersion: '1.0.0', availableVersion: '1.1.0', entry: procEntry });
    const packUpdate = (id = 'wifi-pack', sourceName = 'official'): PackUpdateAvailable =>
      ({ packId: id, packName: id, sourceName, installedVersion: '1.0.0', availableVersion: '2.0.0', newProcessorIds: [], entry: packEntry });

    /** A fake `onUpdatesAvailable` whose callback the test can fire. */
    function listener() {
      let cb: ((p: UpdatesAvailableEvent) => void) | null = null;
      const unlisten = vi.fn();
      const listenUpdates = vi.fn((c: (p: UpdatesAvailableEvent) => void) => { cb = c; return Promise.resolve(unlisten); });
      return { listenUpdates, unlisten, fire: (p: UpdatesAvailableEvent) => cb?.(p) };
    }
    const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

    it('opens the prompt from a non-empty seed even if the event never arrives', async () => {
      const { listenUpdates } = listener();
      const store = createPacksStore({
        sources: noSources(), listenUpdates,
        commands: baseCommands({ getPendingUpdates: vi.fn(() => Promise.resolve([procUpdate('a')])) }),
      });
      await tick();
      expect(store.updatePromptOpen()).toBe(true);
      expect(store.pendingUpdates()).toEqual([procUpdate('a')]);
      store.dispose();
    });

    it('stays closed on an empty seed, then opens when the event reports updates and refreshes sources', async () => {
      const { listenUpdates, fire } = listener();
      const refreshSources = vi.fn();
      const store = createPacksStore({ sources: noSources(), listenUpdates, refreshSources, commands: baseCommands() });
      await tick();
      expect(store.updatePromptOpen()).toBe(false);
      fire({ updates: [], packUpdates: [packUpdate()], autoApplied: ['x@official'] });
      expect(store.updatePromptOpen()).toBe(true);
      expect(store.pendingPackUpdates()).toEqual([packUpdate()]);
      expect(refreshSources).toHaveBeenCalledTimes(1);
      store.dispose();
    });

    it('an event with only auto-applied updates opens nothing — there is nothing to decide', async () => {
      const { listenUpdates, fire } = listener();
      const store = createPacksStore({ sources: noSources(), listenUpdates, commands: baseCommands() });
      await tick();
      fire({ updates: [], packUpdates: [], autoApplied: ['x@official'] });
      expect(store.updatePromptOpen()).toBe(false);
      store.dispose();
    });

    it('Later dismisses for the session: a later event still updates the lists but never re-opens it', async () => {
      const { listenUpdates, fire } = listener();
      const store = createPacksStore({
        sources: noSources(), listenUpdates,
        commands: baseCommands({ getPendingUpdates: vi.fn(() => Promise.resolve([procUpdate('a')])) }),
      });
      await tick();
      store.dismissUpdatePrompt();
      expect(store.updatePromptOpen()).toBe(false);
      fire({ updates: [procUpdate('a'), procUpdate('b')], packUpdates: [], autoApplied: [] });
      expect(store.updatePromptOpen()).toBe(false);
      expect(store.pendingUpdates()).toHaveLength(2);
      store.dispose();
    });

    it('updateAll updates each source once and each pack once, reports what stayed pending, and counts progress', async () => {
      const { listenUpdates, fire } = listener();
      const updateAllFromSource = vi.fn((sourceName: string) => Promise.resolve(
        sourceName === 'official'
          ? [{ processorId: 'a', oldVersion: '1.0.0', newVersion: '1.1.0', success: true, error: null } as UpdateResult]
          : [{ processorId: 'c', oldVersion: '1.0.0', newVersion: '1.1.0', success: false, error: 'boom' } as UpdateResult],
      ));
      const installPackFromMarketplace = vi.fn(() => Promise.reject(new Error('pack download failed')));
      const store = createPacksStore({
        sources: noSources(), listenUpdates,
        commands: baseCommands({ updateAllFromSource, installPackFromMarketplace }),
      });
      await tick();
      fire({ updates: [procUpdate('a'), procUpdate('b'), procUpdate('c', 'team')], packUpdates: [packUpdate()], autoApplied: [] });
      const seen: number[] = [];
      const run = store.updateAll();
      expect(store.updatingAll()).toBe(true);
      expect(store.updateAllProgress()).toEqual({ done: 0, total: 3 }); // 2 sources + 1 pack
      const outcome = await run;
      seen.push(store.updateAllProgress().done);
      expect(updateAllFromSource).toHaveBeenCalledTimes(2);
      expect(updateAllFromSource).toHaveBeenNthCalledWith(1, 'official');
      expect(updateAllFromSource).toHaveBeenNthCalledWith(2, 'team');
      expect(installPackFromMarketplace).toHaveBeenCalledTimes(1);
      expect(store.updatingAll()).toBe(false);
      expect(seen).toEqual([3]);
      // 'a' succeeded; 'b' was never reported by its source; 'c' failed; the pack threw.
      expect(outcome).toEqual({ failedProcessorIds: ['b', 'c'], failedPackIds: ['wifi-pack'] });
      expect(store.errorFor('wifi-pack')).toContain('pack download failed');
      store.dispose();
    });

    it('dispose unlistens the updates subscription', async () => {
      const { listenUpdates, unlisten } = listener();
      const store = createPacksStore({ sources: noSources(), listenUpdates, commands: baseCommands() });
      await tick();
      store.dispose();
      expect(unlisten).toHaveBeenCalledTimes(1);
    });
  });
});
