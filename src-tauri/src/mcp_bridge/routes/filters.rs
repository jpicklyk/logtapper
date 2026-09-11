//! Filter endpoints: create, info, paginated lines, cancel, close.
//!
//! Every mutation goes through `services::filters` via `ctx.svc(client)` —
//! the same functions `commands::filter` calls for the UI — so an
//! agent-created filter's background scan is the identical scan the desktop
//! command spawns, not a second reimplementation.
//!
//! Progress reports from an agent-triggered scan still land on the desktop:
//! [`h_create_filter`] wraps `ctx.events` (the same `EventSink`/`TauriSink`
//! the UI listens on) in `services::pipeline::EventSinkProgress`, exactly the
//! pattern `h_run_pipeline` established for pipeline runs triggered by an
//! agent — there is no separate agent-side progress channel to receive
//! `filter-progress` on, so an agent instead polls [`h_filter_info`] for
//! `status`/`linesScanned`/`totalLines`.
//!
//! ## Snapshot semantics for agents
//!
//! `totalLines` (from create) and every line `lines` returns reflect only
//! the source window that existed the moment the filter was created. A
//! filter never re-scans or extends itself: lines a streaming session
//! receives afterward are not covered, even while the filter is still
//! `"scanning"` earlier history and even after that scan completes. Create a
//! new filter (or use a watch, `/mcp/sessions/{session_id}/watches`, for a
//! live-matching subscription) to cover data that arrives later. `cancel`
//! stops the scan early; `close` additionally discards this filter's id and
//! matched-line bookkeeping — neither touches the session's history or any
//! other filter's results. See `services::filters` for the full contract.
//!
//! Success bodies are the typed `services::filters` structs; `cancel`/`close`
//! answer [`Ack`]. Failures carry a real status (an unknown filter id is a
//! `404 NOT_FOUND`, an uncompilable regex a `400 INVALID_ARGUMENT`).

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;

use crate::core::filter::FilterCriteria;
use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::client_name;
use crate::services::ServiceError;
use crate::services::events::ProgressSink;
use crate::services::filters::{self, FilterCreateResult, FilterInfo, FilteredLinesResult};
use crate::services::pipeline::EventSinkProgress;
use crate::services::wire::Ack;

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/filters
// ---------------------------------------------------------------------------

pub(crate) async fn h_create_filter(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(criteria): Json<FilterCriteria>,
) -> Result<Json<FilterCreateResult>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    // Same "an agent action still lights up the desktop" pattern as
    // `h_run_pipeline`: `ctx.events` is the real `TauriSink`, so `on_progress`
    // emits `filter-progress` exactly where the UI already listens.
    let progress: Arc<dyn ProgressSink> =
        Arc::new(EventSinkProgress::new(Arc::clone(&ctx.events)));
    Ok(Json(filters::create(&svc, session_id, criteria, progress)?))
}

// ---------------------------------------------------------------------------
// GET /mcp/filters/{filter_id}
// ---------------------------------------------------------------------------

pub(crate) async fn h_filter_info(
    State(ctx): State<BridgeCtx>,
    Path(filter_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<FilterInfo>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(filters::info(&svc, &filter_id)?))
}

// ---------------------------------------------------------------------------
// GET /mcp/filters/{filter_id}/lines?offset=&limit=
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub(crate) struct FilterLinesParams {
    /// 0-based start into the matched-line list (default 0).
    offset: Option<usize>,
    /// Page size (default 200, capped at 1000 by `services::filters::lines`
    /// regardless of what is requested here).
    limit: Option<usize>,
}

pub(crate) async fn h_filter_lines(
    State(ctx): State<BridgeCtx>,
    Path(filter_id): Path<String>,
    Query(params): Query<FilterLinesParams>,
    headers: HeaderMap,
) -> Result<Json<FilteredLinesResult>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    let offset = params.offset.unwrap_or(0);
    let limit = params.limit.unwrap_or(200);
    Ok(Json(filters::lines(&svc, &filter_id, offset, limit)?))
}

// ---------------------------------------------------------------------------
// POST /mcp/filters/{filter_id}/cancel
// ---------------------------------------------------------------------------

pub(crate) async fn h_cancel_filter(
    State(ctx): State<BridgeCtx>,
    Path(filter_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    filters::cancel(&svc, &filter_id)?;
    Ok(Json(Ack::ok()))
}

// ---------------------------------------------------------------------------
// DELETE /mcp/filters/{filter_id}
// ---------------------------------------------------------------------------

pub(crate) async fn h_close_filter(
    State(ctx): State<BridgeCtx>,
    Path(filter_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    filters::close(&svc, &filter_id)?;
    Ok(Json(Ack::ok()))
}
