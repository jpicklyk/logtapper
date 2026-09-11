//! ADB live-capture endpoints: device discovery, start/stop, status, save, and
//! the polled event feed.
//!
//! Everything goes through `services::stream` via `ctx.svc(client)` — the same
//! functions `commands::adb` calls for the desktop. The one thing that differs
//! between the two callers is the `Sink<AdbStreamEvent>` on the far end: the UI
//! gets one Tauri IPC `Channel`, an agent gets a per-session
//! `services::events::RingSink` (cap `AGENT_RING_CAPACITY`) registered by
//! [`h_start_stream`] and drained here by [`h_stream_events`].
//!
//! ## Polling contract
//!
//! An agent has no persistent socket. After `POST /mcp/adb/stream` it polls
//! `GET /mcp/sessions/{session_id}/stream/events?since=<cursor>`; every
//! response carries `nextSince` to pass back on the following poll, `latestSeq`
//! so the caller can tell how far behind it is, and `gap: true` when it fell
//! more than `AGENT_RING_CAPACITY` events behind and the missing events were
//! evicted. Sequence numbers start at 1, so `since=0` (the default) means
//! "everything still retained".
//!
//! Line text in a drained batch goes through `policy::redact_line` inside the
//! service — fail-closed for a session whose `mcp_anonymize` flag was never
//! signalled — independently of the in-chain `__pii_anonymizer` an agent's
//! stream also carries.
//!
//! These are new routes (no legacy JSON shape to preserve), so success
//! responses serialize typed structs directly. Errors keep today's
//! `{ "error", "code" }`-over-200 envelope pending WP-13.

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::mcp_bridge::routes::artifacts::client_name;
use crate::mcp_bridge::BridgeCtx;
use crate::services::stream::{self, AdbStreamEvent, StartStreamRequest, StreamStatus};
use crate::services::ServiceError;

/// Today's bridge error envelope — real HTTP status codes are WP-13's job.
fn err_json(e: &ServiceError) -> Json<Value> {
    Json(json!({ "error": e.message(), "code": e.code() }))
}

// ---------------------------------------------------------------------------
// GET /mcp/adb/devices
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DevicesResponse {
    devices: Vec<stream::AdbDevice>,
}

/// List attached devices. `adb` missing from PATH is a typed error body, never
/// a panic or a 500.
pub(crate) async fn h_adb_devices(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match stream::devices(&svc).await {
        Ok(devices) => Json(json!(DevicesResponse { devices })),
        Err(e) => err_json(&e),
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/adb/stream
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartStreamResponse {
    session_id: String,
    source_name: String,
    status: StreamStatus,
}

/// Start a live capture for an agent.
///
/// The event ring is registered *before* the capture task can produce anything
/// (it is the sink itself), so no batch can be dropped between start and the
/// agent's first poll.
pub(crate) async fn h_start_stream(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Json(req): Json<StartStreamRequest>,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));

    // A ring for a session id we do not have yet: create it, hand it in as the
    // sink, then register it under the id `start` assigns. The window between
    // the two is buffered by the ring itself, not lost.
    let ring = stream::new_ring();
    let sink: std::sync::Arc<dyn crate::services::events::Sink<AdbStreamEvent>> =
        std::sync::Arc::clone(&ring) as _;

    let load = match stream::start(svc.clone(), req, sink).await {
        Ok(load) => load,
        Err(e) => return err_json(&e),
    };

    // Registering also prunes rings whose session is gone.
    if let Err(e) = stream::register_ring(&svc, &load.session_id, ring) {
        return err_json(&e);
    }

    match stream::status(&svc, &load.session_id) {
        Ok(status) => Json(json!(StartStreamResponse {
            session_id: load.session_id,
            source_name: load.source_name,
            status,
        })),
        Err(e) => err_json(&e),
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/stream/status
// ---------------------------------------------------------------------------

pub(crate) async fn h_stream_status(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match stream::status(&svc, &session_id) {
        Ok(status) => Json(json!(status)),
        Err(e) => err_json(&e),
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/stream/events?since=&limit=
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub(crate) struct StreamEventsParams {
    /// Cursor from the previous poll's `nextSince`. 0 (the default) means
    /// "everything still retained".
    since: Option<u64>,
    /// Page size, default 200, capped at the ring capacity.
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamEventsResponse {
    session_id: String,
    /// Highest sequence the ring has issued, whether or not it is in `events`.
    latest_seq: u64,
    /// Cursor to send as `since` on the next poll.
    next_since: u64,
    /// True when events between the caller's cursor and the oldest retained
    /// item were evicted — they are gone for good.
    gap: bool,
    /// `{ "seq": N, "item": { "event": "batch", "data": { … } } }` per entry —
    /// the same `SeqItem` shape every `RingSink` consumer sees.
    events: Vec<crate::services::events::SeqItem<AdbStreamEvent>>,
}

pub(crate) async fn h_stream_events(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<StreamEventsParams>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    let since = params.since.unwrap_or(0);
    let limit = params
        .limit
        .unwrap_or(200)
        .clamp(1, stream::AGENT_RING_CAPACITY);

    match stream::events(&svc, &session_id, since, limit) {
        Ok(page) => Json(json!(StreamEventsResponse {
            session_id: page.session_id,
            latest_seq: page.latest_seq,
            next_since: page.next_since,
            gap: page.gap,
            events: page.events,
        })),
        Err(e) => err_json(&e),
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/stream/stop
// ---------------------------------------------------------------------------

pub(crate) async fn h_stop_stream(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match stream::stop(&svc, &session_id) {
        Ok(()) => Json(json!({ "ok": true, "sessionId": session_id })),
        Err(e) => err_json(&e),
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/stream/save
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveStreamBody {
    /// Absolute destination path. Its **parent directory** must already exist
    /// and be inside the MCP open allowlist; the file itself need not exist.
    dest_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveStreamResponse {
    session_id: String,
    lines_written: u32,
}

pub(crate) async fn h_save_stream(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<SaveStreamBody>,
) -> Json<Value> {
    let svc = ctx.svc(&client_name(&headers));
    match stream::save_live_capture(&svc, &session_id, &body.dest_path) {
        Ok(lines_written) => Json(json!(SaveStreamResponse {
            session_id,
            lines_written,
        })),
        Err(e) => err_json(&e),
    }
}
