/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { McpBundleInfo, McpStatus } from '@bridge/types';
import { claudeCodeCommandFor, claudeCodeHttpCommandFor, desktopConfigFor, httpConfigFor, McpAgentSetup } from './McpAgentSetup';
import { createSettingsStore } from './settingsStore';
import type { SettingsStore } from './settingsStore';

vi.mock('@viewport/copyText', () => ({ writeClipboard: vi.fn() }));
import { writeClipboard } from '@viewport/copyText';

const saveDialog = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...args: unknown[]) => saveDialog(...args) }));

afterEach(cleanup);

// ── pure helpers ────────────────────────────────────────────────────────────

describe('desktopConfigFor', () => {
  it('escapes backslashes via JSON.stringify so Claude Desktop reads a valid path', () => {
    const json = desktopConfigFor('C:\\Program Files\\LogTapper\\logtapper-mcp.exe');
    expect(JSON.parse(json)).toEqual({
      mcpServers: { logtapper: { command: 'C:\\Program Files\\LogTapper\\logtapper-mcp.exe' } },
    });
    expect(json).toContain('\\\\');
  });
});

describe('claudeCodeHttpCommandFor / httpConfigFor', () => {
  it('produces the http-transport add command at user scope', () => {
    expect(claudeCodeHttpCommandFor('http://127.0.0.1:40405/mcp')).toBe(
      'claude mcp add --transport http --scope user logtapper http://127.0.0.1:40405/mcp',
    );
  });
  it('produces an mcpServers block keyed by url', () => {
    expect(JSON.parse(httpConfigFor('http://127.0.0.1:40405/mcp'))).toEqual({ mcpServers: { logtapper: { url: 'http://127.0.0.1:40405/mcp' } } });
  });
});

describe('claudeCodeCommandFor', () => {
  it('quotes the path for the shell', () => {
    expect(claudeCodeCommandFor('/usr/local/bin/logtapper-mcp')).toBe(
      'claude mcp add logtapper --scope user -- "/usr/local/bin/logtapper-mcp"',
    );
  });
});

// ── component: rendered as a hand-built store double ────────────────────────

function fakeStore(overrides: {
  resolved?: boolean;
  sidecarPath?: string | null;
  httpEndpoint?: string | null;
  httpError?: string | null;
  httpPort?: number;
  bridgeRunning?: boolean;
  bundle?: McpBundleInfo | null;
  setMcpHttpPort?: (port: number) => Promise<void>;
  installMcpBundle?: () => Promise<void>;
  saveMcpBundle?: (dest: string) => Promise<void>;
} = {}): SettingsStore {
  const [resolved] = createSignal(overrides.resolved ?? true);
  const [sidecarPath] = createSignal(overrides.sidecarPath === undefined ? '/opt/logtapper/logtapper-mcp' : overrides.sidecarPath);
  const [bundle] = createSignal<McpBundleInfo | null>(overrides.bundle === undefined ? { path: '/opt/logtapper/logtapper.mcpb', installable: true } : overrides.bundle);
  const [httpEndpoint] = createSignal(overrides.httpEndpoint === undefined ? 'http://127.0.0.1:40405/mcp' : overrides.httpEndpoint);
  const [status] = createSignal<McpStatus | null>(overrides.bridgeRunning ? ({ running: true } as McpStatus) : null);
  const [httpError] = createSignal<string | null>(overrides.httpError ?? null);
  const [httpPort] = createSignal(overrides.httpPort ?? 40405);
  return {
    mcpAgentResolved: resolved,
    mcpSidecarPath: sidecarPath,
    mcpHttpEndpoint: httpEndpoint,
    mcpHttpError: httpError,
    mcpHttpPort: httpPort,
    setMcpHttpPort: vi.fn(overrides.setMcpHttpPort ?? (() => Promise.resolve())),
    mcpStatus: status,
    mcpBundleInfo: bundle,
    refreshMcpAgentSetup: vi.fn(),
    installMcpBundle: vi.fn(overrides.installMcpBundle ?? (() => Promise.resolve())),
    saveMcpBundle: vi.fn(overrides.saveMcpBundle ?? (() => Promise.resolve())),
    error: () => null,
    clearError: vi.fn(),
  } as unknown as SettingsStore;
}

