use std::path::Path;

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

    // 2. Create cancel token. Insert replaces any previous sender for this session,
    //    which drops it and cancels the pending task. Single lock acquisition avoids
    //    a race between concurrent calls for the same session_id.
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

// ---------------------------------------------------------------------------
// Synchronous flush — called on app exit (RunEvent::Exit)
// ---------------------------------------------------------------------------

/// Flush all workspace (.ltw) files synchronously.
///
/// Called from the `RunEvent::Exit` handler in `lib.rs`. This is lighter than
/// `close_session_inner` — it only saves .ltw files without tearing down
/// sessions, since the process is about to exit anyway.
///
/// Testable without `AppHandle` because it takes a pre-resolved `workspace_dir`.
pub fn flush_all_workspaces_inner(state: &AppState, workspace_dir: &Path) {
    // 1. Cancel all pending debounced saves (brief lock, immediately dropped).
    //    Dropping the senders signals cancellation to any spawned async tasks.
    if let Ok(mut tasks) = state.workspace_save_tasks.lock() {
        tasks.clear();
    }

    // 2. Collect (session_id, file_path) pairs under a brief sessions lock.
    //    Skip streaming sessions (no file_path) and .lts sessions (self-contained).
    let sessions_to_save: Vec<(String, String)> = {
        let Ok(sessions) = state.sessions.lock() else { return };
        sessions
            .values()
            .filter_map(|s| {
                let fp = s.file_path.as_ref()?;
                if fp.ends_with(".lts") {
                    return None;
                }
                Some((s.id.clone(), fp.clone()))
            })
            .collect()
    }; // sessions lock dropped

    // 3. For each session: snapshot bookmarks/analyses, write .ltw.
    for (session_id, file_path) in &sessions_to_save {
        let bookmarks = snapshot_bookmarks(state, session_id);
        let analyses = snapshot_analyses(state, session_id);

        let ws_path = workspace_dir.join(workspace::path_to_workspace_name(file_path));
        let meta = workspace::SessionMeta::default();
        if let Err(e) = workspace::save_workspace(&ws_path, file_path, &bookmarks, &analyses, &meta) {
            log::warn!("Exit flush failed for session {session_id}: {e}");
        }
    }

    // 4. Evict old workspaces once (not per-session).
    if !sessions_to_save.is_empty() {
        workspace::evict_old_workspaces(workspace_dir, 20);
    }
}

