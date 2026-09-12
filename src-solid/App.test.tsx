/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { App } from './App';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
// A2 added the presence store to App, which fetches bridge status, the
// activity journal, the focus context and the session list on construction —
// all must be stubbed, or the module mock throws on the missing export.
// E1 added the editor tab, which reads text files.
// W0b added the session store and action surface: both reach the bridge
// (`set_focused_session` on focus, `close_session` on a tab close) and both
// subscribe to the four session/indexing events mocked below.
// W3 added the sections store, which fetches section/dumpstate metadata for
// the focused session when it is bugreport-like — stubbed even though no test
// here opens one, so the module import itself never sees an undefined export.
// W4a/W4b added the analyzer store, which fetches the processor/pack catalog
// on construction and subscribes to pipeline progress.
// W6 added the analyses store, which lists analyses and subscribes to
// `analysis-update` on construction.
// W5 added the device state store, which fetches a tracker's snapshot/
// transitions once a cursor exists and a tracker is active — stubbed even
// though no test here opens a session with an active tracker.
// W7 added the bookmarks store, which fetches a session's bookmarks the
// first time it is focused and subscribes to `bookmark-update`.
// W1b added the workspace store, which reads `app-state.json` and the CLI
// startup file on construction, subscribes to the three `workspace-*` list/
// content events, and drives open/save/switch/rename/delete over v4 commands.
// W8 added the export and settings stores. Neither fetches anything at
// construction (their commands only run once their drawer panel mounts,
// via `onMount`), but every command each store's `DEFAULT_COMMANDS` object
// references must still exist on the mock, or that key resolves to
// `undefined` — harmless today (no test opens those drawers) but stubbed
// anyway so the module's shape stays honest as more tests are added.
// W9 added the editor tabs store, which defaults to the same `readTextFile`/
// `writeTextFile` commands the removed E1 demo used (`open`/`save` are not
// called at construction, only from user actions neither test here triggers).
vi.mock('@bridge/commands', () => ({
  getLines: vi.fn(),
  loadLogFile: vi.fn(),
  closeSession: vi.fn(() => Promise.resolve()),
  setFocusedSession: vi.fn(() => Promise.resolve()),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(() => Promise.resolve()),
  getSections: vi.fn(() => Promise.resolve([])),
  getDumpstateMetadata: vi.fn(() => Promise.resolve(null)),
  getMcpStatus: vi.fn(() => Promise.resolve({ running: false, port: 0, idleSecs: null, agentRawAccess: false })),
  getActivity: vi.fn(() => Promise.resolve([])),
  getFocus: vi.fn(() => Promise.resolve(null)),
  setFocus: vi.fn(() => Promise.resolve(null)),
  getExportAllSessionsInfo: vi.fn(() =>
    Promise.resolve({ sessions: [], totalProcessorCount: 0, totalPipelineProcessorCount: 0 }),
  ),
  exportAllSessions: vi.fn(() => Promise.resolve()),
  listProcessors: vi.fn(() => Promise.resolve([])),
  listPacks: vi.fn(() => Promise.resolve([])),
  loadProcessorFromFile: vi.fn(),
  uninstallProcessor: vi.fn(() => Promise.resolve()),
  setSessionPipelineMeta: vi.fn(() => Promise.resolve()),
  runPipeline: vi.fn(),
  stopPipeline: vi.fn(() => Promise.resolve()),
  getMatchedLines: vi.fn(() => Promise.resolve([])),
  getCorrelatorEvents: vi.fn(() => Promise.resolve({ guidance: null, events: [] })),
  getProcessorVars: vi.fn(() => Promise.resolve({})),
  listAnalyses: vi.fn(() => Promise.resolve([])),
  getAnalysis: vi.fn(),
  publishAnalysis: vi.fn(),
  updateAnalysis: vi.fn(),
  deleteAnalysis: vi.fn(),
  getStateAtLine: vi.fn(),
  getStateTransitions: vi.fn(() => Promise.resolve([])),
  listBookmarks: vi.fn(() => Promise.resolve([])),
  createBookmark: vi.fn(),
  updateBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  getAppState: vi.fn(() => Promise.resolve({ workspaces: [], activeWorkspaceId: null })),
  saveAppState: vi.fn(() => Promise.resolve()),
  getStartupFile: vi.fn(() => Promise.resolve(null)),
  loadWorkspaceV4: vi.fn(),
  saveWorkspaceV4: vi.fn(),
  autoSaveWorkspace: vi.fn(),
  beginWorkspaceSwitch: vi.fn(() => Promise.resolve()),
  renameWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
  restoreWorkspaceSession: vi.fn(() => Promise.resolve()),
  getAnonymizerConfig: vi.fn(() => Promise.resolve({ detectors: [] })),
  setAnonymizerConfig: vi.fn(() => Promise.resolve()),
  testAnonymizer: vi.fn(() => Promise.resolve({ anonymized: '', replacements: [] })),
  getPiiMappings: vi.fn(() => Promise.resolve({})),
  getFileAssociationStatus: vi.fn(() => Promise.resolve([])),
  setFileAssociation: vi.fn(() => Promise.resolve()),
  openDefaultAppsSettings: vi.fn(() => Promise.resolve()),
  getMcpOpenAllowlist: vi.fn(() => Promise.resolve({ allowedDirs: [], allowAll: false })),
  setMcpOpenAllowlist: vi.fn(() => Promise.resolve()),
  setAgentRawAccess: vi.fn(() => Promise.resolve()),
  startMcpBridge: vi.fn(() => Promise.resolve()),
  stopMcpBridge: vi.fn(() => Promise.resolve()),
  listThemes: vi.fn(() => Promise.resolve([])),
  readTheme: vi.fn(),
  writeTheme: vi.fn(() => Promise.resolve()),
  deleteTheme: vi.fn(() => Promise.resolve()),
  listSources: vi.fn(() => Promise.resolve([])),
  addSource: vi.fn(() => Promise.resolve()),
  removeSource: vi.fn(() => Promise.resolve()),
}));
vi.mock('@bridge/events', () => ({
  onActivity: vi.fn(() => Promise.resolve(() => {})),
  onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
  onNavigateRequest: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionOpened: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionClosed: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexProgress: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexComplete: vi.fn(() => Promise.resolve(() => {})),
  onPipelineProgress: vi.fn(() => Promise.resolve(() => {})),
  onAnalysisUpdate: vi.fn(() => Promise.resolve(() => {})),
  onBookmarkUpdate: vi.fn(() => Promise.resolve(() => {})),
  onWorkspaceListChanged: vi.fn(() => Promise.resolve(() => {})),
  onWorkspaceAutoSaved: vi.fn(() => Promise.resolve(() => {})),
  onWorkspaceRestored: vi.fn(() => Promise.resolve(() => {})),
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

  it('reaches the editor surface from the top bar before any document exists', () => {
    render(() => <App />);
    expect(screen.queryByTestId('editor-tabs')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /new document/i }));
    expect(screen.getByTestId('editor-tabs')).toBeTruthy();
    expect(screen.queryByText(/no log open/i)).toBeNull();
  });

  it('shows the empty state until a file is opened', () => {
    render(() => <App />);
    expect(screen.getByText(/no log open/i)).toBeTruthy();
  });
});
