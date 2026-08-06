//! Tauri commands for workspace lifecycle operations.
//!
//! These commands handle saving/loading `.ltw` v4 workspace files and
//! persisting the application state (`app-state.json`).

use std::path::Path;

use tauri::{Emitter, State};

use crate::commands::{lock_or_err, AppState};
use crate::workspace::app_state::{self, AppStateFile};
use crate::workspace::autosave::{self, WorkspaceEnvelope};
use crate::workspace::ltw_v4::{
    self, LtwEditorTab, LtwLayout, LtwManifestSession, LtwPipelineChain,
};
use crate::workspace::{now_ms, SessionMeta};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared helper: collect session data from AppState
// ---------------------------------------------------------------------------

pub(crate) type SessionEntry = (
    LtwManifestSession,
    Vec<crate::core::bookmark::Bookmark>,
    SessionMeta,
);

/// Snapshot all open sessions and their bookmarks from AppState.
/// Acquires locks briefly: sessions once, bookmarks/meta once each.
///
/// Analyses are workspace-owned (not keyed by session) and are no longer part
/// of this per-session snapshot — they are collected separately via
/// [`crate::commands::workspace_sync::snapshot_workspace_analyses`] and
/// written to the top-level `analyses.json` entry in the `.ltw` (see
/// `workspace::ltw_v4`).
pub(crate) fn collect_session_data(state: &AppState) -> Result<Vec<SessionEntry>, String> {
    // Snapshot session info under brief lock
    // (id, file_path, source_name, source_type, source_type_override)
    let session_info: Vec<(String, String, String, String, Option<String>)> = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
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
        let bm_guard = lock_or_err(&state.bookmarks, "bookmarks")?;
        let meta_guard = lock_or_err(&state.session_pipeline_meta, "session_pipeline_meta")?;
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
pub(crate) fn snapshot_session_ids(state: &AppState) -> Result<Vec<String>, String> {
    let sessions = lock_or_err(&state.sessions, "sessions")?;
    Ok(sessions
        .iter()
        .filter(|(_, session)| {
            session.file_path.is_some() && session.primary_source().is_some()
        })
        .map(|(id, _)| id.clone())
        .collect())
}

/// Build entry refs from collected data (for write_ltw's borrow signature).
pub(crate) fn entry_refs(entries: &[SessionEntry]) -> Vec<(
    LtwManifestSession,
    &[crate::core::bookmark::Bookmark],
    &SessionMeta,
)> {
    entries
        .iter()
        .map(|(m, b, meta)| (m.clone(), b.as_slice(), meta))
        .collect()
}

/// Shared save sequence for `save_workspace_v4` and `auto_save_workspace`:
/// cache the workspace envelope, snapshot session data, then write the
/// `.ltw` file under `state.ltw_write_lock` (serialised against the
/// background flush's write to the same file).
///
/// `envelope_ltw_path` is the one point where the two callers differ:
/// `save_workspace_v4` caches its explicit dest path so a background flush
/// can rebuild this exact shell; `auto_save_workspace` caches `None` because
/// it always recomputes `workspaces/{id}.ltw` itself.
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
) -> Result<(), String> {
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
    let workspace_analyses = crate::commands::workspace_sync::snapshot_workspace_analyses(state);

    // Serialise against the background flush's write on the same file.
    let _guard = state.ltw_write_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    ltw_v4::write_ltw(
        dest_path,
        workspace_name,
        Some(workspace_id),
        &entry_refs(&entries),
        &workspace_analyses,
        chain,
        editor_tabs,
        layout,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Save workspace (.ltw v4)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceOptions {
    /// Stable workspace identifier — cached into the backend envelope so a
    /// background flush can update this workspace's `app-state.json` entry.
    pub workspace_id: String,
    pub dest_path: String,
    pub workspace_name: String,
    pub editor_tabs: Vec<LtwEditorTab>,
    pub layout: Option<LtwLayout>,
    pub pipeline_chain: Vec<String>,
    pub disabled_chain_ids: Vec<String>,
}

/// Collect all open sessions and their artifacts, then write a `.ltw` v4 file.
#[tauri::command]
pub async fn save_workspace_v4(
    state: State<'_, AppState>,
    options: SaveWorkspaceOptions,
) -> Result<(), String> {
    let chain = LtwPipelineChain {
        chain: options.pipeline_chain,
        disabled_ids: options.disabled_chain_ids,
    };

    // Explicit save → ltw_path is the chosen dest path, so a background flush
    // can rebuild this exact workspace shell.
    write_workspace_snapshot(
        &state,
        Path::new(&options.dest_path),
        &options.workspace_id,
        &options.workspace_name,
        Some(options.dest_path.clone()),
        &options.editor_tabs,
        options.layout.as_ref(),
        &chain,
    )
}

// ---------------------------------------------------------------------------
// Auto-save workspace to app_data_dir (for workspace switching)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveWorkspaceOptions {
    /// Stable workspace identifier — keys the auto-save filename so two
    /// distinct workspaces that happen to share a name (e.g. both "Untitled")
    /// no longer collide onto the same file.
    pub workspace_id: String,
    pub workspace_name: String,
    pub editor_tabs: Vec<LtwEditorTab>,
    pub layout: Option<LtwLayout>,
    pub pipeline_chain: Vec<String>,
    pub disabled_chain_ids: Vec<String>,
}

/// Auto-save the active workspace to `app_data_dir/workspaces/{workspace_id}.ltw`.
/// Returns the path where it was saved.
///
/// Keyed by workspace id, not sanitized name: two "Untitled" workspaces used to
/// derive the same `Untitled.ltw` and overwrite each other. Legacy name-keyed
/// files left over from before this change are deliberately not migrated or
/// touched here.
#[tauri::command]
pub async fn auto_save_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    options: AutoSaveWorkspaceOptions,
) -> Result<String, String> {
    let ws_dir = crate::workspace::workspace_dir(&app)?;
    let dest = ws_dir.join(format!("{}.ltw", options.workspace_id));

    let chain = LtwPipelineChain {
        chain: options.pipeline_chain,
        disabled_ids: options.disabled_chain_ids,
    };

    // ltw_path is None: this is the id-keyed auto-save, so a backend flush
    // recomputes `workspaces/{id}.ltw` itself.
    write_workspace_snapshot(
        &state,
        &dest,
        &options.workspace_id,
        &options.workspace_name,
        None,
        &options.editor_tabs,
        options.layout.as_ref(),
        &chain,
    )?;

    dest.to_str()
        .map(str::to_string)
        .ok_or_else(|| "Failed to convert path to string".to_string())
}

