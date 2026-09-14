/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type {
  AnonymizerConfig, AnonymizerTestResult, FileAssocEntry, McpStatus, Source, ThemeSummary, UserTheme,
} from '@bridge/types';
import type { Density, ThemeController, ThemeMode } from '../theme/applyTheme';
import { SettingsPanel } from './SettingsPanel';
import type { SettingsStore } from './settingsStore';
import type { PacksStore } from '../packs/packsStore';
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
afterEach(cleanup);
/** A hand-built `SettingsStore` double — the panel is tested as a renderer
 *  over the store's public surface, not against the real store (that is
 *  `settingsStore.test.ts`'s job). Mirrors `AnalysesPanel.test.tsx`'s `fakeStore`. */
function fakeStore(): SettingsStore {
  const [mcpStatus] = createSignal<McpStatus | null>(null);
  const [f] = createSignal(false);
  const noop = () => Promise.resolve();
  return {
    mcpStatus, mcpBridgePending: f, setMcpBridgeEnabled: vi.fn(noop), agentRawAccessPending: f, setAgentRawAccess: vi.fn(noop),
    allowlist: () => null, refreshAllowlist: vi.fn(), addAllowDir: vi.fn(noop), removeAllowDir: vi.fn(noop), setAllowAll: vi.fn(noop),
    fileAssociations: () => [] as FileAssocEntry[], refreshFileAssociations: vi.fn(), setFileAssociation: vi.fn(noop), openDefaultAppsSettings: vi.fn(),
    anonymizerConfig: () => null as AnonymizerConfig | null, refreshAnonymizerConfig: vi.fn(), toggleDetector: vi.fn(noop),
    testResult: () => null as AnonymizerTestResult | null,
    runAnonymizerTest: vi.fn(() => Promise.resolve({ anonymized: '', replacements: [] })),
    piiMappings: () => ({}), refreshPiiMappings: vi.fn(noop),
    themes: () => [] as ThemeSummary[], refreshThemes: vi.fn(),
    readTheme: vi.fn(() => Promise.resolve({ name: '', base: 'dark', tokens: {} } as UserTheme)),
    saveTheme: vi.fn(noop), deleteTheme: vi.fn(noop),
    importThemeFromFile: vi.fn(() => Promise.resolve({ name: '', base: 'dark', tokens: {} } as UserTheme)),
    exportThemeToFile: vi.fn(noop),
    sources: () => [] as Source[], refreshSources: vi.fn(), addSource: vi.fn(noop), removeSource: vi.fn(noop),
    error: () => null, dispose: vi.fn(),
  } as unknown as SettingsStore;
}
/** Minimal `PacksStore` double — enough for `PacksPanel` to render its empty
 *  state; `PacksPanel.test.tsx` covers the panel's own behaviour. */
function fakePacksStore(): PacksStore {
  const [sources] = createSignal([]);
  const [selectedSource] = createSignal<string | null>(null);
  const [emptyArr] = createSignal([]);
  const [f] = createSignal(false);
  const noop = () => Promise.resolve();
  return {
    sources, selectedSource,
    entries: emptyArr, packEntries: emptyArr, entriesLoading: f, entriesError: () => null,
    fetchEntries: vi.fn(noop),
    installedPacks: emptyArr, installedProcessors: emptyArr, refreshInstalled: vi.fn(noop),
    isPending: vi.fn(() => false), errorFor: vi.fn(() => undefined),
    installPack: vi.fn(noop), uninstallPack: vi.fn(noop), installProcessor: vi.fn(noop), uninstallProcessor: vi.fn(noop),
    pendingUpdates: emptyArr, pendingPackUpdates: emptyArr, updatesLoading: f, updateErrors: emptyArr,
    checkUpdates: vi.fn(noop), updateOne: vi.fn(noop), updateAllFromSource: vi.fn(noop), updatePack: vi.fn(noop),
    dispose: vi.fn(),
  } as unknown as PacksStore;
}
function fakeThemeController(): ThemeController {
  const [mode, setModeSignal] = createSignal<ThemeMode>('dark');
  const [density, setDensitySignal] = createSignal<Density>('comfortable');
  return {
    mode, resolvedBase: () => 'dark', density, userOverrides: () => undefined,
    setMode: vi.fn((m: ThemeMode) => setModeSignal(m)), setDensity: vi.fn((d: Density) => setDensitySignal(d)),
    setUserOverrides: vi.fn(), dispose: vi.fn(),
  };
}
describe('SettingsPanel', () => {
  it('opens on the General tab, showing the theme controller state, and switches tabs on click', () => {
    const theme = fakeThemeController();
    render(() => <SettingsPanel store={fakeStore()} theme={theme} />);
    expect(screen.getByTestId('general-tab')).toBeTruthy();
    const select = screen.getByDisplayValue('dark') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'light' } });
    expect(theme.setMode).toHaveBeenCalledWith('light');
    fireEvent.click(screen.getByRole('tab', { name: 'PII' }));
    expect(screen.getByTestId('pii-tab')).toBeTruthy();
    expect(screen.queryByTestId('general-tab')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Themes' }));
    expect(screen.getByTestId('themes-tab')).toBeTruthy();
  });
  it('shows a fallback on the Packs tab when no packs store is supplied, and the real panel (with Sources under Advanced) when one is', () => {
    render(() => <SettingsPanel store={fakeStore()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Packs' }));
    expect(screen.getByText('Packs are unavailable in this build.')).toBeTruthy();
    cleanup();
    render(() => <SettingsPanel store={fakeStore()} packs={fakePacksStore()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Packs' }));
    expect(screen.getByTestId('packs-panel')).toBeTruthy();
    fireEvent.click(screen.getByTestId('packs-advanced').querySelector('summary')!);
    expect(screen.getByTestId('sources-tab')).toBeTruthy();
  });
  it('deletes a user theme only after the row is confirmed', () => {
    const store = fakeStore();
    (store as { themes: () => ThemeSummary[] }).themes = () => [{ slug: 'ember', name: 'Ember', base: 'dark' }];
    render(() => <SettingsPanel store={store} theme={fakeThemeController()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Themes' }));
    fireEvent.click(screen.getByTitle('Delete theme'));
    expect(store.deleteTheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Keep theme'));
    expect(screen.getByTitle('Delete theme')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Delete theme'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete?' }));
    expect(store.deleteTheme).toHaveBeenCalledWith('ember');
  });
  it('renders General without a theme controller (optional prop)', () => {
    render(() => <SettingsPanel store={fakeStore()} />);
    expect(screen.getByTestId('general-tab')).toBeTruthy();
  });
});
