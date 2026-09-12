import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { createSettingsStore } from './settingsStore';
import type { AnonymizerTestResult, McpStatus, UserTheme } from '@bridge/types';
function noStatus() {
  const [status] = createSignal<McpStatus | null>(null);
  return status;
}
function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

describe('settingsStore', () => {
  it('auto-starts the MCP bridge at construction when the shared preference is on', () => {
    const startMcpBridge = vi.fn(() => Promise.resolve());
    const storage = memoryStorage({ logtapper_settings: JSON.stringify({ mcpBridgeEnabled: true, density: 'compact' }) });
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { startMcpBridge }, storage });
    expect(startMcpBridge).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('leaves the bridge alone at construction when the preference is off, absent, or malformed', () => {
    for (const raw of [JSON.stringify({ mcpBridgeEnabled: false }), undefined, '{not json', '[]']) {
      const startMcpBridge = vi.fn(() => Promise.resolve());
      const storage = memoryStorage(raw === undefined ? {} : { logtapper_settings: raw });
      const store = createSettingsStore({ mcpStatus: noStatus(), commands: { startMcpBridge }, storage });
      expect(startMcpBridge).not.toHaveBeenCalled();
      store.dispose();
    }
  });

  it('persists the bridge toggle into the shared settings blob without dropping other keys', async () => {
    const startMcpBridge = vi.fn(() => Promise.resolve());
    const stopMcpBridge = vi.fn(() => Promise.resolve());
    const storage = memoryStorage({ logtapper_settings: JSON.stringify({ density: 'compact', exportAnonymize: true }) });
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { startMcpBridge, stopMcpBridge }, storage });
    await store.setMcpBridgeEnabled(true);
    expect(JSON.parse(storage.data.logtapper_settings!)).toEqual({ density: 'compact', exportAnonymize: true, mcpBridgeEnabled: true });
    await store.setMcpBridgeEnabled(false);
    expect(JSON.parse(storage.data.logtapper_settings!).mcpBridgeEnabled).toBe(false);
    store.dispose();
  });

  it('does not persist the preference when the bridge command rejects', async () => {
    const startMcpBridge = vi.fn(() => Promise.reject(new Error('port in use')));
    const storage = memoryStorage();
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { startMcpBridge }, storage });
    await expect(store.setMcpBridgeEnabled(true)).rejects.toThrow('port in use');
    expect(storage.data.logtapper_settings).toBeUndefined();
    store.dispose();
  });

  it('testAnonymizer round-trip: the call succeeds and its result is stored', async () => {
    const result: AnonymizerTestResult = {
      anonymized: 'user <EMAIL-1> logged in',
      replacements: [{ token: '<EMAIL-1>', original: 'a@b.com', category: 'email', start: 5, end: 12 }],
    };
    const testAnonymizer = vi.fn(() => Promise.resolve(result));
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { testAnonymizer } });
    const returned = await store.runAnonymizerTest('user a@b.com logged in');
    expect(testAnonymizer).toHaveBeenCalledWith('user a@b.com logged in');
    expect(returned).toEqual(result);
    expect(store.testResult()).toEqual(result);
    store.dispose();
  });
  it('theme round-trip: export, modify, import — the imported theme appears in the list', async () => {
    const theme: UserTheme = { name: 'Midnight', base: 'dark', tokens: { '--accent': '#ff0000' } };
    let written: string | null = null;
    const savedThemes: { slug: string; name: string; base: UserTheme['base'] }[] = [];
    const writeTextFile = vi.fn((_p: string, content: string) => { written = content; return Promise.resolve(); });
    const readTextFile = vi.fn(() => Promise.resolve(written ?? ''));
    const writeTheme = vi.fn((slug: string, t: UserTheme) => {
      savedThemes.push({ slug, name: t.name, base: t.base });
      return Promise.resolve();
    });
    const listThemes = vi.fn(() => Promise.resolve(savedThemes.map((t) => ({ ...t }))));
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { writeTextFile, readTextFile, writeTheme, listThemes } });
    await store.exportThemeToFile('C:/themes/midnight.json', theme);
    expect(writeTextFile).toHaveBeenCalledWith('C:/themes/midnight.json', JSON.stringify(theme, null, 2));
    const modified: UserTheme = { ...theme, tokens: { ...theme.tokens, '--surface': '#101010' } };
    await store.exportThemeToFile('C:/themes/midnight.json', modified); // "modify" the exported file
    const imported = await store.importThemeFromFile('C:/themes/midnight.json', 'midnight');
    expect(imported).toEqual(modified);
    expect(writeTheme).toHaveBeenCalledWith('midnight', modified);
    await vi.waitFor(() => expect(store.themes()).toEqual([{ slug: 'midnight', name: 'Midnight', base: 'dark' }]));
    store.dispose();
  });
  it('importThemeFromFile rejects invalid themes without writing them', async () => {
    const readTextFile = vi.fn(() => Promise.resolve(JSON.stringify({ name: '', base: 'nope', tokens: {} })));
    const writeTheme = vi.fn(() => Promise.resolve());
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { readTextFile, writeTheme } });
    await expect(store.importThemeFromFile('C:/bad.json', 'bad')).rejects.toThrow();
    expect(writeTheme).not.toHaveBeenCalled();
    store.dispose();
  });
  it('setAgentRawAccess calls the exact backend command', async () => {
    const setAgentRawAccess = vi.fn(() => Promise.resolve());
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { setAgentRawAccess } });
    await store.setAgentRawAccess(true);
    expect(setAgentRawAccess).toHaveBeenCalledWith(true);
    expect(store.agentRawAccessPending()).toBe(false);
    store.dispose();
  });
  it('allowlist writes call setMcpOpenAllowlist with the exact merged allowlist', async () => {
    const getMcpOpenAllowlist = vi.fn(() => Promise.resolve({ allowedDirs: ['C:/logs'], allowAll: false }));
    const setMcpOpenAllowlist = vi.fn(() => Promise.resolve());
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { getMcpOpenAllowlist, setMcpOpenAllowlist } });
    store.refreshAllowlist();
    await vi.waitFor(() => expect(store.allowlist()).not.toBeNull());
    await store.addAllowDir('D:/captures');
    expect(setMcpOpenAllowlist).toHaveBeenCalledWith(['C:/logs', 'D:/captures'], false);
    await store.removeAllowDir('C:/logs');
    expect(setMcpOpenAllowlist).toHaveBeenLastCalledWith(['D:/captures'], false);
    store.dispose();
  });
});
