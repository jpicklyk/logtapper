/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type {
  AnonymizerConfig, AnonymizerTestResult, FileAssocEntry, McpBundleInfo, McpStatus, Source, ThemeSummary, UserTheme,
} from '@bridge/types';
import type { AppliedUserTheme, Density, ThemeController, ThemeMode } from '../theme';
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
    mcpStatus, mcpBridgePending: f, setMcpBridgeEnabled: vi.fn(noop), mcpBridgeEnabled: f,
    agentRawAccessPending: f, setAgentRawAccess: vi.fn(noop),
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
    mcpSidecarPath: () => null as string | null, mcpBundleInfo: () => null as McpBundleInfo | null,
    mcpHttpEndpoint: () => null as string | null, mcpHttpError: () => null as string | null,
    mcpHttpPort: () => 40405, setMcpHttpPort: vi.fn(() => Promise.resolve()),
    mcpAgentResolved: () => true, refreshMcpAgentSetup: vi.fn(),
    installMcpBundle: vi.fn(noop), saveMcpBundle: vi.fn(noop),
    error: () => null, clearError: vi.fn(), dispose: vi.fn(),
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
    sources, refreshSources: vi.fn(), selectedSource,
    entries: emptyArr, packEntries: emptyArr, entriesLoading: f, entriesError: () => null,
    fetchEntries: vi.fn(noop),
    installedPacks: emptyArr, installedProcessors: emptyArr, refreshInstalled: vi.fn(noop),
    isPending: vi.fn(() => false), errorFor: vi.fn(() => undefined),
    installPack: vi.fn(noop), uninstallPack: vi.fn(noop), installProcessor: vi.fn(noop), uninstallProcessor: vi.fn(noop),
    pendingUpdates: emptyArr, pendingPackUpdates: emptyArr, updatesLoading: f, updateErrors: emptyArr,
    updatesError: () => null,
    checkUpdates: vi.fn(noop), updateOne: vi.fn(noop), updateAllFromSource: vi.fn(noop), updatePack: vi.fn(noop),
    dispose: vi.fn(),
  } as unknown as PacksStore;
}
function fakeThemeController(): ThemeController {
  const [mode, setModeSignal] = createSignal<ThemeMode>('dark');
  const [density, setDensitySignal] = createSignal<Density>('comfortable');
  const [overrides, setOverrides] = createSignal<Record<string, string> | undefined>(undefined);
  const [appliedSlug, setAppliedSlug] = createSignal<string | null>(null);
  return {
    mode, resolvedBase: () => 'dark', density, userOverrides: overrides, appliedThemeSlug: appliedSlug,
    setMode: vi.fn((m: ThemeMode) => setModeSignal(m)), setDensity: vi.fn((d: Density) => setDensitySignal(d)),
    setUserOverrides: vi.fn((o: Record<string, string> | undefined) => setOverrides(() => o)),
    applyUserTheme: vi.fn((slug: string, theme: AppliedUserTheme) => {
      setModeSignal(theme.base);
      setOverrides(() => ({ ...theme.tokens }));
      setAppliedSlug(slug);
    }),
    clearUserTheme: vi.fn(() => { setOverrides(() => undefined); setAppliedSlug(null); }),
    dispose: vi.fn(),
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

describe('SettingsPanel error banner (D1-H3)', () => {
  it('renders the store error as a dismissible alert and clears it on dismiss', () => {
    const store = fakeStore();
    const [message, setMessage] = createSignal<string | null>(null);
    (store as { error: () => string | null }).error = message;
    (store as { clearError: () => void }).clearError = vi.fn(() => setMessage(null));

    render(() => <SettingsPanel store={store} />);
    expect(screen.queryByTestId('settings-error')).toBeNull();

    setMessage('set_agent_raw_access failed: NOT_ALLOWED');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('NOT_ALLOWED');

    fireEvent.click(screen.getByTitle('Dismiss'));
    expect(store.clearError).toHaveBeenCalled();
    expect(screen.queryByTestId('settings-error')).toBeNull();
  });
});

describe('SettingsPanel tab widget (D1-L7)', () => {
  it('pairs every tab with its panel and moves selection with the arrow keys', () => {
    render(() => <SettingsPanel store={fakeStore()} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-controls')).toBe('settings-tabpanel-general');
    expect(screen.getByRole('tabpanel').getAttribute('id')).toBe('settings-tabpanel-general');
    // Roving tabindex: exactly one tab stop for the whole strip.
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);

    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(screen.getByTestId('pii-tab')).toBeTruthy();
    fireEvent.keyDown(screen.getAllByRole('tab')[1], { key: 'ArrowLeft' });
    expect(screen.getByTestId('general-tab')).toBeTruthy();
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'End' });
    expect(screen.getByText('Packs are unavailable in this build.')).toBeTruthy();
  });
});

