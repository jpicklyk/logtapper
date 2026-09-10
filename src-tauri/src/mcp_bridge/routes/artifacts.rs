//! Bookmark and analysis artifact endpoints.
//!
//! Analyses are workspace-owned (`AppState::analyses`), not session-owned: a
//! single artifact's sections can carry `SourceReference`s that each resolve
//! to a *different* session (or to none, if unattributed). Two route
//! families exist over the same underlying store:
//!
//! - `/mcp/analyses[/...]` — the primary, workspace-scoped family. List
//!   returns every artifact; publish takes no session and performs no
//!   session verification; get/update/delete look up by `artifact_id` alone
//!   (artifact ids are workspace-unique, so this is always correct).
//! - `/mcp/sessions/{session_id}/analyses[/...]` — retained for callers that
//!   still think in terms of "this session's analyses". List filters to
//!   artifacts with at least one reference attributed to `session_id`;
//!   publish verifies the session exists and stamps any unattributed
//!   reference with it. get/update/delete under this family still resolve by
//!   `artifact_id` alone — the `{session_id}` path segment is accepted as
//!   caller context but is NOT used as a filter. This leniency is
//!   deliberate: an artifact can span multiple sessions, so rejecting a
//!   request whose `{session_id}` doesn't happen to be the "first" one would
//!   be surprising, not safer.
//!
//! Every mutation goes through `services::{bookmarks,analyses}` via
//! `ctx.svc(client)` — the same functions `commands::{bookmark,analysis}`
//! call for the UI — so both transports share one implementation, one set of
//! emitted events, and one autosave/journal trigger.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::services::{analyses, bookmarks};

/// The self-reported `X-LogTapper-Client` header value an agent caller sends,
/// defaulting to `"mcp"` when absent — mirrors `Caller::agent`'s doc comment.
/// Shared with `routes::watches`, which has the identical need.
pub(super) fn client_name(headers: &HeaderMap) -> String {
    headers
        .get("x-logtapper-client")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("mcp")
        .to_string()
}

// ---------------------------------------------------------------------------
// Bookmark endpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct BookmarkListQuery {
    category: Option<String>,
    tag: Option<String>,
}

