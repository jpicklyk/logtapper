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
//! Success bodies are the typed `services::workspace` structs; `save` and
//! `autosave` share one [`WorkspaceSaved`] shape (pre-WP-13 they spelled the
//! same fact `destPath` and `path` respectively). Failures carry a real
//! status — `403 NOT_ALLOWED` for a destination or `.ltw` outside the
//! allowlist, `400 INVALID_PATH` / `INVALID_ARGUMENT` for a malformed one.

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::Deserialize;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{JsonBody, Qs, client_name};
use crate::services::ServiceError;
use crate::services::workspace::{
    self, DeleteWorkspaceRequest, RenameWorkspaceRequest, WorkspaceLoadOutcome, WorkspaceSummary,
};
use crate::services::wire::{Ack, WorkspaceList, WorkspaceSaved};
use crate::workspace::app_state::WorkspaceEntry;

// ---------------------------------------------------------------------------
// GET /mcp/workspaces
// ---------------------------------------------------------------------------

/// The persisted workspace list from `app-state.json`.
pub(crate) async fn h_list_workspaces(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<WorkspaceList>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(WorkspaceList { workspaces: workspace::list(&svc)? }))
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
) -> Result<Json<WorkspaceSummary>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(workspace::current(&svc)?))
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
    JsonBody(body): JsonBody<LoadWorkspaceBody>,
) -> Result<Json<WorkspaceLoadOutcome>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(workspace::load_and_restore(&svc, &body.path).await?))
}

// ---------------------------------------------------------------------------
// POST /mcp/workspace/save
// ---------------------------------------------------------------------------

/// Write a `.ltw` at a caller-chosen destination inside the open allowlist.
pub(crate) async fn h_save_workspace(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    JsonBody(options): JsonBody<workspace::SaveWorkspaceOptions>,
) -> Result<Json<WorkspaceSaved>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    let path = options.dest_path.clone();
    workspace::save(&svc, options)?;
    Ok(Json(WorkspaceSaved { saved: true, path }))
}

// ---------------------------------------------------------------------------
// POST /mcp/workspace/autosave
// ---------------------------------------------------------------------------

/// Write the id-keyed auto-save under `app_data_dir/workspaces/`.
pub(crate) async fn h_autosave_workspace(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    JsonBody(options): JsonBody<workspace::AutoSaveWorkspaceOptions>,
) -> Result<Json<WorkspaceSaved>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    let path = workspace::auto_save(&svc, options)?;
    Ok(Json(WorkspaceSaved { saved: true, path }))
}

// ---------------------------------------------------------------------------
// PATCH /mcp/workspaces/{id} — rename
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameWorkspaceBody {
    pub new_name: String,
}

pub(crate) async fn h_rename_workspace(
    State(ctx): State<BridgeCtx>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<RenameWorkspaceBody>,
) -> Result<Json<WorkspaceEntry>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(workspace::rename_workspace(
        &svc,
        RenameWorkspaceRequest { workspace_id, new_name: body.new_name },
    )?))
}

// ---------------------------------------------------------------------------
// DELETE /mcp/workspaces/{id}?deleteFile=&force=
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteWorkspaceQuery {
    #[serde(default)]
    pub delete_file: bool,
    #[serde(default)]
    pub force: bool,
}

/// `delete_file` requires [`crate::services::policy::authorize_write_dest`]
/// for an `Agent` caller (the entry's `ltwPath` is deleted like any other
/// agent-chosen write destination); `force` closes the active workspace's
/// open sessions first instead of refusing the delete outright — see
/// `services::workspace::delete_workspace`.
pub(crate) async fn h_delete_workspace(
    State(ctx): State<BridgeCtx>,
    Path(workspace_id): Path<String>,
    Qs(query): Qs<DeleteWorkspaceQuery>,
    headers: HeaderMap,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    workspace::delete_workspace(
        &svc,
        DeleteWorkspaceRequest {
            workspace_id,
            delete_file: query.delete_file,
            force: query.force,
        },
    )?;
    Ok(Json(Ack::ok()))
}
