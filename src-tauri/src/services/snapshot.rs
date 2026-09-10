//! Owned reads of `AppState` — the lock-discipline choke point.
//!
//! A service function holds **at most one** `AppState` lock. Anything needing
//! two pieces of state takes them one at a time through a helper here: acquire,
//! clone what is needed, drop, return owned data. Concentrating that pattern in
//! one file means the "never nest two `AppState` locks" rule is auditable by
//! reading a single module instead of every service.
//!
//! These three helpers were moved here from `commands/workspace_sync.rs`, which
//! now re-exports them so its existing callers (`collect_session_data` in
//! `workspace_cmd.rs`) are unchanged.
//!
//! **Lock-poison policy:** the save-path helpers return an empty value rather
//! than an error. A poisoned `bookmarks` map must not abort a workspace save —
//! losing an autosave is worse than saving without one map's contents. Service
//! functions on the read path should use `lock_svc` and surface
//! `ServiceError::LockPoisoned` instead.

use crate::commands::AppState;
use crate::core::analysis::AnalysisArtifact;
use crate::core::bookmark::Bookmark;
use crate::workspace;

/// Snapshot bookmarks for a session under a brief lock.
pub fn snapshot_bookmarks(state: &AppState, session_id: &str) -> Vec<Bookmark> {
    let Ok(guard) = state.bookmarks.lock() else {
        return vec![];
    };
    guard.get(session_id).cloned().unwrap_or_default()
}

/// Snapshot the entire workspace-owned analyses store under a brief lock.
/// Analyses are not keyed by session — this is the full, unfiltered list;
/// callers that need a single session's subset should filter with
/// [`crate::core::analysis::artifact_references_session`].
pub fn snapshot_workspace_analyses(state: &AppState) -> Vec<AnalysisArtifact> {
    let Ok(guard) = state.analyses.lock() else {
        return vec![];
    };
    guard.clone()
}

/// Snapshot pipeline meta (chain + disabled IDs) for a session under a brief lock.
pub fn snapshot_pipeline_meta(state: &AppState, session_id: &str) -> workspace::SessionMeta {
    let Ok(guard) = state.session_pipeline_meta.lock() else {
        return workspace::SessionMeta::default();
    };
    guard.get(session_id).cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_state() -> AppState {
        AppState::new()
    }

    #[test]
    fn snapshot_pipeline_meta_returns_default_when_absent() {
        let state = make_state();
        let meta = snapshot_pipeline_meta(&state, "nonexistent-session");
        assert!(meta.active_processor_ids.is_empty());
        assert!(meta.disabled_processor_ids.is_empty());
    }

    #[test]
    fn snapshot_workspace_analyses_returns_full_unfiltered_list() {
        let state = make_state();
        state.analyses.lock().unwrap().push(AnalysisArtifact {
            id: "art-1".to_string(),
            title: "T".to_string(),
            created_at: 0,
            sections: vec![],
            legacy_session_id: None,
        });

        let snapshot = snapshot_workspace_analyses(&state);
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].id, "art-1");
    }

    #[test]
    fn snapshot_bookmarks_returns_empty_for_an_unknown_session() {
        let state = make_state();
        assert!(snapshot_bookmarks(&state, "nope").is_empty());
    }

    #[test]
    fn save_path_helpers_degrade_to_empty_on_poison_instead_of_panicking() {
        // A poisoned map must not abort a workspace save.
        let state = std::sync::Arc::new(make_state());
        let poisoner = std::sync::Arc::clone(&state);
        let joined = std::thread::spawn(move || {
            let _g = poisoner.bookmarks.lock().expect("lock not yet poisoned");
            panic!("simulated writer panic while holding bookmarks");
        })
        .join();
        assert!(joined.is_err());
        assert!(state.bookmarks.is_poisoned());
        assert!(snapshot_bookmarks(&state, "any").is_empty());
    }
}
