//! Analysis-artifact mutation and listing service.
//!
//! The single implementation of analysis-artifact CRUD, shared by
//! `commands::analysis` (`Caller::Ui`) and `mcp_bridge::routes::artifacts`
//! (`Caller::Agent`). Analyses are workspace-owned (`AppState::analyses`), not
//! session-owned: a single artifact's sections can carry `SourceReference`s
//! that each resolve to a *different* session (or to none, if unattributed).
//!
//! Every mutation: locks `AppState::analyses`, mutates, drops the guard,
//! emits the identical `analysis-update` event both transports' UI listeners
//! already expect, schedules an autosave flush (except restoring a workspace,
//! which must not re-persist itself as a "mutation"), and journals the action.

use uuid::Uuid;

use crate::commands::AppState;
use crate::core::analysis::{
    artifact_references_session, artifact_session_ids, migrate_artifact, AnalysisArtifact,
    AnalysisSection, AnalysisUpdateEvent,
};
use crate::workspace::autosave::schedule_autosave;

use super::{lock_svc, ServiceCtx, ServiceError};

/// Publish an analysis artifact, emit `analysis-update` (`published`),
/// schedule an autosave flush, and journal `analysis.publish`.
///
/// `session_id`: `Some(sid)` verifies the session exists (same error message
/// as before) and stamps every unattributed reference in `sections` with
/// `sid` via [`migrate_artifact`]. `None` publishes a workspace-level
/// artifact with no session verification — references keep whatever
/// attribution (if any) the caller already gave them.
pub fn publish(
    ctx: &ServiceCtx,
    session_id: Option<String>,
    title: String,
    sections: Vec<AnalysisSection>,
) -> Result<AnalysisArtifact, ServiceError> {
    if let Some(sid) = &session_id {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        if !sessions.contains_key(sid) {
            return Err(ServiceError::NotFound(format!("Session not found: {sid}")));
        }
    }

    let mut artifact = AnalysisArtifact {
        id: Uuid::new_v4().to_string(),
        title,
        created_at: crate::workspace::now_ms(),
        sections,
        legacy_session_id: None,
    };

    if let Some(sid) = &session_id {
        migrate_artifact(&mut artifact, Some(sid.as_str()));
    }

    {
        let mut analyses = lock_svc(&ctx.state().analyses, "analyses")?;
        analyses.push(artifact.clone());
    }

    ctx.events().emit_json(
        "analysis-update",
        serde_json::to_value(AnalysisUpdateEvent {
            artifact_id: artifact.id.clone(),
            action: "published".to_string(),
            session_ids: artifact_session_ids(&artifact),
            session_id: session_id.clone(),
        })
        .unwrap_or_default(),
    );

    schedule_autosave(ctx.state());
    ctx.journal(
        "analysis.publish",
        session_id.as_deref(),
        format!("artifact {}: {}", artifact.id, artifact.title),
    );

    Ok(artifact)
}

/// Pure title/sections-apply step for [`update`]: mutates `art` in place and,
/// when `sections` is replaced, re-runs [`migrate_artifact`] with
/// `fallback_session`. Split out so the fallback-session behavior is directly
/// unit-testable against a plain `AnalysisArtifact` — see [`update`]'s doc
/// comment for what `fallback_session` means.
pub(crate) fn apply_update(
    art: &mut AnalysisArtifact,
    title: Option<String>,
    sections: Option<Vec<AnalysisSection>>,
    fallback_session: Option<&str>,
) {
    if let Some(t) = title {
        art.title = t;
    }
    if let Some(s) = sections {
        art.sections = s;
        migrate_artifact(art, fallback_session);
    }
}

