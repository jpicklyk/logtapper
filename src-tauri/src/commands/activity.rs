//! The UI half of the shared activity feed.
//!
//! Reads the same `AppState::activity` journal `GET /mcp/activity` reads, so
//! the UI sees agent actions and an agent sees UI actions — one feed, not two.
//! Writes happen only through `services::ServiceCtx::journal`.

use std::sync::Arc;

use tauri::State;

use crate::commands::AppState;
use crate::services::ActivityEntry;

/// Return journaled actions, newest-last.
///
/// - `limit` — cap the result at the newest N entries.
/// - `since_id` — return only entries with `id > since_id`, for incremental
///   polling. Combine both to poll a bounded tail.
///
/// The journal is a bounded ring (500 entries), so a caller that polls slower
/// than the app mutates will see a gap between its `since_id` and the oldest
/// returned `id`. Ids are monotonic for the life of the process, which is what
/// makes that gap detectable rather than silent.
///
/// Infallible — a poisoned journal lock recovers in place rather than failing
/// the read — but the signature keeps `Result` so the frontend's generated
/// binding does not change shape if that ever stops being true.
#[tauri::command]
pub fn get_activity(
    state: State<'_, Arc<AppState>>,
    limit: Option<usize>,
    since_id: Option<u64>,
) -> Result<Vec<ActivityEntry>, String> {
    Ok(state.activity.list(limit, since_id))
}

#[cfg(test)]
mod tests {
    use crate::services::testing::test_ctx;
    use crate::services::Caller;

    /// The command is a one-line read over `ActivityJournal::list`; what is
    /// worth pinning here is that a UI read and an agent read see the SAME
    /// entries, including each other's. `get_activity` itself needs a Tauri
    /// `State`, so the assertion runs against the journal it delegates to.
    #[test]
    fn ui_and_agent_actions_land_in_one_feed() {
        let (ui, _tmp) = test_ctx().with_session("s1", 1).build();
        let agent = ui.with_caller(Caller::agent("claude-code"));

        ui.journal("session.open", Some("s1"), "opened dumpstate.txt");
        agent.journal("bookmark.create", Some("s1"), "line 42: ANR");
        ui.journal("pipeline.run", Some("s1"), "3 processors");

        let all = ui.state().activity.list(None, None);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].caller, Caller::Ui);
        assert_eq!(all[1].caller, Caller::agent("claude-code"));
        assert_eq!(all[2].action, "pipeline.run");

        // Incremental poll from the agent's own entry forward.
        let tail = ui.state().activity.list(None, Some(all[1].id));
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].action, "pipeline.run");

        // limit keeps the newest.
        let newest = ui.state().activity.list(Some(1), None);
        assert_eq!(newest.len(), 1);
        assert_eq!(newest[0].action, "pipeline.run");
    }
}
