//! Shared artifact-mutation surface for bookmarks and analyses.
//!
//! Both transports that can mutate session artifacts — the Tauri command layer
//! (`commands::bookmark`, `commands::analysis`) and the MCP HTTP bridge
//! (`mcp_bridge`) — funnel their writes through these functions. Each performs
//! the lock + mutate, emits the identical `bookmark-update` / `analysis-update`
//! event the frontend listens for, and schedules exactly one durable auto-save
//! flush (Q4). Consolidating here guarantees the durability trigger cannot be
//! forgotten at a new write site and keeps event payloads byte-identical across
//! both transports.
//!
//! Every function takes `&AppHandle` — the one handle type both transports hold
//! (`tauri::AppHandle` in commands, `AppHandle<Wry>` in the bridge) — and reads
//! `AppState` from it, mirroring how the bridge already resolves state. State is
//! locked, mutated, and the guard dropped *before* any emit / schedule, per the
//! `commands/CLAUDE.md` lock discipline.

use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::commands::{lock_or_err, AppState};
use crate::core::analysis::{
    artifact_session_ids, migrate_artifact, AnalysisArtifact, AnalysisSection, AnalysisUpdateEvent,
};
use crate::core::bookmark::{Bookmark, BookmarkUpdateEvent, CreatedBy};
use crate::workspace::autosave::schedule_autosave;

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

