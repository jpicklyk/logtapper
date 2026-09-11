//! GET/PUT/DELETE /mcp/focus — the shared focus context (see
//! `services::focus`). PUT sets it, DELETE clears it, GET reads it. All three
//! go through the identical `services::focus` functions the `set_focus`/
//! `get_focus` Tauri commands call — an agent's PUT and the UI's own focus
//! push land in the same slot and journal the same `focus.set` action.

use axum::{
    Json,
    extract::State,
    http::HeaderMap,
};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{JsonBody, client_name};
use crate::services::focus::{self, FocusContext, FocusContextInput};
use crate::services::wire::Ack;
use crate::services::ServiceError;

pub(crate) async fn h_get_focus(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<Option<FocusContext>>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(focus::get_focus(&svc)?))
}

pub(crate) async fn h_set_focus(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<FocusContextInput>,
) -> Result<Json<Option<FocusContext>>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(focus::set_focus(&svc, Some(body))?))
}

pub(crate) async fn h_clear_focus(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    focus::set_focus(&svc, None)?;
    Ok(Json(Ack::ok()))
}
