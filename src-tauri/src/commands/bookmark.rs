//! Thin Tauri adapters over `services::bookmarks`. Each command builds a
//! [`crate::commands::adapters::ui_ctx`], calls one service function, and
//! marshals the `Result<T, ServiceError>` into the `Result<T, String>` the
//! frontend expects.

use crate::commands::adapters::ui_ctx;
use crate::core::bookmark::{Bookmark, CreatedBy};
use crate::services::bookmarks;

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
    let ctx = ui_ctx(&app);
    Ok(bookmarks::create(
        &ctx,
        session_id,
        line_number,
        label,
        note,
        created_by,
        line_number_end,
        snippet,
        category,
        tags,
    )?)
}

/// List all bookmarks for a session (unfiltered — see
/// `services::bookmarks::list` for the category/tag filter the MCP bridge
/// uses).
#[tauri::command]
pub fn list_bookmarks(app: tauri::AppHandle, session_id: String) -> Result<Vec<Bookmark>, String> {
    let ctx = ui_ctx(&app);
    Ok(bookmarks::list(&ctx, &session_id, None, None)?)
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
    let ctx = ui_ctx(&app);
    Ok(bookmarks::update(
        &ctx,
        session_id,
        bookmark_id,
        label,
        note,
        category,
        tags,
    )?)
}

/// Delete a bookmark by ID.
#[tauri::command]
pub fn delete_bookmark(
    app: tauri::AppHandle,
    session_id: String,
    bookmark_id: String,
) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    bookmarks::remove(&ctx, session_id, bookmark_id)?;
    Ok(())
}
