//! Workspace lifecycle: save, auto-save, envelope sync, switch, load, restore,
//! and the `app-state.json` workspace list.
//!
//! The single implementation behind both transports. `commands::workspace_cmd`
//! is the Tauri adapter (unchanged command signatures, returns and emits — the
//! desktop's save/restore sequence is the most load-bearing user workflow in
//! the app and must stay byte-identical), and `mcp_bridge::routes::workspace`
//! is the agent adapter.
//!
//! ## What stays in the frontend
//!
//! The *restore rules* — which `.ltw` candidate to trust, how to pair manifest
//! entries with the sessions a load actually produced, drift detection,
//! auto-run scheduling — live in `src-next/hooks/workspace/*.ts` and are
//! deliberately **not** moved here (see plans/service-layer-phase1.md "Out of
//! scope"). This module exposes the primitives those rules drive:
//! [`save`], [`auto_save`], [`sync_envelope`], [`begin_switch`], [`load`],
//! [`restore_session`], [`app_state`], [`save_app_state`], [`list`].
//!
//! [`load_and_restore`] is the one place that *does* orchestrate a whole
//! workspace open end to end. It exists for agents, which have no frontend to
//! run the TS rules: it opens every session in the manifest in order and
//! restores each one's artifacts. The desktop never calls it.
//!
//! ## The `.ltw` layout tree is opaque
//!
//! [`LtwLayout`] is `serde_json::Value` and surfaces to TypeScript as
//! `unknown`. The backend stores and returns it verbatim and never inspects
//! it — the pane tree's shape is frontend-owned.
//!
//! ## Autosave
//!
//! The debounced background flusher (`workspace::autosave`) stays Tauri-bound:
//! it owns a scheduler task and an `AppHandle`. Services only ever call its
//! handle-free entry points — [`autosave::cache_envelope`],
//! [`autosave::begin_switch_suppression`], `autosave::schedule_autosave` —
//! all of which take `&AppState`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::commands::AppState;
use crate::core::analysis::{AnalysisArtifact, AnalysisUpdateEvent};
use crate::core::bookmark::Bookmark;
use crate::workspace::app_state::{self as app_state_file, AppStateFile, WorkspaceEntry};
use crate::workspace::autosave::{self, WorkspaceEnvelope};
use crate::workspace::ltw_v4::{
    self, LtwEditorTab, LtwLayout, LtwManifestSession, LtwPipelineChain,
};
use crate::workspace::{now_ms, SessionMeta};

use super::{lock_svc, ServiceCtx, ServiceError};

// ---------------------------------------------------------------------------
// Paths (Tauri-free counterparts of workspace::workspace_dir /
// workspace::app_state::app_state_path)
// ---------------------------------------------------------------------------

/// `app_data_dir/app-state.json`, creating the data dir if needed.
///
/// The Tauri-bound twin is [`crate::workspace::app_state::app_state_path`],
/// which `lib.rs` and the autosave flusher still use because they hold an
/// `AppHandle`. Its `APP_STATE_FILENAME` constant is private to that module
/// (which is outside this package's ownership), so the literal is repeated
/// here rather than widened — [`tests::app_state_path_matches_the_tauri_twin`]
/// pins the two spellings together so they cannot drift onto different files.
pub(crate) fn app_state_path(ctx: &ServiceCtx) -> Result<PathBuf, ServiceError> {
    let dir = ctx.paths().app_data_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| ServiceError::Internal(format!("Failed to create app data dir: {e}")))?;
    Ok(dir.join(APP_STATE_FILENAME))
}

/// Must equal `crate::workspace::app_state::APP_STATE_FILENAME` (private there).
pub(crate) const APP_STATE_FILENAME: &str = "app-state.json";

/// Must equal the segment `crate::workspace::workspace_dir` joins.
pub(crate) const WORKSPACES_SUBDIR: &str = "workspaces";

