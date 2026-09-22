/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { App } from './App';
import type { LoadResult } from '@bridge/types';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
// F1: the `catalog-update` test below needs to see the PUBLIC `refreshCatalog`
// / `refreshInstalled` calls App makes on the real stores — not the
// construction-time seeds each store fires through its own closure — so the
// two factories are wrapped to count calls on the returned object's method.
// Everything else in both barrels is the real module.
const refreshSpies = vi.hoisted(() => ({ refreshCatalog: vi.fn(), refreshInstalled: vi.fn() }));
vi.mock('./analyzers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./analyzers')>();
  return {
    ...mod,
    createAnalyzerStore: (deps: Parameters<typeof mod.createAnalyzerStore>[0]) => {
      const store = mod.createAnalyzerStore(deps);
      const original = store.refreshCatalog;
      store.refreshCatalog = () => {
        refreshSpies.refreshCatalog();
        return original();
      };
      return store;
    },
  };
});
vi.mock('./packs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./packs')>();
  return {
    ...mod,
    createPacksStore: (deps: Parameters<typeof mod.createPacksStore>[0]) => {
      const store = mod.createPacksStore(deps);
      const original = store.refreshInstalled;
      store.refreshInstalled = () => {
        refreshSpies.refreshInstalled();
        return original();
      };
      return store;
    },
  };
});
// Review A-M8: `hydrate().then(startupRestore)` used to run in the render body
// with no rejection handler, so a restore that failed past `hydrate`'s own
// `getAppState` catch became an unhandled rejection the user never saw. The
// store is wrapped (not replaced) so every other test in this file keeps the
// real one; only a test that sets `hydrateError` gets a rejecting `hydrate`.
const workspaceHooks = vi.hoisted(() => ({ hydrateError: null as Error | null }));
vi.mock('./workspace', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./workspace')>();
  return {
    ...mod,
    createWorkspaceStore: (deps: Parameters<typeof mod.createWorkspaceStore>[0]) => {
      const store = mod.createWorkspaceStore(deps);
      const original = store.hydrate;
      store.hydrate = () =>
        workspaceHooks.hydrateError
          ? Promise.reject(workspaceHooks.hydrateError)
          : original.call(store);
      return store;
    },
  };
});
// The shell now renders `WindowControls`, which calls `getCurrentWindow()` from
// `@tauri-apps/api/window` — that throws outside a Tauri webview, so stub it.
// Every method returns a resolved promise; `isMaximized` reports false so the
// middle control renders as "Maximize".
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onResized: vi.fn(() => Promise.resolve(() => {})),
  }),
}));
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
  // S1 mounts a QueryBar per open pane, which needs the filter/search commands
  // even though no test here drives either mode's inputs.
  createFilter: vi.fn(),
  getFilteredLines: vi.fn(),
  cancelFilter: vi.fn(() => Promise.resolve()),
  closeFilter: vi.fn(() => Promise.resolve()),
  searchLogs: vi.fn(),
  setFocusedSession: vi.fn(() => Promise.resolve()),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(() => Promise.resolve()),
  getSections: vi.fn(() => Promise.resolve([])),
  getDumpstateMetadata: vi.fn(() => Promise.resolve(null)),
  getMcpStatus: vi.fn(() => Promise.resolve({ running: false, port: 0, idleSecs: null, agentRawAccess: false, anonymizerMode: 'external', effectiveAgentRaw: false })),
  getAppUpdatePolicy: vi.fn(() => Promise.resolve({ managedBy: null, needsElevation: false })),
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
  getSessionChain: vi.fn((sessionId: string) => Promise.resolve({ sessionId, activeProcessorIds: [], disabledProcessorIds: [] })),
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
  renderAnalysisMarkdown: vi.fn(() => Promise.resolve('')),
  exportAnalysisMarkdown: vi.fn(() => Promise.resolve()),
  getStateAtLine: vi.fn(),
  getStateTransitions: vi.fn(() => Promise.resolve([])),
  listBookmarks: vi.fn(() => Promise.resolve([])),
  createBookmark: vi.fn(),
  updateBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  listWatches: vi.fn(() => Promise.resolve([])),
  createWatch: vi.fn(),
  cancelWatch: vi.fn(() => Promise.resolve()),
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
  getAnonymizerConfig: vi.fn(() => Promise.resolve({ detectors: [], mode: 'external' })),
  setAnonymizerConfig: vi.fn(() => Promise.resolve()),
  anonymizeText: vi.fn((_sessionId: string, text: string) => Promise.resolve(text)),
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
  // P1 added the packs store, which fetches installed packs/processors
  // (`listPacks`/`listProcessors` above) immediately at construction and
  // calls the rest of these only from a Packs-tab action no test here
  // triggers — stubbed anyway so `defaultCommands` never resolves an
  // undefined key.
  fetchMarketplace: vi.fn(() => Promise.resolve({ processors: [], packs: [] })),
  installFromMarketplace: vi.fn(),
  installPackFromMarketplace: vi.fn(),
  uninstallPackFromMarketplace: vi.fn(() => Promise.resolve()),
  checkUpdates: vi.fn(() => Promise.resolve({ updates: [], packUpdates: [], errors: [] })),
  getPendingUpdates: vi.fn(() => Promise.resolve([])),
  getPendingPackUpdates: vi.fn(() => Promise.resolve([])),
  updateProcessor: vi.fn(),
  updateAllFromSource: vi.fn(() => Promise.resolve([])),
  saveSourcesToDisk: vi.fn(() => Promise.resolve()),
}));
vi.mock('@bridge/events', () => ({
  onActivity: vi.fn(() => Promise.resolve(() => {})),
  onAgentRequest: vi.fn(() => Promise.resolve(() => {})),
  onLtsEditorTabs: vi.fn(() => Promise.resolve(() => {})),
  onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
  onNavigateRequest: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionOpened: vi.fn(() => Promise.resolve(() => {})),
  onBridgeSessionClosed: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexProgress: vi.fn(() => Promise.resolve(() => {})),
  onFileIndexComplete: vi.fn(() => Promise.resolve(() => {})),
  onFilterProgress: vi.fn(() => Promise.resolve(() => {})),
  onSearchProgress: vi.fn(() => Promise.resolve(() => {})),
  onPipelineProgress: vi.fn(() => Promise.resolve(() => {})),
  onPipelineComplete: vi.fn(() => Promise.resolve(() => {})),
  onChainUpdate: vi.fn(() => Promise.resolve(() => {})),
  onCatalogUpdate: vi.fn(() => Promise.resolve(() => {})),
  onUpdatesAvailable: vi.fn(() => Promise.resolve(() => {})),
  onAnalysisUpdate: vi.fn(() => Promise.resolve(() => {})),
  onBookmarkUpdate: vi.fn(() => Promise.resolve(() => {})),
  onWatchMatch: vi.fn(() => Promise.resolve(() => {})),
  onWatchUpdate: vi.fn(() => Promise.resolve(() => {})),
  onWorkspaceListChanged: vi.fn(() => Promise.resolve(() => {})),
  onWorkspaceAutoSaved: vi.fn(() => Promise.resolve(() => {})),
  onWorkspaceRestored: vi.fn(() => Promise.resolve(() => {})),
  onAdbTrackerUpdate: vi.fn(() => Promise.resolve(() => {})),
}));

