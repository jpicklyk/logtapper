//! Settings endpoints: anonymizer config (read + preview) and the open-file
//! allowlist (read only).
//!
//! **Deliberately no write routes here.** `services::settings::{
//! set_anonymizer_config, set_open_allowlist}` both call
//! `policy::deny_agent_gate_mutation` and return `Forbidden` for an
//! `Agent` caller — every bridge caller *is* an `Agent` (`BridgeCtx::svc`
//! only ever constructs `Caller::Agent`), so a `POST`/`PUT` route here would
//! do nothing but round-trip a guaranteed 403. Omitting the route entirely is
//! the honest version of that: an agent cannot widen its own anonymizer
//! config or open-file allowlist, full stop, and the route table says so by
//! not existing rather than by always refusing. If a future package needs an
//! agent-writable setting, it gets its own gate in `services::settings`
//! first — never relax `deny_agent_gate_mutation` to make room for a route.

use axum::{Json, extract::State, http::HeaderMap};
use serde::Deserialize;

use crate::anonymizer::config::AnonymizerConfig;
use crate::commands::bridge_access::McpOpenAllowlist;
use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{JsonBody, client_name};
use crate::services::ServiceError;
use crate::services::settings::{self, AnonymizerTestResult};

/// `GET /mcp/settings/anonymizer` — the current anonymizer configuration.
pub(crate) async fn h_get_anonymizer_config(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<AnonymizerConfig>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(settings::anonymizer_config(&svc)?))
}

/// `GET /mcp/settings/open_allowlist` — the configured MCP open-file
/// allowlist, so an agent can see what it is permitted to open.
pub(crate) async fn h_get_open_allowlist(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<McpOpenAllowlist>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(settings::open_allowlist(&svc)?))
}

#[derive(Deserialize)]
pub(crate) struct TestAnonymizerBody {
    text: String,
}

/// `POST /mcp/settings/anonymizer/test` — preview what the current
/// configuration would redact in `text`. Not a mutation: nothing persisted,
/// nothing config-related changed, so this is fine for an agent to call.
pub(crate) async fn h_test_anonymizer(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<TestAnonymizerBody>,
) -> Result<Json<AnonymizerTestResult>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(settings::test_anonymizer(&svc, body.text)?))
}