// ---------------------------------------------------------------------------
// Sync workspace envelope (Q4) — lightweight backend cache refresh, no I/O
// ---------------------------------------------------------------------------

/// Options for `sync_workspace_envelope`. Mirrors the save options but carries
/// the workspace's explicit `.ltw` path (if any) rather than a dest, and never
/// writes a file.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWorkspaceEnvelopeOptions {
    pub workspace_id: String,
    pub workspace_name: String,
    /// The workspace's explicit `.ltw` path, or null if it only auto-saves to
    /// the id-keyed `workspaces/{id}.ltw`.
    pub ltw_path: Option<String>,
    pub editor_tabs: Vec<LtwEditorTab>,
    pub layout: Option<LtwLayout>,
    pub pipeline_chain: Vec<String>,
    pub disabled_chain_ids: Vec<String>,
}

/// Refresh the backend workspace-envelope cache from the frontend without
/// writing any file. Pushed at the end of a workspace open/switch (so the
/// envelope exists before any MCP artifact write can occur) and whenever the
/// active workspace's identity changes (rename / path update).
#[tauri::command]
pub async fn sync_workspace_envelope(
    state: State<'_, AppState>,
    options: SyncWorkspaceEnvelopeOptions,
) -> Result<(), String> {
    autosave::cache_envelope(
        &state,
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

// ---------------------------------------------------------------------------
// Begin workspace switch — arm the autosave switch-suppression window
// ---------------------------------------------------------------------------

/// Open the backend autosave switch-suppression window at the start of a
/// workspace teardown (new / open / switch).
///
/// The frontend orchestrates a switch as a burst of independent commands
/// (auto-save the outgoing workspace, close each session, restore the incoming
/// one), so there is no single backend "switch" call the flusher could observe.
/// Meanwhile the debounced flush timer is armed by artifact mutations —
/// including over the MCP bridge — so it can fire mid-teardown, independent of
/// any frontend gating. Without this window a flush landing after some (but not
/// all) of the outgoing sessions have closed writes the outgoing shell minus
/// the already-closed sessions, clobbering the complete `.ltw` the switch wrote
/// at its start. This command tells the backend "a transition is underway";
/// [`autosave::flush`] and [`autosave::flush_now_blocking`] then skip until the
/// restore re-caches the envelope (which clears the window) or the window's
/// deadline lapses (bounding a dead-mid-way transition to a short, self-healing
/// suppression rather than a permanently disabled autosave).
#[tauri::command]
pub async fn begin_workspace_switch(state: State<'_, AppState>) -> Result<(), String> {
    autosave::begin_switch_suppression(&state);
    Ok(())
}

// ---------------------------------------------------------------------------
// Load workspace (.ltw v4) — returns manifest for frontend orchestration
// ---------------------------------------------------------------------------

/// Per-session artifact data returned as part of `LoadWorkspaceResult`.
/// Ordered to match `LoadWorkspaceResult::sessions` by index.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceSessionData {
    pub bookmarks: Vec<crate::core::bookmark::Bookmark>,
    /// Legacy per-session analyses payload — populated only when the source
    /// `.ltw` predates the analyses migration (see `LtwSessionData::analyses`
    /// / `workspace::ltw_v4` module doc). Current files always read `[]` here;
    /// the workspace's real analyses are on [`LoadWorkspaceResult::analyses`].
    pub analyses: Vec<crate::core::analysis::AnalysisArtifact>,
    pub active_processor_ids: Vec<String>,
    pub disabled_processor_ids: Vec<String>,
}

/// Result returned to the frontend after reading a `.ltw` v4 file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceResult {
    pub workspace_name: String,
    /// Stable workspace id from the manifest, or null for legacy files. Q3's
    /// trust gate (`assessRestoreCandidate`) matches this against the app-state
    /// entry's id before a silent restore.
    pub workspace_id: Option<String>,
    /// Manifest `savedAt` (epoch-ms). Q3 compares it against the recorded
    /// `lastAutoSaveAt` when the candidate is the auto-save.
    pub saved_at: i64,
    pub sessions: Vec<LtwManifestSession>,
    pub pipeline_chain: LtwPipelineChain,
    pub editor_tabs: Vec<LtwEditorTab>,
    pub layout: Option<LtwLayout>,
    /// Workspace-level analyses (top-level `analyses.json`). Empty for a
    /// pre-migration file — see [`LoadWorkspaceSessionData::analyses`] for
    /// where that data surfaces instead.
    pub analyses: Vec<crate::core::analysis::AnalysisArtifact>,
    /// Per-session artifacts ordered to match `sessions` by index.
    pub session_data: Vec<LoadWorkspaceSessionData>,
}

