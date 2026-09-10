//! Session lifecycle endpoints: status, open/close, listing, metadata.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{err, get_session_and_source, lock_or_err_response, lock_or_json_err, session_to_json};

// ---------------------------------------------------------------------------
// GET /mcp/status
// ---------------------------------------------------------------------------

pub(crate) async fn h_status(State(ctx): State<BridgeCtx>) -> Json<Value> {
    let state = &*ctx.state;

    let session_ids: Vec<String> = {
        let sessions = lock_or_json_err!(state.sessions, "sessions");
        sessions.keys().cloned().collect()
    };

    let processor_ids: Vec<String> = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        procs.keys().cloned().collect()
    };

    Json(json!({
        "running": true,
        "port": crate::mcp_bridge::PORT,
        "sessionCount": session_ids.len(),
        "sessionIds": session_ids,
        "installedProcessors": processor_ids.len(),
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

/// Open a log file as a session on behalf of an MCP client, gated by the
/// `mcp_open_allowlist` allowlist.
///
/// Reuses [`crate::commands::files::open_file_inner`] — the SAME writer the Tauri
/// UI uses — so the stored `file_path`, the derived session id, the emitted
/// events, and the background indexer are all identical to a UI-driven open. The
/// file is opened with its CANONICAL path so the stored id is stable regardless
/// of the spelling the client sent (reopening the same file is therefore
/// idempotent — same session id, one registry entry).
///
/// Error contract (see [`crate::commands::bridge_access::OpenAccessError`]):
/// - `NotAllowed` → HTTP 403 `{ "error": "path is not allowed", "code": "NOT_ALLOWED" }`.
///   Deliberately identical whether the path is outside the allowlist OR does not
///   exist — a client must not be able to probe the filesystem for files it isn't
///   allowed to open. Do not branch the message or status on which case it is.
/// - `InvalidPath(msg)` → HTTP 400 `{ "error": msg, "code": "INVALID_PATH" }` for
///   malformed input (relative / UNC / verbatim / device / ADS paths), rejected
///   before any filesystem access.
pub(crate) async fn h_open_file(
    State(ctx): State<BridgeCtx>,
    Json(body): Json<OpenFileBody>,
) -> Response {
    use crate::commands::bridge_access::{OpenAccessError, canonical_compare_form, validate_open_path};

    let state = &*ctx.state;

    // Allowlist: lock, clone both fields, drop.
    let (allowed, allow_all): (Vec<String>, bool) = {
        let cfg = state.mcp_open_allowlist.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        (cfg.allowed_dirs.clone(), cfg.allow_all)
    };

    // Canonical paths of already-open file-backed sessions (auto-permit reopen).
    // Skip streams (file_path=None) and any path that no longer canonicalizes.
    // The sessions lock is released at the end of this block — it is NEVER held
    // across the open call below.
    let open_paths: Vec<String> = {
        let sessions = lock_or_err_response!(state.sessions, "sessions");
        sessions
            .values()
            .filter_map(|s| s.file_path.as_deref())
            .filter_map(|p| canonical_compare_form(std::path::Path::new(p)))
            .collect()
    };

    match validate_open_path(&allowed, &open_paths, &body.path, allow_all) {
        Err(OpenAccessError::NotAllowed) => {
            err(StatusCode::FORBIDDEN, "path is not allowed", "NOT_ALLOWED")
        }
        Err(OpenAccessError::InvalidPath(msg)) => {
            err(StatusCode::BAD_REQUEST, msg, "INVALID_PATH")
        }
        Ok(canonical) => {
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
            let canonical_str = canonical.to_string_lossy().to_string();
            // `open_file_inner` does CPU-bound mmap + line-index (and, for a
            // bugreport zip, decompression) work — run it on a blocking thread
            // rather than the axum/tokio worker thread this handler is polled
            // on, mirroring `run_pipeline` (commands/pipeline.rs:246-268) and
            // the Tauri `load_log_file` command's own wrapping of this same
            // fn. The borrowed `&AppState` can't cross into the 'static
            // closure, so the `Arc` is cloned in instead.
            let handle_for_task = match ctx.app() {
                Ok(a) => a.clone(),
                Err(e) => return err(StatusCode::SERVICE_UNAVAILABLE, e, "TRANSPORT_UNAVAILABLE"),
            };
            let state_for_task = Arc::clone(&ctx.state);
            let open_result = tokio::task::spawn_blocking(move || {
                let state = state_for_task;
                crate::commands::files::open_file_inner(
                    &state,
                    &handle_for_task,
                    &canonical_str,
                    source_type_override,
                )
            })
            .await
            .unwrap_or_else(|e| Err(format!("open file task panicked: {e}")));
            match open_result {
                Ok(results) => match results.first() {
                    Some(first) => {
                        // Notify the frontend so it creates a logviewer tab for this
                        // already-loaded session — the symmetric half of `session-closed`.
                        // Emitted HERE, from the handler, NOT from `open_file_inner`: the
                        // UI-initiated open path already builds its own tab and must stay
                        // behavior-unchanged; a bridge-initiated open is otherwise invisible
                        // to the frontend unless the bridge tells it. The payload is the full
                        // LoadResult (camelCase) so the frontend can reuse its normal
                        // post-load tab logic against an already-loaded session. Reopening the
                        // same file re-fires this with the SAME (deterministic) sessionId — the
                        // frontend listener is idempotent and will not spawn a duplicate tab.
                        ctx.events.emit_json(
                            "session-opened",
                            serde_json::to_value(first).unwrap_or(Value::Null),
                        );
                        Json(json!({
                            "sessionId": first.session_id,
                            "sourceType": first.source_type,
                            "totalLines": first.total_lines,
                            "isIndexing": first.is_indexing,
                        }))
                        .into_response()
                    }
                    None => err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "open produced no session",
                        "OPEN_FAILED",
                    ),
                },
                Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e, "OPEN_FAILED"),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/close
// ---------------------------------------------------------------------------

/// Close a session on behalf of an MCP client. ALWAYS closes (never refuses
/// because the session is displayed): purges every session-keyed map and drops
/// the file's memory map via [`crate::commands::files::close_session_inner`] — the
/// SAME cleanup the Tauri UI close path runs — then notifies the frontend so any
/// pane/tab bound to the session is closed.
///
/// The `session-closed` Tauri event is emitted HERE, not from `close_session_inner`.
/// The UI close path is user-initiated (the user already sees their own tab go
/// away) and must stay behavior-unchanged; a bridge-initiated close, by contrast,
/// is invisible to the frontend unless the bridge tells it. Emitting only on this
/// path keeps the two paths cleanly separated.
///
/// Error contract:
/// - Unknown session id → HTTP 404 `{ "error": "session not found", "code": "NOT_FOUND" }`.
///   The existence check runs under a short-lived `sessions` lock that is dropped
///   before `close_session_inner` re-acquires it (no lock held across the close).
pub(crate) async fn h_close_session(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
) -> Response {
    let state = &*ctx.state;

    // Existence check under a short-lived lock; drop it before closing.
    {
        let sessions = lock_or_err_response!(state.sessions, "sessions");
        if !sessions.contains_key(&session_id) {
            return err(StatusCode::NOT_FOUND, "session not found", "NOT_FOUND");
        }
    }

    if let Err(e) =
        crate::commands::files::close_session_inner(state, ctx.app.as_ref(), &session_id)
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e, "CLOSE_FAILED");
    }

    // Notify the frontend so it closes any pane/tab bound to this session.
    ctx.events
        .emit_json("session-closed", json!({ "sessionId": session_id }));

    Json(json!({ "closed": true, "sessionId": session_id })).into_response()
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions
// ---------------------------------------------------------------------------

pub(crate) async fn h_sessions(State(ctx): State<BridgeCtx>) -> Json<Value> {
    let state = &*ctx.state;

    // Snapshot the frontend's focused session id (see `AppState::focused_session`)
    // before building the session list, so each entry can report whether it is
    // the one the user currently has focused.
    let focused_session_id: Option<String> =
        state.focused_session.lock().map(|f| f.clone()).unwrap_or(None);

    // Collect session info without holding the lock into the JSON builder.
    let sessions_info: Vec<Value> = {
        let sessions = lock_or_json_err!(state.sessions, "sessions");
        sessions
            .values()
            .map(|session| session_to_json(session, focused_session_id.as_deref()))
            .collect()
    };

    // Processor IDs that have pipeline results for any session.
    let processors_with_results: Vec<String> = {
        let results = lock_or_json_err!(state.pipeline_results, "pipeline_results");
        let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for session_map in results.values() {
            ids.extend(session_map.keys().cloned());
        }
        ids.into_iter().collect()
    };

    // Installed processors (id + name + type).
    let installed: Vec<Value> = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        procs
            .values()
            .map(|p| {
                json!({
                    "id": p.meta.id,
                    "name": p.meta.name,
                    "processorType": p.processor_type(),
                })
            })
            .collect()
    };

    Json(json!({
        "sessions": sessions_info,
        "processorsWithResults": processors_with_results,
        "installedProcessors": installed,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/metadata
// ---------------------------------------------------------------------------

pub(crate) async fn h_metadata(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let state = &*ctx.state;

    get_session_and_source!(state, session_id => sessions, session, source);

    let total_lines = source.total_lines();
    let first_ts = source.first_timestamp();
    let last_ts = source.last_timestamp();

    let file_size = if let Some(file_src) = session.file_source() {
        file_src.mmap().len() as u64
    } else if let Some(stream_src) = session.stream_source() {
        stream_src.stream_byte_count()
    } else {
        0
    };

    let section_count = source.sections().len();

    Json(json!({
        "sessionId": session_id,
        "sourceName": source.name(),
        "sourceType": source.source_type().to_string(),
        "totalLines": total_lines,
        "fileSize": file_size,
        "isLive": source.is_live(),
        "isIndexing": source.is_indexing(),
        "firstTimestamp": first_ts,
        "lastTimestamp": last_ts,
        "sectionCount": section_count,
    }))
}
