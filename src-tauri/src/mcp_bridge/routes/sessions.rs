//! Session lifecycle endpoints: status, open/close, listing, metadata.
//!
//! Every handler here is a thin adapter: build a [`crate::services::ServiceCtx`]
//! via `ctx.svc(client)`, call the shared `services::sessions` function, then
//! render the JSON shape this route has always returned. `h_status` /
//! `h_sessions` / `h_metadata` keep today's `Json<Value>` + always-200
//! contract (WP-13 unifies error status codes); `h_open_file` / `h_close_session`
//! already returned real status codes and keep doing so, now sourced from
//! [`crate::services::ServiceError::http_status`] / `::code`.

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{err, lock_or_err_response};
use crate::services::sessions;

/// Self-reported MCP client name from the `X-LogTapper-Client` header,
/// defaulting to `"mcp"` — passed to `BridgeCtx::svc` so the activity feed can
/// tell agents apart. Never trusted for authorization.
fn client_name(headers: &HeaderMap) -> &str {
    headers
        .get("x-logtapper-client")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("mcp")
}

// ---------------------------------------------------------------------------
// GET /mcp/status
// ---------------------------------------------------------------------------

pub(crate) async fn h_status(State(ctx): State<BridgeCtx>, headers: HeaderMap) -> Json<Value> {
    let svc = ctx.svc(client_name(&headers));
    match sessions::bridge_status(&svc) {
        Ok(status) => Json(json!({
            "running": true,
            "port": crate::mcp_bridge::PORT,
            "sessionCount": status.session_ids.len(),
            "sessionIds": status.session_ids,
            "installedProcessors": status.installed_processor_count,
        })),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/open_file   { "path": "C:\\logs\\device.log" }
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct OpenFileBody {
    /// Absolute local path to open. Must resolve inside the configured
    /// `mcp_open_allowlist`, or match an already-open session.
    path: String,
    /// Optional source-type override, replacing content detection for this
    /// session. See [`crate::core::session::SourceType::from_label`] for the
    /// accepted labels.
    #[serde(default, rename = "sourceType")]
    source_type: Option<String>,
}

/// Open a log file (or a `.lts` bundle) as a session on behalf of an MCP
/// client.
///
/// Delegates entirely to [`crate::services::sessions::open`] — including the
/// allowlist check, which the service now runs via `policy::authorize_open`
/// FIRST. This handler no longer calls `validate_open_path` itself; it only
/// maps the resulting [`crate::services::ServiceError`] onto an HTTP status,
/// preserving the exact 403/400 contract this route has always had:
///
/// - `Forbidden` (`NOT_ALLOWED`) → HTTP 403. Deliberately identical whether the
///   path is outside the allowlist OR does not exist — a client must not be
///   able to probe the filesystem for files it isn't allowed to open.
/// - `InvalidArg` (`INVALID_PATH` / `INVALID_SOURCE_TYPE`) → HTTP 400.
pub(crate) async fn h_open_file(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Json(body): Json<OpenFileBody>,
) -> Response {
    // Validate the override before opening. An unknown label is a client
    // error, not something to silently ignore — falling back to detection
    // would defeat the whole point of supplying it.
    let source_type_override = match body.source_type.as_deref() {
        None => None,
        Some(label) => match crate::core::session::SourceType::from_label(label) {
            Some(t) => Some(t),
            None => {
                return err(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "unknown sourceType '{label}'; expected one of: {}",
                        crate::core::session::SourceType::labels().join(", ")
                    ),
                    "INVALID_SOURCE_TYPE",
                );
            }
        },
    };

    let svc = ctx.svc(client_name(&headers));
    match sessions::open(svc, &body.path, source_type_override).await {
        Ok(results) => match results.first() {
            Some(first) => Json(json!({
                "sessionId": first.session_id,
                "sourceType": first.source_type,
                "totalLines": first.total_lines,
                "isIndexing": first.is_indexing,
            }))
            .into_response(),
            None => err(StatusCode::INTERNAL_SERVER_ERROR, "open produced no session", "OPEN_FAILED"),
        },
        Err(e) => {
            let status = StatusCode::from_u16(e.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            err(status, e.message(), e.code())
        }
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/close
// ---------------------------------------------------------------------------

/// Close a session on behalf of an MCP client. ALWAYS closes (never refuses
/// because the session is displayed) via [`crate::services::sessions::close`],
/// which purges every session-keyed map, drops the file's memory map, emits
/// `session-closed`, and journals `session.close`.
///
/// Error contract:
/// - Unknown session id → HTTP 404 `{ "error": "session not found", "code": "NOT_FOUND" }`
///   (checked before calling the service, matching this route's historical
///   wording — `close` itself is a no-op on an unknown id, matching the UI
///   close command's permissive behavior).
pub(crate) async fn h_close_session(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Response {
    let svc = ctx.svc(client_name(&headers));

    {
        let sessions_map = lock_or_err_response!(svc.state().sessions, "sessions");
        if !sessions_map.contains_key(&session_id) {
            return err(StatusCode::NOT_FOUND, "session not found", "NOT_FOUND");
        }
    }

    if let Err(e) = sessions::close(&svc, &session_id) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.message(), e.code());
    }

    Json(json!({ "closed": true, "sessionId": session_id })).into_response()
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions
// ---------------------------------------------------------------------------

pub(crate) async fn h_sessions(State(ctx): State<BridgeCtx>, headers: HeaderMap) -> Json<Value> {
    let svc = ctx.svc(client_name(&headers));
    match sessions::list(&svc) {
        Ok(overview) => {
            let sessions_info: Vec<Value> = overview
                .sessions
                .into_iter()
                .map(|s| {
                    let sources: Vec<Value> = s
                        .sources
                        .into_iter()
                        .map(|src| {
                            json!({
                                "id": src.id,
                                "name": src.name,
                                "sourceType": src.source_type,
                                "totalLines": src.total_lines,
                                "path": src.path,
                            })
                        })
                        .collect();
                    json!({ "id": s.id, "sources": sources, "focused": s.focused })
                })
                .collect();

            let installed: Vec<Value> = overview
                .installed_processors
                .into_iter()
                .map(|p| json!({ "id": p.id, "name": p.name, "processorType": p.processor_type }))
                .collect();

            Json(json!({
                "sessions": sessions_info,
                "processorsWithResults": overview.processors_with_results,
                "installedProcessors": installed,
            }))
        }
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/metadata
// ---------------------------------------------------------------------------

pub(crate) async fn h_metadata(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let svc = ctx.svc(client_name(&headers));
    match sessions::bridge_metadata(&svc, &session_id) {
        Ok(m) => Json(json!({
            "sessionId": session_id,
            "sourceName": m.source_name,
            "sourceType": m.source_type,
            "totalLines": m.total_lines,
            "fileSize": m.file_size,
            "isLive": m.is_live,
            "isIndexing": m.is_indexing,
            "firstTimestamp": m.first_timestamp,
            "lastTimestamp": m.last_timestamp,
            "sectionCount": m.section_count,
        })),
        Err(e) => Json(json!({ "error": e.message() })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_bridge::BridgeCtx;
    use crate::services::paths::{FixedPaths, NullSpawner};
    use crate::services::testing::{fixture_session, RecordingSink};
    use crate::services::{AppPaths, EventSink, Spawner};
    use std::sync::Arc;

    fn test_bridge_ctx() -> (BridgeCtx, Arc<crate::commands::AppState>, Arc<RecordingSink>, tempfile::TempDir) {
        let state = Arc::new(crate::commands::AppState::new());
        let sink = Arc::new(RecordingSink::new());
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths: Arc<dyn AppPaths> = Arc::new(FixedPaths(tmp.path().to_path_buf()));
        let spawner: Arc<dyn Spawner> = Arc::new(NullSpawner);
        let ctx = BridgeCtx::from_parts(Arc::clone(&state), Arc::clone(&sink) as Arc<dyn EventSink>, paths, spawner);
        (ctx, state, sink, tmp)
    }

    fn no_headers() -> HeaderMap {
        HeaderMap::new()
    }

    // ── Golden tests: today's exact JSON shapes ──────────────────────────────

    #[tokio::test]
    async fn h_status_reports_running_port_sessions_and_processor_count() {
        let (ctx, state, ..) = test_bridge_ctx();
        state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 3));

        let Json(body) = h_status(State(ctx), no_headers()).await;

        assert_eq!(body["running"], true);
        assert_eq!(body["port"], crate::mcp_bridge::PORT);
        assert_eq!(body["sessionCount"], 1);
        assert_eq!(body["sessionIds"][0], "s1");
        assert_eq!(body["installedProcessors"], 0);
    }

    #[tokio::test]
    async fn h_sessions_renders_id_sources_and_focused() {
        let (ctx, state, ..) = test_bridge_ctx();
        state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 2));
        *state.focused_session.lock().unwrap() = Some("s1".to_string());

        let Json(body) = h_sessions(State(ctx), no_headers()).await;

        let sessions = body["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["id"], "s1");
        assert_eq!(sessions[0]["focused"], true);
        assert_eq!(sessions[0]["sources"][0]["totalLines"], 2);
        assert!(body["processorsWithResults"].as_array().unwrap().is_empty());
        assert!(body["installedProcessors"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn h_metadata_renders_the_light_shape_with_section_count() {
        let (ctx, state, ..) = test_bridge_ctx();
        state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 4));

        let Json(body) = h_metadata(State(ctx), no_headers(), Path("s1".to_string())).await;

        assert_eq!(body["sessionId"], "s1");
        assert_eq!(body["totalLines"], 4);
        assert!(body.get("logLevelDistribution").is_none(), "bridge metadata must stay the light shape");
        assert!(body.get("sectionCount").is_some());
    }

    #[tokio::test]
    async fn h_metadata_errors_with_the_historical_wording_for_an_unknown_session() {
        let (ctx, ..) = test_bridge_ctx();

        let Json(body) = h_metadata(State(ctx), no_headers(), Path("nope".to_string())).await;

        assert_eq!(body["error"], "Session not found: nope");
    }

    #[tokio::test]
    async fn h_close_session_closes_and_reports_the_session_id() {
        let (ctx, state, sink, _tmp) = test_bridge_ctx();
        state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 1));

        let res = h_close_session(State(ctx), no_headers(), Path("s1".to_string())).await;

        assert_eq!(res.status(), StatusCode::OK);
        assert!(!state.sessions.lock().unwrap().contains_key("s1"));
        assert_eq!(sink.only_event("session-closed")["sessionId"], "s1");
    }

    #[tokio::test]
    async fn h_close_session_404s_for_an_unknown_session() {
        let (ctx, ..) = test_bridge_ctx();

        let res = h_close_session(State(ctx), no_headers(), Path("nope".to_string())).await;

        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    // ── open_file: the allowlist/path-hygiene gate lives entirely in the service now ──

    #[tokio::test]
    async fn h_open_file_denies_a_path_outside_the_allowlist() {
        let (ctx, _state, _sink, tmp) = test_bridge_ctx();
        let f = tmp.path().join("outside.log");
        std::fs::write(&f, "x").unwrap();

        let res = h_open_file(
            State(ctx),
            no_headers(),
            Json(OpenFileBody { path: f.to_string_lossy().to_string(), source_type: None }),
        )
        .await;

        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn h_open_file_opens_an_allowed_existing_file() {
        let (ctx, state, ..) = test_bridge_ctx();
        let dir = tempfile::tempdir().unwrap();
        state.mcp_open_allowlist.lock().unwrap().allowed_dirs.push(dir.path().to_string_lossy().to_string());
        let f = dir.path().join("device.log");
        std::fs::write(&f, "01-01 00:00:00.000  1  1 I Tag: hi\n").unwrap();

        let res = h_open_file(
            State(ctx),
            no_headers(),
            Json(OpenFileBody { path: f.to_string_lossy().to_string(), source_type: None }),
        )
        .await;

        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn h_open_file_rejects_an_unknown_source_type_label() {
        let (ctx, ..) = test_bridge_ctx();

        let res = h_open_file(
            State(ctx),
            no_headers(),
            Json(OpenFileBody { path: "C:\\x.log".to_string(), source_type: Some("not-a-real-type".to_string()) }),
        )
        .await;

        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn client_name_defaults_to_mcp_when_header_absent() {
        assert_eq!(client_name(&HeaderMap::new()), "mcp");
    }

    #[test]
    fn client_name_reads_the_header_when_present() {
        let mut h = HeaderMap::new();
        h.insert("x-logtapper-client", "claude-code".parse().unwrap());
        assert_eq!(client_name(&h), "claude-code");
    }
}
