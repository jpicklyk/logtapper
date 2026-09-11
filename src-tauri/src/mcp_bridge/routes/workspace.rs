//! Workspace endpoints: list, current, load (open end to end), save, autosave.
//!
//! Every handler goes through `services::workspace` via `ctx.svc(client)` —
//! the same functions `commands::workspace_cmd` calls for the desktop.
//!
//! ## What an agent can and cannot reach
//!
//! Three gates, all enforced inside the service (not here), so the desktop and
//! an agent cannot drift apart:
//!
//! - **Load** ([`h_load_workspace`]) runs the `.ltw` itself through
//!   `services::policy::authorize_open`, and then opens each session it names
//!   through `services::sessions::open`, which gates again. A `.ltw` is a list
//!   of file paths; honouring one blindly would be an allowlist bypass, so
//!   *every* path in the chain is checked, not just the manifest's.
//! - **Save** ([`h_save_workspace`]) runs its caller-chosen destination
//!   through `services::workspace::authorize_write`: the parent directory must
//!   exist inside the MCP open allowlist, and the file name must be a plain
//!   segment. The `.ltw` itself need not exist yet.
//! - **Autosave** ([`h_autosave_workspace`]) writes to the app-owned
//!   `app_data_dir/workspaces/{workspaceId}.ltw`, so there is no destination
//!   for a caller to choose at all — only the id, which the service constrains
//!   to a single path segment.
//!
//! There is deliberately **no** route for `save_app_state`: an agent has no
//! business rewriting the desktop's whole workspace list and active-workspace
//! pointer. `GET /mcp/workspaces` exposes the same data read-only.
//!
//! ## Load is the one orchestrating route
//!
//! The desktop reads a `.ltw` and then runs its own restore rules in
//! TypeScript (`src-next/hooks/workspace/*.ts`) — trust assessment, drift
//! detection, artifact/session pairing, auto-run scheduling. An agent has no
//! frontend to run them, so `POST /mcp/workspace/load` calls
//! `services::workspace::load_and_restore`, which arms the autosave
//! switch-suppression window, reads the manifest and then opens and restores
//! every session in it **sequentially**. One entry failing (file moved,
//! unreadable, outside the allowlist) is recorded on that entry's `error` and
//! the remaining entries still restore, so a partially-recoverable workspace
//! comes back partially rather than not at all.
//!
//! The `layout` tree rides along in the response untouched — the backend never
//! inspects it (see `services::workspace`'s module doc).
//!
//! ## Response shapes
//!
//! These are new routes (no legacy JSON shape to preserve), so success
//! responses serialize the typed `services::workspace` structs directly.
//!
//! The error envelope is `{ "error", "code" }` everywhere, but the status
//! differs by handler class, following the split `h_open_file` established:
//!
//! - The three **write** routes (`load`, `save`, `autosave`) render real HTTP
//!   statuses from [`ServiceError::http_status`] / [`ServiceError::code`] —
//!   `403 NOT_ALLOWED` for a destination or `.ltw` outside the allowlist,
//!   `400 INVALID_PATH` / `INVALID_ARGUMENT` for a malformed one. A gate
//!   refusal that answered `200` would be indistinguishable from success to
//!   any client that checks the status, which is exactly why `h_open_file`
//!   and `h_close_session` were exempted from the 200-always convention.
//! - The two **read** routes keep the ordinary `200 + { "error" }` shape of
//!   every sibling GET in this bridge, pending WP-13's uniform migration.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::mcp_bridge::respond::err;
use crate::mcp_bridge::routes::artifacts::client_name;
use crate::mcp_bridge::BridgeCtx;
use crate::services::{workspace, ServiceError};

/// The legacy read-route envelope: `200` with `{ "error", "code" }`.
fn err_json(e: &ServiceError) -> Json<Value> {
    Json(json!({ "error": e.message(), "code": e.code() }))
}

/// The write-route envelope: the same body under the error's real status.
fn err_response(e: &ServiceError) -> Response {
    let status =
        StatusCode::from_u16(e.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    err(status, e.message(), e.code())
}

// ---------------------------------------------------------------------------
// GET /mcp/workspaces
// ---------------------------------------------------------------------------

/// The persisted workspace list from `app-state.json`.
pub(crate) async fn h_list_workspaces(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match workspace::list(&svc) {
        Ok(entries) => Json(json!({ "workspaces": entries })),
        Err(e) => err_json(&e),
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/workspace
// ---------------------------------------------------------------------------

/// What the backend currently believes the active workspace is — the
/// frontend-supplied envelope merged with the active `app-state.json` entry
/// and the live session set.
pub(crate) async fn h_current_workspace(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match workspace::current(&svc) {
        Ok(summary) => Json(json!(summary)),
        Err(e) => err_json(&e),
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/workspace/load
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct LoadWorkspaceBody {
    pub path: String,
}

/// Open a `.ltw` end to end: arm the switch window, read the manifest, then
/// open and restore every session it names.
pub(crate) async fn h_load_workspace(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Json(body): Json<LoadWorkspaceBody>,
) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    match workspace::load_and_restore(&svc, &body.path).await {
        Ok(outcome) => Json(json!(outcome)).into_response(),
        Err(e) => err_response(&e),
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/workspace/save
// ---------------------------------------------------------------------------

/// Write a `.ltw` at a caller-chosen destination inside the open allowlist.
pub(crate) async fn h_save_workspace(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Json(options): Json<workspace::SaveWorkspaceOptions>,
) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    let dest = options.dest_path.clone();
    match workspace::save(&svc, options) {
        Ok(()) => Json(json!({ "saved": true, "destPath": dest })).into_response(),
        Err(e) => err_response(&e),
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/workspace/autosave
// ---------------------------------------------------------------------------

/// Write the id-keyed auto-save under `app_data_dir/workspaces/`.
pub(crate) async fn h_autosave_workspace(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Json(options): Json<workspace::AutoSaveWorkspaceOptions>,
) -> Response {
    let svc = ctx.svc(&client_name(&headers));
    match workspace::auto_save(&svc, options) {
        Ok(path) => Json(json!({ "saved": true, "path": path })).into_response(),
        Err(e) => err_response(&e),
    }
}
