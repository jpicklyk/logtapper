use crate::commands::AppState;
use crate::core::analysis::AnalysisArtifact;
use crate::core::bookmark::Bookmark;
use crate::workspace;

// ---------------------------------------------------------------------------
// Shared snapshot helpers — used by collect_session_data in workspace_cmd.rs
// to read bookmarks/analyses under brief locks.
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

/// Snapshot pipeline meta (chain + disabled IDs) for a session under a brief lock.
pub fn snapshot_pipeline_meta(state: &AppState, session_id: &str) -> workspace::SessionMeta {
    let Ok(guard) = state.session_pipeline_meta.lock() else {
        return workspace::SessionMeta::default();
    };
    guard.get(session_id).cloned().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
}
