use tauri::State;

use crate::commands::artifact_mutations;
use crate::commands::{lock_or_err, AppState};
use crate::core::bookmark::{Bookmark, CreatedBy};

/// Create a new bookmark on a specific line.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_bookmark(
    app: tauri::AppHandle,
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
    artifact_mutations::add_bookmark(
        &app,
        session_id,
        line_number,
        label,
        note,
        created_by,
        line_number_end,
        snippet,
        category,
        tags,
    )
}

/// List all bookmarks for a session.
#[tauri::command]
pub fn list_bookmarks(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Bookmark>, String> {
    let bookmarks = lock_or_err(&state.bookmarks, "bookmarks")?;
    Ok(bookmarks.get(&session_id).cloned().unwrap_or_default())
}

/// Update an existing bookmark's label, note, category, and tags.
#[tauri::command]
pub fn update_bookmark(
    app: tauri::AppHandle,
    session_id: String,
    bookmark_id: String,
    label: Option<String>,
    note: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Bookmark, String> {
    artifact_mutations::update_bookmark(&app, session_id, bookmark_id, label, note, category, tags)
}

/// Delete a bookmark by ID.
#[tauri::command]
pub fn delete_bookmark(
    app: tauri::AppHandle,
    session_id: String,
    bookmark_id: String,
) -> Result<(), String> {
    artifact_mutations::remove_bookmark(&app, session_id, bookmark_id).map(|_| ())
}
