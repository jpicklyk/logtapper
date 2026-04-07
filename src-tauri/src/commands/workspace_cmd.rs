//! Tauri commands for workspace lifecycle operations.
//!
//! These commands handle saving/loading `.ltw` v4 workspace files and
//! persisting the application state (`app-state.json`).

use tauri::State;

use crate::commands::{lock_or_err, AppState};
use crate::workspace::app_state::{self, AppStateFile};
use crate::workspace::ltw_v4::{
    self, LtwEditorTab, LtwLayout, LtwManifestSession, LtwPipelineChain,
};
use crate::workspace::SessionMeta;

use serde::{Deserialize, Serialize};

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
    app: tauri::AppHandle,
    options: SaveWorkspaceOptions,
) -> Result<(), String> {
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

    // Collect per-session bookmarks, analyses, pipeline meta
    let mut session_entries: Vec<(
        LtwManifestSession,
        Vec<crate::core::bookmark::Bookmark>,
        Vec<crate::core::analysis::AnalysisArtifact>,
        SessionMeta,
    )> = Vec::new();

    for (session_id, file_path, source_name, source_type) in &session_info {
        let bookmarks = {
            let bm = lock_or_err(&state.bookmarks, "bookmarks")?;
            bm.get(session_id).cloned().unwrap_or_default()
        };
        let analyses = {
            let an = lock_or_err(&state.analyses, "analyses")?;
            an.get(session_id).cloned().unwrap_or_default()
        };
        let meta = {
            let pm = lock_or_err(&state.session_pipeline_meta, "session_pipeline_meta")?;
            pm.get(session_id).cloned().unwrap_or_default()
        };

        session_entries.push((
            LtwManifestSession {
                file_path: file_path.clone(),
                source_name: source_name.clone(),
                source_type: source_type.clone(),
            },
            bookmarks,
            analyses,
            meta,
        ));
    }

    let chain = LtwPipelineChain {
        chain: options.pipeline_chain,
        disabled_ids: options.disabled_chain_ids,
    };

    // Build the tuple refs that write_ltw expects
    let entry_refs: Vec<(
        LtwManifestSession,
        &[crate::core::bookmark::Bookmark],
        &[crate::core::analysis::AnalysisArtifact],
        &SessionMeta,
    )> = session_entries
        .iter()
        .map(|(m, b, a, meta)| (m.clone(), b.as_slice(), a.as_slice(), meta))
        .collect();

    let dest = std::path::Path::new(&options.dest_path);
    ltw_v4::write_ltw(
        dest,
        &options.workspace_name,
        &entry_refs,
        &chain,
        &options.editor_tabs,
        options.layout.as_ref(),
    )?;

    let _ = app; // suppress unused warning — app handle available for future use
    Ok(())
}

// ---------------------------------------------------------------------------
// Auto-save workspace to app_data_dir (for workspace switching)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveWorkspaceOptions {
    pub workspace_id: String,
    pub workspace_name: String,
    pub editor_tabs: Vec<LtwEditorTab>,
    pub layout: Option<LtwLayout>,
    pub pipeline_chain: Vec<String>,
    pub disabled_chain_ids: Vec<String>,
}

/// Auto-save the active workspace to `app_data_dir/workspaces/{workspace_id}.ltw`.
/// Returns the path where it was saved.
#[tauri::command]
pub async fn auto_save_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    options: AutoSaveWorkspaceOptions,
) -> Result<String, String> {
    let ws_dir = crate::workspace::workspace_dir(&app)?;
    let dest = ws_dir.join(format!("{}.ltw", options.workspace_id));

    // Snapshot session info
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

    let mut session_entries: Vec<(
        LtwManifestSession,
        Vec<crate::core::bookmark::Bookmark>,
        Vec<crate::core::analysis::AnalysisArtifact>,
        SessionMeta,
    )> = Vec::new();

    for (session_id, file_path, source_name, source_type) in &session_info {
        let bookmarks = {
            let bm = lock_or_err(&state.bookmarks, "bookmarks")?;
            bm.get(session_id).cloned().unwrap_or_default()
        };
        let analyses = {
            let an = lock_or_err(&state.analyses, "analyses")?;
            an.get(session_id).cloned().unwrap_or_default()
        };
        let meta = {
            let pm = lock_or_err(&state.session_pipeline_meta, "session_pipeline_meta")?;
            pm.get(session_id).cloned().unwrap_or_default()
        };

        session_entries.push((
            LtwManifestSession {
                file_path: file_path.clone(),
                source_name: source_name.clone(),
                source_type: source_type.clone(),
            },
            bookmarks,
            analyses,
            meta,
        ));
    }

    let chain = LtwPipelineChain {
        chain: options.pipeline_chain,
        disabled_ids: options.disabled_chain_ids,
    };

    let entry_refs: Vec<(
        LtwManifestSession,
        &[crate::core::bookmark::Bookmark],
        &[crate::core::analysis::AnalysisArtifact],
        &SessionMeta,
    )> = session_entries
        .iter()
        .map(|(m, b, a, meta)| (m.clone(), b.as_slice(), a.as_slice(), meta))
        .collect();

    ltw_v4::write_ltw(
        &dest,
        &options.workspace_name,
        &entry_refs,
        &chain,
        &options.editor_tabs,
        options.layout.as_ref(),
    )?;

    // Return the path as a string so the frontend can store it
    dest.to_str()
        .map(str::to_string)
        .ok_or_else(|| "Failed to convert path to string".to_string())
}

// ---------------------------------------------------------------------------
// Load workspace (.ltw v4) — returns manifest for frontend orchestration
// ---------------------------------------------------------------------------

/// Result returned to the frontend after reading a `.ltw` v4 file.
/// The frontend uses this to orchestrate session loading (calling load_log_file
/// for each session) and restoring layout/editors.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceResult {
    pub workspace_name: String,
    pub sessions: Vec<LtwManifestSession>,
    pub pipeline_chain: LtwPipelineChain,
    pub editor_tabs: Vec<LtwEditorTab>,
    pub layout: Option<LtwLayout>,
}

/// Read a `.ltw` v4 file and return its contents for frontend orchestration.
///
/// This does NOT open any sessions — the frontend calls `load_log_file` for each
/// session path after receiving this result. Bookmarks/analyses are returned so
/// the frontend can restore them after sessions load.
#[tauri::command]
pub async fn load_workspace_v4(path: String) -> Result<LoadWorkspaceResult, String> {
    let data = ltw_v4::read_ltw(std::path::Path::new(&path))?;

    Ok(LoadWorkspaceResult {
        workspace_name: data.manifest.workspace_name,
        sessions: data.manifest.sessions,
        pipeline_chain: data.pipeline_chain,
        editor_tabs: data.editor_tabs,
        layout: data.layout,
    })
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
