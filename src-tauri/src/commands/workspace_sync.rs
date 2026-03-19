use tauri::Manager;
use crate::commands::AppState;
use crate::workspace;

/// Schedule a debounced workspace save for the given session.
///
/// Cancels any previously pending save for this session, snapshots the current
/// bookmarks and analyses under brief locks, then spawns an async task that
/// waits 1.5s before writing the `.ltw` file. If another mutation arrives
/// before the timer expires, the pending task is cancelled and a new one
/// is spawned.
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

    // 3. Snapshot bookmarks + analyses under brief locks (all dropped before spawn).
    let bookmarks = state.bookmarks.lock().ok()
        .and_then(|b| b.get(session_id).cloned())
        .unwrap_or_default();
    let analyses = state.analyses.lock().ok()
        .and_then(|a| a.get(session_id).cloned())
        .unwrap_or_default();

    // 4. Create cancel token.
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    if let Ok(mut tasks) = state.workspace_save_tasks.lock() {
        tasks.insert(session_id.to_string(), cancel_tx);
    }

    // 5. Spawn debounced save task.
    let app_clone = app.clone();
    let sid = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(1500)) => {
                // Not cancelled — perform the save.
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
                let state: tauri::State<'_, AppState> = app_clone.state();
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
