import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ActivityEntry, AdbStreamStopped, AdbTrackerUpdate, FileIndexProgress, FileIndexComplete, SearchProgress, FilterProgress, PipelineProgress, BookmarkUpdateEvent, AnalysisUpdateEvent, WatchMatchEvent, WatchUpdateEvent, LoadResult, SessionClosedEvent, WorkspaceAutoSavedEvent, WorkspaceRestoredEvent, WorkspaceListChangedEvent, LtsEditorTabPayload, FocusContext, NavRequest } from './types';

// ---------------------------------------------------------------------------
// ADB streaming events
// ---------------------------------------------------------------------------

// NOTE: adb-batch and adb-processor-update are no longer emitted as Tauri
// broadcast events — they arrive via the Channel<AdbStreamEvent> passed to
// start_adb_stream. See commands.ts startAdbStream and useStreamSession.

export function onAdbTrackerUpdate(
  cb: (payload: AdbTrackerUpdate) => void,
): Promise<UnlistenFn> {
  return listen<AdbTrackerUpdate>('adb-tracker-update', (e) => cb(e.payload));
}

export function onAdbStreamStopped(
  cb: (payload: AdbStreamStopped) => void,
): Promise<UnlistenFn> {
  return listen<AdbStreamStopped>('adb-stream-stopped', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Progressive file-indexing events
// ---------------------------------------------------------------------------

export function onFileIndexProgress(
  cb: (payload: FileIndexProgress) => void,
): Promise<UnlistenFn> {
  return listen<FileIndexProgress>('file-index-progress', (e) => cb(e.payload));
}

export function onFileIndexComplete(
  cb: (payload: FileIndexComplete) => void,
): Promise<UnlistenFn> {
  return listen<FileIndexComplete>('file-index-complete', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Search progress events (chunked streaming results)
// ---------------------------------------------------------------------------

export function onSearchProgress(
  cb: (payload: SearchProgress) => void,
): Promise<UnlistenFn> {
  return listen<SearchProgress>('search-progress', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Pipeline run progress
// ---------------------------------------------------------------------------

/**
 * Per-processor progress during a pipeline run. Emitted by `pipeline.rs`; the
 * payload is `PipelineProgress` from `types.ts`, the TypeScript mirror of the
 * Rust struct.
 */
export function onPipelineProgress(
  cb: (payload: PipelineProgress) => void,
): Promise<UnlistenFn> {
  return listen<PipelineProgress>('pipeline-progress', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Filter progress events (Phase 1)
// ---------------------------------------------------------------------------

export function onFilterProgress(
  cb: (payload: FilterProgress) => void,
): Promise<UnlistenFn> {
  return listen<FilterProgress>('filter-progress', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Bookmark update events (Phase 2)
// ---------------------------------------------------------------------------

export function onBookmarkUpdate(
  cb: (payload: BookmarkUpdateEvent) => void,
): Promise<UnlistenFn> {
  return listen<BookmarkUpdateEvent>('bookmark-update', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Analysis update events (Phase 2)
// ---------------------------------------------------------------------------

export function onAnalysisUpdate(
  cb: (payload: AnalysisUpdateEvent) => void,
): Promise<UnlistenFn> {
  return listen<AnalysisUpdateEvent>('analysis-update', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Watch match events (Phase 4)
// ---------------------------------------------------------------------------

export function onWatchMatch(
  cb: (payload: WatchMatchEvent) => void,
): Promise<UnlistenFn> {
  return listen<WatchMatchEvent>('watch-match', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Watch lifecycle events (create / cancel, from EITHER caller)
// ---------------------------------------------------------------------------

/**
 * Emitted on every watch mutation, by the UI's own create/cancel path AND by an
 * agent's (`POST|DELETE /mcp/sessions/{id}/watches`). Until the services layer
 * landed, an agent-created watch was invisible to the Watches panel because
 * nothing emitted for it.
 *
 * The payload carries `sessionId`, so the consumer must match on it rather than
 * treating this as a broadcast — a watch created for a background session must
 * not appear in the focused pane's panel. Because the UI emits too, a consumer
 * that already applied its own optimistic update will see its own mutation come
 * back: dedupe by `watch.id`.
 */
export function onWatchUpdate(
  cb: (payload: WatchUpdateEvent) => void,
): Promise<UnlistenFn> {
  return listen<WatchUpdateEvent>('watch-update', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Activity feed (shared UI + agent journal)
// ---------------------------------------------------------------------------

/**
 * One journaled action, live. Emitted by `ServiceCtx::journal` for every
 * mutation from either caller — the same entries `getActivity()` returns, so
 * the normal pattern is one `getActivity()` on mount followed by this listener
 * appending. Reads are never journaled, so this stays quiet while the user is
 * only looking around.
 */
export function onActivity(
  cb: (entry: ActivityEntry) => void,
): Promise<UnlistenFn> {
  return listen<ActivityEntry>('activity', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Shared focus context + agent navigation requests (B1)
// ---------------------------------------------------------------------------

/**
 * Emitted whenever the shared focus context changes, by either caller —
 * `setFocus()`/`PUT /mcp/focus` set it, `setFocus(null)`/`DELETE /mcp/focus`
 * clear it (payload `null`). Distinct from `focused_session` (which pane is
 * open) — this is the explicit "ask about this" handoff.
 */
export function onFocusChanged(
  cb: (payload: FocusContext | null) => void,
): Promise<UnlistenFn> {
  return listen<FocusContext | null>('focus-changed', (e) => cb(e.payload));
}

/**
 * Emitted when an agent (or the UI's own `requestNavigation()`, for testing
 * the same path) asks to jump to a specific line/analysis in a session. This
 * event never applies the jump itself — the consumer decides whether to
 * navigate immediately or hold for confirmation, per its own
 * `require_nav_confirmation` setting (frontend-local for now). The payload
 * carries `sessionId`, so a consumer bound to one pane must match on it
 * rather than treating this as a broadcast.
 */
export function onNavigateRequest(
  cb: (payload: NavRequest) => void,
): Promise<UnlistenFn> {
  return listen<NavRequest>('navigate-request', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// User theme storage (B2)
// ---------------------------------------------------------------------------

/**
 * `theme-changed` payload. Hand-written — the backend builds it with
 * `serde_json::json!({ "slug": slug })` (`services::themes::write`/`delete`),
 * not a `#[derive(TS)]` struct, since it carries nothing beyond the slug.
 */
export interface ThemeChangedEvent {
  slug: string;
}

/**
 * Emitted whenever a stored user theme is created, replaced, or deleted
 * (`writeTheme`/`deleteTheme`, Ui-only). The payload is just the slug — a
 * consumer that needs the theme's contents should re-fetch it via
 * `readTheme`/`listThemes` rather than trust a stale cached copy.
 */
export function onThemeChanged(
  cb: (payload: ThemeChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<ThemeChangedEvent>('theme-changed', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// File open events (file association / single-instance)
// ---------------------------------------------------------------------------

export function onOpenFile(
  cb: (path: string) => void,
): Promise<UnlistenFn> {
  return listen<string>('open-file', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Session closed by the MCP bridge (agent-initiated close)
// ---------------------------------------------------------------------------

/**
 * Emitted after a session is closed — by an agent (POST /mcp/sessions/{id}/close)
 * or by the UI's own close path, which now emits it too. The consumer closes any
 * pane/tab bound to `sessionId` (targeted — never all panes) and is idempotent,
 * which is what keeps the UI-initiated close from doing anything twice.
 */
export function onBridgeSessionClosed(
  cb: (payload: SessionClosedEvent) => void,
): Promise<UnlistenFn> {
  return listen<SessionClosedEvent>('session-closed', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Session opened by the MCP bridge (agent-initiated open)
// ---------------------------------------------------------------------------

/** Payload for the `session-opened` Tauri event: the full `LoadResult` of the
 *  freshly bridge-opened session (camelCase mirror of the Rust struct). */
export type SessionOpenedPayload = LoadResult;

/**
 * Emitted by the MCP bridge AFTER it opens a file on behalf of an agent
 * (POST /mcp/open_file). The UI open path does NOT emit this — it builds its own
 * tab — only bridge-initiated opens, which are otherwise invisible to the
 * frontend. The consumer creates + activates a logviewer tab for the
 * already-loaded session, reusing the normal post-load path (never re-invoking
 * `load_log_file`). Idempotent: a reopen re-fires this with the same
 * (deterministic) `sessionId`, and the consumer must not spawn a duplicate tab.
 */
export function onBridgeSessionOpened(
  cb: (payload: SessionOpenedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SessionOpenedPayload>('session-opened', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Workspace auto-saved (Q4 — backend flush)
// ---------------------------------------------------------------------------

/**
 * Emitted by the backend auto-save flusher after it writes the `.ltw`. The
 * shape matches the frontend `workspace:auto-saved` bus event, so it can be
 * forwarded directly.
 */
export function onWorkspaceAutoSaved(
  cb: (payload: WorkspaceAutoSavedEvent) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceAutoSavedEvent>('workspace-auto-saved', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Workspace restored (`.ltw`/`.lts` load) — chain restore + toast summary
// ---------------------------------------------------------------------------

/**
 * Emitted after a workspace or `.lts` file finishes restoring. Consumed by
 * `useWorkspaceRestore` (pipeline chain restore + auto-run scheduling) and
 * `useWorkspaceRestoreToast` (bookmark/analysis/pipeline restore summary
 * toast) — both subscribe independently to the same event.
 */
export function onWorkspaceRestored(
  cb: (payload: WorkspaceRestoredEvent) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceRestoredEvent>('workspace-restored', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// Workspace list changed (rename/delete) — B3
// ---------------------------------------------------------------------------

/**
 * Emitted after `renameWorkspace`/`deleteWorkspace` changes the app-state
 * workspace list itself — distinct from `onWorkspaceRestored`/
 * `onWorkspaceAutoSaved`, which are about one workspace's content. Consumers
 * that show the workspace list (e.g. a "switch workspace" menu) should
 * refetch via `getAppState()` rather than trying to patch their own copy.
 */
export function onWorkspaceListChanged(
  cb: (payload: WorkspaceListChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceListChangedEvent>('workspace-list-changed', (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// `.lts` editor tab restore
// ---------------------------------------------------------------------------

/**
 * Emitted while restoring a `.lts` file's embedded editor (scratch) tabs.
 * Consumed by `useEditorTabRestore`, which opens each tab not already open
 * in the current center tree (dedup by label).
 */
export function onLtsEditorTabs(
  cb: (payload: LtsEditorTabPayload[]) => void,
): Promise<UnlistenFn> {
  return listen<LtsEditorTabPayload[]>('lts-editor-tabs', (e) => cb(e.payload));
}