// Nothing resets the module mocks between tests, so `toHaveBeenCalledTimes`
// counts carried over from whichever test ran before — three tests in this
// file had grown their own ad hoc clears to cope. Clear calls (not
// implementations: the factory-set defaults above must survive) before each.
beforeEach(() => vi.clearAllMocks());

// vitest `globals` is off, so @solidjs/testing-library's auto-cleanup never
// registers — unmount explicitly or renders stack up across tests.
afterEach(cleanup);

const originalInnerWidth = window.innerWidth;
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
});

describe('App', () => {
  // The scaffold heading was replaced by the viewer shell in P3; the open-file
  // button is the stable landmark.
  // Scoped to the top bar: with no session open, the shell now lands on
  // workspace home (A1's first-run actions), and that panel has its own
  // "Open file…" button in its header. Both are real and both should exist —
  // this test is about the persistent top-bar one, so it says so rather than
  // matching whichever the query happens to reach first.
  it('renders the open-file button', () => {
    render(() => <App />);
    const topBar = within(screen.getByTestId('top-bar'));
    expect(topBar.getByRole('button', { name: /open file/i })).toBeTruthy();
  });

  it('reaches the editor surface from the top bar before any document exists', () => {
    render(() => <App />);
    expect(screen.queryByTestId('editor-tabs')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /new document/i }));
    expect(screen.getByTestId('editor-tabs')).toBeTruthy();
    expect(screen.queryByText(/no log open/i)).toBeNull();
  });

  // Phase 2c's acceptance criterion: opening with nothing loaded must offer
  // attach-a-device and open-a-capture. A1 built both on workspace-home, but
  // that is a rail surface and the shell's drawer starts closed, so a cold
  // start showed only "No log open" and the actions sat behind a glyph. The
  // live smoke confirmed it before this was wired. Asserting the first-run
  // block is REACHABLE ON MOUNT is the point — not that it exists somewhere.
  it('lands on workspace home when nothing is open, so first-run actions are visible (A1)', () => {
    render(() => <App />);
    expect(screen.getByTestId('workspace-first-run')).toBeTruthy();
    expect(screen.getByTestId('attach-device-toggle')).toBeTruthy();
    expect(screen.getByTestId('sessions-empty-open-file')).toBeTruthy();
  });

  // A failure used to be clearable ONLY by starting another open, so a startup
  // restore that could not reach a file (a workspace naming a path on an
  // unmounted drive) parked its message in the top bar for the rest of the
  // session, sitting there beside a healthy running capture. Reported from the
  // running app. The dismiss control is what makes a failure an event rather
  // than permanent state.
  it('lets the user dismiss a failure from the top bar', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { loadLogFile } = await import('@bridge/commands');

    vi.mocked(open).mockReset();
    vi.mocked(loadLogFile).mockReset();
    vi.mocked(open).mockResolvedValueOnce('/gone.log');
    vi.mocked(loadLogFile).mockRejectedValueOnce(new Error('drive not mounted'));

    render(() => <App />);
    fireEvent.click(within(screen.getByTestId('top-bar')).getByRole('button', { name: /^open file/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('drive not mounted');

    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));

    expect(screen.queryByRole('alert')).toBeNull();
  });

  // The session line, the loading indicator and the error all used to sit in
  // the top bar beside the action buttons. The user asked for them in the
  // footer: they are state, not actions. This pins WHERE they render, not just
  // that they render, so a later refactor cannot quietly move them back.
  it('reports the focused session in the footer, not the top bar', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { getLines, loadLogFile } = await import('@bridge/commands');

    vi.mocked(open).mockReset();
    vi.mocked(loadLogFile).mockReset();
    vi.mocked(open).mockResolvedValueOnce('/status.log');
    vi.mocked(loadLogFile).mockResolvedValueOnce([
      {
        sessionId: '/status.log',
        sourceId: '/status.log',
        sourceName: 'status.log',
        filePath: '/status.log',
        totalLines: 4321,
        fileSize: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        sourceType: 'Logcat',
        isStreaming: false,
        isIndexing: false,
        hasCrlf: false,
        encoding: 'UTF-8',
      },
    ]);
    vi.mocked(getLines).mockResolvedValue({ lines: [], totalLines: 4321 } as never);

    render(() => <App />);
    fireEvent.click(within(screen.getByTestId('top-bar')).getByRole('button', { name: /^open file/i }));

    const status = await screen.findByTestId('status-session');
    expect(status.textContent).toContain('status.log');
    expect(status.textContent).toContain('4,321 lines');

    // In the footer…
    expect(screen.getByRole('contentinfo').contains(status)).toBe(true);
    // …and nowhere in the top bar.
    expect(within(screen.getByTestId('top-bar')).queryByText(/4,321 lines/)).toBeNull();
  });

  it('mounts the bookmarks panel inside the workspace drawer, not as a navigator surface', () => {
    render(() => <App />);
    // Cold start with no session opens the workspace drawer (2c first-run fix).
    const panel = screen.getByTestId('bookmarks-panel');
    expect(screen.getByTestId('workspace-bookmarks').contains(panel)).toBe(true);
    expect(within(screen.getByTestId('top-bar')).queryByRole('button', { name: /^file info/i })).toBeNull();
  });

  it('the footer chip owns the session-info popover state that the sections "File info…" button shares', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { getLines, loadLogFile } = await import('@bridge/commands');

    vi.mocked(open).mockReset();
    vi.mocked(loadLogFile).mockReset();
    vi.mocked(open).mockResolvedValueOnce('/info.log');
    vi.mocked(loadLogFile).mockResolvedValueOnce([
      {
        sessionId: '/info.log',
        sourceId: '/info.log',
        sourceName: 'info.log',
        filePath: '/info.log',
        totalLines: 12,
        fileSize: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        sourceType: 'Logcat',
        isStreaming: false,
        isIndexing: false,
        hasCrlf: false,
        encoding: 'UTF-8',
      },
    ]);
    vi.mocked(getLines).mockResolvedValue({ lines: [], totalLines: 12 } as never);

    render(() => <App />);
    const topBar = within(screen.getByTestId('top-bar'));
    fireEvent.click(topBar.getByRole('button', { name: /^open file/i }));
    const chip = await screen.findByTestId('status-session');

    fireEvent.click(chip);
    expect(screen.getByTestId('session-info-popover')).toBeTruthy();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(chip);
    expect(screen.queryByTestId('session-info-popover')).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  // C2: the status-bar session chip opens a popover with a "reopen as…"
  // control that REPLACES the session at its own tab rather than opening a
  // second one — the backend id is deterministic per path, and closing first
  // would destroy the bookmarks/analyses the reopen is supposed to keep (see
  // `app/SessionInfo.tsx`'s doc comment).
  it('reopens the focused session as a different source type from the status-bar popover, without duplicating the tab', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { getLines, loadLogFile } = await import('@bridge/commands');

    vi.mocked(open).mockReset();
    vi.mocked(loadLogFile).mockReset();
    vi.mocked(open).mockResolvedValueOnce('/reopen.log');
    const session = (sourceType: string) => [
      {
        sessionId: '/reopen.log',
        sourceId: '/reopen.log',
        sourceName: 'reopen.log',
        filePath: '/reopen.log',
        totalLines: 10,
        fileSize: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        sourceType,
        isStreaming: false,
        isIndexing: false,
        hasCrlf: false,
        encoding: 'UTF-8',
      },
    ];
    vi.mocked(loadLogFile).mockResolvedValueOnce(session('Logcat'));
    vi.mocked(getLines).mockResolvedValue({ lines: [], totalLines: 10 } as never);

    render(() => <App />);
    fireEvent.click(within(screen.getByTestId('top-bar')).getByRole('button', { name: /^open file/i }));
    await screen.findByTestId('status-session');
    expect(screen.getAllByRole('tab')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('status-session'));
    // Scoped to the popover's own testid, not `role="dialog"` — workspace
    // home's own drawer (`aria-label="Workspace"`) is also a dialog and is
    // still open behind it at this point in the test.
    expect(screen.getByTestId('session-info-popover')).toBeTruthy();

    vi.mocked(loadLogFile).mockResolvedValueOnce(session('Kernel'));
    fireEvent.change(screen.getByLabelText(/reopen this file as/i), { target: { value: 'Kernel' } });

    expect(loadLogFile).toHaveBeenLastCalledWith('/reopen.log', 'Kernel');
    // Same tab — not a second one alongside it.
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1));
    // The popover closed itself on a successful reopen selection.
    expect(screen.queryByTestId('session-info-popover')).toBeNull();
  });

  it('shows the empty state until a file is opened', () => {
    render(() => <App />);
    expect(screen.getByText(/no log open/i)).toBeTruthy();
  });

  it('disables the split control below the wide tier (S1)', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true }); // compact
    render(() => <App />);
    const button = screen.getByRole('button', { name: /split view/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('splits into two panes, each bound to a different session (S1)', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { getLines, loadLogFile } = await import('@bridge/commands');

    const makeLoad = (path: string): LoadResult => ({
      sessionId: path,
      sourceId: path,
      sourceName: path,
      filePath: path,
      totalLines: 5,
      fileSize: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      sourceType: 'Logcat',
      isStreaming: false,
      isIndexing: false,
      hasCrlf: false,
      encoding: 'UTF-8',
    });

    vi.mocked(open).mockResolvedValueOnce('/a.log').mockResolvedValueOnce('/b.log');
    vi.mocked(loadLogFile).mockImplementation((path: string) => Promise.resolve([makeLoad(path)]));
    vi.mocked(getLines).mockResolvedValue({ lines: [], totalLines: 5 } as never);

    // Split view (S1) is gated to wide/ultra-wide — jsdom has no matchMedia,
    // so `createTier` reads `innerWidth`, whose jsdom default (1024) is compact.
    Object.defineProperty(window, 'innerWidth', { value: 2600, configurable: true });

    render(() => <App />);
    // Same disambiguation as above: workspace home's header carries its own
    // "Open file…" now that the first-run drawer opens on an empty start.
    const openButton = within(screen.getByTestId('top-bar')).getByRole('button', {
      name: /^open file/i,
    }) as HTMLButtonElement;

    fireEvent.click(openButton);
    await waitFor(() => expect(loadLogFile).toHaveBeenCalledTimes(1));
    // `openFileDialog` disables this button for the duration of `openPath`
    // (`actions.busy()`) — wait for it to re-enable, or the second click is a
    // no-op on a disabled element.
    await waitFor(() => expect(openButton.disabled).toBe(false));

    fireEvent.click(openButton);
    await waitFor(() => expect(loadLogFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(openButton.disabled).toBe(false));

    // Both sessions are open; '/b.log' (opened last) is focused in the
    // primary pane, so only '/a.log' is offered for the secondary.
    fireEvent.click(screen.getByRole('button', { name: /split view/i }));
    const picker = screen.getByLabelText('Secondary pane session') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value).filter(Boolean)).toEqual(['/a.log']);

    fireEvent.change(picker, { target: { value: '/a.log' } });

    const grids = screen.getAllByRole('grid');
    expect(grids).toHaveLength(2);
    expect(screen.getAllByLabelText('Secondary pane session')).toHaveLength(1);

    // The primary pane's tab strip can switch its focus to the same session
    // the secondary pane is already showing — that must clear the secondary
    // selection rather than let both panes render (and share the state of)
    // the same session.
    fireEvent.click(document.querySelector('[data-key="/a.log"]')!);

    expect(screen.getAllByRole('grid')).toHaveLength(1);
    // The split stays open — only its session selection was cleared.
    const pickerAfter = screen.getByLabelText('Secondary pane session') as HTMLSelectElement;
    expect(pickerAfter.value).toBe('');
  });

  // S1's review flagged this path as unit-tested (`splitView.handleSessionClosed`)
  // but never exercised end to end. It matters because a session can close from
  // outside this UI — an agent calling `close_session` over the MCP bridge —
  // so the clearing effect is driven by `store.order` changing, not by the tab
  // close button's own handler. Closing from the button is simply the reachable
  // way to make `order` change in a test.
  it('clears the secondary pane when its session is closed (S1)', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { getLines, loadLogFile, closeSession } = await import('@bridge/commands');

    const makeLoad = (path: string): LoadResult => ({
      sessionId: path,
      sourceId: path,
      sourceName: path,
      filePath: path,
      totalLines: 5,
      fileSize: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      sourceType: 'Logcat',
      isStreaming: false,
      isIndexing: false,
      hasCrlf: false,
      encoding: 'UTF-8',
    });

    // `globals` is off and nothing resets mocks between tests here, so call
    // counts carry over from the split test above — clear the three this test
    // asserts on rather than asserting cumulative totals.
    vi.mocked(open).mockReset();
    vi.mocked(loadLogFile).mockClear();
    vi.mocked(closeSession).mockClear();

    vi.mocked(open).mockResolvedValueOnce('/a.log').mockResolvedValueOnce('/b.log');
    vi.mocked(loadLogFile).mockImplementation((path: string) => Promise.resolve([makeLoad(path)]));
    vi.mocked(getLines).mockResolvedValue({ lines: [], totalLines: 5 } as never);

    Object.defineProperty(window, 'innerWidth', { value: 2600, configurable: true });

    render(() => <App />);
    // Same disambiguation as above: workspace home's header carries its own
    // "Open file…" now that the first-run drawer opens on an empty start.
    const openButton = within(screen.getByTestId('top-bar')).getByRole('button', {
      name: /^open file/i,
    }) as HTMLButtonElement;

    fireEvent.click(openButton);
    await waitFor(() => expect(loadLogFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(openButton.disabled).toBe(false));

    fireEvent.click(openButton);
    await waitFor(() => expect(loadLogFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(openButton.disabled).toBe(false));

    // '/b.log' is focused in the primary pane, so '/a.log' goes to the secondary.
    fireEvent.click(screen.getByRole('button', { name: /split view/i }));
    const picker = screen.getByLabelText('Secondary pane session') as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: '/a.log' } });
    expect(screen.getAllByRole('grid')).toHaveLength(2);

    // Close the session the SECONDARY pane is showing, not the focused one.
    fireEvent.click(screen.getByRole('button', { name: /close \/a\.log/i }));
    await waitFor(() => expect(closeSession).toHaveBeenCalledWith('/a.log'));

    // The secondary selection is cleared rather than left pointing at a session
    // the store can no longer resolve, and the split itself stays open.
    await waitFor(() => expect(screen.getAllByRole('grid')).toHaveLength(1));
    const pickerAfter = screen.getByLabelText('Secondary pane session') as HTMLSelectElement;
    expect(pickerAfter.value).toBe('');
    // '/a.log' is gone from the options too — it is no longer an open session.
    expect([...pickerAfter.options].map((o) => o.value).filter(Boolean)).toEqual([]);

    // The assertions above are necessary but NOT sufficient: if the clearing
    // effect were removed, the grid count and the picker value would both look
    // identical, because `App.tsx` would fall back to "That session is no
    // longer open." for the now-unresolvable id and render no second grid
    // either. These two lines are what actually separate "cleared" from
    // "stale but guarded" — the pane must show the pick-a-session placeholder,
    // never the stale-session fallback.
    expect(screen.queryByText(/no longer open/i)).toBeNull();
    expect(screen.getByText(/pick a session above/i)).toBeTruthy();
  });

  // F1: `catalog-update` is the ONE path by which an install/uninstall/update
  // — an agent's over the bridge, or this UI's own Packs tab — reaches the
  // analyzer catalog and the packs store's installed set. Both stores fetch
  // `listProcessors` + `listPacks` once at construction; after the event each
  // must have re-fetched exactly once more, so the counts separate "both
  // refreshed once" from "one refreshed twice" or "nobody listened".
  it('refreshes the analyzer catalog and the installed packs once each on catalog-update', async () => {
    const { onCatalogUpdate } = await import('@bridge/events');
    render(() => <App />);
    // Two subscribers: App's refresh wiring and `analyzerStore`'s own
    // uninstall-pruning listener (W4a). The real event reaches both, so the
    // test fires every registered handler — the refresh counts below are what
    // pin the no-double-fetch contract, not the subscriber count.
    expect(onCatalogUpdate).toHaveBeenCalledTimes(2);
    const handlers = vi.mocked(onCatalogUpdate).mock.calls.map((call) => call[0]);
    // Construction-time seeds go through each store's internal closure, not
    // the public method — so nothing has hit the spies yet.
    expect(refreshSpies.refreshCatalog).not.toHaveBeenCalled();
    expect(refreshSpies.refreshInstalled).not.toHaveBeenCalled();

    const event: Parameters<(typeof handlers)[number]>[0] = {
      caller: { kind: 'agent', client: 'claude' },
      action: 'install',
      ids: ['wifi@official'],
    };
    for (const fire of handlers) fire(event);

    expect(refreshSpies.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(refreshSpies.refreshInstalled).toHaveBeenCalledTimes(1);
  });

  // The anonymizer mode's one in-app consequence: under `All` the backend
  // redacts the Ui's own `get_lines` pages, so entering or leaving `All`
  // must throw away every open session's cached text and refetch — exactly
  // what `replace()` does for a reopen. A change between External and None
  // changes nothing the viewer shows, so it must NOT refetch.
  it('entering or leaving anonymizer mode All refetches every open session; External<->None does not', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { getLines, loadLogFile, listProcessors, setAnonymizerConfig } = await import('@bridge/commands');

    const makeLoad = (path: string): LoadResult => ({
      sessionId: path,
      sourceId: path,
      sourceName: path,
      filePath: path,
      totalLines: 5,
      fileSize: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      sourceType: 'Logcat',
      isStreaming: false,
      isIndexing: false,
      hasCrlf: false,
      encoding: 'UTF-8',
    });
    // The pinned PII card only renders when the catalog carries the anonymizer.
    vi.mocked(listProcessors).mockResolvedValue([
      {
        id: '__pii_anonymizer', name: 'PII Anonymizer', version: '1.0.0', description: '', tags: [], builtin: true,
        processorType: 'transformer', group: null, varsMeta: [], deprecated: false, hasSchema: false,
        trackerSections: [], sourceTypes: [],
      },
    ] as never);
    vi.mocked(open).mockResolvedValueOnce('/a.log').mockResolvedValueOnce('/b.log');
    vi.mocked(loadLogFile).mockImplementation((path: string) => Promise.resolve([makeLoad(path)]));
    vi.mocked(getLines).mockResolvedValue({ lines: [], totalLines: 5 } as never);
    // Wide tier: the analyzers surface is the `details` column, so the pinned
    // card is on screen next to the viewer without opening a drawer.
    Object.defineProperty(window, 'innerWidth', { value: 2600, configurable: true });
    // jsdom has no layout, so a viewer's viewport is 0 rows tall and it never
    // fetches a page — give the grid a height (as `LogViewer.test.tsx` does) so
    // a refetch is observable as a `getLines` call. Restored below.
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.getAttribute('role') === 'grid' ? 220 : 0; },
    });
    try {
      await modeSwitchScenario();
    } finally {
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }

    async function modeSwitchScenario(): Promise<void> {
      render(() => <App />);
      const openButton = within(screen.getByTestId('top-bar')).getByRole('button', { name: /^open file/i }) as HTMLButtonElement;
      fireEvent.click(openButton);
      await waitFor(() => expect(loadLogFile).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(openButton.disabled).toBe(false));
      fireEvent.click(openButton);
      await waitFor(() => expect(loadLogFile).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(openButton.disabled).toBe(false));

      // Only a mounted pane fetches (an unmounted session's cleared cache is
      // refilled the moment it is shown), so put both sessions on screen: the
      // split's secondary pane shows '/a.log' beside the focused '/b.log'.
      fireEvent.click(screen.getByRole('button', { name: /split view/i }));
      fireEvent.change(screen.getByLabelText('Secondary pane session'), { target: { value: '/a.log' } });
      expect(screen.getAllByRole('grid')).toHaveLength(2);
      await waitFor(() => expect(vi.mocked(getLines).mock.calls.some(([req]) => (req as { sessionId: string }).sessionId === '/a.log')).toBe(true));

      const radios = await screen.findAllByRole('radio');
      expect(radios.map((r) => r.textContent)).toEqual(['All', 'External', 'None']);
      // The control ignores a selection while its previous write is settling.
      const settled = () => waitFor(() => expect(screen.getByRole('radiogroup').getAttribute('aria-busy')).toBeNull());
      const sessionsFetched = (since: number): string[] =>
        [...new Set(vi.mocked(getLines).mock.calls.slice(since).map(([req]) => (req as { sessionId: string }).sessionId))].sort();

      // External -> All: both sessions refetch.
      let mark = vi.mocked(getLines).mock.calls.length;
      fireEvent.click(radios[0]);
      await waitFor(() => expect(setAnonymizerConfig).toHaveBeenCalledWith(expect.objectContaining({ mode: 'all' })));
      await waitFor(() => expect(sessionsFetched(mark)).toEqual(['/a.log', '/b.log']));

      // All -> None: both refetch again (the viewer goes back to raw).
      await settled();
      mark = vi.mocked(getLines).mock.calls.length;
      fireEvent.click(radios[2]);
      await waitFor(() => expect(setAnonymizerConfig).toHaveBeenCalledWith(expect.objectContaining({ mode: 'none' })));
      await waitFor(() => expect(sessionsFetched(mark)).toEqual(['/a.log', '/b.log']));

      // None -> External: nothing the viewer shows changed, so no refetch.
      await settled();
      mark = vi.mocked(getLines).mock.calls.length;
      fireEvent.click(radios[1]);
      await waitFor(() => expect(setAnonymizerConfig).toHaveBeenCalledWith(expect.objectContaining({ mode: 'external' })));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sessionsFetched(mark)).toEqual([]);
    }
  });
});

