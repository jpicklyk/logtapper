//! Chart and timeline-series endpoints.
//!
//! `GET /mcp/sessions/{session_id}/chart` and
//! `GET /mcp/sessions/{session_id}/timeline` are kept as **two separate
//! routes**, not folded into one. `services::timeline::chart_data` takes a
//! single `processor_id` and returns every `ChartData` that processor's
//! `output.charts` spec declares (a different response shape per call); the
//! timeline endpoint takes a *set* of processor ids and returns one
//! downsampled `(line_num, value)` series per `timeline`-annotated chart
//! spec across all of them. Folding the two under one path would mean either
//! two mutually-exclusive query-parameter modes on one route (worse for MCP
//! tool schemas, which want one shape per tool) or a response union — neither
//! is simpler than two small routes with one query param each.
//!
//! Both handlers are thin renderers over `services::timeline`, which reads
//! only structured chart/emission data — never raw log-line text — so
//! neither goes through `policy::redact_line` (see that service module's doc
//! comment for the full trace).

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp_bridge::routes::tracker::client_name;
use crate::mcp_bridge::BridgeCtx;
use crate::services::timeline;

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/chart
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct ChartParams {
    /// The processor whose `output.charts` to compute.
    processor_id: String,
}

pub(crate) async fn h_chart(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(params): Query<ChartParams>,
) -> Json<Value> {
    let svc = ctx.svc(client_name(&headers));
    match timeline::chart_data(&svc, &session_id, &params.processor_id) {
        Ok(charts) => Json(json!(charts)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/timeline
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct TimelineParams {
    /// Comma-separated list of processor IDs to search for
    /// `timeline`-annotated chart specs.
    processor_ids: String,
}

pub(crate) async fn h_timeline(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(params): Query<TimelineParams>,
) -> Json<Value> {
    let processor_ids: Vec<String> = params
        .processor_ids
        .split(',')
        .map(|id| id.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let svc = ctx.svc(client_name(&headers));
    match timeline::timeline_data(&svc, &session_id, &processor_ids) {
        Ok(series) => Json(json!(series)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}
