use tauri::State;

use crate::commands::artifact_mutations;
use crate::commands::{lock_or_err, AppState};
use crate::core::analysis::{artifact_references_session, AnalysisArtifact, AnalysisSection};

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
    artifact_mutations::publish_analysis(&app, session_id, title, sections)
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
    artifact_mutations::update_analysis(&app, artifact_id, title, sections, None)
}

/// Pure filtering step for [`list_analyses`], taking `&AppState` directly so
/// it is unit-testable without a Tauri-managed `State<'_, AppState>`.
/// `session_id: None` returns the full workspace list; `Some(sid)` filters to
/// artifacts with at least one reference attributed to `sid`.
pub(crate) fn list_analyses_impl(
    state: &AppState,
    session_id: Option<String>,
) -> Result<Vec<AnalysisArtifact>, String> {
    let analyses = lock_or_err(&state.analyses, "analyses")?;
    Ok(match session_id {
        None => analyses.clone(),
        Some(sid) => analyses
            .iter()
            .filter(|a| artifact_references_session(a, &sid))
            .cloned()
            .collect(),
    })
}

/// List analysis artifacts. `session_id: None` returns the full workspace
/// list; `Some(sid)` filters to artifacts with at least one reference
/// attributed to `sid`.
#[tauri::command]
pub fn list_analyses(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<AnalysisArtifact>, String> {
    list_analyses_impl(&state, session_id)
}

/// Get a single analysis artifact by ID.
#[tauri::command]
pub fn get_analysis(
    state: State<'_, AppState>,
    artifact_id: String,
) -> Result<AnalysisArtifact, String> {
    let analyses = lock_or_err(&state.analyses, "analyses")?;
    analyses
        .iter()
        .find(|a| a.id == artifact_id)
        .cloned()
        .ok_or_else(|| format!("Analysis not found: {artifact_id}"))
}

/// Delete an analysis artifact by ID.
#[tauri::command]
pub fn delete_analysis(app: tauri::AppHandle, artifact_id: String) -> Result<(), String> {
    artifact_mutations::remove_analysis(&app, artifact_id)
}

/// Wholesale replace the workspace analyses store (used by workspace
/// restore). Does not schedule an autosave flush.
#[tauri::command]
pub fn set_workspace_analyses(
    app: tauri::AppHandle,
    analyses: Vec<AnalysisArtifact>,
) -> Result<(), String> {
    artifact_mutations::set_workspace_analyses(&app, analyses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::analysis::{AnalysisSection, HighlightType, SourceReference};

    fn artifact_with_ref(id: &str, session_id: &str) -> AnalysisArtifact {
        AnalysisArtifact {
            id: id.to_string(),
            title: id.to_string(),
            created_at: 0,
            sections: vec![AnalysisSection {
                heading: "H".to_string(),
                body: "B".to_string(),
                references: vec![SourceReference {
                    line_number: 1,
                    end_line: None,
                    label: "ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: Some(session_id.to_string()),
                }],
                severity: None,
            }],
            legacy_session_id: None,
        }
    }

    #[test]
    fn list_analyses_filtered_by_session_returns_only_referencing_artifacts() {
        let state = AppState::new();
        {
            let mut analyses = state.analyses.lock().unwrap();
            analyses.push(artifact_with_ref("art-a", "sess-a"));
            analyses.push(artifact_with_ref("art-b", "sess-b"));
        }

        let result = list_analyses_impl(&state, Some("sess-a".to_string())).unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "art-a");
    }

    #[test]
    fn list_analyses_unfiltered_returns_all() {
        let state = AppState::new();
        {
            let mut analyses = state.analyses.lock().unwrap();
            analyses.push(artifact_with_ref("art-a", "sess-a"));
            analyses.push(artifact_with_ref("art-b", "sess-b"));
        }

        let result = list_analyses_impl(&state, None).unwrap();

        assert_eq!(result.len(), 2, "session_id: None must return the full workspace list");
    }

    /// Regression: `references` is optional on `AnalysisSection`, so a
    /// session-scoped publish of a narrative-only analysis (conclusion /
    /// summary, no line anchors) produces an artifact with zero references
    /// anywhere. `migrate_artifact` has nothing to stamp in that case, so
    /// without `artifact_references_session` treating "zero references" as
    /// "relevant to every session", such an artifact would be invisible to
    /// every session-filtered list despite having just been published under
    /// that session.
    #[test]
    fn session_scoped_publish_without_references_visible_in_session_list() {
        let state = AppState::new();
        // Shape produced by publish_analysis(Some("sess-a"), title, sections)
        // when sections carry no references: migrate_artifact stamps nothing.
        let narrative_only = AnalysisArtifact {
            id: "art-narrative".to_string(),
            title: "Summary".to_string(),
            created_at: 0,
            sections: vec![AnalysisSection {
                heading: "Conclusion".to_string(),
                body: "Everything is fine.".to_string(),
                references: vec![],
                severity: None,
            }],
            legacy_session_id: None,
        };
        state.analyses.lock().unwrap().push(narrative_only);

        let result = list_analyses_impl(&state, Some("sess-a".to_string())).unwrap();

        assert_eq!(
            result.len(),
            1,
            "a reference-less analysis must be visible in the session it was published under"
        );
        assert_eq!(result[0].id, "art-narrative");
    }
}
