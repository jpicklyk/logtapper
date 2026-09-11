//! GET/PUT/DELETE for user themes — see `services::themes` for the shape,
//! validation rules, and the Ui-only write/delete gate. `PUT`/`DELETE`
//! always answer 403 `NOT_ALLOWED` for an agent caller, via the same
//! `policy::deny_agent_gate_mutation` mechanism that protects the anonymizer
//! config, the open-file allowlist, and the agent raw-access setting — the
//! decision lives in `services::themes`/`services::policy`, not here.

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{JsonBody, client_name};
use crate::services::ServiceError;
use crate::services::themes::{self, ThemeSummary, UserTheme};
use crate::services::wire::Ack;

pub(crate) async fn h_list_themes(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<Vec<ThemeSummary>>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(themes::list(&svc)?))
}

pub(crate) async fn h_read_theme(
    State(ctx): State<BridgeCtx>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Json<UserTheme>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(themes::read(&svc, &slug)?))
}

pub(crate) async fn h_write_theme(
    State(ctx): State<BridgeCtx>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<UserTheme>,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    themes::write(&svc, &slug, body)?;
    Ok(Json(Ack::ok()))
}

pub(crate) async fn h_delete_theme(
    State(ctx): State<BridgeCtx>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    themes::delete(&svc, &slug)?;
    Ok(Json(Ack::ok()))
}
