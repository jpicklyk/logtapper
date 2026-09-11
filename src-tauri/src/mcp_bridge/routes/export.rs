//! Multi-session export endpoints.
//!
//! `GET /mcp/export/info` and `POST /mcp/export` are global (not
//! session-scoped) — they operate over every open session, mirroring
//! `services::export::{info, run}`. See that module's doc comment for the
//! destination policy and redaction rules an agent's export is subject to.
//!
//! Both answer with a real HTTP status: a denied destination is
//! `403 NOT_ALLOWED`, a malformed one `400 INVALID_PATH`. `h_export_run` was
//! already on real statuses before WP-13 (it was the first route to need a
//! gate refusal to be distinguishable from success); `h_export_info` joined it
//! when every route did.

use axum::{Json, extract::State, http::HeaderMap};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::client_name;
use crate::services::ServiceError;
use crate::services::export::{self, ExportAllOptions, ExportAllSessionsInfo};
use crate::services::wire::Ack;

// ---------------------------------------------------------------------------
// GET /mcp/export/info
// ---------------------------------------------------------------------------

pub(crate) async fn h_export_info(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<ExportAllSessionsInfo>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(export::info(&svc)?))
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
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    export::run(svc, options).await?;
    Ok(Json(Ack::ok()))
}