/// Read a `.ltw` v4 file and return its contents for frontend orchestration.
#[tauri::command]
pub async fn load_workspace_v4(path: String) -> Result<LoadWorkspaceResult, String> {
    let data = ltw_v4::read_ltw(Path::new(&path))?;

    let session_data = data.sessions.iter().map(|s| LoadWorkspaceSessionData {
        bookmarks: s.bookmarks.clone(),
        analyses: s.analyses.clone(),
        active_processor_ids: s.session_meta.active_processor_ids.clone(),
        disabled_processor_ids: s.session_meta.disabled_processor_ids.clone(),
    }).collect();

    Ok(LoadWorkspaceResult {
        workspace_name: data.manifest.workspace_name,
        workspace_id: data.manifest.workspace_id,
        saved_at: data.manifest.saved_at,
        sessions: data.manifest.sessions,
        pipeline_chain: data.pipeline_chain,
        editor_tabs: data.editor_tabs,
        layout: data.layout,
        analyses: data.analyses,
        session_data,
    })
}

// ---------------------------------------------------------------------------
// Restore per-session artifacts after workspace load
// ---------------------------------------------------------------------------

/// Options for restoring per-session artifacts into AppState.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionOptions {
    pub session_id: String,
    pub bookmarks: Vec<crate::core::bookmark::Bookmark>,
    pub analyses: Vec<crate::core::analysis::AnalysisArtifact>,
    pub active_processor_ids: Vec<String>,
    pub disabled_processor_ids: Vec<String>,
}

