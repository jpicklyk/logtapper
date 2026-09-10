//! Thin Tauri adapters over `services::analyses`. Each command builds a
//! [`crate::commands::adapters::ui_ctx`], calls one service function, and
//! marshals the `Result<T, ServiceError>` into the `Result<T, String>` the
//! frontend expects.

use crate::commands::adapters::ui_ctx;
use crate::core::analysis::{AnalysisArtifact, AnalysisSection};
use crate::services::analyses;

/// Publish a new analysis artifact. `session_id: None` publishes a
/// workspace-level artifact (no session verification, references keep
/// whatever attribution the caller supplied); `Some(sid)` verifies the
/// session exists and stamps unattributed references with it.
#[tauri::command]
pub fn publish_analysis(
    app: tauri::AppHandle,
    session_id: Option<String>,
    title: String,
    sections: Vec<AnalysisSection>,
) -> Result<AnalysisArtifact, String> {
    let ctx = ui_ctx(&app);
    Ok(analyses::publish(&ctx, session_id, title, sections)?)
}

/// Update an existing analysis artifact (replace title and/or sections),
/// looked up by `artifact_id` alone — the store is not keyed by session.
#[tauri::command]
pub fn update_analysis(
    app: tauri::AppHandle,
    artifact_id: String,
    title: Option<String>,
    sections: Option<Vec<AnalysisSection>>,
) -> Result<AnalysisArtifact, String> {
    let ctx = ui_ctx(&app);
    Ok(analyses::update(&ctx, artifact_id, title, sections, None)?)
}

/// List analysis artifacts. `session_id: None` returns the full workspace
/// list; `Some(sid)` filters to artifacts with at least one reference
/// attributed to `sid`.
#[tauri::command]
pub fn list_analyses(
    app: tauri::AppHandle,
    session_id: Option<String>,
) -> Result<Vec<AnalysisArtifact>, String> {
    let ctx = ui_ctx(&app);
    Ok(analyses::list(&ctx, session_id.as_deref())?)
}

/// Get a single analysis artifact by ID.
#[tauri::command]
pub fn get_analysis(app: tauri::AppHandle, artifact_id: String) -> Result<AnalysisArtifact, String> {
    let ctx = ui_ctx(&app);
    Ok(analyses::get(&ctx, &artifact_id)?)
}

/// Delete an analysis artifact by ID.
#[tauri::command]
pub fn delete_analysis(app: tauri::AppHandle, artifact_id: String) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    analyses::remove(&ctx, artifact_id)?;
    Ok(())
}

/// Wholesale replace the workspace analyses store (used by workspace
/// restore). Does not schedule an autosave flush.
#[tauri::command]
pub fn set_workspace_analyses(
    app: tauri::AppHandle,
    analyses: Vec<AnalysisArtifact>,
) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    crate::services::analyses::set_workspace(&ctx, analyses)?;
    Ok(())
}
