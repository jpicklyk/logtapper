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

  it('applies a saved non-default MCP port before auto-starting the bridge', async () => {
    const calls: string[] = [];
    const setMcpHttpPort = vi.fn((port: number) => { calls.push(`port:${port}`); return Promise.resolve(); });
    const startMcpBridge = vi.fn(() => { calls.push('start'); return Promise.resolve(); });
    const storage = memoryStorage({ logtapper_settings: JSON.stringify({ mcpBridgeEnabled: true, mcpHttpPort: 41000 }) });
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { startMcpBridge, setMcpHttpPort }, storage });
    expect(store.mcpHttpPort()).toBe(41000);
    await vi.waitFor(() => expect(startMcpBridge).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['port:41000', 'start']);
    store.dispose();
  });

  it('setMcpHttpPort persists the port beside the bridge preference and re-reads the endpoint', async () => {
    const setMcpHttpPort = vi.fn(() => Promise.resolve());
    const getMcpHttpInfo = vi.fn(() => Promise.resolve({ url: 'http://127.0.0.1:41000/mcp', port: 41000, error: null }));
    const storage = memoryStorage({ logtapper_settings: JSON.stringify({ mcpBridgeEnabled: false, density: 'compact' }) });
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { setMcpHttpPort, getMcpHttpInfo }, storage });
    await store.setMcpHttpPort(41000);
    expect(setMcpHttpPort).toHaveBeenCalledWith(41000);
    expect(store.mcpHttpPort()).toBe(41000);
    expect(JSON.parse(storage.getItem('logtapper_settings')!)).toEqual({ mcpBridgeEnabled: false, density: 'compact', mcpHttpPort: 41000 });
    await vi.waitFor(() => expect(store.mcpHttpEndpoint()).toBe('http://127.0.0.1:41000/mcp'));
    store.dispose();
  });

  it('a rejected port change reaches error() and leaves the port untouched', async () => {
    const setMcpHttpPort = vi.fn(() => Promise.reject(new Error('Port 80 is privileged; choose 1024 or higher')));
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { setMcpHttpPort }, storage: memoryStorage({}) });
    await expect(store.setMcpHttpPort(80)).rejects.toThrow();
    expect(store.error()).toContain('privileged');
    expect(store.mcpHttpPort()).toBe(40405);
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
    const store = createSettingsStore({ mcpStatus: noStatus(), storage: memoryStorage(), commands: { testAnonymizer } });
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
    const store = createSettingsStore({ mcpStatus: noStatus(), storage: memoryStorage(), commands: { writeTextFile, readTextFile, writeTheme, listThemes } });
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
    const store = createSettingsStore({ mcpStatus: noStatus(), storage: memoryStorage(), commands: { readTextFile, writeTheme } });
    await expect(store.importThemeFromFile('C:/bad.json', 'bad')).rejects.toThrow();
    expect(writeTheme).not.toHaveBeenCalled();
    store.dispose();
  });
  it('setAgentRawAccess calls the exact backend command', async () => {
    const setAgentRawAccess = vi.fn(() => Promise.resolve());
    const store = createSettingsStore({ mcpStatus: noStatus(), storage: memoryStorage(), commands: { setAgentRawAccess } });
    await store.setAgentRawAccess(true);
    expect(setAgentRawAccess).toHaveBeenCalledWith(true);
    expect(store.agentRawAccessPending()).toBe(false);
    store.dispose();
  });
  it('allowlist writes call setMcpOpenAllowlist with the exact merged allowlist', async () => {
    const getMcpOpenAllowlist = vi.fn(() => Promise.resolve({ allowedDirs: ['C:/logs'], allowAll: false }));
    const setMcpOpenAllowlist = vi.fn(() => Promise.resolve());
    const store = createSettingsStore({ mcpStatus: noStatus(), storage: memoryStorage(), commands: { getMcpOpenAllowlist, setMcpOpenAllowlist } });
    store.refreshAllowlist();
    await vi.waitFor(() => expect(store.allowlist()).not.toBeNull());
    await store.addAllowDir('D:/captures');
    expect(setMcpOpenAllowlist).toHaveBeenCalledWith(['C:/logs', 'D:/captures'], false);
    await store.removeAllowDir('C:/logs');
    expect(setMcpOpenAllowlist).toHaveBeenLastCalledWith(['D:/captures'], false);
    store.dispose();
  });
});

