//! Session lifecycle endpoints: status, open/close, listing, metadata.
//!
//! Every handler here is a thin adapter: build a [`crate::services::ServiceCtx`]
//! via `ctx.svc(client)`, call the shared `services::sessions` function, map
//! the result into the typed `services::wire` shape.
//!
//! **Wire changes (WP-13).** `h_status` / `h_sessions` / `h_metadata` answered
//! `200 + { "error": … }` on failure; they now answer a real status with the
//! `{ "error": { code, message } }` envelope, like `h_open_file` and
//! `h_close_session` already did. `GET /mcp/status`'s `installedProcessors`
//! (a *count*) is renamed `installedProcessorCount` — `GET /mcp/sessions` uses
//! `installedProcessors` for the *list*, and having one key mean both was a
//! trap. `h_metadata` gained the `sessionId` echo it always rendered, now as a
//! typed field.
//!
//! `h_open_file`'s 403/400 contract is unchanged and now comes for free: the
//! gate's `Forbidden` renders identically whether the path is outside the
//! allowlist or does not exist, because `impl IntoResponse for ServiceError`
//! is a pure function of the error (see `mcp_bridge::respond`).

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::Deserialize;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{JsonBody, client_name};
use crate::services::ServiceError;
use crate::services::sessions;
use crate::services::wire::{
    Ack, BridgeInstalledProcessor, BridgeSessionEntry, BridgeSessionList, BridgeSessionMetadata,
    BridgeSessionSource, BridgeStatusInfo, OpenedSession,
};

// ---------------------------------------------------------------------------
// GET /mcp/status
// ---------------------------------------------------------------------------

pub(crate) async fn h_status(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<BridgeStatusInfo>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    let status = sessions::bridge_status(&svc)?;
    Ok(Json(BridgeStatusInfo {
        running: true,
        port: crate::mcp_bridge::PORT,
        session_count: status.session_ids.len(),
        session_ids: status.session_ids,
        installed_processor_count: status.installed_processor_count,
    }))
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
/// allowlist check, which the service runs via `policy::authorize_open` FIRST.
/// This handler no longer calls `validate_open_path` itself; it only surfaces
/// the resulting [`ServiceError`], preserving the exact contract this route has
/// always had:
///
/// - `Forbidden` (`NOT_ALLOWED`) → HTTP 403. Deliberately identical whether the
///   path is outside the allowlist OR does not exist — a client must not be
///   able to probe the filesystem for files it isn't allowed to open.
/// - `InvalidArg` (`INVALID_PATH` / `INVALID_SOURCE_TYPE`) → HTTP 400.
pub(crate) async fn h_open_file(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<OpenFileBody>,
) -> Result<Json<OpenedSession>, ServiceError> {
    // Validate the override before opening. An unknown label is a client
    // error, not something to silently ignore — falling back to detection
    // would defeat the whole point of supplying it.
    let source_type_override = match body.source_type.as_deref() {
        None => None,
        Some(label) => match crate::core::session::SourceType::from_label(label) {
            Some(t) => Some(t),
            None => {
                return Err(ServiceError::InvalidArg {
                    code: "INVALID_SOURCE_TYPE",
                    message: format!(
                        "unknown sourceType '{label}'; expected one of: {}",
                        crate::core::session::SourceType::labels().join(", ")
                    ),
                });
            }
        },
    };

    let svc = ctx.svc(client_name(&headers));
    let results = sessions::open(svc, &body.path, source_type_override).await?;

    // A `.lts` bundle can produce several sessions; this route reports the
    // first, matching its long-standing single-file convention. The rest are
    // still open and visible through `GET /mcp/sessions`.
    let first = results.into_iter().next().ok_or_else(|| {
        ServiceError::Internal("open produced no session".to_string())
    })?;

    Ok(Json(OpenedSession {
        session_id: first.session_id,
        source_type: first.source_type,
        total_lines: first.total_lines,
        is_indexing: first.is_indexing,
    }))
}

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/close
// ---------------------------------------------------------------------------

/// Close a session on behalf of an MCP client. ALWAYS closes (never refuses
/// because the session is displayed) via [`crate::services::sessions::close`],
/// which purges every session-keyed map, drops the file's memory map, emits
/// `session-closed`, and journals `session.close`.
///
/// An unknown session id is a `404 NOT_FOUND` — checked before calling the
/// service, which is a no-op on an unknown id (matching the UI close command's
/// permissive behavior).
pub(crate) async fn h_close_session(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));

    {
        let sessions_map = crate::services::lock_svc(&svc.state().sessions, "sessions")?;
        if !sessions_map.contains_key(&session_id) {
            return Err(ServiceError::NotFound("session not found".to_string()));
        }
    }

    sessions::close(&svc, &session_id)?;
    Ok(Json(Ack::ok()))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions
