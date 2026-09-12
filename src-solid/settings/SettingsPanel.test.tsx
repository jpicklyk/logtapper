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
    fireEvent.click(screen.getByRole('tab', { name: 'Sources' }));
    expect(screen.getByTestId('sources-tab')).toBeTruthy();
  });
  it('renders General without a theme controller (optional prop)', () => {
    render(() => <SettingsPanel store={fakeStore()} />);
    expect(screen.getByTestId('general-tab')).toBeTruthy();
  });
});
