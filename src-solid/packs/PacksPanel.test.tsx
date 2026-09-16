/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type {
  MarketplaceEntry, MarketplacePackEntry, PackSummary, ProcessorSummary, Source,
  UpdateAvailable, PackUpdateAvailable, SourceError,
} from '@bridge/types';
import { PacksPanel } from './PacksPanel';
import type { PacksStore } from './packsStore';

afterEach(cleanup);

const wifiPack: MarketplacePackEntry = {
  id: 'wifi-pack', name: 'WiFi Pack', version: '1.0.0', description: 'Finds WiFi issues',
  path: 'packs/wifi.pack.yaml', tags: ['wifi'], sha256: 'abc', category: 'Network',
  processorIds: ['wifi-state', 'wlan-disconnect'],
};
const batteryPack: MarketplacePackEntry = {
  id: 'battery-pack', name: 'Battery Pack', version: '1.0.0', description: 'Finds battery drain',
  path: 'packs/battery.pack.yaml', tags: ['battery'], sha256: 'def', category: 'Power',
  processorIds: ['battery-drain'],
};
const wifiStateEntry: MarketplaceEntry = {
  id: 'wifi-state', name: 'WiFi State', version: '1.0.0', description: 'Tracks WiFi association',
  path: 'processors/wifi_state.yaml', tags: ['wifi'], sha256: 'x', category: 'Network',
  license: 'MIT', processorType: 'state_tracker', sourceTypes: ['logcat'], deprecated: false,
};
const standaloneEntry: MarketplaceEntry = {
  id: 'anr-detector', name: 'ANR Detector', version: '1.0.0', description: 'Finds ANRs',
  path: 'processors/anr.yaml', tags: ['anr'], sha256: 'y', category: 'Performance',
  license: 'MIT', processorType: 'reporter', sourceTypes: ['logcat'], deprecated: false,
};

function fakeStore(overrides: Partial<PacksStore> = {}): PacksStore {
  const [sources] = createSignal<Source[]>([{ name: 'official', type: 'github', repo: 'jpicklyk/logtapper', enabled: true, autoUpdate: true }]);
  const [selectedSource, setSelectedSource] = createSignal<string | null>('official');
  const [entries] = createSignal<MarketplaceEntry[]>([wifiStateEntry, standaloneEntry]);
  const [packEntries] = createSignal<MarketplacePackEntry[]>([wifiPack, batteryPack]);
  const [entriesLoading] = createSignal(false);
  const [entriesError] = createSignal<string | null>(null);
  const [installedPacks] = createSignal<PackSummary[]>([]);
  const [installedProcessors] = createSignal<ProcessorSummary[]>([]);
  const [pendingUpdates] = createSignal<UpdateAvailable[]>([]);
  const [pendingPackUpdates] = createSignal<PackUpdateAvailable[]>([]);
  const [updatesLoading] = createSignal(false);
  const [updateErrors] = createSignal<SourceError[]>([]);
  const [updatesError] = createSignal<string | null>(null);

  return {
    sources,
    refreshSources: vi.fn(),
    selectedSource,
    entries,
    packEntries,
    entriesLoading,
    entriesError,
    fetchEntries: vi.fn((name: string) => { setSelectedSource(name); return Promise.resolve(); }),
    installedPacks,
    installedProcessors,
    refreshInstalled: vi.fn(() => Promise.resolve()),
    isPending: vi.fn(() => false),
    errorFor: vi.fn(() => undefined),
    installPack: vi.fn(() => Promise.resolve({} as PackSummary)),
    uninstallPack: vi.fn(() => Promise.resolve()),
    installProcessor: vi.fn(() => Promise.resolve({} as ProcessorSummary)),
    uninstallProcessor: vi.fn(() => Promise.resolve()),
    pendingUpdates,
    pendingPackUpdates,
    updatesLoading,
    updateErrors,
    updatesError,
    checkUpdates: vi.fn(() => Promise.resolve()),
    updateOne: vi.fn(() => Promise.resolve()),
    updateAllFromSource: vi.fn(() => Promise.resolve()),
    updatePack: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
    ...overrides,
  } as PacksStore;
}

