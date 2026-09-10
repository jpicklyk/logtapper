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

use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;

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
    axum::extract::Query(query): axum::extract::Query<BookmarkListQuery>,
) -> Json<Value> {
    let state = &*ctx.state;
    let bookmarks = state.bookmarks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let list: Vec<_> = bookmarks
        .get(&session_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|bm| {
            if let Some(ref cat) = query.category {
                if bm.category.as_deref() != Some(cat.as_str()) {
                    return false;
                }
            }
            if let Some(ref tag) = query.tag {
                let has_tag = bm
                    .tags
                    .as_ref()
                    .is_some_and(|tags| tags.iter().any(|t| t == tag));
                if !has_tag {
                    return false;
                }
            }
            true
        })
        .collect();
    Json(json!(list))
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
    Json(body): Json<CreateBookmarkBody>,
) -> Json<Value> {
    use crate::core::bookmark::CreatedBy;

    match crate::commands::artifact_mutations::add_bookmark(
        &ctx.app,
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
        Err(e) => Json(json!({ "error": e })),
    }
}

pub(crate) async fn h_delete_bookmark(
    State(ctx): State<BridgeCtx>,
    Path((session_id, bookmark_id)): Path<(String, String)>,
) -> Json<Value> {
    match crate::commands::artifact_mutations::remove_bookmark(&ctx.app, session_id, bookmark_id) {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "error": e })),
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
    Json(body): Json<UpdateBookmarkBody>,
) -> Json<Value> {
    match crate::commands::artifact_mutations::update_bookmark(
        &ctx.app,
        session_id,
        bookmark_id,
        body.label,
        body.note,
        body.category,
        body.tags,
    ) {
        Ok(updated) => Json(json!(updated)),
        Err(e) => Json(json!({ "error": e })),
    }
}

// ---------------------------------------------------------------------------
// Analysis endpoints
// ---------------------------------------------------------------------------

/// `GET /mcp/analyses` — every workspace analysis artifact, unfiltered.
pub(crate) async fn h_list_all_analyses(State(ctx): State<BridgeCtx>) -> Json<Value> {
    let state = &*ctx.state;
    let analyses = state.analyses.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    Json(json!(analyses.clone()))
}

/// `GET /mcp/sessions/{session_id}/analyses` — analyses with at least one
/// reference attributed to `session_id`. Leniency: an artifact matching here
/// may also reference other sessions; this list is not exhaustive for those.
pub(crate) async fn h_list_analyses(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let state = &*ctx.state;
    let analyses = state.analyses.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let list: Vec<_> = analyses
        .iter()
        .filter(|a| crate::core::analysis::artifact_references_session(a, &session_id))
        .cloned()
        .collect();
    Json(json!(list))
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
    Json(body): Json<PublishAnalysisBody>,
) -> Json<Value> {
    match crate::commands::artifact_mutations::publish_analysis(
        &ctx.app,
        None,
        body.title,
        body.sections,
    ) {
        Ok(artifact) => Json(json!(artifact)),
        Err(e) => Json(json!({ "error": e })),
    }
}

/// `POST /mcp/sessions/{session_id}/analyses` — publish an analysis
/// attributed to `session_id`. Verifies the session exists and stamps any
/// reference lacking its own `sessionId` with `session_id`.
pub(crate) async fn h_publish_analysis(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Json(body): Json<PublishAnalysisBody>,
) -> Json<Value> {
    match crate::commands::artifact_mutations::publish_analysis(
        &ctx.app,
        Some(session_id),
        body.title,
        body.sections,
    ) {
        Ok(artifact) => Json(json!(artifact)),
        Err(e) => Json(json!({ "error": e })),
    }
}

fn lookup_analysis(ctx: &BridgeCtx, artifact_id: &str) -> Json<Value> {
    let state = &*ctx.state;
    let analyses = state.analyses.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(art) = analyses.iter().find(|a| a.id == artifact_id) {
        return Json(json!(art));
    }
    Json(json!({"error": format!("Analysis not found: {artifact_id}")}))
}

/// `GET /mcp/analyses/{artifact_id}` — look up by artifact id (workspace-unique).
pub(crate) async fn h_get_analysis(
    State(ctx): State<BridgeCtx>,
    Path(artifact_id): Path<String>,
) -> Json<Value> {
    lookup_analysis(&ctx, &artifact_id)
}

/// `GET /mcp/sessions/{session_id}/analyses/{artifact_id}` — same lookup as
/// [`h_get_analysis`]; `session_id` is retained caller context only, not a
/// filter (see module doc above).
pub(crate) async fn h_get_analysis_scoped(
    State(ctx): State<BridgeCtx>,
    Path((_session_id, artifact_id)): Path<(String, String)>,
) -> Json<Value> {
    lookup_analysis(&ctx, &artifact_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateAnalysisBody {
    title: Option<String>,
    sections: Option<Vec<crate::core::analysis::AnalysisSection>>,
}

fn do_update_analysis(
    ctx: &BridgeCtx,
    artifact_id: String,
    body: UpdateAnalysisBody,
    fallback_session: Option<String>,
) -> Json<Value> {
    match crate::commands::artifact_mutations::update_analysis(
        &ctx.app,
        artifact_id,
        body.title,
        body.sections,
        fallback_session,
    ) {
        Ok(updated) => Json(json!(updated)),
        Err(e) => Json(json!({ "error": e })),
    }
}

/// `PUT /mcp/analyses/{artifact_id}` — update by artifact id (workspace-unique).
/// No fallback session: an unattributed reference in replaced `sections`
/// stays unattributed, matching the workspace route's "no session context"
/// semantics.
pub(crate) async fn h_update_analysis(
    State(ctx): State<BridgeCtx>,
    Path(artifact_id): Path<String>,
    Json(body): Json<UpdateAnalysisBody>,
) -> Json<Value> {
    do_update_analysis(&ctx, artifact_id, body, None)
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
    Json(body): Json<UpdateAnalysisBody>,
) -> Json<Value> {
    do_update_analysis(&ctx, artifact_id, body, Some(session_id))
}

fn do_delete_analysis(ctx: &BridgeCtx, artifact_id: String) -> Json<Value> {
    match crate::commands::artifact_mutations::remove_analysis(&ctx.app, artifact_id) {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "error": e })),
    }
}

/// `DELETE /mcp/analyses/{artifact_id}` — delete by artifact id (workspace-unique).
pub(crate) async fn h_delete_analysis(
    State(ctx): State<BridgeCtx>,
    Path(artifact_id): Path<String>,
) -> Json<Value> {
    do_delete_analysis(&ctx, artifact_id)
}

/// `DELETE /mcp/sessions/{session_id}/analyses/{artifact_id}` — same delete
/// as [`h_delete_analysis`]; `session_id` is retained caller context only,
/// not a filter (see module doc above).
pub(crate) async fn h_delete_analysis_scoped(
    State(ctx): State<BridgeCtx>,
    Path((_session_id, artifact_id)): Path<(String, String)>,
) -> Json<Value> {
    do_delete_analysis(&ctx, artifact_id)
}