/// Flush all workspace files on app exit. Resolves the workspace directory
/// from the `AppHandle` and delegates to `flush_all_workspaces_inner`.
pub fn flush_all_workspaces(app: &tauri::AppHandle) {
    let dir = match workspace::workspace_dir(app) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("flush_all_workspaces: failed to resolve workspace dir: {e}");
            return;
        }
    };
    let state = app.state::<AppState>();
    flush_all_workspaces_inner(&state, &dir);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::session::AnalysisSession;
    use crate::core::bookmark::{Bookmark, CreatedBy};
    use crate::core::analysis::AnalysisArtifact;

    fn make_state() -> AppState {
        AppState::new()
    }

    fn insert_session(state: &AppState, id: &str, file_path: Option<&str>) {
        let mut session = AnalysisSession::new(id.to_string());
        session.file_path = file_path.map(str::to_string);
        state.sessions.lock().unwrap().insert(id.to_string(), session);
    }

    fn make_bookmark(session_id: &str, line: u32) -> Bookmark {
        Bookmark {
            id: format!("bm-{line}"),
            session_id: session_id.to_string(),
            line_number: line,
            line_number_end: None,
            snippet: None,
            category: None,
            tags: None,
            label: format!("Label {line}"),
            note: String::new(),
            created_by: CreatedBy::User,
            created_at: 1000,
        }
    }

    fn make_artifact(session_id: &str, title: &str) -> AnalysisArtifact {
        AnalysisArtifact {
            id: format!("art-{title}"),
            session_id: session_id.to_string(),
            title: title.to_string(),
            created_at: 2000,
            sections: vec![],
        }
    }

    fn count_ltw_files(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "ltw"))
            .count()
    }

    #[test]
    fn flush_saves_file_backed_session() {
        let state = make_state();
        let tmp = tempfile::tempdir().expect("tmpdir");

        insert_session(&state, "sess-1", Some("/logs/device.log"));
        state.bookmarks.lock().unwrap()
            .insert("sess-1".to_string(), vec![make_bookmark("sess-1", 42)]);
        state.analyses.lock().unwrap()
            .insert("sess-1".to_string(), vec![make_artifact("sess-1", "Test")]);

        flush_all_workspaces_inner(&state, tmp.path());

        // Verify .ltw file was created and is loadable
        let ws_name = workspace::path_to_workspace_name("/logs/device.log");
        let ws_path = tmp.path().join(&ws_name);
        assert!(ws_path.exists(), ".ltw file must be created: {ws_name}");

        let loaded = workspace::load_workspace(&ws_path).expect("load_workspace");
        assert_eq!(loaded.bookmarks.len(), 1);
        assert_eq!(loaded.bookmarks[0].line_number, 42);
        assert_eq!(loaded.analyses.len(), 1);
        assert_eq!(loaded.analyses[0].title, "Test");
    }

    #[test]
    fn flush_skips_streaming_session() {
        let state = make_state();
        let tmp = tempfile::tempdir().expect("tmpdir");

        // Streaming session has file_path = None
        insert_session(&state, "adb-sess", None);
        state.bookmarks.lock().unwrap()
            .insert("adb-sess".to_string(), vec![make_bookmark("adb-sess", 10)]);

        flush_all_workspaces_inner(&state, tmp.path());

        assert_eq!(count_ltw_files(tmp.path()), 0,
            "no .ltw file should be created for streaming sessions");
    }

    #[test]
    fn flush_skips_lts_session() {
        let state = make_state();
        let tmp = tempfile::tempdir().expect("tmpdir");

        insert_session(&state, "lts-sess", Some("/exports/capture.lts"));
        state.bookmarks.lock().unwrap()
            .insert("lts-sess".to_string(), vec![make_bookmark("lts-sess", 5)]);

        flush_all_workspaces_inner(&state, tmp.path());

        assert_eq!(count_ltw_files(tmp.path()), 0,
            "no .ltw file should be created for .lts sessions");
    }

    #[test]
    fn flush_cancels_pending_debounced_saves() {
        let state = make_state();
        let tmp = tempfile::tempdir().expect("tmpdir");

        // Simulate a pending debounced save
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
        state.workspace_save_tasks.lock().unwrap()
            .insert("sess-1".to_string(), cancel_tx);

        insert_session(&state, "sess-1", Some("/logs/file.log"));

        flush_all_workspaces_inner(&state, tmp.path());

        assert!(state.workspace_save_tasks.lock().unwrap().is_empty(),
            "pending debounced saves must be cancelled");
        // The receiver should see the channel closed (sender was dropped)
        assert!(cancel_rx.try_recv().is_err(),
            "cancel channel must be closed after flush");
    }

    #[test]
    fn flush_saves_multiple_sessions() {
        let state = make_state();
        let tmp = tempfile::tempdir().expect("tmpdir");

        for i in 0..3 {
            let id = format!("sess-{i}");
            let path = format!("/logs/file{i}.log");
            insert_session(&state, &id, Some(&path));
            state.bookmarks.lock().unwrap()
                .insert(id.clone(), vec![make_bookmark(&id, i * 10)]);
        }

        flush_all_workspaces_inner(&state, tmp.path());

        assert_eq!(count_ltw_files(tmp.path()), 3,
            "three .ltw files must be created for three sessions");
    }

    #[test]
    fn flush_empty_state_is_noop() {
        let state = make_state();
        let tmp = tempfile::tempdir().expect("tmpdir");

        // No sessions at all — must not panic
        flush_all_workspaces_inner(&state, tmp.path());

        assert_eq!(count_ltw_files(tmp.path()), 0);
    }

    #[test]
    fn flush_does_not_remove_sessions() {
        let state = make_state();
        let tmp = tempfile::tempdir().expect("tmpdir");

        insert_session(&state, "sess-1", Some("/logs/device.log"));

        flush_all_workspaces_inner(&state, tmp.path());

        // Unlike close_session_inner, flush must NOT remove sessions from state
        assert!(state.sessions.lock().unwrap().contains_key("sess-1"),
            "sessions must remain in state after flush (not a full teardown)");
    }
}