describe('GeneralTab security toggle (D1-M5, D1-M6)', () => {
  it('shows the raw-access checkbox as indeterminate and disabled until McpStatus lands', () => {
    const store = fakeStore();
    const [status, setStatus] = createSignal<McpStatus | null>(null);
    (store as { mcpStatus: () => McpStatus | null }).mcpStatus = status;

    render(() => <SettingsPanel store={store} />);
    const box = screen.getByTestId('agent-raw-access') as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box.disabled).toBe(true);
    // The unknown state must never be actionable — a click here would write a
    // value the user never saw the current setting for. `.click()` (not
    // `fireEvent.click`, which dispatches regardless) so `disabled` is honoured.
    box.click();
    expect(store.setAgentRawAccess).not.toHaveBeenCalled();

    setStatus({ running: true, idleSecs: 2, agentRawAccess: true } as unknown as McpStatus);
    expect(box.indeterminate).toBe(false);
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
  });

  it('labels the bridge "starting" while the preference is on but it is not running yet', () => {
    const store = fakeStore();
    const [enabled, setEnabled] = createSignal(false);
    (store as { mcpBridgeEnabled: () => boolean }).mcpBridgeEnabled = enabled;

    render(() => <SettingsPanel store={store} />);
    expect(screen.getByText(/Bridge: disabled/)).toBeTruthy();
    setEnabled(true);
    expect(screen.getByText(/Bridge: starting/)).toBeTruthy();
  });
});

