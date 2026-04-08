//! Tauri commands for workspace lifecycle operations.
//!
//! These commands handle saving/loading `.ltw` v4 workspace files and
//! persisting the application state (`app-state.json`).

use std::path::Path;

use tauri::State;

use crate::commands::{lock_or_err, AppState};
use crate::workspace::app_state::{self, AppStateFile};
use crate::workspace::ltw_v4::{
    self, LtwEditorTab, LtwLayout, LtwManifestSession, LtwPipelineChain,
};
use crate::workspace::SessionMeta;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared helper: collect session data from AppState
// ---------------------------------------------------------------------------

type SessionEntry = (
    LtwManifestSession,
    Vec<crate::core::bookmark::Bookmark>,
    Vec<crate::core::analysis::AnalysisArtifact>,
    SessionMeta,
);

/// Snapshot all open sessions and their artifacts from AppState.
/// Acquires locks briefly: sessions once, bookmarks/analyses/meta once each.
fn collect_session_data(state: &AppState) -> Result<Vec<SessionEntry>, String> {
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

    // Snapshot all maps once (not per-session) to minimize lock acquisitions
    let all_bookmarks = lock_or_err(&state.bookmarks, "bookmarks")?.clone();
    let all_analyses = lock_or_err(&state.analyses, "analyses")?.clone();
    let all_meta = lock_or_err(&state.session_pipeline_meta, "session_pipeline_meta")?.clone();

    let mut entries = Vec::with_capacity(session_info.len());
    for (session_id, file_path, source_name, source_type) in session_info {
        entries.push((
            LtwManifestSession {
                file_path,
                source_name,
                source_type,
            },
            all_bookmarks.get(&session_id).cloned().unwrap_or_default(),
            all_analyses.get(&session_id).cloned().unwrap_or_default(),
            all_meta.get(&session_id).cloned().unwrap_or_default(),
        ));
    }
    Ok(entries)
}

/// Build entry refs from collected data (for write_ltw's borrow signature).
fn entry_refs(entries: &[SessionEntry]) -> Vec<(
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
    let entries = collect_session_data(&state)?;
    let chain = LtwPipelineChain {
        chain: options.pipeline_chain,
        disabled_ids: options.disabled_chain_ids,
    };

    ltw_v4::write_ltw(
        Path::new(&options.dest_path),
        &options.workspace_name,
        &entry_refs(&entries),
        &chain,
        &options.editor_tabs,
        options.layout.as_ref(),
    )
}

// ---------------------------------------------------------------------------
// Auto-save workspace to app_data_dir (for workspace switching)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveWorkspaceOptions {
    pub workspace_name: String,
    pub editor_tabs: Vec<LtwEditorTab>,
    pub layout: Option<LtwLayout>,
    pub pipeline_chain: Vec<String>,
    pub disabled_chain_ids: Vec<String>,
}

/// Auto-save the active workspace to `app_data_dir/workspaces/{sanitized_name}.ltw`.
/// Returns the path where it was saved.
#[tauri::command]
pub async fn auto_save_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    options: AutoSaveWorkspaceOptions,
) -> Result<String, String> {
    let ws_dir = crate::workspace::workspace_dir(&app)?;
    let sanitized = crate::workspace::sanitize_workspace_name(&options.workspace_name);
    let dest = ws_dir.join(format!("{sanitized}.ltw"));

    let entries = collect_session_data(&state)?;
    let chain = LtwPipelineChain {
        chain: options.pipeline_chain,
        disabled_ids: options.disabled_chain_ids,
    };

    ltw_v4::write_ltw(
        &dest,
        &options.workspace_name,
        &entry_refs(&entries),
        &chain,
        &options.editor_tabs,
        options.layout.as_ref(),
    )?;

    dest.to_str()
        .map(str::to_string)
        .ok_or_else(|| "Failed to convert path to string".to_string())
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
    state: AppStateFile,
) -> Result<(), String> {
    let path = app_state::app_state_path(&app)?;
    app_state::save_app_state(&path, &state)
}