/// Create a bookmark, emit `bookmark-update` (`created`), and schedule a flush.
#[allow(clippy::too_many_arguments)]
pub fn add_bookmark(
    app: &AppHandle,
    session_id: String,
    line_number: u32,
    label: String,
    note: String,
    created_by: CreatedBy,
    line_number_end: Option<u32>,
    snippet: Option<Vec<String>>,
    category: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Bookmark, String> {
    let state = app.state::<AppState>();

    // Verify session exists.
    {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        if !sessions.contains_key(&session_id) {
            return Err(format!("Session not found: {session_id}"));
        }
    }

    let bookmark = Bookmark {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        line_number,
        line_number_end,
        snippet,
        category,
        tags,
        label,
        note,
        created_by,
        created_at: crate::workspace::now_ms(),
    };

    {
        let mut bookmarks = lock_or_err(&state.bookmarks, "bookmarks")?;
        bookmarks
            .entry(session_id.clone())
            .or_default()
            .push(bookmark.clone());
    }

    let _ = app.emit(
        "bookmark-update",
        BookmarkUpdateEvent {
            session_id,
            action: "created".to_string(),
            bookmark: bookmark.clone(),
        },
    );

    schedule_autosave(&state);

    Ok(bookmark)
}

/// Update a bookmark's label / note / category / tags, emit `bookmark-update`
/// (`updated`), and schedule a flush.
pub fn update_bookmark(
    app: &AppHandle,
    session_id: String,
    bookmark_id: String,
    label: Option<String>,
    note: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Bookmark, String> {
    let state = app.state::<AppState>();

    let mut bookmarks = lock_or_err(&state.bookmarks, "bookmarks")?;
    let list = bookmarks
        .get_mut(&session_id)
        .ok_or_else(|| format!("No bookmarks for session: {session_id}"))?;

    let bm = list
        .iter_mut()
        .find(|b| b.id == bookmark_id)
        .ok_or_else(|| format!("Bookmark not found: {bookmark_id}"))?;

    if let Some(l) = label {
        bm.label = l;
    }
    if let Some(n) = note {
        bm.note = n;
    }
    if let Some(c) = category {
        bm.category = Some(c);
    }
    if let Some(t) = tags {
        bm.tags = Some(t);
    }

    let updated = bm.clone();
    drop(bookmarks);

    let _ = app.emit(
        "bookmark-update",
        BookmarkUpdateEvent {
            session_id,
            action: "updated".to_string(),
            bookmark: updated.clone(),
        },
    );

    schedule_autosave(&state);

    Ok(updated)
}

/// Remove a bookmark, emit `bookmark-update` (`deleted`), and schedule a flush.
/// Returns the removed bookmark (the same value carried in the emitted event).
pub fn remove_bookmark(
    app: &AppHandle,
    session_id: String,
    bookmark_id: String,
) -> Result<Bookmark, String> {
    let state = app.state::<AppState>();

    let mut bookmarks = lock_or_err(&state.bookmarks, "bookmarks")?;
    let list = bookmarks
        .get_mut(&session_id)
        .ok_or_else(|| format!("No bookmarks for session: {session_id}"))?;

    let idx = list
        .iter()
        .position(|b| b.id == bookmark_id)
        .ok_or_else(|| format!("Bookmark not found: {bookmark_id}"))?;

    let removed = list.remove(idx);
    drop(bookmarks);

    let _ = app.emit(
        "bookmark-update",
        BookmarkUpdateEvent {
            session_id,
            action: "deleted".to_string(),
            bookmark: removed.clone(),
        },
    );

    schedule_autosave(&state);

    Ok(removed)
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

/// Publish an analysis artifact, emit `analysis-update` (`published`), and
/// schedule a flush.
///
/// `session_id`: `Some(sid)` verifies the session exists (same error message
/// as before) and stamps every unattributed reference in `sections` with
/// `sid` via [`migrate_artifact`]. `None` publishes a workspace-level
/// artifact with no session verification — references keep whatever
/// attribution (if any) the caller already gave them.
pub fn publish_analysis(
    app: &AppHandle,
    session_id: Option<String>,
    title: String,
    sections: Vec<AnalysisSection>,
) -> Result<AnalysisArtifact, String> {
    let state = app.state::<AppState>();

    if let Some(sid) = &session_id {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        if !sessions.contains_key(sid) {
            return Err(format!("Session not found: {sid}"));
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
        let mut analyses = lock_or_err(&state.analyses, "analyses")?;
        analyses.push(artifact.clone());
    }

    let _ = app.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            artifact_id: artifact.id.clone(),
            action: "published".to_string(),
            session_ids: artifact_session_ids(&artifact),
            session_id,
        },
    );

    schedule_autosave(&state);

    Ok(artifact)
}

/// Pure title/sections-apply step for [`update_analysis`]: mutates `art` in
/// place and, when `sections` is replaced, re-runs [`migrate_artifact`] with
/// `fallback_session`. Split out so the fallback-session behavior is directly
/// unit-testable against a plain `AnalysisArtifact` — see
/// `update_analysis`'s doc comment for what `fallback_session` means.
pub(crate) fn apply_analysis_update(
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
/// (`updated`), and schedule a flush. Looked up by `artifact_id` alone — the
/// workspace-owned store is not keyed by session.
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
pub fn update_analysis(
    app: &AppHandle,
    artifact_id: String,
    title: Option<String>,
    sections: Option<Vec<AnalysisSection>>,
    fallback_session: Option<String>,
) -> Result<AnalysisArtifact, String> {
    let state = app.state::<AppState>();

    let updated = {
        let mut analyses = lock_or_err(&state.analyses, "analyses")?;
        let art = analyses
            .iter_mut()
            .find(|a| a.id == artifact_id)
            .ok_or_else(|| format!("Analysis not found: {artifact_id}"))?;

        apply_analysis_update(art, title, sections, fallback_session.as_deref());

        art.clone()
    };

    let session_ids = artifact_session_ids(&updated);
    let session_id = session_ids.first().cloned();

    let _ = app.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            artifact_id: updated.id.clone(),
            action: "updated".to_string(),
            session_ids,
            session_id,
        },
    );

    schedule_autosave(&state);

    Ok(updated)
}

/// Pure find-and-remove step for [`remove_analysis`]: looks up `artifact_id`
/// by scanning the whole store and removes it. The workspace store is not
/// keyed by session, so this succeeds regardless of what session(s) the
/// artifact's own references happen to point at — split out from
/// `remove_analysis` (which additionally needs an `AppHandle` for the
/// `analysis-update` emit) so that invariant is directly unit-testable
/// against a plain `Vec<AnalysisArtifact>`.
pub(crate) fn remove_analysis_by_id(
    analyses: &mut Vec<AnalysisArtifact>,
    artifact_id: &str,
) -> Result<AnalysisArtifact, String> {
    let idx = analyses
        .iter()
        .position(|a| a.id == artifact_id)
        .ok_or_else(|| format!("Analysis not found: {artifact_id}"))?;
    Ok(analyses.remove(idx))
}

/// Remove an analysis artifact by `artifact_id`, emit `analysis-update`
/// (`deleted`) carrying the removed artifact's session ids, and schedule a
/// flush.
pub fn remove_analysis(app: &AppHandle, artifact_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();

    let removed = {
        let mut analyses = lock_or_err(&state.analyses, "analyses")?;
        remove_analysis_by_id(&mut analyses, &artifact_id)?
    };

    let session_ids = artifact_session_ids(&removed);
    let session_id = session_ids.first().cloned();

    let _ = app.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            artifact_id,
            action: "deleted".to_string(),
            session_ids,
            session_id,
        },
    );

    schedule_autosave(&state);

    Ok(())
}