describe('settingsStore error channel (D1-H3)', () => {
  it('records a rejected mutation, clears it on the next attempt, and on clearError()', async () => {
    let fail = true;
    const setAgentRawAccess = vi.fn(() => (fail ? Promise.reject(new Error('backend said no')) : Promise.resolve()));
    const store = createSettingsStore({ mcpStatus: noStatus(), storage: memoryStorage(), commands: { setAgentRawAccess } });

    expect(store.error()).toBeNull();
    await expect(store.setAgentRawAccess(true)).rejects.toThrow('backend said no');
    expect(store.error()).toContain('backend said no');

    store.clearError();
    expect(store.error()).toBeNull();

    // A failure recorded by one write must not outlive the retry that succeeds.
    await expect(store.setAgentRawAccess(true)).rejects.toThrow();
    expect(store.error()).not.toBeNull();
    fail = false;
    await store.setAgentRawAccess(false);
    expect(store.error()).toBeNull();

    store.dispose();
  });

  it('a rejected allowlist write keeps its message while the rollback refresh runs', async () => {
    const getMcpOpenAllowlist = vi.fn(() => Promise.resolve({ allowedDirs: ['C:/logs'], allowAll: false }));
    const setMcpOpenAllowlist = vi.fn(() => Promise.reject(new Error('policy gate: NOT_ALLOWED')));
    const store = createSettingsStore({ mcpStatus: noStatus(), storage: memoryStorage(), commands: { getMcpOpenAllowlist, setMcpOpenAllowlist } });
    store.refreshAllowlist();
    await vi.waitFor(() => expect(store.allowlist()).not.toBeNull());

    await expect(store.addAllowDir('D:/captures')).rejects.toThrow();
    // The rollback re-read must not wipe the reason the write failed.
    await vi.waitFor(() => expect(store.allowlist()?.allowedDirs).toEqual(['C:/logs']));
    expect(store.error()).toContain('NOT_ALLOWED');

    store.dispose();
  });
});

describe('settingsStore security-toggle freshness (D1-M6)', () => {
  it('re-reads McpStatus after setAgentRawAccess, whether it resolves or rejects', async () => {
    const refreshMcpStatus = vi.fn();
    let fail = false;
    const setAgentRawAccess = vi.fn(() => (fail ? Promise.reject(new Error('nope')) : Promise.resolve()));
    const store = createSettingsStore({ mcpStatus: noStatus(), storage: memoryStorage(), refreshMcpStatus, commands: { setAgentRawAccess } });

    await store.setAgentRawAccess(true);
    expect(refreshMcpStatus).toHaveBeenCalledTimes(1);

    fail = true;
    await expect(store.setAgentRawAccess(false)).rejects.toThrow('nope');
    // The rejected case is the one that matters: without a re-read the checkbox
    // stays visually flipped for up to a poll interval while agents still get raw text.
    expect(refreshMcpStatus).toHaveBeenCalledTimes(2);

    store.dispose();
  });

  it('re-reads McpStatus after the bridge toggle', async () => {
    const refreshMcpStatus = vi.fn();
    const startMcpBridge = vi.fn(() => Promise.resolve());
    const store = createSettingsStore({ mcpStatus: noStatus(), storage: memoryStorage(), refreshMcpStatus, commands: { startMcpBridge } });
    await store.setMcpBridgeEnabled(true);
    expect(refreshMcpStatus).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('builds without a refreshMcpStatus dep', async () => {
    const setAgentRawAccess = vi.fn(() => Promise.resolve());
    const store = createSettingsStore({ mcpStatus: noStatus(), storage: memoryStorage(), commands: { setAgentRawAccess } });
    await expect(store.setAgentRawAccess(true)).resolves.toBeUndefined();
    store.dispose();
  });
});

describe('settingsStore bridge preference (D1-M5)', () => {
  it('exposes the persisted preference, seeded from storage and updated by a successful toggle', async () => {
    const storage = memoryStorage({ logtapper_settings: JSON.stringify({ mcpBridgeEnabled: true }) });
    const startMcpBridge = vi.fn(() => Promise.resolve());
    const stopMcpBridge = vi.fn(() => Promise.resolve());
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { startMcpBridge, stopMcpBridge }, storage });

    expect(store.mcpBridgeEnabled()).toBe(true);
    await store.setMcpBridgeEnabled(false);
    expect(store.mcpBridgeEnabled()).toBe(false);
    store.dispose();
  });

  it('leaves the preference untouched when the toggle rejects', async () => {
    const startMcpBridge = vi.fn(() => Promise.reject(new Error('port in use')));
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { startMcpBridge }, storage: memoryStorage() });
    await expect(store.setMcpBridgeEnabled(true)).rejects.toThrow();
    expect(store.mcpBridgeEnabled()).toBe(false);
    store.dispose();
  });
});