describe('ThemesTab (D1-M3, D1-M13, B-M5)', () => {
  function themeStore(themes: ThemeSummary[], theme?: UserTheme) {
    const store = fakeStore();
    (store as { themes: () => ThemeSummary[] }).themes = () => themes;
    if (theme) (store as { readTheme: (slug: string) => Promise<UserTheme> }).readTheme = vi.fn(() => Promise.resolve(theme));
    return store;
  }
  const openThemes = () => fireEvent.click(screen.getByRole('tab', { name: 'Themes' }));

  it('scores contrast against the draft, not the painted theme', () => {
    // The painted theme is dark (fakeThemeController). A light draft whose text
    // is #eeeeee is unreadable on its own #ffffff surface, but would pass
    // against dark's #0c1014 surface — exactly the old getComputedStyle bug.
    render(() => <SettingsPanel store={fakeStore()} theme={fakeThemeController()} />);
    openThemes();
    fireEvent.change(screen.getByDisplayValue('dark'), { target: { value: 'light' } });
    const tokenInputs = screen.getAllByPlaceholderText('inherit base theme');
    fireEvent.input(tokenInputs[1], { target: { value: '#eeeeee' } });
    expect(screen.getByText(/fail$/)).toBeTruthy();

    // Give the draft its own dark surface and the same text now passes.
    fireEvent.input(tokenInputs[0], { target: { value: '#000000' } });
    expect(screen.queryByText(/fail$/)).toBeNull();
  });

  it('requires an explicit second Save to overwrite an existing slug', () => {
    const store = themeStore([{ slug: 'ember', name: 'Ember', base: 'dark' }]);
    render(() => <SettingsPanel store={store} theme={fakeThemeController()} />);
    openThemes();
    const textboxes = screen.getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.input(textboxes[0], { target: { value: 'ember' } });
    fireEvent.input(textboxes[1], { target: { value: 'Mine' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(store.saveTheme).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('already exists');

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite?' }));
    expect(store.saveTheme).toHaveBeenCalledWith('ember', expect.objectContaining({ name: 'Mine' }));
  });

  it('Use applies the theme through the controller and marks it in use', async () => {
    const theme: UserTheme = { name: 'Ember', base: 'light', tokens: { '--accent': '#ff8800' } };
    const store = themeStore([{ slug: 'ember', name: 'Ember', base: 'light' }], theme);
    const controller = fakeThemeController();
    render(() => <SettingsPanel store={store} theme={controller} />);
    openThemes();

    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    await vi.waitFor(() =>
      expect(controller.applyUserTheme).toHaveBeenCalledWith('ember', { base: 'light', tokens: { '--accent': '#ff8800' } }),
    );
    expect(controller.userOverrides()).toEqual({ '--accent': '#ff8800' });
    expect(screen.getByTestId('applied-theme')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use built-in theme' }));
    expect(controller.userOverrides()).toBeUndefined();
    expect(screen.queryByTestId('applied-theme')).toBeNull();
  });

  it('deleting the theme in use drops its overrides', async () => {
    const theme: UserTheme = { name: 'Ember', base: 'light', tokens: { '--accent': '#ff8800' } };
    const store = themeStore([{ slug: 'ember', name: 'Ember', base: 'light' }], theme);
    const controller = fakeThemeController();
    render(() => <SettingsPanel store={store} theme={controller} />);
    openThemes();
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    await vi.waitFor(() => expect(controller.appliedThemeSlug()).toBe('ember'));

    fireEvent.click(screen.getByTitle('Delete theme'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete?' }));
    await vi.waitFor(() => expect(controller.clearUserTheme).toHaveBeenCalled());
  });

  it('hides the Use actions when no controller is supplied', () => {
    render(() => <SettingsPanel store={themeStore([{ slug: 'ember', name: 'Ember', base: 'dark' }])} />);
    openThemes();
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull();
  });
});

describe('SourcesTab (D1-L9)', () => {
  const openSources = (store: SettingsStore) => {
    render(() => <SettingsPanel store={store} packs={fakePacksStore()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Packs' }));
    fireEvent.click(screen.getByTestId('packs-advanced').querySelector('summary')!);
  };

  it('rejects a github source with no repo and a local source with no path', () => {
    const store = fakeStore();
    openSources(store);
    const tab = within(screen.getByTestId('sources-tab'));
    fireEvent.input(tab.getAllByRole('textbox')[0], { target: { value: 'mine' } });

    fireEvent.click(tab.getByRole('button', { name: 'Add source' }));
    expect(store.addSource).not.toHaveBeenCalled();
    expect(tab.getByRole('alert').textContent).toContain('repo is required');

    fireEvent.change(tab.getByDisplayValue('github'), { target: { value: 'local' } });
    fireEvent.click(tab.getByRole('button', { name: 'Add source' }));
    expect(store.addSource).not.toHaveBeenCalled();
    expect(tab.getByRole('alert').textContent).toContain('path is required');
  });

  it('rejects a github repo that is not in owner/repo form', () => {
    const store = fakeStore();
    openSources(store);
    const tab = within(screen.getByTestId('sources-tab'));
    const textboxes = tab.getAllByRole('textbox');
    fireEvent.input(textboxes[0], { target: { value: 'mine' } });
    fireEvent.input(tab.getByPlaceholderText('owner/repo'), { target: { value: 'justarepo' } });

    fireEvent.click(tab.getByRole('button', { name: 'Add source' }));
    expect(store.addSource).not.toHaveBeenCalled();
    expect(tab.getByRole('alert').textContent).toContain('owner/repo');

    fireEvent.input(tab.getByPlaceholderText('owner/repo'), { target: { value: 'jpicklyk/logtapper' } });
    fireEvent.click(tab.getByRole('button', { name: 'Add source' }));
    expect(store.addSource).toHaveBeenCalledWith({
      name: 'mine', type: 'github', repo: 'jpicklyk/logtapper', enabled: true, autoUpdate: true,
    });
  });

  it('removes a source only after the row is confirmed', () => {
    const store = fakeStore();
    (store as { sources: () => Source[] }).sources = () => [
      { name: 'official', type: 'github', repo: 'a/b', enabled: true, autoUpdate: true },
    ];
    openSources(store);
    const tab = within(screen.getByTestId('sources-tab'));

    fireEvent.click(tab.getByTitle('Remove source'));
    expect(store.removeSource).not.toHaveBeenCalled();
    fireEvent.click(tab.getByTitle('Keep source'));
    fireEvent.click(tab.getByTitle('Remove source'));
    fireEvent.click(tab.getByRole('button', { name: 'Remove?' }));
    expect(store.removeSource).toHaveBeenCalledWith('official');
  });
});