/// Pure store-replace step for [`set_workspace_analyses`]. Deliberately does
/// NOT call `schedule_autosave` — restoring a workspace must not immediately
/// re-persist itself as a "mutation". Split out from `set_workspace_analyses`
/// (which additionally needs an `AppHandle` for the `analysis-update` emit)
/// so the no-autosave invariant is directly unit-testable: this function has
/// no access to `schedule_autosave` at all, so it structurally cannot call it.
pub(crate) fn replace_workspace_analyses(
    state: &AppState,
    analyses: Vec<AnalysisArtifact>,
) -> Result<(), String> {
    let mut guard = lock_or_err(&state.analyses, "analyses")?;
    *guard = analyses;
    Ok(())
}

/// Wholesale replace the workspace analyses store (e.g. `.ltw` workspace
/// restore), emit `analysis-update` (`restored`), and do NOT schedule an
/// autosave flush — restoring a workspace must not immediately re-persist
/// itself as a "mutation".
pub fn set_workspace_analyses(app: &AppHandle, analyses: Vec<AnalysisArtifact>) -> Result<(), String> {
    let state = app.state::<AppState>();

    replace_workspace_analyses(&state, analyses)?;

    let _ = app.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            artifact_id: String::new(),
            action: "restored".to_string(),
            session_ids: vec![],
            session_id: None,
        },
    );

    Ok(())
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

    /// Regression for the scoped-update de-attribution bug: a pre-1.3.0 MCP
    /// client PUTting to `/mcp/sessions/{session_id}/analyses/{artifact_id}`
    /// with references carrying no `sessionId` at all must NOT have the
    /// update silently strip all attribution — the scoped route threads
    /// `session_id` through as the `migrate_artifact` fallback.
    #[test]
    fn scoped_update_with_unattributed_references_keeps_them_attributed_to_the_path_session() {
        let mut art = artifact_with_unattributed_ref("art-scoped");

        apply_analysis_update(
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

    /// The workspace (unscoped) route has no session context — replaced
    /// sections with unattributed references stay unattributed, matching
    /// `update_analysis`'s pre-existing no-fallback behavior.
    #[test]
    fn workspace_update_with_no_fallback_leaves_unattributed_references_alone() {
        let mut art = artifact_with_unattributed_ref("art-workspace");

        apply_analysis_update(
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

    /// The workspace store is not keyed by session — deleting by artifact_id
    /// must find and remove the right artifact no matter what session(s) its
    /// own references are attributed to, and leave every other artifact
    /// (referencing other sessions) untouched.
    #[test]
    fn delete_by_artifact_id_finds_artifact_regardless_of_session() {
        let mut analyses = vec![
            artifact_with_ref("art-a", "sess-a"),
            artifact_with_ref("art-b", "sess-b"),
            artifact_with_ref("art-c", "sess-c"),
        ];

        let removed = remove_analysis_by_id(&mut analyses, "art-b").expect("must find art-b");

        assert_eq!(removed.id, "art-b");
        assert_eq!(analyses.len(), 2);
        assert!(analyses.iter().any(|a| a.id == "art-a"));
        assert!(analyses.iter().any(|a| a.id == "art-c"));
        assert!(!analyses.iter().any(|a| a.id == "art-b"));
    }

    #[test]
    fn delete_by_artifact_id_errors_when_not_found() {
        let mut analyses = vec![artifact_with_ref("art-a", "sess-a")];
        let err = remove_analysis_by_id(&mut analyses, "does-not-exist")
            .expect_err("must error for an unknown artifact_id");
        assert!(err.contains("does-not-exist"));
    }

    /// Restoring the workspace analyses store must not schedule an autosave
    /// flush — `replace_workspace_analyses` has no access to
    /// `schedule_autosave`, so this pins the invariant structurally: the
    /// dirty-tracking generation counter must be unchanged after the call.
    #[test]
    fn set_workspace_analyses_does_not_schedule_autosave() {
        use std::sync::atomic::Ordering;

        let state = AppState::new();
        let before = state.autosave_generation.load(Ordering::Relaxed);

        replace_workspace_analyses(&state, vec![artifact_with_ref("art-a", "sess-a")])
            .expect("replace must succeed");

        let after = state.autosave_generation.load(Ordering::Relaxed);
        assert_eq!(
            before, after,
            "restoring the workspace analyses store must not bump the autosave dirty generation"
        );
        assert_eq!(state.analyses.lock().unwrap().len(), 1, "the store must still be replaced");
    }
}
