//! GET /mcp/sessions/{session_id}/insights
//!
//! A one-line adapter over `services::insights::digest` — see that module for
//! the shared evaluation logic.
//!
//! **Wire change (WP-13).** This route used to hand-render the digest back into
//! the snake_case shape it had before `Insights` was a type, including one
//! asymmetry: `last_line` was emitted only for aggregate signals and omitted
//! *entirely* (not as `null`) for per-emission ones. `Insights` now serializes
//! itself, so the body is camelCase throughout (`sessionId`, `processorId`,
//! `processorName`, `signalCounts`, `totalEmissions`, `lastLine`) and every
//! signal carries `lastLine` — `null` where the old shape had no key at all —
//! alongside the new `isAggregate` discriminant that explains it.

use std::collections::HashSet;

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::Deserialize;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{Qs, client_name};
use crate::services::ServiceError;
use crate::services::insights::{self, Insights};

#[derive(Deserialize)]
pub(crate) struct InsightsParams {
    /// Max total signal events to return across all processors (default 20).
    max_signals: Option<usize>,
    /// Comma-separated list of processor IDs to include. If absent, all are included.
    processor_ids: Option<String>,
}

pub(crate) async fn h_insights(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Qs(params): Qs<InsightsParams>,
) -> Result<Json<Insights>, ServiceError> {
    let max_signals = params.max_signals.unwrap_or(20);
    let filter_ids: Option<HashSet<String>> = params.processor_ids.map(|s| {
        s.split(',')
            .map(|id| id.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });

    let svc = ctx.svc(client_name(&headers));
    Ok(Json(insights::digest(
        &svc,
        &session_id,
        max_signals,
        filter_ids.as_ref(),
    )?))
}
