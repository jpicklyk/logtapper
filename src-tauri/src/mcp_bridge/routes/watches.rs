//! Watch endpoints: list, create, cancel.
//!
//! Every mutation goes through `services::watches` via `ctx.svc(client)` —
//! the same functions `commands::watch` calls for the UI — so a watch created
//! here emits the identical `watch-update` event the Watches panel listens
//! for, instead of the silent, UI-invisible creation this route used to do.
//!
//! Responses are the typed `WatchInfo` itself (list: `Vec<WatchInfo>`); a
//! cancel answers [`Ack`]. Failures are [`ServiceError`] — real status, one
//! envelope (see `mcp_bridge::respond`).

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::Deserialize;

use crate::core::watch::WatchInfo;
use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::client_name;
use crate::services::ServiceError;
use crate::services::watches;
use crate::services::wire::Ack;

pub(crate) async fn h_list_watches(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<WatchInfo>>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(watches::list(&svc, &session_id)?))
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
) -> Result<Json<WatchInfo>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(watches::create(&svc, session_id, body.criteria)?))
}

pub(crate) async fn h_cancel_watch(
    State(ctx): State<BridgeCtx>,
    Path((session_id, watch_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    watches::cancel(&svc, session_id, watch_id)?;
    Ok(Json(Ack::ok()))
}