// ── Startup side effects live in onMount, with a catch (review A-M8) ───────

describe('App — a failing workspace restore is reported, not swallowed', () => {
  afterEach(() => {
    workspaceHooks.hydrateError = null;
  });

  it('puts the failure on the status line instead of raising an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent): void => {
      event.preventDefault();
      rejections.push(event.reason);
    };
    window.addEventListener('unhandledrejection', onRejection);
    try {
      workspaceHooks.hydrateError = new Error('app-state.json is corrupt');
      render(() => <App />);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Workspace restore failed');
      expect(alert.textContent).toContain('app-state.json is corrupt');
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      window.removeEventListener('unhandledrejection', onRejection);
    }
  });

  it('shows nothing on the status line when the restore succeeds', async () => {
    render(() => <App />);
    await waitFor(() => expect(screen.getByTestId('workspace-first-run')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ── Global shortcuts (C3) — app/shortcuts.ts wired from App.tsx's onMount ──

describe('App — global keyboard shortcuts (C3)', () => {
  it('Ctrl+O opens the file dialog, the same action the top-bar button uses', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    vi.mocked(open).mockClear();

    render(() => <App />);
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  });

  it('Ctrl+Shift+O opens the "open in editor" file picker and switches to the editor surface', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    vi.mocked(open).mockClear();
    vi.mocked(open).mockResolvedValueOnce(null); // cancelled — no readTextFile call needed

    render(() => <App />);
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  });

  it('Ctrl+N starts a new workspace (same transition Switcher/WorkspaceHome use)', async () => {
    const { beginWorkspaceSwitch } = await import('@bridge/commands');
    vi.mocked(beginWorkspaceSwitch).mockClear();

    render(() => <App />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });

    await waitFor(() => expect(beginWorkspaceSwitch).toHaveBeenCalledTimes(1));
  });

  it('Ctrl+Shift+E opens the Export rail drawer', async () => {
    render(() => <App />);
    expect(screen.queryByTestId('export-dialog')).toBeNull();

    fireEvent.keyDown(window, { key: 'E', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(screen.getByTestId('export-dialog')).toBeTruthy());
  });

  // Plain Ctrl+S is `EditorTabs.tsx:58`'s own shortcut, not this module's —
  // pressing it with no editor document open must not reach any of the
  // actions this module owns (open-file dialog, new/save workspace, export).
  it('plain Ctrl+S is ignored here — no file dialog, no workspace transition, no export drawer', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { beginWorkspaceSwitch, saveWorkspaceV4, autoSaveWorkspace } = await import('@bridge/commands');
    vi.mocked(open).mockClear();
    vi.mocked(beginWorkspaceSwitch).mockClear();
    vi.mocked(saveWorkspaceV4).mockClear();
    vi.mocked(autoSaveWorkspace).mockClear();

    render(() => <App />);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    // Give any (wrongly) triggered async action a turn to run before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(open).not.toHaveBeenCalled();
    expect(beginWorkspaceSwitch).not.toHaveBeenCalled();
    expect(saveWorkspaceV4).not.toHaveBeenCalled();
    expect(autoSaveWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('export-dialog')).toBeNull();
  });

  it('disposes the listener on unmount — a keypress afterwards does nothing', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    vi.mocked(open).mockClear();

    const { unmount } = render(() => <App />);
    unmount();
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });

    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
  });
});