/// Restore bookmarks, analyses, and pipeline meta for a session that was just
/// loaded as part of a `.ltw` workspace restore. Emits `workspace-restored`,
/// and — only when at least one LEGACY per-session analysis was actually
/// merged into the workspace-owned store (`options.analyses` is non-empty
/// only for a pre-migration `.ltw`; see `LoadWorkspaceSessionData::analyses`)
/// — also emits `analysis-update` (`restored`) so the frontend re-lists.
///
/// Without this second emit, a legacy `.ltw`'s per-session analyses land in
/// `AppState::analyses` (via `restore_artifacts`) but the frontend's analysis
/// list — already fetched earlier in the restore sequence, before this
/// session's artifacts existed — never learns anything changed, so those
/// analyses stay invisible until the app restarts (or something else happens
/// to trigger a re-list). Current (post-migration) `.ltw` files carry their
/// analyses in the top-level `analyses.json` / `LoadWorkspaceResult::analyses`
/// instead and go through `set_workspace_analyses`, which already emits this
/// same event — so this path only matters for legacy files. Gated on
/// `an_count > 0` to avoid a gratuitous re-list on every bookmark-only
/// restore. Autosave is suppressed during a workspace restore (see
/// `AppState::autosave_switch_suppressed_until`), so this emit has no
/// persistence side effect.
#[tauri::command]
pub async fn restore_workspace_session(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    options: RestoreSessionOptions,
) -> Result<(), String> {
    let meta = crate::workspace::SessionMeta {
        active_processor_ids: options.active_processor_ids,
        disabled_processor_ids: options.disabled_processor_ids,
    };

    let (bm_count, an_count) = crate::commands::files::restore_artifacts(
        &state,
        &options.session_id,
        options.bookmarks,
        options.analyses,
    );

    crate::commands::files::emit_workspace_restored(
        &state,
        &app,
        &options.session_id,
        bm_count,
        an_count,
        meta,
        "workspace",
    );

    if an_count > 0 {
        let _ = app.emit(
            "analysis-update",
            crate::core::analysis::AnalysisUpdateEvent {
                artifact_id: String::new(),
                action: "restored".to_string(),
                session_ids: vec![],
                session_id: None,
            },
        );
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// App state persistence
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_app_state(app: tauri::AppHandle) -> Result<AppStateFile, String> {
    let path = app_state::app_state_path(&app)?;
    Ok(app_state::load_app_state(&path))
}

#[tauri::command]
pub async fn save_app_state_cmd(
    app: tauri::AppHandle,
    app_state: State<'_, AppState>,
    state: AppStateFile,
) -> Result<(), String> {
    let path = app_state::app_state_path(&app)?;
    // Serialise against the background flush's read-modify-write of the same
    // file so the two writers never tear it (a corrupt app-state.json parses as
    // the empty default, which would silently drop the whole workspace list).
    let _guard = app_state
        .app_state_write_lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    app_state::save_app_state(&path, &state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ltw_path(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "logtapper_workspace_cmd_test_{}_{}_{}.ltw",
            std::process::id(),
            tag,
            now_ms()
        ));
        p
    }

    /// `save_workspace_v4` and `auto_save_workspace` were extracted onto the
    /// shared `write_workspace_snapshot` helper. They differ only in which
    /// path they target and what they cache as the envelope's `ltw_path` —
    /// the `.ltw` file itself must come out identical (aside from
    /// `saved_at`, which is a fresh timestamp per call) regardless of which
    /// caller shape drives the helper.
    #[test]
    fn write_workspace_snapshot_produces_equivalent_ltw_for_both_callers() {
        let state = AppState::default();
        let chain = LtwPipelineChain {
            chain: vec!["proc-a".to_string(), "proc-b".to_string()],
            disabled_ids: vec!["proc-b".to_string()],
        };
        let editor_tabs: Vec<LtwEditorTab> = Vec::new();

        let dest_explicit = temp_ltw_path("explicit");
        let dest_auto = temp_ltw_path("auto");

        // Mirrors save_workspace_v4: envelope caches the explicit dest path.
        write_workspace_snapshot(
            &state,
            &dest_explicit,
            "ws-1",
            "My Workspace",
            Some(dest_explicit.to_string_lossy().to_string()),
            &editor_tabs,
            None,
            &chain,
        )
        .expect("explicit save should succeed");

        // Mirrors auto_save_workspace: envelope caches None.
        write_workspace_snapshot(
            &state,
            &dest_auto,
            "ws-1",
            "My Workspace",
            None,
            &editor_tabs,
            None,
            &chain,
        )
        .expect("auto-save should succeed");

        let a = ltw_v4::read_ltw(&dest_explicit).expect("read explicit-save file");
        let b = ltw_v4::read_ltw(&dest_auto).expect("read auto-save file");

        assert_eq!(a.manifest.workspace_name, b.manifest.workspace_name);
        assert_eq!(a.manifest.workspace_id, b.manifest.workspace_id);
        assert_eq!(a.pipeline_chain.chain, b.pipeline_chain.chain);
        assert_eq!(a.pipeline_chain.disabled_ids, b.pipeline_chain.disabled_ids);
        assert_eq!(a.manifest.sessions.len(), 0, "no sessions were open in AppState::default()");
        assert_eq!(b.manifest.sessions.len(), 0);

        // The last call (auto-save) is what's cached; its ltw_path must be
        // None, matching auto_save_workspace's own semantics.
        let cached = state
            .workspace_envelope
            .lock()
            .expect("envelope lock")
            .clone()
            .expect("envelope should be cached");
        assert_eq!(cached.ltw_path, None);
        assert_eq!(cached.workspace_id, "ws-1");

        let _ = std::fs::remove_file(&dest_explicit);
        let _ = std::fs::remove_file(&dest_auto);
    }
}