describe('settingsStore MCP agent setup (C1)', () => {
  it('resolves both reads together when both succeed', async () => {
    const getMcpSidecarPath = vi.fn(() => Promise.resolve('/opt/logtapper-mcp'));
    const getMcpBundlePath = vi.fn(() => Promise.resolve({ path: '/opt/logtapper.mcpb', installable: true }));
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { getMcpSidecarPath, getMcpBundlePath }, storage: memoryStorage() });
    store.refreshMcpAgentSetup();
    await vi.waitFor(() => expect(store.mcpAgentResolved()).toBe(true));
    expect(store.mcpSidecarPath()).toBe('/opt/logtapper-mcp');
    expect(store.mcpBundleInfo()).toEqual({ path: '/opt/logtapper.mcpb', installable: true });
    expect(store.error()).toBeNull();
    store.dispose();
  });

  it('a rejected bundle read still resolves the sidecar leg and marks the block resolved (Promise.allSettled)', async () => {
    const getMcpSidecarPath = vi.fn(() => Promise.resolve('/opt/logtapper-mcp'));
    const getMcpBundlePath = vi.fn(() => Promise.reject(new Error('no bundle in this build')));
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { getMcpSidecarPath, getMcpBundlePath }, storage: memoryStorage() });
    store.refreshMcpAgentSetup();
    await vi.waitFor(() => expect(store.mcpAgentResolved()).toBe(true));
    expect(store.mcpSidecarPath()).toBe('/opt/logtapper-mcp');
    expect(store.mcpBundleInfo()).toBeNull();
    // Neither leg's rejection is a user-facing error: a source checkout with no
    // bundled resources is the expected case, rendered as a hint, not a banner.
    expect(store.error()).toBeNull();
    store.dispose();
  });

  it('a rejected sidecar read still resolves the bundle leg and marks the block resolved', async () => {
    const getMcpSidecarPath = vi.fn(() => Promise.reject(new Error('no sidecar in dev build')));
    const getMcpBundlePath = vi.fn(() => Promise.resolve({ path: '/opt/logtapper.mcpb', installable: false }));
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { getMcpSidecarPath, getMcpBundlePath }, storage: memoryStorage() });
    store.refreshMcpAgentSetup();
    await vi.waitFor(() => expect(store.mcpAgentResolved()).toBe(true));
    expect(store.mcpSidecarPath()).toBeNull();
    expect(store.mcpBundleInfo()).toEqual({ path: '/opt/logtapper.mcpb', installable: false });
    expect(store.error()).toBeNull();
    store.dispose();
  });

  it('installMcpBundle rejection is recorded in the shared error channel', async () => {
    const openMcpBundle = vi.fn(() => Promise.reject(new Error('no handler registered')));
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { openMcpBundle }, storage: memoryStorage() });
    await expect(store.installMcpBundle()).rejects.toThrow('no handler registered');
    expect(store.error()).toBe('Error: no handler registered');
    store.dispose();
  });

  it('installMcpBundle success leaves the error channel untouched', async () => {
    const openMcpBundle = vi.fn(() => Promise.resolve());
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { openMcpBundle }, storage: memoryStorage() });
    await expect(store.installMcpBundle()).resolves.toBeUndefined();
    expect(store.error()).toBeNull();
    store.dispose();
  });

  it('saveMcpBundle rejection is recorded in the shared error channel', async () => {
    const saveMcpBundle = vi.fn(() => Promise.reject(new Error('disk full')));
    const store = createSettingsStore({ mcpStatus: noStatus(), commands: { saveMcpBundle }, storage: memoryStorage() });
    await expect(store.saveMcpBundle('/tmp/out.mcpb')).rejects.toThrow('disk full');
    expect(store.error()).toBe('Error: disk full');
    store.dispose();
  });
});