/// Update an analysis artifact's title / sections, emit `analysis-update`
/// (`updated`), schedule an autosave flush, and journal `analysis.update`.
/// Looked up by `artifact_id` alone — the workspace-owned store is not keyed
/// by session.
///
/// `fallback_session`: when `sections` is replaced, [`migrate_artifact`]
/// re-runs with this as the fallback. `None` (the workspace route, and the
/// Tauri command) leaves any unattributed reference in the new sections
/// unattributed. `Some(sid)` (the session-SCOPED MCP route only) stamps
/// unattributed references with `sid` instead — this matters for pre-1.3.0
/// MCP clients that PUT to `/mcp/sessions/{session_id}/analyses/{artifact_id}`
/// with references carrying no `sessionId` at all: without this fallback the
/// update would silently de-attribute the artifact from every session,
/// dropping it out of session-scoped lists and `.lts` export.
pub fn update(
    ctx: &ServiceCtx,
    artifact_id: String,
    title: Option<String>,
    sections: Option<Vec<AnalysisSection>>,
    fallback_session: Option<String>,
) -> Result<AnalysisArtifact, ServiceError> {
    let updated = {
        let mut analyses = lock_svc(&ctx.state().analyses, "analyses")?;
        let art = analyses
            .iter_mut()
            .find(|a| a.id == artifact_id)
            .ok_or_else(|| ServiceError::NotFound(format!("Analysis not found: {artifact_id}")))?;

        apply_update(art, title, sections, fallback_session.as_deref());

        art.clone()
    };

    let session_ids = artifact_session_ids(&updated);
    let session_id = session_ids.first().cloned();

    ctx.events().emit_json(
        "analysis-update",
        serde_json::to_value(AnalysisUpdateEvent {
            artifact_id: updated.id.clone(),
            action: "updated".to_string(),
            session_ids,
            session_id: session_id.clone(),
        })
        .unwrap_or_default(),
    );

    schedule_autosave(ctx.state());
    ctx.journal(
        "analysis.update",
        session_id.as_deref(),
        format!("artifact {}", updated.id),
    );

    Ok(updated)
}

/// Pure find-and-remove step for [`remove`]: looks up `artifact_id` by
/// scanning the whole store and removes it. The workspace store is not keyed
/// by session, so this succeeds regardless of what session(s) the artifact's
/// own references happen to point at — split out from [`remove`] (which
/// additionally needs a [`ServiceCtx`] for the `analysis-update` emit) so
/// that invariant is directly unit-testable against a plain
/// `Vec<AnalysisArtifact>`.
pub(crate) fn remove_by_id(
    analyses: &mut Vec<AnalysisArtifact>,
    artifact_id: &str,
) -> Result<AnalysisArtifact, ServiceError> {
    let idx = analyses
        .iter()
        .position(|a| a.id == artifact_id)
        .ok_or_else(|| ServiceError::NotFound(format!("Analysis not found: {artifact_id}")))?;
    Ok(analyses.remove(idx))
}

/// Remove an analysis artifact by `artifact_id`, emit `analysis-update`
/// (`deleted`) carrying the removed artifact's session ids, schedule an
/// autosave flush, and journal `analysis.delete`.
pub fn remove(ctx: &ServiceCtx, artifact_id: String) -> Result<(), ServiceError> {
    let removed = {
        let mut analyses = lock_svc(&ctx.state().analyses, "analyses")?;
        remove_by_id(&mut analyses, &artifact_id)?
    };

    let session_ids = artifact_session_ids(&removed);
    let session_id = session_ids.first().cloned();

    ctx.events().emit_json(
        "analysis-update",
        serde_json::to_value(AnalysisUpdateEvent {
            artifact_id: artifact_id.clone(),
            action: "deleted".to_string(),
            session_ids,
            session_id: session_id.clone(),
        })
        .unwrap_or_default(),
    );

    schedule_autosave(ctx.state());
    ctx.journal(
        "analysis.delete",
        session_id.as_deref(),
        format!("artifact {artifact_id}"),
    );

    Ok(())
}

/// List analysis artifacts. `session_id: None` returns the full workspace
/// list; `Some(sid)` filters to artifacts with at least one reference
/// attributed to `sid` (or with zero references at all — see
/// [`artifact_references_session`]). Shared by the Tauri command
/// (session_id: None, or a session-scoped call) and the two MCP bridge route
/// families (`/mcp/analyses` and `/mcp/sessions/{id}/analyses`).
pub fn list(
    ctx: &ServiceCtx,
    session_id: Option<&str>,
) -> Result<Vec<AnalysisArtifact>, ServiceError> {
    let analyses = lock_svc(&ctx.state().analyses, "analyses")?;
    Ok(match session_id {
        None => analyses.clone(),
        Some(sid) => analyses
            .iter()
            .filter(|a| artifact_references_session(a, sid))
            .cloned()
            .collect(),
    })
}

/// Get a single analysis artifact by id (workspace-unique).
pub fn get(ctx: &ServiceCtx, artifact_id: &str) -> Result<AnalysisArtifact, ServiceError> {
    let analyses = lock_svc(&ctx.state().analyses, "analyses")?;
    analyses
        .iter()
        .find(|a| a.id == artifact_id)
        .cloned()
        .ok_or_else(|| ServiceError::NotFound(format!("Analysis not found: {artifact_id}")))
}

