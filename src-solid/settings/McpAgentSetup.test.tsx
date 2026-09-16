/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { McpBundleInfo } from '@bridge/types';
import { claudeCodeCommandFor, desktopConfigFor, McpAgentSetup } from './McpAgentSetup';
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
  bundle?: McpBundleInfo | null;
  installMcpBundle?: () => Promise<void>;
  saveMcpBundle?: (dest: string) => Promise<void>;
} = {}): SettingsStore {
  const [resolved] = createSignal(overrides.resolved ?? true);
  const [sidecarPath] = createSignal(overrides.sidecarPath === undefined ? '/opt/logtapper/logtapper-mcp' : overrides.sidecarPath);
  const [bundle] = createSignal<McpBundleInfo | null>(overrides.bundle === undefined ? { path: '/opt/logtapper/logtapper.mcpb', installable: true } : overrides.bundle);
  return {
    mcpAgentResolved: resolved,
    mcpSidecarPath: sidecarPath,
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

  it('renders the no-sidecar hint when the sidecar path is null (source checkout)', () => {
    render(() => <McpAgentSetup store={fakeStore({ sidecarPath: null })} />);
    expect(screen.getByText(/No bundled server binary found/)).toBeTruthy();
    expect(screen.queryByText('Copy path')).toBeNull();
  });

  it('still renders the Claude Code block when the Desktop bundle is absent (one allSettled leg missing)', () => {
    render(() => <McpAgentSetup store={fakeStore({ bundle: null })} />);
    expect(screen.queryByText('Claude Desktop')).toBeNull();
    expect(screen.getByText('Claude Code')).toBeTruthy();
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

  it('copy claude mcp add command writes the shell command', () => {
    render(() => <McpAgentSetup store={fakeStore()} />);
    fireEvent.click(screen.getByText('Copy claude mcp add command'));
    expect(writeClipboard).toHaveBeenCalledWith(claudeCodeCommandFor('/opt/logtapper/logtapper-mcp'));
  });

  it('copy JSON config writes the desktop config block', () => {
    render(() => <McpAgentSetup store={fakeStore()} />);
    fireEvent.click(screen.getByText('Copy JSON config'));
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