describe('McpAgentSetup', () => {
  beforeEach(() => {
    saveDialog.mockReset();
    vi.mocked(writeClipboard).mockClear();
  });

  it('renders nothing until the store resolves the sidecar/bundle reads', () => {
    render(() => <McpAgentSetup store={fakeStore({ resolved: false })} />);
    expect(screen.queryByTestId('mcp-agent-setup')).toBeNull();
  });

  it('calls refreshMcpAgentSetup on mount', () => {
    const store = fakeStore();
    render(() => <McpAgentSetup store={store} />);
    expect(store.refreshMcpAgentSetup).toHaveBeenCalledTimes(1);
  });

  it('renders the Claude Desktop install button only when the bundle is installable', () => {
    render(() => <McpAgentSetup store={fakeStore({ bundle: { path: 'x', installable: false } })} />);
    expect(screen.queryByText('Install extension')).toBeNull();
    expect(screen.getByText('Save bundle…')).toBeTruthy();
  });

  it('renders the no-sidecar hint when neither the endpoint nor the sidecar exists (source checkout)', () => {
    render(() => <McpAgentSetup store={fakeStore({ sidecarPath: null, httpEndpoint: null })} />);
    expect(screen.getByText(/No bundled server binary found/)).toBeTruthy();
    expect(screen.queryByText('Copy path')).toBeNull();
    expect(screen.queryByText('Copy URL')).toBeNull();
  });

  it('tells the user to enable the bridge when the sidecar exists but the endpoint is down', () => {
    render(() => <McpAgentSetup store={fakeStore({ httpEndpoint: null })} />);
    expect(screen.getByText(/Enable the MCP bridge above/)).toBeTruthy();
    expect(screen.queryByText('Copy URL')).toBeNull();
    expect(screen.getByText('Copy path')).toBeTruthy();
  });

  it('shows "starting" while the bridge is on and no endpoint or error has been reported yet', () => {
    render(() => <McpAgentSetup store={fakeStore({ httpEndpoint: null, bridgeRunning: true })} />);
    expect(screen.getByText(/Starting the MCP server/)).toBeTruthy();
    expect(screen.queryByText(/Enable the MCP bridge above/)).toBeNull();
  });

  it('shows the backend reason verbatim when the last start failed', () => {
    render(() => <McpAgentSetup store={fakeStore({ httpEndpoint: null, bridgeRunning: true, httpError: 'cannot listen on 127.0.0.1:40405: EADDRINUSE' })} />);
    expect(screen.getByText(/did not start: cannot listen on 127.0.0.1:40405: EADDRINUSE/)).toBeTruthy();
  });

  it('tells Claude Desktop users to update the extension setting only when the port is not the default', () => {
    render(() => <McpAgentSetup store={fakeStore({ httpPort: 40405 })} />);
    expect(screen.queryByText(/LogTapper MCP URL/)).toBeNull();
    cleanup();
    render(() => <McpAgentSetup store={fakeStore({ httpPort: 41000, httpEndpoint: 'http://127.0.0.1:41000/mcp' })} />);
    expect(screen.getByText(/open the LogTapper extension/)).toBeTruthy();
  });

  it('port editor: Apply is disabled until the draft is a different valid number, then calls setMcpHttpPort', () => {
    const store = fakeStore({ httpPort: 40405 });
    render(() => <McpAgentSetup store={store} />);
    const apply = screen.getByText('Apply port') as HTMLButtonElement;
    const input = screen.getByLabelText('Port') as HTMLInputElement;
    expect(input.value).toBe('40405');
    expect(apply.disabled).toBe(true);
    fireEvent.input(input, { target: { value: '41000' } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(store.setMcpHttpPort).toHaveBeenCalledWith(41000);
    fireEvent.input(input, { target: { value: 'abc' } });
    expect(apply.disabled).toBe(true);
  });

  it('port editor: a rejected port change is swallowed here (the store renders it) and does not throw', async () => {
    const store = fakeStore({ setMcpHttpPort: () => Promise.reject(new Error('Port 80 is privileged')) });
    render(() => <McpAgentSetup store={store} />);
    fireEvent.input(screen.getByLabelText('Port'), { target: { value: '80' } });
    fireEvent.click(screen.getByText('Apply port'));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.setMcpHttpPort).toHaveBeenCalledWith(80);
  });

  it('copy URL writes the endpoint, and the HTTP buttons write the URL-based command and config', () => {
    render(() => <McpAgentSetup store={fakeStore()} />);
    fireEvent.click(screen.getByText('Copy URL'));
    expect(writeClipboard).toHaveBeenLastCalledWith('http://127.0.0.1:40405/mcp');
    fireEvent.click(screen.getByText('Copy claude mcp add command'));
    expect(writeClipboard).toHaveBeenLastCalledWith(claudeCodeHttpCommandFor('http://127.0.0.1:40405/mcp'));
    fireEvent.click(screen.getByText('Copy JSON config'));
    expect(writeClipboard).toHaveBeenLastCalledWith(httpConfigFor('http://127.0.0.1:40405/mcp'));
  });

  it('still renders the HTTP and by-path blocks when the Desktop bundle is absent (one allSettled leg missing)', () => {
    render(() => <McpAgentSetup store={fakeStore({ bundle: null })} />);
    expect(screen.queryByText('Claude Desktop')).toBeNull();
    expect(screen.getByText('Any MCP client (HTTP)')).toBeTruthy();
    expect(screen.getByText('Launch by path (stdio)')).toBeTruthy();
    expect(screen.getByText('/opt/logtapper/logtapper-mcp')).toBeTruthy();
  });

  it('copy path writes the raw path and flips to "Copied" for 1.5s, then reverts', () => {
    vi.useFakeTimers();
    try {
      render(() => <McpAgentSetup store={fakeStore()} />);
      fireEvent.click(screen.getByText('Copy path'));
      expect(writeClipboard).toHaveBeenCalledWith('/opt/logtapper/logtapper-mcp');
      expect(screen.getByText('Copied')).toBeTruthy();
      vi.advanceTimersByTime(1499);
      expect(screen.getByText('Copied')).toBeTruthy();
      vi.advanceTimersByTime(1);
      expect(screen.getByText('Copy path')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('copy claude mcp add command (by path) writes the stdio shell command', () => {
    render(() => <McpAgentSetup store={fakeStore()} />);
    fireEvent.click(screen.getByText('Copy claude mcp add command (by path)'));
    expect(writeClipboard).toHaveBeenCalledWith(claudeCodeCommandFor('/opt/logtapper/logtapper-mcp'));
  });

  it('copy JSON config (by path) writes the command-based config block', () => {
    render(() => <McpAgentSetup store={fakeStore()} />);
    fireEvent.click(screen.getByText('Copy JSON config (by path)'));
    expect(writeClipboard).toHaveBeenCalledWith(desktopConfigFor('/opt/logtapper/logtapper-mcp'));
  });

  it('save bundle: a cancelled dialog (undefined result) is a no-op — saveMcpBundle is never called', async () => {
    saveDialog.mockResolvedValue(undefined);
    const store = fakeStore();
    render(() => <McpAgentSetup store={store} />);
    fireEvent.click(screen.getByText('Save bundle…'));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.saveMcpBundle).not.toHaveBeenCalled();
  });

  it('save bundle: a chosen destination calls store.saveMcpBundle and shows a success note that clears after ~6s', async () => {
    vi.useFakeTimers();
    try {
      saveDialog.mockResolvedValue('C:\\out\\logtapper.mcpb');
      const store = fakeStore();
      render(() => <McpAgentSetup store={store} />);
      fireEvent.click(screen.getByText('Save bundle…'));
      await vi.waitFor(() => expect(store.saveMcpBundle).toHaveBeenCalledWith('C:\\out\\logtapper.mcpb'));
      await vi.waitFor(() => expect(screen.getByText(/Saved to C:\\out\\logtapper\.mcpb/)).toBeTruthy());
      await vi.advanceTimersByTimeAsync(6000);
      expect(screen.queryByText(/Saved to/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('install failure reaches the store error channel via the real store, not a local String(e) note', async () => {
    const openMcpBundle = vi.fn(() => Promise.reject(new Error('install failed')));
    const store = createSettingsStore({
      mcpStatus: () => null,
      commands: { openMcpBundle, getMcpSidecarPath: () => Promise.resolve('/opt/logtapper-mcp'), getMcpBundlePath: () => Promise.resolve({ path: 'x', installable: true }) },
    });
    render(() => <McpAgentSetup store={store} />);
    await vi.waitFor(() => expect(screen.getByText('Install extension')).toBeTruthy());
    fireEvent.click(screen.getByText('Install extension'));
    await vi.waitFor(() => expect(store.error()).toBe('Error: install failed'));
    expect(screen.queryByText('install failed', { exact: false })).toBeNull();
    store.dispose();
  });

  it('save failure reaches the store error channel', async () => {
    saveDialog.mockResolvedValue('/tmp/out.mcpb');
    const saveMcpBundle = vi.fn(() => Promise.reject(new Error('disk full')));
    const store = createSettingsStore({
      mcpStatus: () => null,
      commands: { saveMcpBundle, getMcpSidecarPath: () => Promise.resolve('/opt/logtapper-mcp'), getMcpBundlePath: () => Promise.resolve({ path: 'x', installable: false }) },
    });
    render(() => <McpAgentSetup store={store} />);
    await vi.waitFor(() => expect(screen.getByText('Save bundle…')).toBeTruthy());
    fireEvent.click(screen.getByText('Save bundle…'));
    await vi.waitFor(() => expect(store.error()).toBe('Error: disk full'));
    store.dispose();
  });
});