describe('PacksPanel', () => {
  it('fetches the first enabled source when nothing is selected yet', () => {
    const [selectedSource, setSelectedSource] = createSignal<string | null>(null);
    const store = fakeStore({
      selectedSource,
      fetchEntries: vi.fn((name: string) => { setSelectedSource(name); return Promise.resolve(); }),
    });
    render(() => <PacksPanel store={store} sourcesPanel={<div data-testid="sources-slot" />} />);
    expect(store.fetchEntries).toHaveBeenCalledWith('official');
  });

  it('groups curated packs by category, showing plain-language descriptions', () => {
    const store = fakeStore();
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    expect(screen.getAllByText('Network').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Power').length).toBeGreaterThan(0);
    expect(screen.getByText('WiFi Pack')).toBeTruthy();
    expect(screen.getByText('Finds WiFi issues')).toBeTruthy();
    expect(screen.getByText('Battery Pack')).toBeTruthy();
  });

  it('does not install a pack on one click: shows a preview of its member analyzers first, gated behind Confirm add', () => {
    const store = fakeStore();
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    const card = screen.getByTestId('pack-card-wifi-pack');
    fireEvent.click(within(card).getByText('Add pack'));
    expect(store.installPack).not.toHaveBeenCalled();
    const preview = screen.getByTestId('pack-preview-wifi-pack');
    expect(within(preview).getByText('WiFi State')).toBeTruthy();
    expect(within(preview).getByText('Tracks WiFi association')).toBeTruthy();
    // wlan-disconnect has no matching fetched entry, falls back to the bare id
    expect(within(preview).getByText('wlan-disconnect')).toBeTruthy();
    fireEvent.click(within(preview).getByText('Confirm add'));
    expect(store.installPack).toHaveBeenCalledWith('official', wifiPack);
  });

  it('cancelling the preview does not install', () => {
    const store = fakeStore();
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    const card = screen.getByTestId('pack-card-wifi-pack');
    fireEvent.click(within(card).getByText('Add pack'));
    fireEvent.click(screen.getByTestId('pack-preview-wifi-pack').querySelector('button:last-child')!);
    expect(store.installPack).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pack-preview-wifi-pack')).toBeNull();
  });

  it('removing an installed pack requires a second confirming click', () => {
    const store = fakeStore({ installedPacks: () => [{ id: 'wifi-pack' } as PackSummary] });
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    const card = screen.getByTestId('pack-card-wifi-pack');
    expect(within(card).getByText('Added')).toBeTruthy();
    fireEvent.click(within(card).getByText('Remove'));
    expect(store.uninstallPack).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByText('Confirm remove'));
    expect(store.uninstallPack).toHaveBeenCalledWith('official', 'wifi-pack');
  });

  it('offers Update AND Remove when a pack update is available (D1-L12)', () => {
    const update: PackUpdateAvailable = {
      packId: 'wifi-pack', packName: 'WiFi Pack', sourceName: 'official',
      installedVersion: '1.0.0', availableVersion: '1.1.0', newProcessorIds: [], entry: wifiPack,
    };
    const store = fakeStore({
      installedPacks: () => [{ id: 'wifi-pack' } as PackSummary],
      pendingPackUpdates: () => [update],
    });
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    const card = screen.getByTestId('pack-card-wifi-pack');
    expect(within(card).getByText('Update available')).toBeTruthy();
    fireEvent.click(within(card).getByText('Update'));
    expect(store.updatePack).toHaveBeenCalledWith('official', wifiPack);

    // Update used to REPLACE Remove, so a pack with a pending update could
    // only be uninstalled by updating it first.
    fireEvent.click(within(card).getByText('Remove'));
    fireEvent.click(within(card).getByText('Confirm remove'));
    expect(store.uninstallPack).toHaveBeenCalledWith('official', 'wifi-pack');
  });

  it('filters packs by search query across name/description/tags', () => {
    const store = fakeStore();
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    fireEvent.input(screen.getByLabelText('Filter packs'), { target: { value: 'battery' } });
    expect(screen.getByText('Battery Pack')).toBeTruthy();
    expect(screen.queryByText('WiFi Pack')).toBeNull();
  });

  it('hides pack-member processors from the Advanced library and lists only standalone entries', () => {
    const store = fakeStore();
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    expect(screen.queryByTestId('library-row-wifi-state')).toBeNull();
    expect(screen.getByTestId('library-row-anr-detector')).toBeTruthy();
  });

  it('renders the injected sourcesPanel slot inside Advanced, unmodified', () => {
    const store = fakeStore();
    render(() => <PacksPanel store={store} sourcesPanel={<div data-testid="sources-slot">hi</div>} />);
    expect(screen.getByTestId('sources-slot')).toBeTruthy();
  });

  it('installing a standalone library analyzer calls installProcessor with the selected source', () => {
    const store = fakeStore();
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    const row = screen.getByTestId('library-row-anr-detector');
    fireEvent.click(within(row).getByText('Add'));
    expect(store.installProcessor).toHaveBeenCalledWith('official', standaloneEntry);
  });

  it('uninstalling a standalone library analyzer is confirm-gated', () => {
    const store = fakeStore({ installedProcessors: () => [{ id: 'anr-detector' } as ProcessorSummary] });
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    const row = screen.getByTestId('library-row-anr-detector');
    fireEvent.click(within(row).getByText('Uninstall'));
    expect(store.uninstallProcessor).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByText('Confirm'));
    expect(store.uninstallProcessor).toHaveBeenCalledWith('anr-detector');
  });

  it('shows an update-available banner summarizing both processor and pack updates', () => {
    const store = fakeStore({
      pendingUpdates: () => [{ processorId: 'a', processorName: 'A', sourceName: 'official', installedVersion: '1.0.0', availableVersion: '1.1.0', entry: wifiStateEntry }],
      pendingPackUpdates: () => [{ packId: 'wifi-pack', packName: 'WiFi Pack', sourceName: 'official', installedVersion: '1.0.0', availableVersion: '1.1.0', newProcessorIds: [], entry: wifiPack }],
    });
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    expect(screen.getByTestId('packs-update-summary').textContent).toContain('2 updates available');
  });

  it('Advanced Updates section triggers checkUpdates and updateOne', () => {
    const store = fakeStore({
      pendingUpdates: () => [{ processorId: 'wifi-state', processorName: 'WiFi State', sourceName: 'official', installedVersion: '1.0.0', availableVersion: '1.1.0', entry: wifiStateEntry }],
    });
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    fireEvent.click(screen.getByText('Check for updates'));
    expect(store.checkUpdates).toHaveBeenCalled();
    const row = screen.getByTestId('update-row-wifi-state');
    fireEvent.click(within(row).getByText('Update'));
    expect(store.updateOne).toHaveBeenCalledWith('wifi-state');
  });

  it('shows the no-sources hint when no source is configured', () => {
    const [sources] = createSignal<Source[]>([]);
    const store = fakeStore({ sources, selectedSource: () => null });
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    expect(screen.getByText(/No marketplace sources configured/)).toBeTruthy();
  });

  describe('source selection (D1-H1)', () => {
    it('asks the owner to load the sources when the list is empty at mount', () => {
      const [sources] = createSignal<Source[]>([]);
      const store = fakeStore({ sources, selectedSource: () => null });
      render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
      // Nothing else loads them: `SourcesTab` is rendered *inside* this panel.
      expect(store.refreshSources).toHaveBeenCalledTimes(1);
    });

    it('does not re-ask when the sources are already loaded', () => {
      const store = fakeStore();
      render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
      expect(store.refreshSources).not.toHaveBeenCalled();
    });

    it('picks the first enabled source when the list arrives AFTER mount', async () => {
      const [sources, setSources] = createSignal<Source[]>([]);
      const [selectedSource, setSelectedSource] = createSignal<string | null>(null);
      const store = fakeStore({
        sources,
        selectedSource,
        fetchEntries: vi.fn((name: string) => { setSelectedSource(name); return Promise.resolve(); }),
      });
      render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
      // `onMount` ran against an empty list — the old code stopped here, with
      // no selected source, a disabled Fetch button and no `<select>`.
      expect(store.fetchEntries).not.toHaveBeenCalled();

      setSources([{ name: 'official', type: 'github', repo: 'jpicklyk/logtapper', enabled: true, autoUpdate: true }]);
      await Promise.resolve();
      expect(store.fetchEntries).toHaveBeenCalledWith('official');
    });

    it('skips disabled sources', async () => {
      const [sources, setSources] = createSignal<Source[]>([]);
      const store = fakeStore({ sources, selectedSource: () => null });
      render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
      setSources([
        { name: 'off', type: 'github', repo: 'a/b', enabled: false, autoUpdate: false },
        { name: 'on', type: 'github', repo: 'c/d', enabled: true, autoUpdate: true },
      ]);
      await Promise.resolve();
      expect(store.fetchEntries).toHaveBeenCalledWith('on');
    });

    it('does not refetch on a later visit once a source is selected (D1-L10)', () => {
      const store = fakeStore(); // selectedSource is already 'official'
      render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
      expect(store.fetchEntries).not.toHaveBeenCalled();
    });
  });

  it('renders a wholesale update-check failure rather than "No pending updates." (D1-M12)', () => {
    const store = fakeStore({ updatesError: () => 'Error: network down' });
    render(() => <PacksPanel store={store} sourcesPanel={<div />} />);
    const banner = screen.getByTestId('updates-check-error');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('network down');
    expect(screen.queryByText('No pending updates.')).toBeNull();
  });
});