pub(crate) async fn h_list_bookmarks(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(query): Query<BookmarkListQuery>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match bookmarks::list(&svc, &session_id, query.category.as_deref(), query.tag.as_deref()) {
        Ok(list) => Json(json!(list)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateBookmarkBody {
    line_number: u32,
    #[serde(default)]
    label: String,
    #[serde(default)]
    note: String,
    line_number_end: Option<u32>,
    snippet: Option<Vec<String>>,
    category: Option<String>,
    tags: Option<Vec<String>>,
}

pub(crate) async fn h_create_bookmark(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreateBookmarkBody>,
) -> Json<Value> {
    use crate::core::bookmark::CreatedBy;

    let svc = ctx.svc(&client_name(&headers));
    match bookmarks::create(
        &svc,
        session_id,
        body.line_number,
        body.label,
        body.note,
        CreatedBy::Agent,
        body.line_number_end,
        body.snippet,
        body.category,
        body.tags,
    ) {
        Ok(bookmark) => Json(json!(bookmark)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

pub(crate) async fn h_delete_bookmark(
    State(ctx): State<BridgeCtx>,
    Path((session_id, bookmark_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match bookmarks::remove(&svc, session_id, bookmark_id) {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateBookmarkBody {
    label: Option<String>,
    note: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
}

pub(crate) async fn h_update_bookmark(
    State(ctx): State<BridgeCtx>,
    Path((session_id, bookmark_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<UpdateBookmarkBody>,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match bookmarks::update(
        &svc,
        session_id,
        bookmark_id,
        body.label,
        body.note,
        body.category,
        body.tags,
    ) {
        Ok(updated) => Json(json!(updated)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

// ---------------------------------------------------------------------------
// Analysis endpoints
// ---------------------------------------------------------------------------

/// `GET /mcp/analyses` — every workspace analysis artifact, unfiltered.
pub(crate) async fn h_list_all_analyses(State(ctx): State<BridgeCtx>, headers: HeaderMap) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match analyses::list(&svc, None) {
        Ok(list) => Json(json!(list)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

/// `GET /mcp/sessions/{session_id}/analyses` — analyses with at least one
/// reference attributed to `session_id`. Leniency: an artifact matching here
/// may also reference other sessions; this list is not exhaustive for those.
pub(crate) async fn h_list_analyses(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match analyses::list(&svc, Some(&session_id)) {
        Ok(list) => Json(json!(list)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishAnalysisBody {
    title: String,
    sections: Vec<crate::core::analysis::AnalysisSection>,
}

/// `POST /mcp/analyses` — publish a workspace analysis with no session
/// verification. References keep whatever `sessionId` (or none) they were
/// given; nothing is stamped.
pub(crate) async fn h_publish_workspace_analysis(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Json(body): Json<PublishAnalysisBody>,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match analyses::publish(&svc, None, body.title, body.sections) {
        Ok(artifact) => Json(json!(artifact)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

/// `POST /mcp/sessions/{session_id}/analyses` — publish an analysis
/// attributed to `session_id`. Verifies the session exists and stamps any
/// reference lacking its own `sessionId` with `session_id`.
pub(crate) async fn h_publish_analysis(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublishAnalysisBody>,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match analyses::publish(&svc, Some(session_id), body.title, body.sections) {
        Ok(artifact) => Json(json!(artifact)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

fn lookup_analysis(ctx: &BridgeCtx, client: &str, artifact_id: &str) -> Json<Value> {
    let svc = ctx.svc(client);
    match analyses::get(&svc, artifact_id) {
        Ok(art) => Json(json!(art)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

/// `GET /mcp/analyses/{artifact_id}` — look up by artifact id (workspace-unique).
pub(crate) async fn h_get_analysis(
    State(ctx): State<BridgeCtx>,
    Path(artifact_id): Path<String>,
    headers: HeaderMap,
) -> Json<Value> {
    lookup_analysis(&ctx, &client_name(&headers), &artifact_id)
}

/// `GET /mcp/sessions/{session_id}/analyses/{artifact_id}` — same lookup as
/// [`h_get_analysis`]; `session_id` is retained caller context only, not a
/// filter (see module doc above).
pub(crate) async fn h_get_analysis_scoped(
    State(ctx): State<BridgeCtx>,
    Path((_session_id, artifact_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Json<Value> {
    lookup_analysis(&ctx, &client_name(&headers), &artifact_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateAnalysisBody {
    title: Option<String>,
    sections: Option<Vec<crate::core::analysis::AnalysisSection>>,
}

fn do_update_analysis(
    ctx: &BridgeCtx,
    client: &str,
    artifact_id: String,
    body: UpdateAnalysisBody,
    fallback_session: Option<String>,
) -> Json<Value> {
    let svc = ctx.svc(client);
    match analyses::update(&svc, artifact_id, body.title, body.sections, fallback_session) {
        Ok(updated) => Json(json!(updated)),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

/// `PUT /mcp/analyses/{artifact_id}` — update by artifact id (workspace-unique).
/// No fallback session: an unattributed reference in replaced `sections`
/// stays unattributed, matching the workspace route's "no session context"
/// semantics.
pub(crate) async fn h_update_analysis(
    State(ctx): State<BridgeCtx>,
    Path(artifact_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<UpdateAnalysisBody>,
) -> Json<Value> {
    do_update_analysis(&ctx, &client_name(&headers), artifact_id, body, None)
}

/// `PUT /mcp/sessions/{session_id}/analyses/{artifact_id}` — same update as
/// [`h_update_analysis`], but `session_id` is threaded through as the
/// `migrate_artifact` fallback for replaced `sections`: a pre-1.3.0 MCP
/// client PUTting references with no `sessionId` at all must not have this
/// route silently de-attribute the artifact from every session. `session_id`
/// is NOT used as a lookup filter — see module doc above.
pub(crate) async fn h_update_analysis_scoped(
    State(ctx): State<BridgeCtx>,
    Path((session_id, artifact_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<UpdateAnalysisBody>,
) -> Json<Value> {
    do_update_analysis(&ctx, &client_name(&headers), artifact_id, body, Some(session_id))
}

fn do_delete_analysis(ctx: &BridgeCtx, client: &str, artifact_id: String) -> Json<Value> {
    let svc = ctx.svc(client);
    match analyses::remove(&svc, artifact_id) {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

/// `DELETE /mcp/analyses/{artifact_id}` — delete by artifact id (workspace-unique).
pub(crate) async fn h_delete_analysis(
    State(ctx): State<BridgeCtx>,
    Path(artifact_id): Path<String>,
    headers: HeaderMap,
) -> Json<Value> {
    do_delete_analysis(&ctx, &client_name(&headers), artifact_id)
}

/// `DELETE /mcp/sessions/{session_id}/analyses/{artifact_id}` — same delete
/// as [`h_delete_analysis`]; `session_id` is retained caller context only,
/// not a filter (see module doc above).
pub(crate) async fn h_delete_analysis_scoped(
    State(ctx): State<BridgeCtx>,
    Path((_session_id, artifact_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Json<Value> {
    do_delete_analysis(&ctx, &client_name(&headers), artifact_id)
}
