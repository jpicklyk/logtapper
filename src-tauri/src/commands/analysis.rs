use tauri::State;
use uuid::Uuid;

use crate::commands::{lock_or_err, AppState};
use crate::core::analysis::{AnalysisArtifact, AnalysisSection, AnalysisUpdateEvent};

/// Publish a new analysis artifact for a session.
#[tauri::command]
pub fn publish_analysis(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    sections: Vec<AnalysisSection>,
) -> Result<AnalysisArtifact, String> {
    // Verify session exists
    {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        if !sessions.contains_key(&session_id) {
            return Err(format!("Session not found: {session_id}"));
        }
    }

    let artifact = AnalysisArtifact {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        title,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
        sections,
    };

    {
        let mut analyses = lock_or_err(&state.analyses, "analyses")?;
        analyses
            .entry(session_id.clone())
            .or_default()
            .push(artifact.clone());
    }

    crate::commands::workspace_sync::schedule_workspace_save(&app, &state, &session_id);

    use tauri::Emitter;
    let _ = app.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            session_id,
            action: "published".to_string(),
            artifact_id: artifact.id.clone(),
        },
    );

    Ok(artifact)
}

/// Update an existing analysis artifact (replace title and/or sections).
#[tauri::command]
pub fn update_analysis(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    artifact_id: String,
    title: Option<String>,
    sections: Option<Vec<AnalysisSection>>,
) -> Result<AnalysisArtifact, String> {
    let mut analyses = lock_or_err(&state.analyses, "analyses")?;
    let list = analyses
        .get_mut(&session_id)
        .ok_or_else(|| format!("No analyses for session: {session_id}"))?;

    let art = list
        .iter_mut()
        .find(|a| a.id == artifact_id)
        .ok_or_else(|| format!("Analysis not found: {artifact_id}"))?;

    if let Some(t) = title {
        art.title = t;
    }
    if let Some(s) = sections {
        art.sections = s;
    }

    let updated = art.clone();
    drop(analyses);

    crate::commands::workspace_sync::schedule_workspace_save(&app, &state, &session_id);

    use tauri::Emitter;
    let _ = app.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            session_id,
            action: "updated".to_string(),
            artifact_id: updated.id.clone(),
        },
    );

    Ok(updated)
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
    state: State<'_, AppState>,
    session_id: String,
    artifact_id: String,
) -> Result<(), String> {
    let mut analyses = lock_or_err(&state.analyses, "analyses")?;
    let list = analyses
        .get_mut(&session_id)
        .ok_or_else(|| format!("No analyses for session: {session_id}"))?;

    let idx = list
        .iter()
        .position(|a| a.id == artifact_id)
        .ok_or_else(|| format!("Analysis not found: {artifact_id}"))?;

    list.remove(idx);
    drop(analyses);

    crate::commands::workspace_sync::schedule_workspace_save(&app, &state, &session_id);

    use tauri::Emitter;
    let _ = app.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            session_id,
            action: "deleted".to_string(),
            artifact_id,
        },
    );

    Ok(())
}
