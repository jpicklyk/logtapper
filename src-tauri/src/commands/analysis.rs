use tauri::State;

use crate::commands::artifact_mutations;
use crate::commands::{lock_or_err, AppState};
use crate::core::analysis::{AnalysisArtifact, AnalysisSection};

/// Publish a new analysis artifact for a session.
#[tauri::command]
pub fn publish_analysis(
    app: tauri::AppHandle,
    session_id: String,
    title: String,
    sections: Vec<AnalysisSection>,
) -> Result<AnalysisArtifact, String> {
    artifact_mutations::publish_analysis(&app, session_id, title, sections)
}

/// Update an existing analysis artifact (replace title and/or sections).
#[tauri::command]
pub fn update_analysis(
    app: tauri::AppHandle,
    session_id: String,
    artifact_id: String,
    title: Option<String>,
    sections: Option<Vec<AnalysisSection>>,
) -> Result<AnalysisArtifact, String> {
    artifact_mutations::update_analysis(&app, session_id, artifact_id, title, sections)
}

/// List all analysis artifacts for a session.
#[tauri::command]
pub fn list_analyses(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<AnalysisArtifact>, String> {
    let analyses = lock_or_err(&state.analyses, "analyses")?;
    Ok(analyses.get(&session_id).cloned().unwrap_or_default())
}

/// Get a single analysis artifact by ID.
#[tauri::command]
pub fn get_analysis(
    state: State<'_, AppState>,
    session_id: String,
    artifact_id: String,
) -> Result<AnalysisArtifact, String> {
    let analyses = lock_or_err(&state.analyses, "analyses")?;
    let list = analyses
        .get(&session_id)
        .ok_or_else(|| format!("No analyses for session: {session_id}"))?;

    list.iter()
        .find(|a| a.id == artifact_id)
        .cloned()
        .ok_or_else(|| format!("Analysis not found: {artifact_id}"))
}

/// Delete an analysis artifact by ID.
#[tauri::command]
pub fn delete_analysis(
    app: tauri::AppHandle,
    session_id: String,
    artifact_id: String,
) -> Result<(), String> {
    artifact_mutations::remove_analysis(&app, session_id, artifact_id)
}
