/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@solidjs/testing-library';
import { App } from './App';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
// A2 added the presence store to App, which fetches bridge status, the
// activity journal, the focus context and the session list on construction —
// all must be stubbed, or the module mock throws on the missing export.
// E1 added the editor tab, which reads text files.
// W0b added the session store and action surface: both reach the bridge
// (`set_focused_session` on focus, `close_session` on a tab close) and both
// subscribe to the four session/indexing events mocked below.
vi.mock('@bridge/commands', () => ({
  getLines: vi.fn(),
  loadLogFile: vi.fn(),
  closeSession: vi.fn(() => Promise.resolve()),
  setFocusedSession: vi.fn(() => Promise.resolve()),
  readTextFile: vi.fn(),
  getMcpStatus: vi.fn(() => Promise.resolve({ running: false, port: 0, idleSecs: null, agentRawAccess: false })),
  getActivity: vi.fn(() => Promise.resolve([])),
  getFocus: vi.fn(() => Promise.resolve(null)),
  setFocus: vi.fn(() => Promise.resolve(null)),
  getExportAllSessionsInfo: vi.fn(() =>
    Promise.resolve({ sessions: [], totalProcessorCount: 0, totalPipelineProcessorCount: 0 }),
  ),
}));
vi.mock('@bridge/events', () => ({
  onActivity: vi.fn(() => Promise.resolve(() => {})),
  onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
  onNavigateRequest: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionOpened: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionClosed: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexProgress: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexComplete: vi.fn(() => Promise.resolve(() => {})),
}));

// vitest `globals` is off, so @solidjs/testing-library's auto-cleanup never
// registers — unmount explicitly or renders stack up across tests.
afterEach(cleanup);

describe('App', () => {
  // The scaffold heading was replaced by the viewer shell in P3; the open-file
  // button is the stable landmark.
  it('renders the open-file button', () => {
    render(() => <App />);
    expect(screen.getByRole('button', { name: /open file/i })).toBeTruthy();
  });

  it('shows the empty state until a file is opened', () => {
    render(() => <App />);
    expect(screen.getByText(/no log open/i)).toBeTruthy();
  });
});
