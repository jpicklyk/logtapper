//! Watch endpoints: list, create, cancel.
//!
//! Every mutation goes through `services::watches` via `ctx.svc(client)` —
//! the same functions `commands::watch` calls for the UI — so a watch created
//! here emits the identical `watch-update` event the Watches panel listens
//! for, instead of the silent, UI-invisible creation this route used to do.

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::routes::artifacts::client_name;
use crate::services::watches;

pub(crate) async fn h_list_watches(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match watches::list(&svc, &session_id) {
        Ok(list) => Json(json!(list)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateWatchBody {
    #[serde(flatten)]
    criteria: crate::core::filter::FilterCriteria,
}

pub(crate) async fn h_create_watch(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreateWatchBody>,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match watches::create(&svc, session_id, body.criteria) {
        Ok(info) => Json(json!(info)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

pub(crate) async fn h_cancel_watch(
    State(ctx): State<BridgeCtx>,
    Path((session_id, watch_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match watches::cancel(&svc, session_id, watch_id) {
        Ok(()) => Json(json!({"ok": true})),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}
