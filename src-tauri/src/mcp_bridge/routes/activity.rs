//! GET /mcp/activity?since=&limit=

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::Qs;
use crate::services::ActivityEntry;

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ActivityParams {
    /// Return only entries with `id > since`. Omit for everything retained.
    since: Option<u64>,
    /// Cap the result at the newest `limit` entries.
    limit: Option<usize>,
}

/// The shared activity feed: every state-changing action, whether the user
/// performed it in the UI or an agent performed it here.
///
/// The agent-facing half of the `get_activity` command — same journal, same
/// `ActivityEntry` shape, so an agent and the UI genuinely see one feed rather
/// than two views that can disagree. Reads are never journaled, so polling this
/// route does not pollute it.
pub(crate) async fn h_activity(
    State(ctx): State<BridgeCtx>,
    Qs(params): Qs<ActivityParams>,
) -> Json<Vec<ActivityEntry>> {
    Json(ctx.state.activity.list(params.limit, params.since))
}
