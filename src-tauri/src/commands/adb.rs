//! ADB streaming commands — the desktop adapter over [`crate::services::stream`].
//!
//! Every function here is a wrapper: build a [`ui_ctx`], wrap the caller's
//! `Channel<AdbStreamEvent>` in an [`AdbChannelSink`], call one service
//! function, marshal one `Result<T, String>`. The capture loop, the 50 ms /
//! 100-line batching window, the `stream_epochs` guard and the continuous
//! processor bookkeeping all live in the service — the agent bridge drives the
//! identical code with a `RingSink` instead of the channel.
//!
//! The Tauri command names, argument names, return types, the
//! `Channel<AdbStreamEvent>` contract and every emitted event name/payload are
//! byte-identical to before the extraction; `tauri::ipc::Channel` appears here
//! and never under `services/`.

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::commands::adapters::{ui_ctx, AdbChannelSink};
use crate::commands::files::LoadResult;
use crate::services::stream::{self, StartStreamRequest, StreamStatus};

/// The ADB wire types now live in `services::stream`; re-exported here because
/// the frontend bindings (`tests/export_bindings.rs`) and several `commands/*`
/// call sites still name them by this path.
pub use crate::services::stream::{
    AdbBatch, AdbDevice, AdbProcessorUpdate, AdbStreamEvent, AdbStreamStopped, AdbTrackerUpdate,
};

// ---------------------------------------------------------------------------
// list_adb_devices
// ---------------------------------------------------------------------------

/// List all connected ADB devices. Returns an empty vec if ADB is on PATH but
/// no device is attached; a spawn failure surfaces as an error string.
#[tauri::command]
pub async fn list_adb_devices(app: AppHandle) -> Result<Vec<AdbDevice>, String> {
    Ok(stream::devices(&ui_ctx(&app)).await?)
}

// ---------------------------------------------------------------------------
// start_adb_stream
// ---------------------------------------------------------------------------

/// Start streaming logcat from a connected ADB device.
///
/// Returns immediately with an empty-session `LoadResult`; lines arrive via the
/// `on_event` channel.
#[tauri::command]
pub async fn start_adb_stream(
    app: AppHandle,
    device_id: Option<String>,
    package_filter: Option<String>,
    active_processor_ids: Vec<String>,
    // Maximum raw log lines to keep in the backend buffer; oldest evicted above
    // this. None defaults to 500,000.
    max_raw_lines: Option<u32>,
    on_event: Channel<AdbStreamEvent>,
) -> Result<LoadResult, String> {
    let ctx = ui_ctx(&app);
    let req = StartStreamRequest {
        device_id,
        package_filter,
        processor_ids: Some(active_processor_ids),
        max_raw_lines,
    };
    Ok(stream::start(ctx, req, std::sync::Arc::new(AdbChannelSink::new(on_event))).await?)
}

// ---------------------------------------------------------------------------
// stop_adb_stream
// ---------------------------------------------------------------------------

/// Stop an active ADB stream. The session remains in AppState as a static log.
#[tauri::command]
pub async fn stop_adb_stream(app: AppHandle, session_id: String) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    let result = stream::stop(&ctx, &session_id);

    // Fallback broadcast, kept from before the extraction: the service emits
    // `adb-stream-stopped` on the happy path, but if it failed before reaching
    // that point (a poisoned lock) the frontend would otherwise never learn the
    // stream is gone. Emitting twice is harmless — the listener is idempotent.
    if result.is_err() {
        let _ = app.emit(
            "adb-stream-stopped",
            AdbStreamStopped {
                session_id,
                reason: "user".to_string(),
            },
        );
    }

    Ok(result?)
}

// ---------------------------------------------------------------------------
// update_stream_processors / update_stream_trackers / update_stream_transformers
// ---------------------------------------------------------------------------

/// Update the set of active reporter processors for a running ADB stream.
#[tauri::command]
pub async fn update_stream_processors(
    app: AppHandle,
    session_id: String,
    processor_ids: Vec<String>,
) -> Result<(), String> {
    Ok(stream::update_processors(&ui_ctx(&app), &session_id, &processor_ids)?)
}

/// Update the set of active StateTracker processors for a running ADB stream.
#[tauri::command]
pub async fn update_stream_trackers(
    app: AppHandle,
    session_id: String,
    tracker_ids: Vec<String>,
) -> Result<(), String> {
    Ok(stream::update_trackers(&ui_ctx(&app), &session_id, &tracker_ids)?)
}

/// Update the set of active Transformer processors for a running ADB stream.
#[tauri::command]
pub async fn update_stream_transformers(
    app: AppHandle,
    session_id: String,
    transformer_ids: Vec<String>,
) -> Result<(), String> {
    Ok(stream::update_transformers(&ui_ctx(&app), &session_id, &transformer_ids)?)
}

// ---------------------------------------------------------------------------
// get_package_pids
// ---------------------------------------------------------------------------

/// Resolve a package name to its current PID(s) on the device.
#[tauri::command]
pub async fn get_package_pids(
    app: AppHandle,
    device_serial: String,
    package_name: String,
) -> Result<Vec<u32>, String> {
    Ok(stream::package_pids(&ui_ctx(&app), &device_serial, &package_name).await?)
}

// ---------------------------------------------------------------------------
// get_stream_status
// ---------------------------------------------------------------------------

/// Snapshot of a stream session: retention counters and the active continuous
/// chain. The same shape `GET /mcp/sessions/{id}/stream/status` returns.
#[tauri::command]
pub async fn get_stream_status(
    app: AppHandle,
    session_id: String,
) -> Result<StreamStatus, String> {
    Ok(stream::status(&ui_ctx(&app), &session_id)?)
}

// ---------------------------------------------------------------------------
// save_live_capture
// ---------------------------------------------------------------------------

/// Write all retained raw lines from a live stream session to a file.
/// Returns the number of lines written.
#[tauri::command]
pub fn save_live_capture(
    app: AppHandle,
    session_id: String,
    output_path: String,
) -> Result<u32, String> {
    Ok(stream::save_live_capture(&ui_ctx(&app), &session_id, &output_path)?)
}
