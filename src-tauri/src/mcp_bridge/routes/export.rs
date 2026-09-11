//! Multi-session export endpoints.
//!
//! `GET /mcp/export/info` and `POST /mcp/export` are global (not
//! session-scoped) — they operate over every open session, mirroring
//! `services::export::{info, run}`. See that module's doc comment for the
//! destination policy and redaction rules an agent's export is subject to.
//!
//! `h_export_run` is the one handler in this file that answers with a REAL
//! HTTP status rather than today's Wave-2 default of "200 + `{error}`" —
//! matching the precedent `h_open_file` already set for a caller-identity
//! gate on a filesystem path (`routes/sessions.rs`'s `err()` helper). The
//! task this package shipped under calls out a concrete `403 NOT_ALLOWED`
//! for a denied export destination, and `ServiceError` already carries the
//! right `(status, code)` pair for every branch uniformly, so there is no
//! reason to special-case just the destination check — every failure from
//! `export::run` (denied destination, a poisoned lock, an unsupported source)
//! renders through the same real-status envelope. `h_export_info` stays on
//! the ordinary read-route convention (200 + `{error}`) — it is a pure read
//! with no gate to signal.
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::err;
use crate::mcp_bridge::routes::tracker::client_name;
use crate::services::export::{self, ExportAllOptions};

// ---------------------------------------------------------------------------
// GET /mcp/export/info
// ---------------------------------------------------------------------------

pub(crate) async fn h_export_info(State(ctx): State<BridgeCtx>, headers: HeaderMap) -> Json<Value> {
    let svc = ctx.svc(client_name(&headers));
    match export::info(&svc) {
        Ok(info) => Json(json!(info)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/export
// ---------------------------------------------------------------------------

/// Body is `ExportAllOptions` as-is — `dest_path` already carries the
/// destination, so there is nothing to add beyond the options the desktop UI
/// already sends.
pub(crate) async fn h_export_run(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Json(options): Json<ExportAllOptions>,
) -> Response {
    let svc = ctx.svc(client_name(&headers));
    match export::run(svc, options).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => {
            let status = StatusCode::from_u16(e.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            err(status, e.message(), e.code())
        }
    }
}
