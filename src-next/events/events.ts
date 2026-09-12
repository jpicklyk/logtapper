import type { AdbExcludedProcessor, AdbProcessorUpdate, AdbTrackerUpdate, SourceType } from '../bridge/types';
import type { EditorTabState, SplitNode } from '../hooks/workspace/workspaceTypes';

/** Typed event map for the internal application event bus. */
export type AppEvents = {
  // ── Generic lifecycle (all source types) ───────────────────────────────────
  /**
   * Fired just before a file load or ADB stream starts for a given pane.
   * Consumers use `paneId` to determine whether to clear their state — only
   * the focused pane's results should be reset; background-pane loads must not
   * disrupt what the user is currently viewing. `outgoingSessionId` is the
   * session being replaced on that pane, resolved by the emitter at emit time
   * (null when the pane was empty) — consumers must use this value directly
   * rather than resolving it themselves via `paneSessionMap`, which is one
   * render behind at this point in the load sequence.
   */
  'session:pre-load':       { paneId: string; outgoingSessionId: string | null };
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
                              tabId: string; isNewTab?: boolean; previousSessionId?: string; readOnly?: boolean;
                              isIndexing?: boolean;
                              /** Absolute source-file path (null for ADB streams). Stashed onto the
                               *  tab so same-named tabs can be disambiguated — see
                               *  `layout/CenterArea/tabDisambiguation.ts`. */
                              sourcePath?: string | null;
                              /** Line count as of this load. Snapshot for the tab tooltip, not a
                               *  live counter — see `Tab.sourceTotalLines`. */
                              totalLines?: number;
                              /** Correlation id stamped by a workspace restore's own `loadFile` calls
                               *  (see `hooks/workspace/restoreCore.ts`). Lets the restore distinguish
                               *  sessions IT produced from a concurrent user-initiated open that happens
                               *  to complete during the restore's awaited load loop — without it, the
                               *  restore would misattribute the other open's session and apply its own
                               *  manifest entry's bookmarks/analyses to the wrong session. Optional and
                               *  unset for every other emitter/consumer. */
                              loadRequestId?: string;
                              /** Workspace epoch (`hooks/workspace/workspaceEpoch.ts`) captured by
                               *  `useFileSession.loadFile` before its backend IPC call. Belt-and-braces
                               *  check: `useCenterTree.onSessionLoaded` ignores an event whose `epoch`
                               *  doesn't match the current epoch — the load's own staleness guard should
                               *  already have discarded it before ever emitting, but this catches the
                               *  event landing on a stale listener anyway. Unset (always accepted) for
                               *  emitters not guarded by the epoch — e.g. the MCP-bridge session-opened
                               *  path, whose backend session already exists independent of any frontend
                               *  workspace-switch race. */
                              epoch?: number };
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
  /** Fired after a live capture is saved to disk — registers the file path
   *  with the tab restore system so it survives app restart. */
  'stream:saved':           { sessionId: string; path: string };

  // ── Pipeline ───────────────────────────────────────────────────────────────
  'pipeline:completed':     { sessionId: string; runCount: number;
                              hasTrackers: boolean; hasReporters: boolean; hasCorrelators: boolean };
  'pipeline:cleared':       undefined;
  /** Targeted: `sessionId` names the session whose chain changed. Consumers
   *  MUST match on it — a live stream applies this to its own session only. */
  'pipeline:chain-changed': { sessionId: string; chain: string[] };
  'pipeline:library-open':  undefined;
  /** Forwarded from Channel<AdbStreamEvent> processorUpdate — drives PipelineContext
   *  so ProcessorDashboard/StatePanel/CorrelationsView refresh during streaming. */
  'pipeline:adb-processor-batch': AdbProcessorUpdate[];
  /** Forwarded from Tauri adb-tracker-update broadcast — triggers runCount bump
   *  and transition line refresh so dashboard/timeline update during streaming. */
  'pipeline:adb-tracker-update': AdbTrackerUpdate;
  /** Forwarded from Channel<AdbStreamEvent> processorsExcluded — the complete
   *  current set of processors a live stream's declared-`source_types` check
   *  excludes. Targeted: `sessionId` names the streaming session: a consumer
   *  showing a different session's dashboard must ignore it. Folded into
   *  `PipelineContext.resultsBySession` (`adb:processors-excluded`) as
   *  `PipelineRunSummary.skipped`, so it renders through the exact same
   *  n/a row `ProcessorDashboard` already draws for a file-mode skip. */
  'pipeline:adb-processors-excluded': { sessionId: string; excluded: AdbExcludedProcessor[] };

  // ── Layout / navigation ───────────────────────────────────────────────────
  /** `analysisArtifactId` is set when opening (or reusing) an `'analysis'`
   *  tab for a specific artifact — the handler emits a targeted `analysis:open`
   *  once it knows which pane the tab landed in. `paneId` explicitly steers a
   *  NEW tab at that pane (e.g. a workspace restore's editor-tab replay
   *  targeting the pane it occupied when saved, resolved via
   *  `restoreTreeSkeleton.ts`'s `PaneResolver`) — omitted, it falls back to
   *  `openCenterTab`'s normal focused-pane/first-leaf default. */
  'layout:open-tab':        { type: string; label?: string; filePath?: string; editorState?: EditorTabState; analysisArtifactId?: string; paneId?: string };
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

  // ── Selection ───────────────────────────────────────────────────────────
  /** Fired when the user changes line selection in a log viewer.
   *  `anchor` is the click origin; `range` is [first, last] of the contiguous
   *  selection (null when cleared). Includes `sessionId` because a pane can
   *  host multiple sessions via tabs. */
  'selection:changed':      { paneId: string; sessionId: string | null;
                              anchor: number | null; range: [number, number] | null };

  // ── Section tracking ──────────────────────────────────────────────────
  /** Fired by useFileInfo when the active section changes (bugreport/dumpstate).
   *  StatusBar subscribes to display the section chip reactively. */
  'section:active-changed': { paneId: string; sectionName: string | null; lineNumber: number | null };

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
  /** Fired when the user selects an analysis artifact to view in the center tab.
   *  `paneId` targets the specific pane's AnalysisReader — analyses are now
   *  workspace-owned (not session-scoped), so with analysis tabs open in two
   *  panes an untargeted event would land on whichever reader mounted last
   *  regardless of which pane it was meant for. Always paired with the pane
   *  id that `layout:open-tab`'s handler resolved the tab into — see
   *  `useWorkspaceLayout`'s `onOpenTab`. */
  'analysis:open':          { artifactId: string; paneId: string };
  /** Fired when the local UI publishes an analysis — used by useAnalysisToast to suppress toasts. */
  'analysis:published-local':    { artifactId: string };
  /** Fired when an analysis is published externally (e.g. via MCP bridge), not by local UI.
   *  `sessionId` is the artifact's best-effort primary session attribution —
   *  null when unattributed (matches `SourceReference.sessionId`). */
  'analysis:published-external': { artifactId: string; title: string; sessionId: string | null };

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
  'marketplace:pack-updated':          { packId: string; sourceName: string };

  // ── Workspace ──────────────────────────────────────────────────────────
  /** Fired on every workspace or artifact mutation. `source` discriminates
   *  what `useWorkspaceAutoSave` does with it:
   *   - 'workspace': a `WorkspaceMutationActions` mutation via `trackMutations()`
   *     (file loads, chain edits, processor installs) or another workspace-layer
   *     change (e.g. editor tab dirty state) — the frontend is the ONLY
   *     persister, so this drives the full debounced `.ltw` write.
   *   - 'artifact': a session-layer artifact mutation (bookmark, analysis) —
   *     the backend's `schedule_autosave` (`artifact_mutations.rs`) already
   *     writes the `.ltw` for these, so this only refreshes the backend's
   *     cached envelope (`sync_workspace_envelope`) to keep the layout/tabs
   *     current for that write.
   *  WorkspaceContext listens to set `dirty = true` regardless of source. */
  'workspace:mutated':       { source: 'artifact' | 'workspace' };
  /** Fired just before a workspace reset (new workspace or open .lts). Hooks
   *  should clean up session-scoped state. */
  'workspace:before-reset':  undefined;
  /** Fired after a workspace teardown completes. Hooks should reinitialize. */
  'workspace:reset':         undefined;
  /** Fired after an .ltw workspace is loaded — signals layout consumers to
   *  apply the saved layout blob (pane widths, visible panes, tabs, etc.). */
  'workspace:restore-layout': { layout: unknown };
  /** Fired by `restoreCore.ts`'s `restoreWorkspace` BEFORE any session load,
   *  when the saved `.ltw` layout carries a center-tree and localStorage
   *  isn't already the fresher source (`plan.applyLtwViewState`). Carries a
   *  tree rebuilt from the saved one with fresh split/leaf/pane ids (the
   *  saved ids are stale by restore time) and every `logviewer`/`editor` tab
   *  dropped — those rebind via the normal session-load / editor-tab-restore
   *  paths, steered at the correct (remapped) pane by
   *  `hooks/workspace/restoreTreeSkeleton.ts`'s placement resolver, rather
   *  than falling through to `firstLeaf` and flattening every pane. `useCenterTree`
   *  is the sole consumer — it replaces the live tree wholesale. */
  'workspace:restore-tree-skeleton': { tree: SplitNode };
  /** Fired after an .lts workspace is fully restored. */
  'workspace:opened':        { name: string; filePath: string };
  /** Fired when a restore begins. Suppresses auto-save until the matching
   *  `workspace:restore-end`, so loading a workspace does not immediately
   *  persist it back. Without this, a restore that only partially succeeds
   *  would overwrite the good .ltw with the partial state. Reference-counted,
   *  so overlapping restores are safe. */
  'workspace:restore-begin': undefined;
  /** Fired when a restore finishes, successfully or not. Must be emitted in a
   *  `finally` — a missed end would suppress auto-save for the rest of the
   *  session. */
  'workspace:restore-end':   undefined;
  /** Fired after a background/debounced auto-save writes the app-data-dir
   *  `.ltw` (i.e. the workspace had no explicit path). WorkspaceContext records
   *  the path + timestamp onto the entry so app-state.json can point at the
   *  crash-recovery file. Targeted by `workspaceId`. */
  'workspace:auto-saved':    { workspaceId: string; path: string; savedAt: number };
  /** Fired by Q2's startup restore when the active workspace's candidate
   *  auto-save `.ltw` failed Q3's trust gate (`assessRestoreCandidate` returned
   *  `untrusted`). The app has already fallen back to the plain-localStorage
   *  plan (no regression); this drives a non-blocking notice offering to open
   *  the file as a NEW workspace. `savedAt` dates it, `reasons` are the machine
   *  codes from the assessment, `candidatePath` is what "Open it" loads. */
  'workspace:untrusted-autosave': { workspaceId: string; candidatePath: string; savedAt: number; reasons: string[] };
  /** Fired by Q2's startup/open restore when the plan diverged from a clean
   *  match — a manifest file has moved/is missing (its artifacts were skipped,
   *  not misattached), a stored tab was not in the workspace file, or a `.lts`
   *  reference was deduped. Surfaced as a non-blocking notice so these are not
   *  swallowed into `console.warn`. Reuses the existing toast surface. */
  'workspace:restore-warnings': { warnings: string[] };

  // ── File operations ──────────────────────────────────────────────────────
  /** Fired when an .lts file import is skipped because it's already open. */
  'file:lts-already-open': { label: string };
  /** Emitted when user triggers Save. Targeted EditorTab (by paneId) handles. */
  'file:save-request':    { paneId: string };
  /** Emitted when user triggers Save As. Targeted EditorTab (by paneId) handles. */
  'file:save-as-request': { paneId: string };
  /** Fired when Export Session is requested (menu or shortcut). Header shows the export modal. */
  'layout:export-session-requested': undefined;
  /** Fired when the user clicks the Settings button in the Header. AppShell opens the modal. */
  'layout:settings-requested': undefined;
};