/// `app_data_dir/workspaces`, creating it if needed. Tauri-free twin of
/// [`crate::workspace::workspace_dir`]; shares its [`WORKSPACES_SUBDIR`]
/// segment (pinned by [`tests::workspaces_dir_matches_the_tauri_twin`]).
pub(crate) fn workspaces_dir(ctx: &ServiceCtx) -> Result<PathBuf, ServiceError> {
    let dir = ctx.paths().app_data_dir()?.join(WORKSPACES_SUBDIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| ServiceError::Internal(format!("Failed to create workspaces dir: {e}")))?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Write gate
// ---------------------------------------------------------------------------

/// Reject a workspace id that could escape the app-data `workspaces/`
/// directory when used as a file stem.
///
/// The auto-save and app-state destinations are app-owned (they are always
/// `app_data_dir/...`), so [`super::policy::authorize_write_dest`]'s
/// allowlist containment does not apply — an agent cannot choose *where* they
/// land. The one piece of caller-supplied data that reaches the path is the
/// workspace id, so that is what gets checked.
fn check_workspace_id(workspace_id: &str) -> Result<(), ServiceError> {
    let bad = workspace_id.is_empty()
        || workspace_id == "."
        || workspace_id == ".."
        || workspace_id.contains(['/', '\\', ':']);
    if bad {
        return Err(ServiceError::invalid_arg(format!(
            "workspace id '{workspace_id}' is not a valid file-name segment"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Session snapshot helpers (shared with workspace::autosave's flusher)
// ---------------------------------------------------------------------------

/// One saved session: its manifest entry, its bookmarks, and its pipeline meta.
pub(crate) type SessionEntry = (LtwManifestSession, Vec<Bookmark>, SessionMeta);

/// Snapshot all open sessions and their bookmarks from `AppState`.
/// Acquires locks briefly: sessions once, bookmarks/meta once each.
///
/// Analyses are workspace-owned (not keyed by session) and are not part of
/// this per-session snapshot — they are collected separately via
/// [`super::snapshot::snapshot_workspace_analyses`] and written to the
/// top-level `analyses.json` entry in the `.ltw` (see `workspace::ltw_v4`).
pub(crate) fn collect_session_data(state: &AppState) -> Result<Vec<SessionEntry>, ServiceError> {
    // Snapshot session info under brief lock
    // (id, file_path, source_name, source_type, source_type_override)
    let session_info: Vec<(String, String, String, String, Option<String>)> = {
        let sessions = lock_svc(&state.sessions, "sessions")?;
        sessions
            .iter()
            .filter_map(|(id, session)| {
                let file_path = session.file_path.as_ref()?;
                let source = session.primary_source()?;
                Some((
                    id.clone(),
                    file_path.clone(),
                    source.name().to_string(),
                    format!("{:?}", source.source_type()),
                    session.source_type_override.clone(),
                ))
            })
            .collect()
    };

    // Extract only the entries for sessions we're saving (not the entire map).
    let mut entries = Vec::with_capacity(session_info.len());
    {
        let bm_guard = lock_svc(&state.bookmarks, "bookmarks")?;
        let meta_guard = lock_svc(&state.session_pipeline_meta, "session_pipeline_meta")?;
        for (session_id, file_path, source_name, source_type, source_type_override) in session_info {
            entries.push((
                LtwManifestSession {
                    file_path,
                    source_name,
                    source_type,
                    source_type_override,
                    // T8: stamp the live session id so a later restore can
                    // detect drift — the file at `file_path` changed since this
                    // save (deterministic ids mean a content change re-derives
                    // a different id) and any analysis reference keyed to this
                    // id would otherwise silently point at the wrong lines.
                    expected_session_id: Some(session_id.clone()),
                },
                bm_guard.get(&session_id).cloned().unwrap_or_default(),
                meta_guard.get(&session_id).cloned().unwrap_or_default(),
            ));
        }
    }
    Ok(entries)
}

/// Snapshot the set of session ids currently eligible for workspace persistence
/// — those with both a file path and a primary source, i.e. exactly the sessions
/// [`collect_session_data`] serialises. Used to stamp the workspace envelope with
/// the sessions it was built against, and — at flush time — to detect a live
/// snapshot that has diverged wholesale from that set (a workspace switch caught
/// mid-flight). Kept in lock-step with `collect_session_data`'s filter above;
/// change both together.
pub(crate) fn snapshot_session_ids(state: &AppState) -> Result<Vec<String>, ServiceError> {
    let sessions = lock_svc(&state.sessions, "sessions")?;
    Ok(sessions
        .iter()
        .filter(|(_, session)| session.file_path.is_some() && session.primary_source().is_some())
        .map(|(id, _)| id.clone())
        .collect())
}

/// Build entry refs from collected data (for `write_ltw`'s borrow signature).
pub(crate) fn entry_refs(
    entries: &[SessionEntry],
) -> Vec<(LtwManifestSession, &[Bookmark], &SessionMeta)> {
    entries
        .iter()
        .map(|(m, b, meta)| (m.clone(), b.as_slice(), meta))
        .collect()
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceOptions {
    /// Stable workspace identifier — cached into the backend envelope so a
    /// background flush can update this workspace's `app-state.json` entry.
    pub workspace_id: String,
    pub dest_path: String,
    pub workspace_name: String,
    pub editor_tabs: Vec<LtwEditorTab>,
    #[ts(type = "unknown")]
    pub layout: Option<LtwLayout>,
    pub pipeline_chain: Vec<String>,
    pub disabled_chain_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveWorkspaceOptions {
    /// Stable workspace identifier — keys the auto-save filename so two
    /// distinct workspaces that happen to share a name (e.g. both "Untitled")
    /// no longer collide onto the same file.
    pub workspace_id: String,
    pub workspace_name: String,
    pub editor_tabs: Vec<LtwEditorTab>,
    #[ts(type = "unknown")]
    pub layout: Option<LtwLayout>,
    pub pipeline_chain: Vec<String>,
    pub disabled_chain_ids: Vec<String>,
}

/// Options for [`sync_envelope`]. Mirrors the save options but carries the
/// workspace's explicit `.ltw` path (if any) rather than a dest, and never
/// writes a file.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyncWorkspaceEnvelopeOptions {
    pub workspace_id: String,
    pub workspace_name: String,
    /// The workspace's explicit `.ltw` path, or null if it only auto-saves to
    /// the id-keyed `workspaces/{id}.ltw`.
    pub ltw_path: Option<String>,
    pub editor_tabs: Vec<LtwEditorTab>,
    #[ts(type = "unknown")]
    pub layout: Option<LtwLayout>,
    pub pipeline_chain: Vec<String>,
    pub disabled_chain_ids: Vec<String>,
}

/// Options for restoring per-session artifacts into `AppState`.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionOptions {
    pub session_id: String,
    pub bookmarks: Vec<Bookmark>,
    pub analyses: Vec<AnalysisArtifact>,
    pub active_processor_ids: Vec<String>,
    pub disabled_processor_ids: Vec<String>,
}

/// Options for [`rename_workspace`].
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenameWorkspaceRequest {
    pub workspace_id: String,
    pub new_name: String,
}

/// Options for [`delete_workspace`].
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkspaceRequest {
    pub workspace_id: String,
    /// Also delete the `.ltw` at the entry's `ltwPath` from disk (its
    /// auto-save file, if any, is always removed regardless of this flag).
    /// An `Agent` destination must pass
    /// [`super::policy::authorize_write_dest`]; `Ui` passes through.
    #[serde(default)]
    pub delete_file: bool,
    /// Required to delete the currently active workspace — with this set it
    /// is closed first (every open session) rather than refused outright.
    #[serde(default)]
    pub force: bool,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Payload of the `workspace-restored` Tauri event. Replaces the ad hoc
/// `serde_json::json!{}` the restore paths used to build by hand — field
/// names are unchanged, so the frontend listener needs no edit.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRestoredEvent {
    pub session_id: String,
    pub bookmark_count: usize,
    pub analysis_count: usize,
    pub active_processor_ids: Vec<String>,
    pub disabled_processor_ids: Vec<String>,
    /// `"workspace"` for a `.ltw` restore, `"lts"` for a `.lts` bundle import.
    pub source: String,
}

/// Payload of the `workspace-auto-saved` Tauri event, emitted by the
/// background flusher (`workspace::autosave`) after a successful flush.
/// Typed here rather than in `autosave.rs` so the wire shape lives with the
/// rest of the workspace contract and picks up `#[derive(TS)]`; the scheduler
/// itself stays Tauri-bound and unchanged.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAutoSavedEvent {
    pub workspace_id: String,
    pub path: String,
    #[ts(type = "number")]
    pub saved_at: i64,
}

/// Payload of the `workspace-list-changed` event, emitted by both
/// [`rename_workspace`] and [`delete_workspace`] — the app-state workspace
/// list itself changed shape, distinct from `workspace-restored`/
/// `workspace-auto-saved`, which are about one workspace's *content*.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListChangedEvent {
    pub workspace_id: String,
    /// `"renamed"` or `"deleted"`.
    pub action: String,
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/// Shared save sequence for [`save`] and [`auto_save`]: cache the workspace
/// envelope, snapshot session data, then write the `.ltw` under
/// `state.ltw_write_lock` (serialised against the background flush's write to
/// the same file).
///
/// `envelope_ltw_path` is the one point where the two callers differ:
/// [`save`] caches its explicit dest path so a background flush can rebuild
/// this exact shell; [`auto_save`] caches `None` because it always recomputes
/// `workspaces/{id}.ltw` itself.
///
/// Returns the manifest `savedAt` stamp `write_ltw` minted (epoch-ms) — the
/// same value a later [`load`] reads back as [`LoadWorkspaceResult::saved_at`].
#[allow(clippy::too_many_arguments)]
fn write_workspace_snapshot(
    state: &AppState,
    dest_path: &Path,
    workspace_id: &str,
    workspace_name: &str,
    envelope_ltw_path: Option<String>,
    editor_tabs: &[LtwEditorTab],
    layout: Option<&LtwLayout>,
    chain: &LtwPipelineChain,
) -> Result<i64, ServiceError> {
    autosave::cache_envelope(
        state,
        WorkspaceEnvelope {
            workspace_id: workspace_id.to_string(),
            workspace_name: workspace_name.to_string(),
            ltw_path: envelope_ltw_path,
            editor_tabs: editor_tabs.to_vec(),
            layout: layout.cloned(),
            pipeline_chain: chain.clone(),
            // Stamped by cache_envelope from the live session set; ignored here.
            session_ids: Vec::new(),
            updated_at: now_ms(),
        },
    );

    let entries = collect_session_data(state)?;
    let workspace_analyses = super::snapshot::snapshot_workspace_analyses(state);

    // Serialise against the background flush's write on the same file.
    let _guard = state
        .ltw_write_lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    ltw_v4::write_ltw(
        dest_path,
        workspace_name,
        Some(workspace_id),
        &entry_refs(&entries),
        &workspace_analyses,
        chain,
        editor_tabs,
        layout,
    )
    .map_err(ServiceError::Internal)
}

/// Collect all open sessions and their artifacts, then write a `.ltw` v4 file
/// at the caller's chosen destination.
///
/// An `Agent` destination must sit inside the MCP open-file allowlist (see
/// [`super::policy::authorize_write_dest`]); a `Ui` destination comes from the
/// native save dialog and is written verbatim.
pub fn save(ctx: &ServiceCtx, options: SaveWorkspaceOptions) -> Result<(), ServiceError> {
    let dest = super::policy::authorize_write_dest(ctx, &options.dest_path)?;

    let chain = LtwPipelineChain {
        chain: options.pipeline_chain,
        disabled_ids: options.disabled_chain_ids,
    };

    // Explicit save → ltw_path is the chosen dest path, so a background flush
    // can rebuild this exact workspace shell.
    write_workspace_snapshot(
        ctx.state(),
        &dest,
        &options.workspace_id,
        &options.workspace_name,
        Some(options.dest_path.clone()),
        &options.editor_tabs,
        options.layout.as_ref(),
        &chain,
    )?;

    ctx.journal(
        "workspace.save",
        None,
        format!("saved workspace '{}'", options.workspace_name),
    );
    Ok(())
}

/// Auto-save the active workspace to `app_data_dir/workspaces/{workspace_id}.ltw`.
/// Returns the path it was written to.
///
/// Keyed by workspace id, not sanitized name: two "Untitled" workspaces used
/// to derive the same `Untitled.ltw` and overwrite each other. Legacy
/// name-keyed files left over from before that change are deliberately not
/// migrated or touched here.
///
/// The destination is app-owned, so [`super::policy::authorize_write_dest`]'s allowlist rule does
/// not apply — the only caller-supplied component is the id, which
/// [`check_workspace_id`] constrains to a single path segment.
pub fn auto_save(
    ctx: &ServiceCtx,
    options: AutoSaveWorkspaceOptions,
) -> Result<String, ServiceError> {
    check_workspace_id(&options.workspace_id)?;
    let dest = workspaces_dir(ctx)?.join(format!("{}.ltw", options.workspace_id));

    let chain = LtwPipelineChain {
        chain: options.pipeline_chain,
        disabled_ids: options.disabled_chain_ids,
    };

    // ltw_path is None: this is the id-keyed auto-save, so a backend flush
    // recomputes `workspaces/{id}.ltw` itself.
    write_workspace_snapshot(
        ctx.state(),
        &dest,
        &options.workspace_id,
        &options.workspace_name,
        None,
        &options.editor_tabs,
        options.layout.as_ref(),
        &chain,
    )?;

    let path = dest
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| ServiceError::Internal("Failed to convert path to string".to_string()))?;

    ctx.journal(
        "workspace.save",
        None,
        format!("auto-saved workspace '{}'", options.workspace_name),
    );
    Ok(path)
}

/// Refresh the backend workspace-envelope cache from the caller without
/// writing any file. Pushed at the end of a workspace open/switch (so the
/// envelope exists before any MCP artifact write can occur) and whenever the
/// active workspace's identity changes (rename / path update).
///
/// Not journaled: it persists nothing and is a bookkeeping push, not a
/// caller-initiated action worth surfacing in the activity feed.
pub fn sync_envelope(
    ctx: &ServiceCtx,
    options: SyncWorkspaceEnvelopeOptions,
) -> Result<(), ServiceError> {
    autosave::cache_envelope(
        ctx.state(),
        WorkspaceEnvelope {
            workspace_id: options.workspace_id,
            workspace_name: options.workspace_name,
            ltw_path: options.ltw_path,
            editor_tabs: options.editor_tabs,
            layout: options.layout,
            pipeline_chain: LtwPipelineChain {
                chain: options.pipeline_chain,
                disabled_ids: options.disabled_chain_ids,
            },
            // Stamped by cache_envelope from the live session set; ignored here.
            session_ids: Vec::new(),
            updated_at: now_ms(),
        },
    );
    Ok(())
}

/// Open the backend autosave switch-suppression window at the start of a
/// workspace teardown (new / open / switch).
///
/// A switch is a burst of independent calls (auto-save the outgoing
/// workspace, close each session, restore the incoming one), so there is no
/// single backend "switch" the flusher could observe. Meanwhile the debounced
/// flush timer is armed by artifact mutations — including over the MCP bridge
/// — so it can fire mid-teardown. Without this window a flush landing after
/// some (but not all) outgoing sessions have closed writes the outgoing shell
/// minus the already-closed sessions, clobbering the complete `.ltw` the
/// switch wrote at its start. `autosave::flush` / `flush_now_blocking` then
/// skip until the restore re-caches the envelope (which clears the window) or
/// the window's deadline lapses.
pub fn begin_switch(ctx: &ServiceCtx) -> Result<(), ServiceError> {
    autosave::begin_switch_suppression(ctx.state());
    ctx.journal("workspace.switch", None, "workspace switch started");
    Ok(())
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/// Per-session artifact data returned as part of [`LoadWorkspaceResult`].
/// Ordered to match `LoadWorkspaceResult::sessions` by index.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceSessionData {
    pub bookmarks: Vec<Bookmark>,
    /// Legacy per-session analyses payload — populated only when the source
    /// `.ltw` predates the analyses migration (see `LtwSessionData::analyses`
    /// / `workspace::ltw_v4` module doc). Current files always read `[]` here;
    /// the workspace's real analyses are on [`LoadWorkspaceResult::analyses`].
    pub analyses: Vec<AnalysisArtifact>,
    pub active_processor_ids: Vec<String>,
    pub disabled_processor_ids: Vec<String>,
}

/// Result of reading a `.ltw` v4 file.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceResult {
    pub workspace_name: String,
    /// Stable workspace id from the manifest, or null for legacy files. Q3's
    /// trust gate (`assessRestoreCandidate`) matches this against the app-state
    /// entry's id before a silent restore.
    pub workspace_id: Option<String>,
    /// Manifest `savedAt` (epoch-ms). Q3 compares it against the recorded
    /// `lastAutoSaveAt` when the candidate is the auto-save.
    #[ts(type = "number")]
    pub saved_at: i64,
    pub sessions: Vec<LtwManifestSession>,
    pub pipeline_chain: LtwPipelineChain,
    pub editor_tabs: Vec<LtwEditorTab>,
    #[ts(type = "unknown")]
    pub layout: Option<LtwLayout>,
    /// Workspace-level analyses (top-level `analyses.json`). Empty for a
    /// pre-migration file — see [`LoadWorkspaceSessionData::analyses`] for
    /// where that data surfaces instead.
    pub analyses: Vec<AnalysisArtifact>,
    /// Per-session artifacts ordered to match `sessions` by index.
    pub session_data: Vec<LoadWorkspaceSessionData>,
}

/// Read a `.ltw` v4 file and return its contents.
///
/// Reading a workspace hands the caller every session path it contains, and
/// [`load_and_restore`] will go on to open them — so for an `Agent` the
/// `.ltw` itself must pass `authorize_open`, exactly like any other file an
/// agent asks the app to read.
pub fn load(ctx: &ServiceCtx, path: &str) -> Result<LoadWorkspaceResult, ServiceError> {
    let authorized = super::policy::authorize_open(ctx, path)?;
    let data = ltw_v4::read_ltw(&authorized).map_err(ServiceError::Internal)?;

    let session_data = data
        .sessions
        .iter()
        .map(|s| LoadWorkspaceSessionData {
            bookmarks: s.bookmarks.clone(),
            analyses: s.analyses.clone(),
            active_processor_ids: s.session_meta.active_processor_ids.clone(),
            disabled_processor_ids: s.session_meta.disabled_processor_ids.clone(),
        })
        .collect();

    let result = LoadWorkspaceResult {
        workspace_name: data.manifest.workspace_name,
        workspace_id: data.manifest.workspace_id,
        saved_at: data.manifest.saved_at,
        sessions: data.manifest.sessions,
        pipeline_chain: data.pipeline_chain,
        editor_tabs: data.editor_tabs,
        layout: data.layout,
        analyses: data.analyses,
        session_data,
    };

    ctx.journal(
        "workspace.load",
        None,
        format!(
            "loaded workspace '{}' ({} session(s))",
            result.workspace_name,
            result.sessions.len()
        ),
    );
    Ok(result)
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/// What one [`restore_session`] call actually merged.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionResult {
    pub session_id: String,
    pub bookmark_count: usize,
    pub analysis_count: usize,
}

/// Restore bookmarks, analyses and pipeline meta for a session that was just
/// opened as part of a `.ltw` workspace restore, and emit
/// `workspace-restored`.
///
/// Also emits `analysis-update` (`restored`) — but only when at least one
/// LEGACY per-session analysis was actually merged into the workspace-owned
/// store (`options.analyses` is non-empty only for a pre-migration `.ltw`;
/// see [`LoadWorkspaceSessionData::analyses`]). Without that second emit, a
/// legacy `.ltw`'s per-session analyses land in `AppState::analyses` but the
/// frontend's analysis list — already fetched earlier in the restore
/// sequence, before this session's artifacts existed — never learns anything
/// changed, so those analyses stay invisible until the app restarts. Current
/// (post-migration) files carry their analyses in the top-level
/// `analyses.json` and go through `analyses::set_workspace`, which emits the
/// same event itself. Gated on `analysis_count > 0` to avoid a gratuitous
/// re-list on every bookmark-only restore.
///
/// Autosave is suppressed during a workspace restore (see
/// `AppState::autosave_switch_suppressed_until`), so neither emit has a
/// persistence side effect — and this deliberately does NOT call
/// `schedule_autosave`: restoring a workspace must not immediately re-persist
/// what was just loaded (same rule as `analyses::set_workspace`). For the
/// same reason it is not journaled — the enclosing `workspace.load` /
/// `workspace.switch` entry already records the caller's action.
pub fn restore_session(
    ctx: &ServiceCtx,
    options: RestoreSessionOptions,
) -> Result<RestoreSessionResult, ServiceError> {
    let meta = SessionMeta {
        active_processor_ids: options.active_processor_ids,
        disabled_processor_ids: options.disabled_processor_ids,
    };

    let (bm_count, an_count) = crate::commands::files::restore_artifacts(
        ctx.state(),
        &options.session_id,
        options.bookmarks,
        options.analyses,
    );

    super::sessions::emit_workspace_restored(
        ctx,
        &options.session_id,
        bm_count,
        an_count,
        meta,
        "workspace",
    );

    if an_count > 0 {
        ctx.events().emit_json(
            "analysis-update",
            serde_json::to_value(AnalysisUpdateEvent {
                artifact_id: String::new(),
                action: "restored".to_string(),
                session_ids: vec![],
                session_id: None,
            })
            .unwrap_or_default(),
        );
    }

    Ok(RestoreSessionResult {
        session_id: options.session_id,
        bookmark_count: bm_count,
        analysis_count: an_count,
    })
}

/// One manifest entry's outcome inside [`load_and_restore`].
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoredSession {
    /// The manifest's `filePath` for this entry.
    pub file_path: String,
    /// Session ids the open actually produced (a `.lts` entry yields several).
    pub session_ids: Vec<String>,
    /// Per-session restore results, in the same order as `session_ids`. Empty
    /// when the open failed.
    pub restored: Vec<RestoreSessionResult>,
    /// Why this entry did not restore, or null on success. A failed entry
    /// never aborts the remaining ones — a workspace whose third log file was
    /// deleted still restores the other four.
    pub error: Option<String>,
}

/// A whole agent-driven workspace open: [`begin_switch`], [`load`], then open
/// and [`restore_session`] every manifest entry in order.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLoadOutcome {
    pub workspace: LoadWorkspaceResult,
    pub sessions: Vec<RestoredSession>,
}

/// Open a workspace end to end: arm the autosave switch window, read the
/// `.ltw`, then open each session it names and restore that session's
/// artifacts.
///
/// This is the **agent** entry point. The desktop does not call it: the
/// frontend runs its own restore rules (`src-next/hooks/workspace/*.ts`) —
/// trust assessment, drift detection, artifact/session pairing, auto-run
/// scheduling — over the same primitives, and those rules stay in TypeScript
/// (plans/service-layer-phase1.md "Out of scope").
///
/// Sessions are opened **sequentially**, not concurrently: each open takes
/// the `sessions` lock and closes any stale session for the same path, and a
/// deterministic order makes the emitted `session-opened` /
/// `workspace-restored` stream reproducible for the frontend watching it.
/// One entry failing (file moved, unreadable, outside the agent's allowlist)
/// is recorded on that entry and the rest still restore.
///
/// Every open goes through [`super::sessions::open`], so an agent's workspace
/// load cannot reach a file its allowlist would refuse — a `.ltw` is a list
/// of paths, and honouring it blindly would be an allowlist bypass.
pub async fn load_and_restore(
    ctx: &ServiceCtx,
    path: &str,
) -> Result<WorkspaceLoadOutcome, ServiceError> {
    begin_switch(ctx)?;
    let workspace = load(ctx, path)?;

    let mut sessions = Vec::with_capacity(workspace.sessions.len());
    for (index, manifest) in workspace.sessions.iter().enumerate() {
        let data = workspace.session_data.get(index);

        let override_type = match manifest.source_type_override.as_deref() {
            None => None,
            Some(label) => match crate::core::session::SourceType::from_label(label) {
                Some(t) => Some(t),
                None => {
                    sessions.push(RestoredSession {
                        file_path: manifest.file_path.clone(),
                        session_ids: vec![],
                        restored: vec![],
                        error: Some(format!("Unknown source type '{label}'")),
                    });
                    continue;
                }
            },
        };

        let opened =
            super::sessions::open(ctx.clone(), &manifest.file_path, override_type).await;
        let opened = match opened {
            Ok(results) => results,
            Err(e) => {
                sessions.push(RestoredSession {
                    file_path: manifest.file_path.clone(),
                    session_ids: vec![],
                    restored: vec![],
                    error: Some(e.message()),
                });
                continue;
            }
        };

        let session_ids: Vec<String> = opened.iter().map(|r| r.session_id.clone()).collect();

        // A `.lts` entry expands into several sessions and carries its own
        // per-session artifacts inside the bundle (already restored by
        // `sessions::open`), so the manifest's single artifact slot applies
        // only to the first produced session — which for every non-`.lts`
        // entry is the only one.
        let mut restored = Vec::new();
        if let (Some(first), Some(data)) = (session_ids.first(), data) {
            restored.push(restore_session(
                ctx,
                RestoreSessionOptions {
                    session_id: first.clone(),
                    bookmarks: data.bookmarks.clone(),
                    analyses: data.analyses.clone(),
                    active_processor_ids: data.active_processor_ids.clone(),
                    disabled_processor_ids: data.disabled_processor_ids.clone(),
                },
            )?);
        }

        sessions.push(RestoredSession {
            file_path: manifest.file_path.clone(),
            session_ids,
            restored,
            error: None,
        });
    }

    // Workspace-owned analyses (top-level `analyses.json`) replace the store
    // wholesale, mirroring what the frontend's restore does via
    // `setWorkspaceAnalyses`.
    super::analyses::set_workspace(ctx, workspace.analyses.clone())?;

    Ok(WorkspaceLoadOutcome {
        workspace,
        sessions,
    })
}

// ---------------------------------------------------------------------------
// app-state.json
// ---------------------------------------------------------------------------

/// Read `app-state.json` (the persisted workspace list + active id).
///
/// A missing file is the normal first-run case and yields the empty default;
/// a corrupt one is renamed aside and also yields the default — see
/// [`crate::workspace::app_state::load_app_state`].
pub fn app_state(ctx: &ServiceCtx) -> Result<AppStateFile, ServiceError> {
    let path = app_state_path(ctx)?;
    Ok(app_state_file::load_app_state(&path))
}

/// Write `app-state.json`.
///
/// The destination is app-owned (always `app_data_dir/app-state.json`) with
/// no caller-supplied path component at all, so [`super::policy::authorize_write_dest`]'s
/// allowlist containment has nothing to check — there is no destination for a
/// caller to choose. The bridge deliberately exposes no route for this: an
/// agent has no business rewriting the desktop's workspace list wholesale.
pub fn save_app_state(ctx: &ServiceCtx, file: AppStateFile) -> Result<(), ServiceError> {
    let path = app_state_path(ctx)?;
    // Serialise against the background flush's read-modify-write of the same
    // file so the two writers never tear it (a corrupt app-state.json parses
    // as the empty default, which would silently drop the whole workspace
    // list).
    let _guard = ctx
        .state()
        .app_state_write_lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    app_state_file::save_app_state(&path, &file).map_err(ServiceError::Internal)
}

/// The persisted workspace list, without the active-id field.
pub fn list(ctx: &ServiceCtx) -> Result<Vec<WorkspaceEntry>, ServiceError> {
    Ok(app_state(ctx)?.workspaces)
}

/// What the backend currently believes the active workspace is.
///
/// Merges the in-memory [`WorkspaceEnvelope`] (the frontend-supplied shell:
/// name, chain, editor tabs, layout presence) with the active
/// `app-state.json` entry (persisted paths and dirty flag) and the live
/// session set. Everything is optional because a freshly-started app has no
/// envelope until the frontend pushes one.
#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    /// Explicit `.ltw` path, from the envelope or the app-state entry.
    pub ltw_path: Option<String>,
    /// Id-keyed auto-save path recorded in `app-state.json`, if any.
    pub auto_save_path: Option<String>,
    #[ts(type = "number | null")]
    pub last_auto_save_at: Option<i64>,
    pub dirty: Option<bool>,
    pub pipeline_chain: Vec<String>,
    pub disabled_chain_ids: Vec<String>,
    pub editor_tab_count: usize,
    /// Whether the envelope carries a layout tree. The tree itself is opaque
    /// and is never returned over the bridge.
    pub has_layout: bool,
    /// Session ids the envelope was cached against.
    pub envelope_session_ids: Vec<String>,
    /// Session ids currently eligible for workspace persistence.
    pub open_session_ids: Vec<String>,
    #[ts(type = "number | null")]
    pub envelope_updated_at: Option<i64>,
}

/// Build a [`WorkspaceSummary`] for the active workspace. A read: not
/// journaled.
pub fn current(ctx: &ServiceCtx) -> Result<WorkspaceSummary, ServiceError> {
    let state = ctx.state();

    let envelope: Option<WorkspaceEnvelope> = state
        .workspace_envelope
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();

    let file = app_state(ctx)?;
    let active_id = envelope
        .as_ref()
        .map(|e| e.workspace_id.clone())
        .or_else(|| file.active_workspace_id.clone());
    let entry = active_id
        .as_deref()
        .and_then(|id| file.workspaces.iter().find(|w| w.id == id));

    let open_session_ids = snapshot_session_ids(state).unwrap_or_default();

    Ok(WorkspaceSummary {
        workspace_id: active_id,
        workspace_name: envelope
            .as_ref()
            .map(|e| e.workspace_name.clone())
            .or_else(|| entry.map(|w| w.name.clone())),
        ltw_path: envelope
            .as_ref()
            .and_then(|e| e.ltw_path.clone())
            .or_else(|| entry.and_then(|w| w.ltw_path.clone())),
        auto_save_path: entry.and_then(|w| w.auto_save_path.clone()),
        last_auto_save_at: entry.and_then(|w| w.last_auto_save_at),
        dirty: entry.map(|w| w.dirty),
        pipeline_chain: envelope
            .as_ref()
            .map(|e| e.pipeline_chain.chain.clone())
            .unwrap_or_default(),
        disabled_chain_ids: envelope
            .as_ref()
            .map(|e| e.pipeline_chain.disabled_ids.clone())
            .unwrap_or_default(),
        editor_tab_count: envelope.as_ref().map_or(0, |e| e.editor_tabs.len()),
        has_layout: envelope.as_ref().is_some_and(|e| e.layout.is_some()),
        envelope_session_ids: envelope
            .as_ref()
            .map(|e| e.session_ids.clone())
            .unwrap_or_default(),
        open_session_ids,
        envelope_updated_at: envelope.as_ref().map(|e| e.updated_at),
    })
}

// ---------------------------------------------------------------------------
// Rename / delete
// ---------------------------------------------------------------------------

/// Reject a workspace display name that is empty, over-long, or carries a
/// path separator.
fn validate_workspace_name(name: &str) -> Result<(), ServiceError> {
    if name.is_empty() || name.chars().count() > 128 || name.contains(['/', '\\']) {
        return Err(ServiceError::invalid_arg(
            "workspace name must be 1-128 characters with no path separators",
        ));
    }
    Ok(())
}

/// Rename a workspace's `app-state.json` entry.
///
/// Updates only the persisted entry's `name`. The `.ltw` manifest's own
/// `workspaceName` field (`workspace::ltw_v4::LtwManifest`) is written once,
/// at save/autosave time, and is deliberately **not** rewritten here — doing
/// so would mean opening and re-zipping the `.ltw` on every rename, and the
/// manifest schema is out of this function's scope to touch. A renamed
/// workspace picks up its new name in the manifest the next time it is
/// saved or auto-saved, same as any other envelope change.
///
/// `Ui` and `Agent` are both allowed unconditionally — a display name carries
/// no path or content an agent could use to widen its allowlist.
pub fn rename_workspace(
    ctx: &ServiceCtx,
    request: RenameWorkspaceRequest,
) -> Result<WorkspaceEntry, ServiceError> {
    validate_workspace_name(&request.new_name)?;

    let mut file = app_state(ctx)?;
    let entry = file
        .workspaces
        .iter_mut()
        .find(|w| w.id == request.workspace_id)
        .ok_or_else(|| ServiceError::NotFound(format!("Workspace '{}' not found", request.workspace_id)))?;
    entry.name = request.new_name.clone();
    let updated = entry.clone();

    save_app_state(ctx, file)?;

    ctx.journal(
        "workspace.rename",
        None,
        format!("renamed workspace '{}' to '{}'", request.workspace_id, request.new_name),
    );
    ctx.events().emit_json(
        "workspace-list-changed",
        serde_json::to_value(WorkspaceListChangedEvent {
            workspace_id: request.workspace_id,
            action: "renamed".to_string(),
        })
        .unwrap_or_default(),
    );
    Ok(updated)
}

/// Delete `path` if — and only if — it names a regular file that exists.
/// Never follows a symlink and never removes a directory: `symlink_metadata`
/// (unlike `metadata`) does not follow the final component, so a symlink is
/// reported as a symlink, not as whatever it points to, and is left alone.
/// Missing or non-regular is a silent no-op — the caller only wants to clean
/// up what is actually there.
fn remove_regular_file_if_present(path: &Path) {
    let is_regular_file = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file());
    if is_regular_file {
        let _ = std::fs::remove_file(path);
    }
}

/// Remove a workspace from `app-state.json`, and its auto-save file if any.
///
/// Refuses to delete the **active** workspace (`app-state.json`'s
/// `activeWorkspaceId`) unless `request.force` is set. When forced, every
/// currently open session is closed first via [`begin_switch`] +
/// [`super::sessions::close`] — the same sequence an ordinary switch already
/// uses, not a second implementation of session teardown — and the cached
/// in-memory envelope (if it belonged to this workspace) is cleared so a
/// late autosave flush cannot resurrect a shell for an entry that no longer
/// exists.
///
/// `delete_file` additionally deletes the entry's explicit `.ltw` (at
/// `ltwPath`, if set), subject to [`super::policy::authorize_write_dest`] for
/// an `Agent` caller — the same allowlist gate export and workspace-save use.
/// `Ui` passes through untouched. See [`remove_regular_file_if_present`] for
/// the safety rule every file removal here follows.
pub fn delete_workspace(ctx: &ServiceCtx, request: DeleteWorkspaceRequest) -> Result<(), ServiceError> {
    let mut file = app_state(ctx)?;
    let index = file
        .workspaces
        .iter()
        .position(|w| w.id == request.workspace_id)
        .ok_or_else(|| ServiceError::NotFound(format!("Workspace '{}' not found", request.workspace_id)))?;

    // Authorize the explicit `.ltw` removal BEFORE any mutation (closing
    // sessions, dropping the auto-save file, editing app-state): a refused
    // agent request must be all-or-nothing and leave every file in place.
    let ltw_dest = if request.delete_file {
        match file.workspaces[index].ltw_path.as_deref() {
            Some(ltw_path) => Some(super::policy::authorize_write_dest(ctx, ltw_path)?),
            None => None,
        }
    } else {
        None
    };

    let is_active = file.active_workspace_id.as_deref() == Some(request.workspace_id.as_str());
    if is_active {
        if !request.force {
            return Err(ServiceError::Conflict(format!(
                "workspace '{}' is active; pass force to close it first",
                request.workspace_id
            )));
        }
        begin_switch(ctx)?;
        for session_id in snapshot_session_ids(ctx.state())? {
            super::sessions::close(ctx, &session_id)?;
        }
        let mut envelope = ctx
            .state()
            .workspace_envelope
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if envelope.as_ref().map(|e| e.workspace_id.as_str()) == Some(request.workspace_id.as_str()) {
            *envelope = None;
        }
        drop(envelope);
        file.active_workspace_id = None;
    }

    let entry = file.workspaces.remove(index);

    if let Some(auto_save_path) = entry.auto_save_path.as_deref() {
        remove_regular_file_if_present(Path::new(auto_save_path));
    }
    if let Some(dest) = ltw_dest.as_deref() {
        remove_regular_file_if_present(dest);
    }

    save_app_state(ctx, file)?;

    ctx.journal("workspace.delete", None, format!("deleted workspace '{}'", request.workspace_id));
    ctx.events().emit_json(
        "workspace-list-changed",
        serde_json::to_value(WorkspaceListChangedEvent {
            workspace_id: request.workspace_id,
            action: "deleted".to_string(),
        })
        .unwrap_or_default(),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;

    fn chain() -> LtwPipelineChain {
        LtwPipelineChain {
            chain: vec!["proc-a".to_string(), "proc-b".to_string()],
            disabled_ids: vec!["proc-b".to_string()],
        }
    }

    fn save_options(dest: &Path) -> SaveWorkspaceOptions {
        SaveWorkspaceOptions {
            workspace_id: "ws-1".to_string(),
            dest_path: dest.to_string_lossy().to_string(),
            workspace_name: "My Workspace".to_string(),
            editor_tabs: vec![],
            layout: None,
            pipeline_chain: chain().chain,
            disabled_chain_ids: chain().disabled_ids,
        }
    }

    // -- save / load round trip ---------------------------------------------

    #[test]
    fn save_then_load_round_trips_the_manifest() {
        let (ctx, tmp) = test_ctx().build();
        let dest = tmp.path().join("round-trip.ltw");

        save(&ctx, save_options(&dest)).expect("save should succeed");
        let loaded = load(&ctx, &dest.to_string_lossy()).expect("load should succeed");

        assert_eq!(loaded.workspace_name, "My Workspace");
        assert_eq!(loaded.workspace_id.as_deref(), Some("ws-1"));
        assert_eq!(loaded.pipeline_chain.chain, chain().chain);
        assert_eq!(loaded.pipeline_chain.disabled_ids, chain().disabled_ids);
        assert!(loaded.sessions.is_empty(), "no sessions were open");
    }

    /// `save` and `auto_save` were extracted onto the shared
    /// `write_workspace_snapshot` helper. They differ only in which path they
    /// target and what they cache as the envelope's `ltw_path` — the `.ltw`
    /// file itself must come out equivalent (aside from `saved_at`, a fresh
    /// timestamp per call) regardless of which caller shape drives it.
    #[test]
    fn save_and_auto_save_produce_equivalent_files() {
        let (ctx, tmp) = test_ctx().build();
        let dest_explicit = tmp.path().join("explicit.ltw");

        save(&ctx, save_options(&dest_explicit)).expect("explicit save");
        let auto_path = auto_save(
            &ctx,
            AutoSaveWorkspaceOptions {
                workspace_id: "ws-1".to_string(),
                workspace_name: "My Workspace".to_string(),
                editor_tabs: vec![],
                layout: None,
                pipeline_chain: chain().chain,
                disabled_chain_ids: chain().disabled_ids,
            },
        )
        .expect("auto-save");

        let a = ltw_v4::read_ltw(&dest_explicit).expect("read explicit-save file");
        let b = ltw_v4::read_ltw(Path::new(&auto_path)).expect("read auto-save file");

        assert_eq!(a.manifest.workspace_name, b.manifest.workspace_name);
        assert_eq!(a.manifest.workspace_id, b.manifest.workspace_id);
        assert_eq!(a.pipeline_chain.chain, b.pipeline_chain.chain);
        assert_eq!(a.pipeline_chain.disabled_ids, b.pipeline_chain.disabled_ids);

        // The last call (auto-save) is what's cached; its ltw_path must be
        // None, matching auto_save's own semantics.
        let cached = ctx
            .state()
            .workspace_envelope
            .lock()
            .expect("envelope lock")
            .clone()
            .expect("envelope should be cached");
        assert_eq!(cached.ltw_path, None);
        assert_eq!(cached.workspace_id, "ws-1");
    }

    #[test]
    fn auto_save_lands_under_the_app_data_workspaces_dir() {
        let (ctx, tmp) = test_ctx().build();
        let path = auto_save(
            &ctx,
            AutoSaveWorkspaceOptions {
                workspace_id: "ws-7".to_string(),
                workspace_name: "W".to_string(),
                editor_tabs: vec![],
                layout: None,
                pipeline_chain: vec![],
                disabled_chain_ids: vec![],
            },
        )
        .expect("auto-save");
        assert_eq!(
            Path::new(&path),
            tmp.path().join("workspaces").join("ws-7.ltw")
        );
    }

    #[test]
    fn auto_save_rejects_a_traversing_workspace_id() {
        let (ctx, _tmp) = test_ctx().build();
        let err = auto_save(
            &ctx,
            AutoSaveWorkspaceOptions {
                workspace_id: "../escape".to_string(),
                workspace_name: "W".to_string(),
                editor_tabs: vec![],
                layout: None,
                pipeline_chain: vec![],
                disabled_chain_ids: vec![],
            },
        )
        .expect_err("a traversing id must not reach the filesystem");
        assert_eq!(err.code(), "INVALID_ARGUMENT");
    }

    // -- layout opacity ------------------------------------------------------

    #[test]
    fn layout_tree_survives_a_round_trip_untouched() {
        let (ctx, tmp) = test_ctx().build();
        let dest = tmp.path().join("layout.ltw");
        let layout = serde_json::json!({
            "direction": "row",
            "children": [{ "id": "pane-1" }, { "nested": { "deep": [1, 2, 3] } }]
        });

        let mut options = save_options(&dest);
        options.layout = Some(layout.clone());
        save(&ctx, options).expect("save");

        let loaded = load(&ctx, &dest.to_string_lossy()).expect("load");
        assert_eq!(
            loaded.layout.as_ref(),
            Some(&layout),
            "the backend must never reshape the frontend-owned layout tree"
        );
    }

    // -- envelope / switch ---------------------------------------------------

    #[test]
    fn sync_envelope_caches_without_writing_a_file() {
        let (ctx, tmp) = test_ctx().build();
        sync_envelope(
            &ctx,
            SyncWorkspaceEnvelopeOptions {
                workspace_id: "ws-9".to_string(),
                workspace_name: "Synced".to_string(),
                ltw_path: Some("C:\\ws\\synced.ltw".to_string()),
                editor_tabs: vec![],
                layout: None,
                pipeline_chain: vec!["p".to_string()],
                disabled_chain_ids: vec![],
            },
        )
        .expect("sync");

        let cached = ctx
            .state()
            .workspace_envelope
            .lock()
            .unwrap()
            .clone()
            .expect("envelope cached");
        assert_eq!(cached.workspace_name, "Synced");
        assert_eq!(cached.ltw_path.as_deref(), Some("C:\\ws\\synced.ltw"));
        // Nothing written.
        assert!(std::fs::read_dir(tmp.path())
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn begin_switch_arms_the_autosave_suppression_window() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(!autosave::switch_suppression_active(ctx.state()));
        begin_switch(&ctx).expect("begin switch");
        assert!(autosave::switch_suppression_active(ctx.state()));
    }

    #[test]
    fn caching_an_envelope_clears_the_switch_window() {
        let (ctx, _tmp) = test_ctx().build();
        begin_switch(&ctx).expect("begin switch");
        sync_envelope(
            &ctx,
            SyncWorkspaceEnvelopeOptions {
                workspace_id: "ws-1".to_string(),
                workspace_name: "W".to_string(),
                ltw_path: None,
                editor_tabs: vec![],
                layout: None,
                pipeline_chain: vec![],
                disabled_chain_ids: vec![],
            },
        )
        .expect("sync");
        assert!(!autosave::switch_suppression_active(ctx.state()));
    }

    // -- restore -------------------------------------------------------------

    #[test]
    fn restore_session_applies_meta_and_emits_workspace_restored() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();

        let result = restore_session(
            &ctx,
            RestoreSessionOptions {
                session_id: "sess-a".to_string(),
                bookmarks: vec![],
                analyses: vec![],
                active_processor_ids: vec!["proc-a".to_string()],
                disabled_processor_ids: vec!["proc-b".to_string()],
            },
        )
        .expect("restore");

        assert_eq!(result.session_id, "sess-a");
        let meta = ctx.state().session_pipeline_meta.lock().unwrap();
        assert_eq!(meta.get("sess-a").unwrap().active_processor_ids, vec!["proc-a"]);
        drop(meta);

        let ev = sink.only_event("workspace-restored");
        assert_eq!(ev["sessionId"], "sess-a");
        assert_eq!(ev["bookmarkCount"], 0);
        assert_eq!(ev["analysisCount"], 0);
        assert_eq!(ev["activeProcessorIds"], serde_json::json!(["proc-a"]));
        assert_eq!(ev["disabledProcessorIds"], serde_json::json!(["proc-b"]));
        assert_eq!(ev["source"], "workspace");
    }

    /// A bookmark-only restore must NOT re-list analyses — the extra emit
    /// exists only for legacy per-session analyses.
    #[test]
    fn restore_session_does_not_emit_analysis_update_without_legacy_analyses() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        restore_session(
            &ctx,
            RestoreSessionOptions {
                session_id: "sess-a".to_string(),
                bookmarks: vec![],
                analyses: vec![],
                active_processor_ids: vec!["proc-a".to_string()],
                disabled_processor_ids: vec![],
            },
        )
        .expect("restore");
        assert!(sink.events_named("analysis-update").is_empty());
    }

    #[test]
    fn restore_session_emits_analysis_update_for_legacy_per_session_analyses() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        restore_session(
            &ctx,
            RestoreSessionOptions {
                session_id: "sess-a".to_string(),
                bookmarks: vec![],
                analyses: vec![AnalysisArtifact {
                    id: "art-1".to_string(),
                    title: "Legacy".to_string(),
                    created_at: 0,
                    sections: vec![],
                    legacy_session_id: None,
                }],
                active_processor_ids: vec![],
                disabled_processor_ids: vec![],
            },
        )
        .expect("restore");
        let ev = sink.only_event("analysis-update");
        assert_eq!(ev["action"], "restored");
    }

    /// Restoring is not a mutation the workspace should immediately persist —
    /// it would write back what was just loaded.
    #[test]
    fn restore_session_does_not_schedule_an_autosave() {
        let (ctx, _tmp) = test_ctx().build();
        let before = ctx
            .state()
            .autosave_generation
            .load(std::sync::atomic::Ordering::Relaxed);
        restore_session(
            &ctx,
            RestoreSessionOptions {
                session_id: "sess-a".to_string(),
                bookmarks: vec![],
                analyses: vec![],
                active_processor_ids: vec!["p".to_string()],
                disabled_processor_ids: vec![],
            },
        )
        .expect("restore");
        assert_eq!(
            ctx.state()
                .autosave_generation
                .load(std::sync::atomic::Ordering::Relaxed),
            before
        );
    }

    // -- app-state -----------------------------------------------------------

    #[test]
    fn app_state_round_trips_and_list_returns_the_entries() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(app_state(&ctx).unwrap().workspaces.is_empty());

        save_app_state(
            &ctx,
            AppStateFile {
                workspaces: vec![WorkspaceEntry {
                    id: "ws-1".to_string(),
                    name: "wifi-debug".to_string(),
                    ltw_path: Some("C:\\ws\\wifi.ltw".to_string()),
                    dirty: false,
                    auto_save_path: None,
                    last_auto_save_at: None,
                }],
                active_workspace_id: Some("ws-1".to_string()),
            },
        )
        .expect("save app state");

        let file = app_state(&ctx).expect("read back");
        assert_eq!(file.active_workspace_id.as_deref(), Some("ws-1"));
        let entries = list(&ctx).expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "wifi-debug");
    }

    #[test]
    fn current_merges_the_envelope_with_the_app_state_entry() {
        let (ctx, _tmp) = test_ctx().build();
        save_app_state(
            &ctx,
            AppStateFile {
                workspaces: vec![WorkspaceEntry {
                    id: "ws-1".to_string(),
                    name: "persisted-name".to_string(),
                    ltw_path: None,
                    dirty: true,
                    auto_save_path: Some("C:\\auto\\ws-1.ltw".to_string()),
                    last_auto_save_at: Some(1_700_000_000_123),
                }],
                active_workspace_id: Some("ws-1".to_string()),
            },
        )
        .expect("save app state");

        sync_envelope(
            &ctx,
            SyncWorkspaceEnvelopeOptions {
                workspace_id: "ws-1".to_string(),
                workspace_name: "live-name".to_string(),
                ltw_path: None,
                editor_tabs: vec![],
                layout: Some(serde_json::json!({ "direction": "row" })),
                pipeline_chain: vec!["proc-a".to_string()],
                disabled_chain_ids: vec!["proc-b".to_string()],
            },
        )
        .expect("sync");

        let summary = current(&ctx).expect("current");
        assert_eq!(summary.workspace_id.as_deref(), Some("ws-1"));
        // The live envelope wins over the persisted name.
        assert_eq!(summary.workspace_name.as_deref(), Some("live-name"));
        assert_eq!(summary.auto_save_path.as_deref(), Some("C:\\auto\\ws-1.ltw"));
        assert_eq!(summary.last_auto_save_at, Some(1_700_000_000_123));
        assert_eq!(summary.dirty, Some(true));
        assert_eq!(summary.pipeline_chain, vec!["proc-a"]);
        assert!(summary.has_layout, "layout presence is reported, not its shape");
    }

    #[test]
    fn current_is_empty_before_any_envelope_is_pushed() {
        let (ctx, _tmp) = test_ctx().build();
        let summary = current(&ctx).expect("current");
        assert!(summary.workspace_id.is_none());
        assert!(!summary.has_layout);
        assert!(summary.pipeline_chain.is_empty());
    }

    // -- gates ---------------------------------------------------------------
    //
    // `authorize_write_dest`'s own gate tests (formerly `authorize_write`
    // here) now live in `services::policy`, next to the consolidated
    // function. What remains here is end-to-end: `save` must actually honor
    // the gate's refusal rather than writing anyway.

    #[test]
    fn agent_save_outside_the_allowlist_never_writes() {
        let (ctx, _tmp) = test_ctx().agent("test").build();
        let outside = tempfile::tempdir().expect("outside dir");
        let dest = outside.path().join("sneaky.ltw");
        let err = save(&ctx, save_options(&dest)).expect_err("must be refused");
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert!(!dest.exists(), "a refused save must not have written anything");
    }

    #[test]
    fn agent_load_outside_the_allowlist_is_forbidden() {
        // Write a real `.ltw` as the UI, then try to read it back as an agent
        // whose allowlist does not cover it.
        let (ui, tmp) = test_ctx().build();
        let dest = tmp.path().join("ui-owned.ltw");
        save(&ui, save_options(&dest)).expect("ui save");

        let (agent, _tmp2) = test_ctx().agent("test").build();
        let err = load(&agent, &dest.to_string_lossy()).expect_err("must be refused");
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[test]
    fn agent_load_inside_the_allowlist_is_permitted() {
        let (ui, tmp) = test_ctx().build();
        let dest = tmp.path().join("shared.ltw");
        save(&ui, save_options(&dest)).expect("ui save");

        let (agent, _tmp2) = test_ctx()
            .agent("test")
            .allowlist(tmp.path().to_path_buf())
            .build();
        let loaded = load(&agent, &dest.to_string_lossy()).expect("inside allowlist");
        assert_eq!(loaded.workspace_name, "My Workspace");
    }

    // -- journal -------------------------------------------------------------

    #[test]
    fn save_and_load_are_journaled_but_reads_are_not() {
        let (ctx, tmp) = test_ctx().build();
        let dest = tmp.path().join("journal.ltw");
        save(&ctx, save_options(&dest)).expect("save");
        load(&ctx, &dest.to_string_lossy()).expect("load");
        let _ = current(&ctx).expect("current");
        let _ = list(&ctx).expect("list");

        let actions: Vec<String> = ctx
            .state()
            .activity
            .list(None, None)
            .into_iter()
            .map(|e| e.action)
            .collect();
        assert_eq!(actions, vec!["workspace.save", "workspace.load"]);
    }

    #[test]
    fn begin_switch_is_journaled() {
        let (ctx, _tmp) = test_ctx().build();
        begin_switch(&ctx).expect("switch");
        let actions: Vec<String> = ctx
            .state()
            .activity
            .list(None, None)
            .into_iter()
            .map(|e| e.action)
            .collect();
        assert_eq!(actions, vec!["workspace.switch"]);
    }

    // -----------------------------------------------------------------------
    // rename_workspace / delete_workspace (B3)
    // -----------------------------------------------------------------------

    fn seed_entry(ctx: &ServiceCtx, id: &str, name: &str) {
        save_app_state(
            ctx,
            AppStateFile {
                workspaces: vec![WorkspaceEntry {
                    id: id.to_string(),
                    name: name.to_string(),
                    ltw_path: None,
                    dirty: false,
                    auto_save_path: None,
                    last_auto_save_at: None,
                }],
                active_workspace_id: None,
            },
        )
        .expect("seed entry");
    }

    #[test]
    fn rename_workspace_updates_the_persisted_name_and_journals() {
        let (ctx, _tmp) = test_ctx().build();
        seed_entry(&ctx, "ws-1", "old-name");

        let updated = rename_workspace(
            &ctx,
            RenameWorkspaceRequest { workspace_id: "ws-1".to_string(), new_name: "new-name".to_string() },
        )
        .expect("rename");
        assert_eq!(updated.name, "new-name");
        assert_eq!(list(&ctx).unwrap()[0].name, "new-name");

        let actions: Vec<String> = ctx.state().activity.list(None, None).into_iter().map(|e| e.action).collect();
        assert_eq!(actions, vec!["workspace.rename"]);
    }

    #[test]
    fn rename_workspace_emits_workspace_list_changed() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        seed_entry(&ctx, "ws-1", "old-name");
        rename_workspace(
            &ctx,
            RenameWorkspaceRequest { workspace_id: "ws-1".to_string(), new_name: "new-name".to_string() },
        )
        .expect("rename");
        let ev = sink.only_event("workspace-list-changed");
        assert_eq!(ev["workspaceId"], "ws-1");
        assert_eq!(ev["action"], "renamed");
    }

    #[test]
    fn rename_workspace_unknown_id_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = rename_workspace(
            &ctx,
            RenameWorkspaceRequest { workspace_id: "nope".to_string(), new_name: "x".to_string() },
        )
        .unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn rename_workspace_rejects_an_empty_or_overlong_or_path_like_name() {
        let (ctx, _tmp) = test_ctx().build();
        seed_entry(&ctx, "ws-1", "old-name");

        for bad in ["", &"x".repeat(129), "a/b", "a\\b"] {
            let err = rename_workspace(
                &ctx,
                RenameWorkspaceRequest { workspace_id: "ws-1".to_string(), new_name: bad.to_string() },
            )
            .expect_err(&format!("{bad:?} must be rejected"));
            assert_eq!(err.code(), "INVALID_ARGUMENT");
        }
    }

    #[test]
    fn rename_workspace_is_allowed_for_an_agent_caller() {
        let (ctx, _tmp) = test_ctx().agent("test").build();
        seed_entry(&ctx, "ws-1", "old-name");
        let updated = rename_workspace(
            &ctx,
            RenameWorkspaceRequest { workspace_id: "ws-1".to_string(), new_name: "renamed".to_string() },
        )
        .expect("agents may rename");
        assert_eq!(updated.name, "renamed");
    }

    #[test]
    fn delete_workspace_unknown_id_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = delete_workspace(
            &ctx,
            DeleteWorkspaceRequest { workspace_id: "nope".to_string(), delete_file: false, force: false },
        )
        .unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn delete_workspace_removes_the_entry_and_journals() {
        let (ctx, _tmp) = test_ctx().build();
        seed_entry(&ctx, "ws-1", "gone-soon");

        delete_workspace(
            &ctx,
            DeleteWorkspaceRequest { workspace_id: "ws-1".to_string(), delete_file: false, force: false },
        )
        .expect("delete");
        assert!(list(&ctx).unwrap().is_empty());

        let actions: Vec<String> = ctx.state().activity.list(None, None).into_iter().map(|e| e.action).collect();
        assert_eq!(actions, vec!["workspace.delete"]);
    }

    #[test]
    fn delete_workspace_emits_workspace_list_changed() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        seed_entry(&ctx, "ws-1", "gone-soon");
        delete_workspace(
            &ctx,
            DeleteWorkspaceRequest { workspace_id: "ws-1".to_string(), delete_file: false, force: false },
        )
        .expect("delete");
        let ev = sink.only_event("workspace-list-changed");
        assert_eq!(ev["workspaceId"], "ws-1");
        assert_eq!(ev["action"], "deleted");
    }

    #[test]
    fn delete_workspace_refuses_the_active_workspace_without_force() {
        let (ctx, _tmp) = test_ctx().build();
        save_app_state(
            &ctx,
            AppStateFile {
                workspaces: vec![WorkspaceEntry {
                    id: "ws-1".to_string(),
                    name: "active".to_string(),
                    ltw_path: None,
                    dirty: false,
                    auto_save_path: None,
                    last_auto_save_at: None,
                }],
                active_workspace_id: Some("ws-1".to_string()),
            },
        )
        .unwrap();

        let err = delete_workspace(
            &ctx,
            DeleteWorkspaceRequest { workspace_id: "ws-1".to_string(), delete_file: false, force: false },
        )
        .unwrap_err();
        assert_eq!(err.code(), "CONFLICT");
        // Refused: the entry must still be there.
        assert_eq!(list(&ctx).unwrap().len(), 1);
    }

    #[test]
    fn delete_workspace_with_force_closes_open_sessions_and_clears_active_id() {
        let mut session = crate::services::testing::fixture_session("sess-a", 1);
        session.file_path = Some("C:\\fake\\a.log".to_string());
        let (ctx, _tmp) = test_ctx().with_session_object(session).build();
        save_app_state(
            &ctx,
            AppStateFile {
                workspaces: vec![WorkspaceEntry {
                    id: "ws-1".to_string(),
                    name: "active".to_string(),
                    ltw_path: None,
                    dirty: false,
                    auto_save_path: None,
                    last_auto_save_at: None,
                }],
                active_workspace_id: Some("ws-1".to_string()),
            },
        )
        .unwrap();

        delete_workspace(
            &ctx,
            DeleteWorkspaceRequest { workspace_id: "ws-1".to_string(), delete_file: false, force: true },
        )
        .expect("forced delete");

        assert!(ctx.state().sessions.lock().unwrap().is_empty(), "open session must be closed");
        assert!(app_state(&ctx).unwrap().active_workspace_id.is_none());
        let actions: Vec<String> = ctx.state().activity.list(None, None).into_iter().map(|e| e.action).collect();
        assert_eq!(actions, vec!["workspace.switch", "session.close", "workspace.delete"]);
    }

    #[test]
    fn delete_workspace_removes_the_auto_save_file_regardless_of_delete_file() {
        let (ctx, tmp) = test_ctx().build();
        let auto_save = tmp.path().join("ws-1.ltw");
        std::fs::write(&auto_save, b"stub").unwrap();
        save_app_state(
            &ctx,
            AppStateFile {
                workspaces: vec![WorkspaceEntry {
                    id: "ws-1".to_string(),
                    name: "w".to_string(),
                    ltw_path: None,
                    dirty: false,
                    auto_save_path: Some(auto_save.to_string_lossy().to_string()),
                    last_auto_save_at: None,
                }],
                active_workspace_id: None,
            },
        )
        .unwrap();

        delete_workspace(
            &ctx,
            DeleteWorkspaceRequest { workspace_id: "ws-1".to_string(), delete_file: false, force: false },
        )
        .expect("delete");
        assert!(!auto_save.exists(), "auto-save file must be removed on delete");
    }

    #[test]
    fn delete_workspace_with_delete_file_removes_the_explicit_ltw_for_ui() {
        let (ctx, tmp) = test_ctx().build();
        let ltw = tmp.path().join("explicit.ltw");
        std::fs::write(&ltw, b"stub").unwrap();
        save_app_state(
            &ctx,
            AppStateFile {
                workspaces: vec![WorkspaceEntry {
                    id: "ws-1".to_string(),
                    name: "w".to_string(),
                    ltw_path: Some(ltw.to_string_lossy().to_string()),
                    dirty: false,
                    auto_save_path: None,
                    last_auto_save_at: None,
                }],
                active_workspace_id: None,
            },
        )
        .unwrap();

        delete_workspace(
            &ctx,
            DeleteWorkspaceRequest { workspace_id: "ws-1".to_string(), delete_file: true, force: false },
        )
        .expect("delete");
        assert!(!ltw.exists(), "explicit .ltw must be removed when delete_file is set");
    }

    #[test]
    fn delete_workspace_with_delete_file_is_refused_for_an_agent_outside_the_allowlist() {
        let (ctx, tmp) = test_ctx().agent("test").build();
        let ltw = tmp.path().join("explicit.ltw");
        std::fs::write(&ltw, b"stub").unwrap();
        let auto_save = tmp.path().join("ws-1.autosave.ltw");
        std::fs::write(&auto_save, b"autosave").unwrap();
        save_app_state(
            &ctx,
            AppStateFile {
                workspaces: vec![WorkspaceEntry {
                    id: "ws-1".to_string(),
                    name: "w".to_string(),
                    ltw_path: Some(ltw.to_string_lossy().to_string()),
                    dirty: false,
                    auto_save_path: Some(auto_save.to_string_lossy().to_string()),
                    last_auto_save_at: None,
                }],
                active_workspace_id: None,
            },
        )
        .unwrap();

        let err = delete_workspace(
            &ctx,
            DeleteWorkspaceRequest { workspace_id: "ws-1".to_string(), delete_file: true, force: false },
        )
        .unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert!(ltw.exists(), "a refused delete must not remove the file");
        // The gate runs before ANY mutation: the auto-save file and the entry
        // must both survive a refusal (all-or-nothing).
        assert!(auto_save.exists(), "a refused delete must not remove the auto-save file");
        assert_eq!(list(&ctx).unwrap().len(), 1);
    }

    #[test]
    fn delete_workspace_never_deletes_a_directory() {
        let (ctx, tmp) = test_ctx().build();
        let dir_as_ltw = tmp.path().join("looks-like-a-workspace.ltw");
        std::fs::create_dir(&dir_as_ltw).unwrap();
        save_app_state(
            &ctx,
            AppStateFile {
                workspaces: vec![WorkspaceEntry {
                    id: "ws-1".to_string(),
                    name: "w".to_string(),
                    ltw_path: Some(dir_as_ltw.to_string_lossy().to_string()),
                    dirty: false,
                    auto_save_path: None,
                    last_auto_save_at: None,
                }],
                active_workspace_id: None,
            },
        )
        .unwrap();

        delete_workspace(
            &ctx,
            DeleteWorkspaceRequest { workspace_id: "ws-1".to_string(), delete_file: true, force: false },
        )
        .expect("delete must still succeed");
        assert!(dir_as_ltw.is_dir(), "a directory must never be removed");
    }

    // -----------------------------------------------------------------------
    // Path twins
    // -----------------------------------------------------------------------
    //
    // Both constants below are duplicated from Tauri-bound twins in
    // `crate::workspace`, which is outside this package's ownership (one of
    // them is `private` there and cannot be imported at all). Rather than
    // trust the duplication, read the twin's source at test time — the same
    // trick `services::tests::services_module_never_imports_tauri` uses — so
    // a rename over there fails here instead of silently splitting the
    // desktop and the services onto two different files.

    fn twin_source(relative: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    #[test]
    fn app_state_path_matches_the_tauri_twin() {
        let needle = format!("APP_STATE_FILENAME: &str = \"{APP_STATE_FILENAME}\"");
        assert!(
            twin_source("src/workspace/app_state.rs").contains(&needle),
            "workspace::app_state::APP_STATE_FILENAME no longer spells {APP_STATE_FILENAME:?} \
             — services::workspace::app_state_path would now target a different file"
        );
    }

    #[test]
    fn workspaces_dir_matches_the_tauri_twin() {
        let needle = format!("data_dir.join(\"{WORKSPACES_SUBDIR}\")");
        assert!(
            twin_source("src/workspace/mod.rs").contains(&needle),
            "workspace::workspace_dir no longer joins {WORKSPACES_SUBDIR:?} \
             — services::workspace::workspaces_dir would now target a different directory"
        );
    }
}
