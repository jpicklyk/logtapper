import type { AdbProcessorUpdate, SourceType } from '../bridge/types';

/** Typed event map for the internal application event bus. */
export type AppEvents = {
  // ── Generic lifecycle (all source types) ───────────────────────────────────
  /**
   * Fired just before a file load or ADB stream starts for a given pane.
   * Consumers use `paneId` to determine whether to clear their state — only
   * the focused pane's results should be reset; background-pane loads must not
   * disrupt what the user is currently viewing.
   */
  'session:pre-load':       { paneId: string };
  /**
   * Emitted immediately when a file load starts (before the backend invoke).
   * Creates a placeholder tab with the filename so the user sees immediate
   * feedback while the backend decompresses/indexes the file.
   */
  'session:loading':        { paneId: string; tabId: string; label: string; isNewTab: boolean };
  /**
   * `tabId` is the pre-assigned tab ID for the logviewer tab that will be
   * created (or updated) for this session.
   *
   * When `isNewTab` is true, a second file is being opened alongside an
   * existing one in the same pane. `previousSessionId` is the session that
   * was active before — workspace layout uses it to keep the pre-existing
   * logviewer tab's mapping intact.
   */
  'session:loaded':         { sessionId: string; paneId: string; sourceName: string; sourceType: SourceType;
                              tabId: string; isNewTab?: boolean; previousSessionId?: string; readOnly?: boolean };
  'session:closed':         { sessionId: string; paneId: string; sourceType: SourceType; tabId?: string };
  'session:focused':        { sessionId: string | null; paneId: string | null };
  'session:indexing-complete': { sessionId: string; totalLines: number };

  // ── Dumpstate / Bugreport specific ─────────────────────────────────────────
  'session:dumpstate:opened':            { sessionId: string; paneId: string; sourceName: string };
  'session:dumpstate:indexing-complete': { sessionId: string; totalLines: number };

  // ── Logcat file specific ────────────────────────────────────────────────────
  'session:logcat:opened':  { sessionId: string; paneId: string; sourceName: string };

  // ── ADB streaming (always logcat) ──────────────────────────────────────────
  'stream:started':         { sessionId: string; paneId: string; deviceSerial: string };
  'stream:stopped':         { sessionId: string; paneId: string };

  // ── Pipeline ───────────────────────────────────────────────────────────────
  'pipeline:completed':     { sessionId: string; runCount: number;
                              hasTrackers: boolean; hasReporters: boolean; hasCorrelators: boolean };
  'pipeline:cleared':       undefined;
  'pipeline:chain-changed': { chain: string[] };
  'pipeline:library-open':  undefined;
  /** Forwarded from Channel<AdbStreamEvent> processorUpdate — drives PipelineContext
   *  so ProcessorDashboard/StatePanel/CorrelationsView refresh during streaming. */
  'pipeline:adb-processor-batch': AdbProcessorUpdate[];

  // ── Layout / navigation ───────────────────────────────────────────────────
  'layout:open-tab':        { type: string; label?: string; filePath?: string };
  /** Fired when a logviewer tab is explicitly closed via the UI tab bar. */
  'layout:logviewer-tab-closed': { tabId: string; paneId: string; sessionId: string };
  /** Fired when the user switches to a logviewer tab that has its own session.
   *  `reason: 'drag'` is set when the activation is caused by a tab drag/drop
   *  rearrangement rather than an explicit tab click — consumers should skip
   *  viewer state resets (search, filter) in that case. */
  'layout:logviewer-tab-activated': { tabId: string; paneId: string; sessionId: string; reason?: 'drag' };
  /** Fired by workspace fallback path when a session was registered under a placeholder
   *  pane ID (e.g. 'primary') but the tab was actually placed in a different pane. */
  'layout:pane-session-remap': { originalPaneId: string; actualPaneId: string; sessionId: string };
  'navigate:jump':          { lineNum: number };

  // ── Selection ───────────────────────────────────────────────────────────
  /** Fired when the user changes line selection in a log viewer.
   *  `anchor` is the click origin; `range` is [first, last] of the contiguous
   *  selection (null when cleared). Includes `sessionId` because a pane can
   *  host multiple sessions via tabs. */
  'selection:changed':      { paneId: string; sessionId: string | null;
                              anchor: number | null; range: [number, number] | null };

  // ── Bookmarks ─────────────────────────────────────────────────────────────
  /** Fired when the user triggers a bookmark creation action (right-click context menu,
   *  Ctrl+B shortcut). Consumers render a creation dialog. */
  'bookmark:create-request': {
    paneId: string;
    sessionId: string;
    lineNumber: number;
    lineNumberEnd?: number;
    defaultLabel?: string;
    position?: { x: number; y: number };
  };

  // ── Analysis ──────────────────────────────────────────────────────────────
  /** Fired when the user selects an analysis artifact to view in the center tab. */
  'analysis:open':          { artifactId: string };
  /** Fired when the local UI publishes an analysis — used by useAnalysisToast to suppress toasts. */
  'analysis:published-local':    { artifactId: string };
  /** Fired when an analysis is published externally (e.g. via MCP bridge), not by local UI. */
  'analysis:published-external': { artifactId: string; title: string; sessionId: string };

  // ── Pane focus ─────────────────────────────────────────────────────────
  /** Fired when any pane receives user interaction. Does not affect session routing. */
  'pane:activated':                    { paneId: string };

  // ── Inline pane notices ──────────────────────────────────────────────────
  /** Transient full-width banner inside a specific pane. Auto-dismisses. */
  'pane:notice':                     { paneId: string; message: string };

  // ── Marketplace ─────────────────────────────────────────────────────────
  'marketplace:processor-installed':   { processorId: string; sourceName: string };
  'marketplace:processor-updated':     { processorId: string; oldVersion: string; newVersion: string };
  'marketplace:processor-uninstalled': { processorId: string };
  'marketplace:sources-changed':       undefined;

  // ── File operations ──────────────────────────────────────────────────────
  /** Emitted when user triggers Save. Focused EditorTab should handle. */
  'file:save-request':    undefined;
  /** Emitted when user triggers Save As. Focused EditorTab should handle. */
  'file:save-as-request': undefined;
  /** Fired when Export Session is requested (menu or shortcut). Header shows the export modal. */
  'layout:export-session-requested': undefined;
  /** Fired when the user clicks the Settings button in the Header. AppShell opens the modal. */
  'layout:settings-requested': undefined;
};
