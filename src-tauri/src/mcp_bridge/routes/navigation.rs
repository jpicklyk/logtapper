//! POST /mcp/navigate — an agent asking the UI to jump to a specific
//! line/analysis in a session. See `services::navigation`.

use axum::{
    Json,
    extract::State,
    http::HeaderMap,
};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{JsonBody, client_name};
use crate::services::navigation::{self, NavRequest, NavRequestInput};
use crate::services::ServiceError;

pub(crate) async fn h_request_navigation(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<NavRequestInput>,
) -> Result<Json<NavRequest>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(navigation::request_navigation(&svc, body)?))
}
