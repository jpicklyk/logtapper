//! Tauri commands for workspace lifecycle operations.
//!
//! These commands handle saving/loading `.ltw` v4 workspace files and
//! persisting the application state (`app-state.json`).

use std::path::Path;

use tauri::State;

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
    Vec<crate::core::analysis::AnalysisArtifact>,
    SessionMeta,
);

/// Snapshot all open sessions and their artifacts from AppState.
/// Acquires locks briefly: sessions once, bookmarks/analyses/meta once each.
pub(crate) fn collect_session_data(state: &AppState) -> Result<Vec<SessionEntry>, String> {
    // Snapshot session info under brief lock
    let session_info: Vec<(String, String, String, String)> = {
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
                ))
            })
            .collect()
    };

    // Extract only the entries for sessions we're saving (not the entire map).
    let mut entries = Vec::with_capacity(session_info.len());
    {
        let bm_guard = lock_or_err(&state.bookmarks, "bookmarks")?;
        let an_guard = lock_or_err(&state.analyses, "analyses")?;
        let meta_guard = lock_or_err(&state.session_pipeline_meta, "session_pipeline_meta")?;
        for (session_id, file_path, source_name, source_type) in session_info {
            entries.push((
                LtwManifestSession {
                    file_path,
                    source_name,
                    source_type,
                },
                bm_guard.get(&session_id).cloned().unwrap_or_default(),
                an_guard.get(&session_id).cloned().unwrap_or_default(),
                meta_guard.get(&session_id).cloned().unwrap_or_default(),
            ));
        }
    }
    Ok(entries)
}

/// Build entry refs from collected data (for write_ltw's borrow signature).
pub(crate) fn entry_refs(entries: &[SessionEntry]) -> Vec<(
    LtwManifestSession,
    &[crate::core::bookmark::Bookmark],
    &[crate::core::analysis::AnalysisArtifact],
    &SessionMeta,
)> {
    entries
        .iter()
        .map(|(m, b, a, meta)| (m.clone(), b.as_slice(), a.as_slice(), meta))
        .collect()
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

    // Cache the envelope before writing so a backend flush can rebuild this
    // workspace shell (explicit save → ltw_path is the chosen path).
    autosave::cache_envelope(
        &state,
        WorkspaceEnvelope {
            workspace_id: options.workspace_id.clone(),
            workspace_name: options.workspace_name.clone(),
            ltw_path: Some(options.dest_path.clone()),
            editor_tabs: options.editor_tabs.clone(),
            layout: options.layout.clone(),
            pipeline_chain: chain.clone(),
            updated_at: now_ms(),
        },
    );

    let entries = collect_session_data(&state)?;

    // Serialise against the background flush's write on the same file.
    let _guard = state.ltw_write_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    ltw_v4::write_ltw(
        Path::new(&options.dest_path),
        &options.workspace_name,
        Some(&options.workspace_id),
        &entry_refs(&entries),
        &chain,
        &options.editor_tabs,
        options.layout.as_ref(),
    )?;
    Ok(())
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

    // Cache the envelope before writing. ltw_path is None: this is the id-keyed
    // auto-save, so a backend flush recomputes `workspaces/{id}.ltw` itself.
    autosave::cache_envelope(
        &state,
        WorkspaceEnvelope {
            workspace_id: options.workspace_id.clone(),
            workspace_name: options.workspace_name.clone(),
            ltw_path: None,
            editor_tabs: options.editor_tabs.clone(),
            layout: options.layout.clone(),
            pipeline_chain: chain.clone(),
            updated_at: now_ms(),
        },
    );

    let entries = collect_session_data(&state)?;

    {
        // Serialise against the background flush's write on the same file.
        let _guard = state.ltw_write_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        ltw_v4::write_ltw(
            &dest,
            &options.workspace_name,
            Some(&options.workspace_id),
            &entry_refs(&entries),
            &chain,
            &options.editor_tabs,
            options.layout.as_ref(),
        )?;
    }

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
            updated_at: now_ms(),
        },
    );
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
/// loaded as part of a `.ltw` workspace restore. Emits `workspace-restored`.
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
    );

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
