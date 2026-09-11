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
use crate::mcp_bridge::respond::{JsonBody, client_name};
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
///
/// `options.anonymize` is `Ui`-only (the Export dialog's "Anonymize PII"
/// checkbox) and is silently ignored for this route: an agent's export is
/// redacted solely by `services::policy::should_anonymize` (i.e.
/// `agent_raw_access`), never by a flag the agent's own request body
/// controls — see `services::export`'s module doc comment ("Redaction").
pub(crate) async fn h_export_run(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    JsonBody(options): JsonBody<ExportAllOptions>,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    export::run(svc, options).await?;
    Ok(Json(Ack::ok()))
}