/// Pure store-replace step for [`set_workspace`]. Deliberately does NOT call
/// `schedule_autosave` — restoring a workspace must not immediately re-persist
/// itself as a "mutation". Split out from [`set_workspace`] (which
/// additionally needs a [`ServiceCtx`] for the `analysis-update` emit) so the
/// no-autosave invariant is directly unit-testable: this function has no
/// access to `schedule_autosave` at all, so it structurally cannot call it.
pub(crate) fn replace_workspace(
    state: &AppState,
    analyses: Vec<AnalysisArtifact>,
) -> Result<(), ServiceError> {
    let mut guard = lock_svc(&state.analyses, "analyses")?;
    *guard = analyses;
    Ok(())
}

/// Wholesale replace the workspace analyses store (e.g. `.ltw` workspace
/// restore), emit `analysis-update` (`restored`), and do NOT schedule an
/// autosave flush or journal — restoring a workspace must not immediately
/// re-persist itself as a "mutation", and it is not a caller-initiated action
/// worth surfacing in the activity feed.
pub fn set_workspace(ctx: &ServiceCtx, analyses: Vec<AnalysisArtifact>) -> Result<(), ServiceError> {
    replace_workspace(ctx.state(), analyses)?;

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

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::analysis::{HighlightType, SourceReference};
    use crate::services::testing::test_ctx;
    use crate::workspace::autosave::has_pending_flush;

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

    fn artifact_with_unattributed_ref(id: &str) -> AnalysisArtifact {
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
                    session_id: None,
                }],
                severity: None,
            }],
            legacy_session_id: None,
        }
    }

    // ── publish ──────────────────────────────────────────────────────────

    #[test]
    fn publish_emits_one_event_journals_and_schedules_autosave() {
        let (ctx, sink, _tmp) = test_ctx().agent("claude-code").with_session("s1", 5).build_recording();

        let art = publish(&ctx, Some("s1".to_string()), "Title".to_string(), vec![])
            .expect("publish must succeed for an existing session");

        let payload = sink.only_event("analysis-update");
        assert_eq!(payload["action"], "published");
        assert_eq!(payload["artifactId"], art.id);

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "analysis.publish");
        assert_eq!(activity[0].caller, crate::services::Caller::agent("claude-code"));

        assert!(has_pending_flush(ctx.state()), "publish must schedule an autosave flush");
    }

    #[test]
    fn publish_rejects_unknown_session() {
        let (ctx, _tmp) = test_ctx().build();
        let err = publish(&ctx, Some("missing".to_string()), "T".to_string(), vec![])
            .expect_err("must fail for a session that does not exist");
        assert_eq!(err.message(), "Session not found: missing");
    }

    #[test]
    fn publish_workspace_level_skips_session_verification() {
        let (ctx, _tmp) = test_ctx().build();
        let art = publish(&ctx, None, "Workspace-level".to_string(), vec![])
            .expect("workspace-level publish needs no session");
        assert_eq!(art.title, "Workspace-level");
    }

    // ── apply_update (pure) ──────────────────────────────────────────────

    #[test]
    fn scoped_update_with_unattributed_references_keeps_them_attributed_to_the_path_session() {
        let mut art = artifact_with_unattributed_ref("art-scoped");

        apply_update(
            &mut art,
            None,
            Some(vec![AnalysisSection {
                heading: "New".to_string(),
                body: "New body".to_string(),
                references: vec![SourceReference {
                    line_number: 2,
                    end_line: None,
                    label: "new-ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: None,
                }],
                severity: None,
            }]),
            Some("sess-path"),
        );

        assert_eq!(
            art.sections[0].references[0].session_id.as_deref(),
            Some("sess-path"),
            "scoped update must stamp unattributed references with the path session"
        );
    }

    #[test]
    fn workspace_update_with_no_fallback_leaves_unattributed_references_alone() {
        let mut art = artifact_with_unattributed_ref("art-workspace");

        apply_update(
            &mut art,
            None,
            Some(vec![AnalysisSection {
                heading: "New".to_string(),
                body: "New body".to_string(),
                references: vec![SourceReference {
                    line_number: 2,
                    end_line: None,
                    label: "new-ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: None,
                }],
                severity: None,
            }]),
            None,
        );

        assert_eq!(
            art.sections[0].references[0].session_id, None,
            "workspace route (no fallback) must leave an unattributed reference unattributed"
        );
    }

    #[test]
    fn update_emits_updated_event_and_journals() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        let art = publish(&ctx, None, "T".to_string(), vec![]).unwrap();
        sink.clear();

        let updated = update(&ctx, art.id, Some("New title".to_string()), None, None)
            .expect("update must find the artifact just published");
        assert_eq!(updated.title, "New title");

        let payload = sink.only_event("analysis-update");
        assert_eq!(payload["action"], "updated");

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.last().unwrap().action, "analysis.update");
    }

    #[test]
    fn update_errors_when_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = update(&ctx, "no-such-id".to_string(), None, None, None)
            .expect_err("must fail for an unknown artifact");
        assert_eq!(err.message(), "Analysis not found: no-such-id");
    }

    // ── remove_by_id (pure) ──────────────────────────────────────────────

    #[test]
    fn delete_by_artifact_id_finds_artifact_regardless_of_session() {
        let mut analyses = vec![
            artifact_with_ref("art-a", "sess-a"),
            artifact_with_ref("art-b", "sess-b"),
            artifact_with_ref("art-c", "sess-c"),
        ];

        let removed = remove_by_id(&mut analyses, "art-b").expect("must find art-b");

        assert_eq!(removed.id, "art-b");
        assert_eq!(analyses.len(), 2);
        assert!(analyses.iter().any(|a| a.id == "art-a"));
        assert!(analyses.iter().any(|a| a.id == "art-c"));
        assert!(!analyses.iter().any(|a| a.id == "art-b"));
    }

    #[test]
    fn delete_by_artifact_id_errors_when_not_found() {
        let mut analyses = vec![artifact_with_ref("art-a", "sess-a")];
        let err = remove_by_id(&mut analyses, "does-not-exist")
            .expect_err("must error for an unknown artifact_id");
        assert_eq!(err.message(), "Analysis not found: does-not-exist");
    }

    #[test]
    fn remove_emits_deleted_event_and_journals() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        let art = publish(&ctx, None, "T".to_string(), vec![]).unwrap();
        sink.clear();

        remove(&ctx, art.id).expect("must remove");
        let payload = sink.only_event("analysis-update");
        assert_eq!(payload["action"], "deleted");
        assert!(list(&ctx, None).unwrap().is_empty());

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.last().unwrap().action, "analysis.delete");
    }

    // ── list / get ───────────────────────────────────────────────────────

    #[test]
    fn list_filtered_by_session_returns_only_referencing_artifacts() {
        let (ctx, _tmp) = test_ctx().build();
        {
            let mut analyses = ctx.state().analyses.lock().unwrap();
            analyses.push(artifact_with_ref("art-a", "sess-a"));
            analyses.push(artifact_with_ref("art-b", "sess-b"));
        }

        let result = list(&ctx, Some("sess-a")).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "art-a");
    }

    #[test]
    fn list_unfiltered_returns_all() {
        let (ctx, _tmp) = test_ctx().build();
        {
            let mut analyses = ctx.state().analyses.lock().unwrap();
            analyses.push(artifact_with_ref("art-a", "sess-a"));
            analyses.push(artifact_with_ref("art-b", "sess-b"));
        }

        let result = list(&ctx, None).unwrap();
        assert_eq!(result.len(), 2, "session_id: None must return the full workspace list");
    }

    #[test]
    fn get_finds_by_artifact_id() {
        let (ctx, _tmp) = test_ctx().build();
        let art = publish(&ctx, None, "Findable".to_string(), vec![]).unwrap();
        let found = get(&ctx, &art.id).unwrap();
        assert_eq!(found.title, "Findable");
    }

    #[test]
    fn get_errors_when_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = get(&ctx, "missing").expect_err("must fail for unknown artifact");
        assert_eq!(err.message(), "Analysis not found: missing");
    }

    // ── set_workspace / replace_workspace ───────────────────────────────

    #[test]
    fn set_workspace_does_not_schedule_autosave_but_does_emit() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();

        set_workspace(&ctx, vec![artifact_with_ref("art-a", "sess-a")])
            .expect("restore must succeed");

        assert!(
            !has_pending_flush(ctx.state()),
            "restoring the workspace analyses store must not schedule an autosave flush"
        );
        let payload = sink.only_event("analysis-update");
        assert_eq!(payload["action"], "restored");
        assert_eq!(list(&ctx, None).unwrap().len(), 1);

        assert!(
            ctx.state().activity.list(None, None).is_empty(),
            "restoring a workspace must not journal an activity entry"
        );
    }
}
