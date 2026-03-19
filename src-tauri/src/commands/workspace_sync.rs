use tauri::Manager;
use crate::commands::AppState;
use crate::core::analysis::AnalysisArtifact;
use crate::core::bookmark::Bookmark;
use crate::workspace;

// ---------------------------------------------------------------------------
// Shared snapshot helpers — used by both schedule_workspace_save and
// close_session_inner to read bookmarks/analyses under brief locks.
// Returns empty Vec on lock poison (non-fatal for save paths).
// ---------------------------------------------------------------------------

/// Snapshot bookmarks for a session under a brief lock.
pub fn snapshot_bookmarks(state: &AppState, session_id: &str) -> Vec<Bookmark> {
    let Ok(guard) = state.bookmarks.lock() else { return vec![] };
    guard.get(session_id).cloned().unwrap_or_default()
}

/// Snapshot analyses for a session under a brief lock.
pub fn snapshot_analyses(state: &AppState, session_id: &str) -> Vec<AnalysisArtifact> {
    let Ok(guard) = state.analyses.lock() else { return vec![] };
    guard.get(session_id).cloned().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Debounced workspace auto-save
// ---------------------------------------------------------------------------

/// Schedule a debounced workspace save for the given session.
///
/// Cancels any previously pending save for this session, then spawns an async
/// task that waits 1.5s before reading the *latest* bookmarks/analyses and
/// writing the `.ltw` file. Reading at save time (not schedule time) means
/// mutations during the debounce window are captured without per-call clones.
///
/// No-op for streaming sessions (no `file_path`).
pub fn schedule_workspace_save(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: &str,
) {
    // 1. Get file_path for this session (brief lock, immediately dropped).
    let file_path = {
        let Ok(sessions) = state.sessions.lock() else { return };
        let Some(fp) = sessions.get(session_id).and_then(|s| s.file_path.clone()) else {
            return; // streaming session — skip
        };
        fp
    };

    // 2. Cancel any previous pending save for this session.
    if let Ok(mut tasks) = state.workspace_save_tasks.lock() {
        tasks.remove(session_id); // dropping the sender cancels the previous task
    }

    // 3. Create cancel token.
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    if let Ok(mut tasks) = state.workspace_save_tasks.lock() {
        tasks.insert(session_id.to_string(), cancel_tx);
    }

    // 4. Spawn debounced save task — reads latest state at save time.
    let app_clone = app.clone();
    let sid = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(1500)) => {
                // Not cancelled — snapshot now (captures all mutations in the window).
                let state: tauri::State<'_, AppState> = app_clone.state();
                let bookmarks = snapshot_bookmarks(&state, &sid);
                let analyses = snapshot_analyses(&state, &sid);

                let ws_path = match workspace::workspace_path_for(&app_clone, &file_path) {
                    Ok(p) => p,
                    Err(e) => {
                        log::warn!("Workspace path resolution failed for {sid}: {e}");
                        return;
                    }
                };
                let meta = workspace::SessionMeta::default();
                if let Err(e) = workspace::save_workspace(&ws_path, &file_path, &bookmarks, &analyses, &meta) {
                    log::warn!("Workspace auto-save failed for {sid}: {e}");
                } else if let Ok(dir) = workspace::workspace_dir(&app_clone) {
                    workspace::evict_old_workspaces(&dir, 20);
                }
                // Clean up the task entry.
                if let Ok(mut tasks) = state.workspace_save_tasks.lock() {
                    tasks.remove(&sid);
                };
            }
            _ = cancel_rx => {
                // Cancelled by a newer mutation — do nothing.
            }
        }
    });
}
