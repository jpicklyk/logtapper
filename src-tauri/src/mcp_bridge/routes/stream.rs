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
//! service — redacted unless the user persisted the `agent_raw_access`
//! opt-out — independently of the in-chain `__pii_anonymizer` an agent's
//! stream also carries.
//!
//! Success bodies are the typed `services::wire` stream envelopes; failures
//! carry a real status (an unknown session is `404 NOT_FOUND`, a save
//! destination outside the allowlist `403 NOT_ALLOWED`).

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::Deserialize;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{JsonBody, Qs, client_name};
use crate::services::ServiceError;
use crate::services::stream::{self, AdbStreamEvent, StartStreamRequest, StreamStatus};
use crate::services::wire::{
    Ack, AdbDeviceList, StreamEventEntry, StreamEventsPage, StreamSaved, StreamStarted,
};

// ---------------------------------------------------------------------------
// GET /mcp/adb/devices
// ---------------------------------------------------------------------------

/// List attached devices. `adb` missing from PATH is a typed error body, never
/// a panic or a 500 with no explanation.
pub(crate) async fn h_adb_devices(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
) -> Result<Json<AdbDeviceList>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(AdbDeviceList { devices: stream::devices(&svc).await? }))
}

// ---------------------------------------------------------------------------
// POST /mcp/adb/stream
// ---------------------------------------------------------------------------

/// Start a live capture for an agent.
///
/// The event ring is registered *before* the capture task can produce anything
/// (it is the sink itself), so no batch can be dropped between start and the
/// agent's first poll.
pub(crate) async fn h_start_stream(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<StartStreamRequest>,
) -> Result<Json<StreamStarted>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));

    // A ring for a session id we do not have yet: create it, hand it in as the
    // sink, then register it under the id `start` assigns. The window between
    // the two is buffered by the ring itself, not lost.
    let ring = stream::new_ring();
    let sink: std::sync::Arc<dyn crate::services::events::Sink<AdbStreamEvent>> =
        std::sync::Arc::clone(&ring) as _;

    let load = stream::start(svc.clone(), req, sink).await?;

    // Registering also prunes rings whose session is gone.
    stream::register_ring(&svc, &load.session_id, ring)?;

    let status = stream::status(&svc, &load.session_id)?;
    Ok(Json(StreamStarted {
        session_id: load.session_id,
        source_name: load.source_name,
        status,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/stream/status
// ---------------------------------------------------------------------------

pub(crate) async fn h_stream_status(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<StreamStatus>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    Ok(Json(stream::status(&svc, &session_id)?))
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

pub(crate) async fn h_stream_events(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Qs(params): Qs<StreamEventsParams>,
    headers: HeaderMap,
) -> Result<Json<StreamEventsPage>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    let since = params.since.unwrap_or(0);
    let limit = params
        .limit
        .unwrap_or(200)
        .clamp(1, stream::AGENT_RING_CAPACITY);

    let page = stream::events(&svc, &session_id, since, limit)?;
    Ok(Json(StreamEventsPage {
        session_id: page.session_id,
        latest_seq: page.latest_seq,
        next_since: page.next_since,
        gap: page.gap,
        events: page
            .events
            .into_iter()
            .map(|e| StreamEventEntry { seq: e.seq, item: e.item })
            .collect(),
    }))
}

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/stream/stop
// ---------------------------------------------------------------------------

pub(crate) async fn h_stop_stream(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Ack>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    stream::stop(&svc, &session_id)?;
    Ok(Json(Ack::ok()))
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

pub(crate) async fn h_save_stream(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<SaveStreamBody>,
) -> Result<Json<StreamSaved>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    let lines_written = stream::save_live_capture(&svc, &session_id, &body.dest_path)?;
    Ok(Json(StreamSaved { session_id, lines_written }))
}
