use tauri::State;
use uuid::Uuid;

use crate::commands::{lock_or_err, AppState};
use crate::core::bookmark::{Bookmark, BookmarkUpdateEvent, CreatedBy};

/// Create a new bookmark on a specific line.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_bookmark(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
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
    // Verify session exists
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
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
    };

    {
        let mut bookmarks = lock_or_err(&state.bookmarks, "bookmarks")?;
        bookmarks
            .entry(session_id.clone())
            .or_default()
            .push(bookmark.clone());
    }

    use tauri::Emitter;
    let _ = app.emit(
        "bookmark-update",
        BookmarkUpdateEvent {
            session_id,
            action: "created".to_string(),
            bookmark: bookmark.clone(),
        },
    );

    Ok(bookmark)
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
#[allow(clippy::too_many_arguments)]
pub fn update_bookmark(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    bookmark_id: String,
    label: Option<String>,
    note: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Bookmark, String> {
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

    use tauri::Emitter;
    let _ = app.emit(
        "bookmark-update",
        BookmarkUpdateEvent {
            session_id,
            action: "updated".to_string(),
            bookmark: updated.clone(),
        },
    );

    Ok(updated)
}

/// Delete a bookmark by ID.
#[tauri::command]
pub fn delete_bookmark(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    bookmark_id: String,
) -> Result<(), String> {
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

    use tauri::Emitter;
    let _ = app.emit(
        "bookmark-update",
        BookmarkUpdateEvent {
            session_id,
            action: "deleted".to_string(),
            bookmark: removed,
        },
    );

    Ok(())
}