// ---------------------------------------------------------------------------

pub(crate) async fn h_sessions(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<BridgeSessionList>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    let overview = sessions::list(&svc)?;

    Ok(Json(BridgeSessionList {
        sessions: overview
            .sessions
            .into_iter()
            .map(|s| BridgeSessionEntry {
                id: s.id,
                sources: s
                    .sources
                    .into_iter()
                    .map(|src| BridgeSessionSource {
                        id: src.id,
                        name: src.name,
                        source_type: src.source_type,
                        total_lines: src.total_lines,
                        path: src.path,
                    })
                    .collect(),
                focused: s.focused,
            })
            .collect(),
        processors_with_results: overview.processors_with_results,
        installed_processors: overview
            .installed_processors
            .into_iter()
            .map(|p| BridgeInstalledProcessor {
                id: p.id,
                name: p.name,
                processor_type: p.processor_type,
            })
            .collect(),
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/metadata
// ---------------------------------------------------------------------------

pub(crate) async fn h_metadata(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<BridgeSessionMetadata>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    let m = sessions::bridge_metadata(&svc, &session_id)?;
    Ok(Json(BridgeSessionMetadata {
        session_id,
        source_name: m.source_name,
        source_type: m.source_type,
        total_lines: m.total_lines,
        file_size: m.file_size,
        is_live: m.is_live,
        is_indexing: m.is_indexing,
        first_timestamp: m.first_timestamp,
        last_timestamp: m.last_timestamp,
        section_count: m.section_count,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_bridge::BridgeCtx;
    use crate::services::paths::{FixedPaths, NullSpawner};
    use crate::services::testing::{RecordingSink, fixture_session};
    use crate::services::{AppPaths, EventSink, Spawner};
    use std::sync::Arc;

    fn test_bridge_ctx() -> (
        BridgeCtx,
        Arc<crate::commands::AppState>,
        Arc<RecordingSink>,
        tempfile::TempDir,
    ) {
        let state = Arc::new(crate::commands::AppState::new());
        let sink = Arc::new(RecordingSink::new());
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths: Arc<dyn AppPaths> = Arc::new(FixedPaths(tmp.path().to_path_buf()));
        let spawner: Arc<dyn Spawner> = Arc::new(NullSpawner);
        let ctx = BridgeCtx::from_parts(
            Arc::clone(&state),
            Arc::clone(&sink) as Arc<dyn EventSink>,
            paths,
            spawner,
        );
        (ctx, state, sink, tmp)
    }

    fn no_headers() -> HeaderMap {
        HeaderMap::new()
    }

    // ── The typed shapes these routes answer with ───────────────────────────

    #[tokio::test]
    async fn h_status_reports_running_port_sessions_and_the_processor_count() {
        let (ctx, state, ..) = test_bridge_ctx();
        state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 3));

        let Json(body) = h_status(State(ctx), no_headers()).await.expect("status");

        assert!(body.running);
        assert_eq!(body.port, crate::mcp_bridge::PORT);
        assert_eq!(body.session_count, 1);
        assert_eq!(body.session_ids, vec!["s1".to_string()]);
        assert_eq!(body.installed_processor_count, 0);
    }

    #[tokio::test]
    async fn h_sessions_renders_id_sources_and_focused() {
        let (ctx, state, ..) = test_bridge_ctx();
        state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 2));
        *state.focused_session.lock().unwrap() = Some("s1".to_string());

        let Json(body) = h_sessions(State(ctx), no_headers()).await.expect("sessions");

        assert_eq!(body.sessions.len(), 1);
        assert_eq!(body.sessions[0].id, "s1");
        assert!(body.sessions[0].focused);
        assert_eq!(body.sessions[0].sources[0].total_lines, 2);
        assert!(body.processors_with_results.is_empty());
        assert!(body.installed_processors.is_empty());
    }

    #[tokio::test]
    async fn h_metadata_renders_the_light_shape_with_section_count() {
        let (ctx, state, ..) = test_bridge_ctx();
        state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 4));

        let Json(body) = h_metadata(State(ctx), no_headers(), Path("s1".to_string()))
            .await
            .expect("metadata");

        assert_eq!(body.session_id, "s1");
        assert_eq!(body.total_lines, 4);
        // The rich command-side `SessionMetadata` has a level histogram; this
        // one deliberately does not (it would cost an O(n) scan per call).
        let v = serde_json::to_value(&body).unwrap();
        assert!(v.get("logLevelDistribution").is_none(), "bridge metadata must stay the light shape");
        assert!(v.get("sectionCount").is_some());
    }

    #[tokio::test]
    async fn h_metadata_is_a_404_for_an_unknown_session() {
        let (ctx, ..) = test_bridge_ctx();

        let err = h_metadata(State(ctx), no_headers(), Path("nope".to_string()))
            .await
            .expect_err("unknown session must error");

        assert_eq!(err.http_status(), 404);
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[tokio::test]
    async fn h_close_session_closes_and_acks() {
        let (ctx, state, sink, _tmp) = test_bridge_ctx();
        state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 1));

        let Json(ack) = h_close_session(State(ctx), no_headers(), Path("s1".to_string()))
            .await
            .expect("close");

        assert!(ack.ok);
        assert!(!state.sessions.lock().unwrap().contains_key("s1"));
        assert_eq!(sink.only_event("session-closed")["sessionId"], "s1");
    }

    #[tokio::test]
    async fn h_close_session_404s_for_an_unknown_session() {
        let (ctx, ..) = test_bridge_ctx();

        let err = h_close_session(State(ctx), no_headers(), Path("nope".to_string()))
            .await
            .expect_err("unknown session must error");

        assert_eq!(err.http_status(), 404);
    }

    // ── open_file: the allowlist/path-hygiene gate lives entirely in the service ──

    #[tokio::test]
    async fn h_open_file_denies_a_path_outside_the_allowlist() {
        let (ctx, _state, _sink, tmp) = test_bridge_ctx();
        let f = tmp.path().join("outside.log");
        std::fs::write(&f, "x").unwrap();

        let err = h_open_file(
            State(ctx),
            no_headers(),
            JsonBody(OpenFileBody { path: f.to_string_lossy().to_string(), source_type: None }),
        )
        .await
        .expect_err("outside the allowlist must be refused");

        assert_eq!(err.http_status(), 403);
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[tokio::test]
    async fn h_open_file_opens_an_allowed_existing_file() {
        let (ctx, state, ..) = test_bridge_ctx();
        let dir = tempfile::tempdir().unwrap();
        state
            .mcp_open_allowlist
            .lock()
            .unwrap()
            .allowed_dirs
            .push(dir.path().to_string_lossy().to_string());
        let f = dir.path().join("device.log");
        std::fs::write(&f, "01-01 00:00:00.000  1  1 I Tag: hi\n").unwrap();

        let Json(opened) = h_open_file(
            State(ctx),
            no_headers(),
            JsonBody(OpenFileBody { path: f.to_string_lossy().to_string(), source_type: None }),
        )
        .await
        .expect("an allowed, existing file opens");

        assert!(!opened.session_id.is_empty());
    }

    #[tokio::test]
    async fn h_open_file_rejects_an_unknown_source_type_label() {
        let (ctx, ..) = test_bridge_ctx();

        let err = h_open_file(
            State(ctx),
            no_headers(),
            JsonBody(OpenFileBody {
                path: "C:\\x.log".to_string(),
                source_type: Some("not-a-real-type".to_string()),
            }),
        )
        .await
        .expect_err("an unknown label must be refused");

        assert_eq!(err.http_status(), 400);
        assert_eq!(err.code(), "INVALID_SOURCE_TYPE");
    }
}
