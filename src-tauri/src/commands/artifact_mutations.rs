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
use crate::core::analysis::{AnalysisArtifact, AnalysisSection, AnalysisUpdateEvent};
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
pub fn publish_analysis(
    app: &AppHandle,
    session_id: String,
    title: String,
    sections: Vec<AnalysisSection>,
) -> Result<AnalysisArtifact, String> {
    let state = app.state::<AppState>();

    // Verify session exists.
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
        created_at: crate::workspace::now_ms(),
        sections,
    };

    {
        let mut analyses = lock_or_err(&state.analyses, "analyses")?;
        analyses
            .entry(session_id.clone())
            .or_default()
            .push(artifact.clone());
    }

    let _ = app.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            session_id,
            action: "published".to_string(),
            artifact_id: artifact.id.clone(),
        },
    );

    schedule_autosave(&state);

    Ok(artifact)
}

/// Update an analysis artifact's title / sections, emit `analysis-update`
/// (`updated`), and schedule a flush.
pub fn update_analysis(
    app: &AppHandle,
    session_id: String,
    artifact_id: String,
    title: Option<String>,
    sections: Option<Vec<AnalysisSection>>,
) -> Result<AnalysisArtifact, String> {
    let state = app.state::<AppState>();

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

    let _ = app.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            session_id,
            action: "updated".to_string(),
            artifact_id: updated.id.clone(),
        },
    );

    schedule_autosave(&state);

    Ok(updated)
}

/// Remove an analysis artifact, emit `analysis-update` (`deleted`), and schedule
/// a flush.
pub fn remove_analysis(
    app: &AppHandle,
    session_id: String,
    artifact_id: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();

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

    let _ = app.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            session_id,
            action: "deleted".to_string(),
            artifact_id,
        },
    );

    schedule_autosave(&state);

    Ok(())
}
