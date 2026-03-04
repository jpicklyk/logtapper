use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_stream::{wrappers::ReceiverStream, StreamExt as _};

use crate::anonymizer::LogAnonymizer;
use crate::commands::AppState;
use crate::commands::files::LoadResult;
use crate::core::line::{LineContext, LineMeta, LogLevel, ParsedLineMeta, ViewLine};
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;
use crate::core::log_source::LogSource;
use crate::core::session::AnalysisSession;
use crate::processors::interpreter::{ContinuousRunState, ProcessorRun};
use crate::processors::reporter::schema::ReporterDef;

// ---------------------------------------------------------------------------
// Payload types for Tauri events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
    pub model: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbBatch {
    pub session_id: String,
    pub lines: Vec<ViewLine>,
    pub total_lines: usize,
    /// Cumulative bytes received from ADB (for Size display in file info panel).
    pub byte_count: u64,
    /// First non-zero timestamp in the stream (nanoseconds since 2000-01-01 UTC).
    pub first_timestamp: Option<i64>,
    /// Most recent non-zero timestamp (nanoseconds since 2000-01-01 UTC).
    pub last_timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbProcessorUpdate {
    pub session_id: String,
    pub processor_id: String,
    pub matched_lines: usize,
    pub emission_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbStreamStopped {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbTrackerUpdate {
    pub session_id: String,
    pub tracker_id: String,
    pub transition_count: usize,
}

/// Typed channel event for ADB streaming — replaces high-frequency `app.emit()` calls.
/// Serializes as a tagged union: `{ "event": "batch", "data": {...} }`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum AdbStreamEvent {
    Batch(AdbBatch),
    ProcessorUpdate(AdbProcessorUpdate),
    StreamStopped(AdbStreamStopped),
}

// ---------------------------------------------------------------------------
// list_adb_devices
// ---------------------------------------------------------------------------

/// List all connected ADB devices. Returns an empty vec if ADB is not on PATH.
/// Retries once after a short delay if the first call returns no devices, which
/// handles the case where the ADB daemon wasn't running and needs time to start.
#[tauri::command]
pub async fn list_adb_devices() -> Result<Vec<AdbDevice>, String> {
    let devices = query_adb_devices().await?;
    if !devices.is_empty() {
        return Ok(devices);
    }
    // ADB daemon may have just started — retry after a brief delay.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    query_adb_devices().await
}

async fn query_adb_devices() -> Result<Vec<AdbDevice>, String> {
    let output = Command::new("adb")
        .arg("devices")
        .arg("-l")
        .output()
        .await
        .map_err(|e| format!("Failed to run adb: {e}. Make sure adb is on your PATH."))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_adb_devices(&stdout)
}

fn parse_adb_devices(output: &str) -> Result<Vec<AdbDevice>, String> {
    let mut devices = Vec::new();
    let mut past_header = false;

    for line in output.lines() {
        if line.starts_with("List of devices") {
            past_header = true;
            continue;
        }
        if !past_header || line.trim().is_empty() {
            continue;
        }
        // Lines starting with "* daemon" are informational messages
        if line.starts_with('*') {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let serial = parts[0].to_string();
        let state = parts[1].to_string();

        // Extract model from "model:ModelName" token
        let model = line
            .split_whitespace()
            .find(|t| t.starts_with("model:"))
            .map(|t| t["model:".len()..].to_string())
            .unwrap_or_else(|| serial.clone());

        devices.push(AdbDevice { serial, model, state });
    }

    Ok(devices)
}

// ---------------------------------------------------------------------------
// start_adb_stream
// ---------------------------------------------------------------------------

/// Start streaming logcat from a connected ADB device.
/// Creates a new session and spawns a background task that feeds lines into it.
/// Returns immediately with an empty-session `LoadResult`; lines arrive via
/// the `on_event` channel.
#[tauri::command]
pub async fn start_adb_stream(
    state: State<'_, AppState>,
    app: AppHandle,
    device_id: Option<String>,
    package_filter: Option<String>,
    active_processor_ids: Vec<String>,
    // Maximum raw log lines to keep in the backend buffer; oldest evicted above this.
    // None defaults to 500,000.
    max_raw_lines: Option<u32>,
    on_event: Channel<AdbStreamEvent>,
) -> Result<LoadResult, String> {
    // ── Resolve device ────────────────────────────────────────────────────────
    let serial = match device_id {
        Some(id) => id,
        None => {
            let devices = list_adb_devices().await?;
            match devices.len() {
                0 => return Err("No ADB devices connected. Connect a device and enable USB debugging.".to_string()),
                1 => devices.into_iter().next().unwrap().serial,
                _ => return Err(
                    "Multiple ADB devices connected. Specify a device_id.".to_string()
                ),
            }
        }
    };

    // ── Create session ────────────────────────────────────────────────────────
    let session_id = uuid::Uuid::new_v4().to_string();
    let source_id = format!("adb-{}", serial.replace(':', "-"));
    let device_label = format!("ADB: {serial}");

    let temp_dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir());

    let mut session = AnalysisSession::new(session_id.clone());
    session.add_stream_source(source_id.clone(), device_label.clone(), temp_dir);

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "Session lock poisoned")?;
        sessions.insert(session_id.clone(), session);
    }

    // ── Initialize continuous processor states ────────────────────────────────
    if !active_processor_ids.is_empty() {
        let procs = state
            .processors
            .lock()
            .map_err(|_| "Processor lock poisoned")?;

        let mut proc_states: HashMap<String, ContinuousRunState> = HashMap::new();
        for proc_id in &active_processor_ids {
            if let Some(def) = procs.get(proc_id).and_then(|p| p.as_reporter()) {
                let run = ProcessorRun::new(def);
                proc_states.insert(proc_id.clone(), run.into_continuous_state(0, false));
            }
        }
        drop(procs);

        let mut sp_state = state
            .stream_processor_state
            .lock()
            .map_err(|_| "Stream processor state lock poisoned")?;
        sp_state.insert(session_id.clone(), proc_states);
    }

    // ── Cancellation channel ──────────────────────────────────────────────────
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut tasks = state
            .stream_tasks
            .lock()
            .map_err(|_| "Stream tasks lock poisoned")?;
        tasks.insert(session_id.clone(), cancel_tx);
    }

    // ── Spawn streaming task ──────────────────────────────────────────────────
    let app_clone = app.clone();
    let sid = session_id.clone();
    let src_id = source_id.clone();
    let serial_clone = serial.clone();
    let max_lines = max_raw_lines.unwrap_or(500_000) as usize;
    tokio::spawn(async move {
        run_streaming_task(
            cancel_rx,
            sid,
            src_id,
            serial_clone,
            package_filter,
            app_clone,
            max_lines,
            on_event,
        )
        .await;
    });

    Ok(LoadResult {
        session_id,
        source_id,
        source_name: device_label,
        file_path: None,
        total_lines: 0,
        file_size: 0,
        first_timestamp: None,
        last_timestamp: None,
        source_type: "Logcat".to_string(),
        is_streaming: true,
        is_indexing: false,
    })
}

// ---------------------------------------------------------------------------
// stop_adb_stream
// ---------------------------------------------------------------------------

/// Stop an active ADB stream. The session remains in AppState as a static log.
#[tauri::command]
pub async fn stop_adb_stream(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    // Send cancellation signal
    let sender = {
        let mut tasks = state
            .stream_tasks
            .lock()
            .map_err(|_| "Stream tasks lock poisoned")?;
        tasks.remove(&session_id)
    };

    if let Some(tx) = sender {
        let _ = tx.send(());
    }

    // The streaming task emits adb-stream-stopped itself; we also emit here in
    // case the task already exited (e.g. the channel was already dropped).
    let _ = app.emit(
        "adb-stream-stopped",
        AdbStreamStopped {
            session_id: session_id.clone(),
            reason: "user".to_string(),
        },
    );

    // Clean up continuous processor state (session data remains for search/pipeline)
    {
        let mut sp_state = state
            .stream_processor_state
            .lock()
            .map_err(|_| "Stream processor state lock poisoned")?;
        sp_state.remove(&session_id);
    }

    // Clean up stream anonymizer
    {
        let mut sa = state
            .stream_anonymizers
            .lock()
            .map_err(|_| "Stream anonymizer lock poisoned")?;
        sa.remove(&session_id);
    }

    // Clean up stream transformer state
    {
        let mut st = state
            .stream_transformer_state
            .lock()
            .map_err(|_| "Stream transformer state lock poisoned")?;
        st.remove(&session_id);
    }

    // Clean up stream tracker state
    {
        let mut st = state
            .stream_tracker_state
            .lock()
            .map_err(|_| "Stream tracker state lock poisoned")?;
        st.remove(&session_id);
    }

    // Clean up accumulated pipeline results from streaming
    {
        if let Ok(mut pr) = state.pipeline_results.lock() {
            pr.remove(&session_id);
        }
    }

    // Clean up state tracker results from streaming
    {
        if let Ok(mut str_results) = state.state_tracker_results.lock() {
            str_results.remove(&session_id);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// set_stream_anonymize
// ---------------------------------------------------------------------------

/// Enable or disable PII anonymization for a live ADB stream.
/// When enabled, a `LogAnonymizer` is created from the current config and
/// applied to every incoming line in `flush_batch` before display and processing.
/// The same anonymizer instance persists across batches so token numbering is
/// consistent (e.g. `user@corp.com` always maps to `<EMAIL-1>`).
#[tauri::command]
pub async fn set_stream_anonymize(
    state: State<'_, AppState>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut sa = state
        .stream_anonymizers
        .lock()
        .map_err(|_| "Stream anonymizer lock poisoned")?;
    if enabled {
        let config = state
            .anonymizer_config
            .lock()
            .map_err(|_| "Anonymizer config lock poisoned")?
            .clone();
        sa.insert(session_id, LogAnonymizer::from_config(&config));
    } else {
        sa.remove(&session_id);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// update_stream_processors
// ---------------------------------------------------------------------------

/// Update the set of active processors for a running ADB stream.
/// Called by the frontend whenever the user toggles processors during streaming.
/// New processors start fresh at the current stream position.
/// Removed processors have their state dropped.
#[tauri::command]
pub async fn update_stream_processors(
    state: State<'_, AppState>,
    session_id: String,
    processor_ids: Vec<String>,
) -> Result<(), String> {
    // Get the current total_lines so new processors are seeded from the right position.
    let current_total = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Session lock poisoned")?;
        sessions
            .get(&session_id)
            .and_then(|s| s.primary_source())
            .map(|src| src.total_lines())
            .unwrap_or(0)
    };

    // Clone the defs we need for any new processors.
    let new_proc_defs: HashMap<String, ReporterDef> = {
        let procs = state
            .processors
            .lock()
            .map_err(|_| "Processor lock poisoned")?;
        processor_ids
            .iter()
            .filter_map(|id| procs.get(id).and_then(|p| p.as_reporter()).map(|d| (id.clone(), d.clone())))
            .collect()
    };

    let mut sp_state = state
        .stream_processor_state
        .lock()
        .map_err(|_| "Stream processor state lock poisoned")?;

    let inner = sp_state.entry(session_id.clone()).or_default();

    // Remove processors no longer in the requested set.
    inner.retain(|id, _| processor_ids.contains(id));

    // Add new processors (those not already tracked) with fresh state.
    for proc_id in &processor_ids {
        if !inner.contains_key(proc_id.as_str()) {
            if let Some(def) = new_proc_defs.get(proc_id) {
                let run = ProcessorRun::new(def);
                inner.insert(proc_id.clone(), run.into_continuous_state(current_total, false));
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// update_stream_trackers
// ---------------------------------------------------------------------------

/// Update the set of active StateTracker processors for a running ADB stream.
/// New trackers start fresh; removed trackers have their state dropped.
#[tauri::command]
pub async fn update_stream_trackers(
    state: State<'_, AppState>,
    session_id: String,
    tracker_ids: Vec<String>,
) -> Result<(), String> {
    let current_total = {
        let sessions = state.sessions.lock().map_err(|_| "Session lock poisoned")?;
        sessions.get(&session_id)
            .and_then(|s| s.primary_source())
            .map(|src| src.total_lines())
            .unwrap_or(0)
    };

    let tracker_defs: HashMap<String, crate::processors::state_tracker::schema::StateTrackerDef> = {
        let procs = state.processors.lock().map_err(|_| "Processor lock poisoned")?;
        tracker_ids.iter()
            .filter_map(|id| procs.get(id).and_then(|p| p.as_state_tracker()).map(|d| (id.clone(), d.clone())))
            .collect()
    };

    let mut st = state.stream_tracker_state.lock()
        .map_err(|_| "Stream tracker state lock poisoned")?;
    let inner = st.entry(session_id).or_default();
    inner.retain(|id, _| tracker_ids.contains(id));
    for t_id in &tracker_ids {
        if !inner.contains_key(t_id.as_str()) {
            if let Some(def) = tracker_defs.get(t_id) {
                let current_state: HashMap<String, serde_json::Value> = def.state.iter()
                    .map(|f| (f.name.clone(), f.default.clone()))
                    .collect();
                inner.insert(t_id.clone(), crate::processors::state_tracker::types::ContinuousTrackerState {
                    current_state,
                    transitions: Vec::new(),
                    last_processed_line: current_total,
                });
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// update_stream_transformers
// ---------------------------------------------------------------------------

/// Update the set of active Transformer processors for a running ADB stream.
#[tauri::command]
pub async fn update_stream_transformers(
    state: State<'_, AppState>,
    session_id: String,
    transformer_ids: Vec<String>,
) -> Result<(), String> {
    let current_total = {
        let sessions = state.sessions.lock().map_err(|_| "Session lock poisoned")?;
        sessions.get(&session_id)
            .and_then(|s| s.primary_source())
            .map(|src| src.total_lines())
            .unwrap_or(0)
    };

    let mut st = state.stream_transformer_state.lock()
        .map_err(|_| "Stream transformer state lock poisoned")?;
    let inner = st.entry(session_id).or_default();
    inner.retain(|id, _| transformer_ids.contains(id));
    for t_id in &transformer_ids {
        if !inner.contains_key(t_id.as_str()) {
            inner.insert(t_id.clone(), crate::processors::transformer::types::ContinuousTransformerState {
                last_processed_line: current_total,
                pii_mappings: None,
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// get_package_pids
// ---------------------------------------------------------------------------

/// Resolve a package name to its current PID(s) on the device.
/// Uses `adb shell pidof <package>` which works on Android 4.4+.
/// Returns an empty vec if the package is not running.
#[tauri::command]
pub async fn get_package_pids(
    device_serial: String,
    package_name: String,
) -> Result<Vec<u32>, String> {
    let output = Command::new("adb")
        .arg("-s")
        .arg(&device_serial)
        .arg("shell")
        .arg("pidof")
        .arg(&package_name)
        .output()
        .await
        .map_err(|e| format!("adb error: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let pids: Vec<u32> = stdout
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    Ok(pids)
}

// ---------------------------------------------------------------------------
// Background streaming task
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn run_streaming_task(
    mut cancel: tokio::sync::oneshot::Receiver<()>,
    session_id: String,
    source_id: String,
    device_serial: String,
    package_filter: Option<String>,
    app: AppHandle,
    max_raw_lines: usize,
    on_event: Channel<AdbStreamEvent>,
) {
    // Build adb command.  -T 1 = replay the last 1 buffered entry then
    // stream new lines only, avoiding a full ring-buffer dump on connect.
    let mut cmd = Command::new("adb");
    cmd.arg("-s")
        .arg(&device_serial)
        .arg("logcat")
        .arg("-v")
        .arg("threadtime")
        .arg("-T")
        .arg("1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())  // capture so errors surface in logs
        .kill_on_drop(true);

    // If package filter specified, add PID filter
    if let Some(ref pkg) = package_filter {
        cmd.arg("--pid").arg(pkg);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = on_event.send(AdbStreamEvent::StreamStopped(AdbStreamStopped {
                session_id: session_id.clone(),
                reason: format!("Failed to spawn adb: {e}"),
            }));
            return;
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = on_event.send(AdbStreamEvent::StreamStopped(AdbStreamStopped {
                session_id: session_id.clone(),
                reason: "Failed to capture adb stdout".to_string(),
            }));
            return;
        }
    };

    // Log stderr from adb so errors surface in the Tauri dev console.
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[adb stderr] {line}");
            }
        });
    }

    // Spawn a dedicated reader task to avoid cancellation-safety issues with
    // next_line() inside tokio::select!. Channel recv() IS cancellation-safe.
    let (line_tx, line_rx) = tokio::sync::mpsc::channel::<String>(1024);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line_tx.send(line).await.is_err() {
                break; // Main task dropped the receiver (cancelled)
            }
        }
        // Sender drops here → chunks_timeout flushes partial batch then yields None
    });

    // chunks_timeout handles both the 100-line count trigger and the 50ms time
    // trigger — no manual ticker or Vec buffer required.
    // tokio::pin! is required because ChunksTimeout is not Unpin and select! needs
    // to poll the future across loop iterations.
    let batched = ReceiverStream::new(line_rx)
        .chunks_timeout(100, Duration::from_millis(50));
    tokio::pin!(batched);

    loop {
        tokio::select! {
            batch = batched.next() => {
                match batch {
                    Some(lines) => {
                        flush_batch(lines, &session_id, &source_id, &app, max_raw_lines, &on_event);
                    }
                    None => {
                        // Reader task ended (EOF or device disconnect); chunks_timeout
                        // flushed any partial batch before yielding None.
                        let _ = on_event.send(AdbStreamEvent::StreamStopped(AdbStreamStopped {
                            session_id: session_id.clone(),
                            reason: "eof".to_string(),
                        }));
                        break;
                    }
                }
            }
            _ = &mut cancel => {
                child.kill().await.ok();
                let _ = on_event.send(AdbStreamEvent::StreamStopped(AdbStreamStopped {
                    session_id: session_id.clone(),
                    reason: "user".to_string(),
                }));
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Batch flush — parses lines, appends to session, runs processors, emits events
// ---------------------------------------------------------------------------

fn flush_batch(
    lines: Vec<String>,
    session_id: &str,
    source_id: &str,
    app: &AppHandle,
    max_raw_lines: usize,
    on_event: &Channel<AdbStreamEvent>,
) {
    if lines.is_empty() {
        return;
    }

    let state_guard = app.state::<AppState>();
    let state: &AppState = &state_guard;
    let parser = LogcatParser;

    // ── Step 1: Snapshot current total_lines (before appending) ───────────────
    let first_new_line = {
        let sessions = match state.sessions.lock() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("[adb flush_batch] sessions lock poisoned (step 1): {e}");
                return;
            }
        };
        sessions
            .get(session_id)
            .and_then(|s| s.primary_source())
            .map(|src| src.total_lines())
            .unwrap_or(0)
    };

    // ── Step 2: Parse once — derive ParsedLineMeta, ViewLine, and LineContext
    //    from a single parse_line call (eliminates redundant parse_meta) ────────
    struct ParsedLine {
        raw: String,
        meta: ParsedLineMeta,
        view_line: ViewLine,
        ctx: Option<LineContext>, // cached for downstream reuse (trackers, reporters)
    }

    let mut parsed: Vec<ParsedLine> = Vec::with_capacity(lines.len());
    for (i, raw) in lines.into_iter().enumerate() {
        let line_num = first_new_line + i;

        if let Some(ctx) = parser.parse_line(&raw, source_id, line_num) {
            // Derive ParsedLineMeta from LineContext (no separate parse_meta call)
            let meta = ParsedLineMeta {
                level: ctx.level,
                tag: ctx.tag.to_string(),
                timestamp: ctx.timestamp,
                byte_offset: 0,
                byte_len: raw.len(),
                is_section_boundary: false,
            };
            let view_line = ViewLine {
                line_num,
                virtual_index: line_num,
                raw: ctx.raw.to_string(),
                level: ctx.level,
                tag: ctx.tag.to_string(),
                message: ctx.message.to_string(),
                timestamp: ctx.timestamp,
                pid: ctx.pid,
                tid: ctx.tid,
                source_id: source_id.to_string(),
                highlights: vec![],
                matched_by: vec![],
                is_context: false,
            };
            parsed.push(ParsedLine { raw, meta, view_line, ctx: Some(ctx) });
        } else {
            // Unparseable line — fallback metadata
            let meta = ParsedLineMeta {
                level: LogLevel::Info,
                tag: String::new(),
                timestamp: 0,
                byte_offset: 0,
                byte_len: raw.len(),
                is_section_boundary: false,
            };
            let view_line = ViewLine {
                line_num,
                virtual_index: line_num,
                raw: raw.clone(),
                level: LogLevel::Info,
                tag: String::new(),
                message: raw.clone(),
                timestamp: 0,
                pid: 0,
                tid: 0,
                source_id: source_id.to_string(),
                highlights: vec![],
                matched_by: vec![],
                is_context: false,
            };
            parsed.push(ParsedLine { raw, meta, view_line, ctx: None });
        }
    }

    if parsed.is_empty() {
        return;
    }

    // ── Step 2b: Apply PII anonymization to ViewLines (if enabled) ────────────
    // Extract the anonymizer for this session (same extract-use-reinsert pattern
    // as stream_processor_state). Using the same instance across batches keeps
    // token numbering stable: the same raw value always maps to the same token.
    let anon: Option<LogAnonymizer> = {
        match state.stream_anonymizers.lock() {
            Ok(mut sa) => sa.remove(session_id),
            Err(e) => {
                eprintln!("[adb flush_batch] stream_anonymizers lock poisoned: {e}");
                None // skip anonymization, don't abort the whole batch
            }
        }
    };

    let mut pii_modified = false;
    if let Some(ref a) = anon {
        for pl in &mut parsed {
            let (anon_msg, _) = a.anonymize(&pl.view_line.message);
            if anon_msg != pl.view_line.message {
                // Reconstruct raw: keep the logcat header prefix, replace message.
                let prefix_len = pl.view_line.raw.len().saturating_sub(pl.view_line.message.len());
                pl.view_line.raw = format!("{}{}", &pl.view_line.raw[..prefix_len], &anon_msg);
                pl.view_line.message = anon_msg;
                pii_modified = true;
            }
        }
    }

    // ── Step 2c: Apply built-in transformers / PII pipeline (if active) ──────
    {
        let transformer_ids: Vec<String> = {
            match state.stream_transformer_state.lock() {
                Ok(st) => st.get(session_id).map(|m| m.keys().cloned().collect()).unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        };

        if !transformer_ids.is_empty() {
            let transformer_defs: Vec<(String, crate::processors::transformer::schema::TransformerDef)> = {
                match state.processors.lock() {
                    Ok(procs) => transformer_ids.iter()
                        .filter_map(|id| procs.get(id.as_str())
                            .and_then(|p| p.as_transformer())
                            .map(|d| (id.clone(), d.clone())))
                        .collect(),
                    Err(e) => {
                        eprintln!("[adb flush_batch] processors lock poisoned (transformers): {e}");
                        Vec::new()
                    }
                }
            };

            if !transformer_defs.is_empty() {
                // Extract ALL transformer states in one lock (consolidated pattern)
                let mut transformer_states: HashMap<String, crate::processors::transformer::types::ContinuousTransformerState> = {
                    match state.stream_transformer_state.lock() {
                        Ok(mut st) => {
                            if let Some(inner) = st.get_mut(session_id) {
                                transformer_ids.iter()
                                    .filter_map(|id| inner.remove(id).map(|s| (id.clone(), s)))
                                    .collect()
                            } else {
                                HashMap::new()
                            }
                        }
                        Err(_) => HashMap::new(),
                    }
                };

                // Build transformer runs seeded with extracted state
                let mut transformer_runs: Vec<(String, crate::processors::transformer::engine::TransformerRun)> =
                    transformer_defs.iter().map(|(t_id, def)| {
                        let cont = transformer_states.remove(t_id).unwrap_or_default();
                        let run = crate::processors::transformer::engine::TransformerRun::new_seeded(def, cont);
                        (t_id.clone(), run)
                    }).collect();

                // Apply transformers using cached LineContext (no re-parse needed).
                for pl in parsed.iter_mut() {
                    let mut ctx = match pl.ctx {
                        Some(ref c) if pii_modified => {
                            // PII modified the message — patch the clone
                            let mut tc = c.clone();
                            tc.message = std::sync::Arc::from(pl.view_line.message.as_str());
                            tc.raw = std::sync::Arc::from(pl.view_line.raw.as_str());
                            tc
                        }
                        Some(ref c) => c.clone(),
                        None => continue, // unparseable line — skip
                    };

                    let mut keep = true;
                    for (_, run) in transformer_runs.iter_mut() {
                        if !run.process_line(&mut ctx) {
                            keep = false;
                            break;
                        }
                    }
                    if keep {
                        if *ctx.message != pl.view_line.message {
                            let prefix_len = pl.view_line.raw.len().saturating_sub(pl.view_line.message.len());
                            pl.view_line.raw = format!("{}{}", &pl.view_line.raw[..prefix_len], &ctx.message);
                            pl.view_line.message = ctx.message.to_string();
                            pii_modified = true; // mark so reporters see the transformed version
                        }
                        pl.view_line.tag = ctx.tag.to_string();
                    }
                    // Note: we don't drop lines in streaming mode — transformers
                    // only modify content, dropping would break the view stream.
                }

                // Re-insert ALL transformer states in one lock
                if let Ok(mut st) = state.stream_transformer_state.lock() {
                    let inner = st.entry(session_id.to_string()).or_default();
                    for (t_id, run) in transformer_runs {
                        let new_cont = run.into_continuous_state(first_new_line + parsed.len());
                        inner.insert(t_id, new_cont);
                    }
                }
            }
        }
    }

    // ── Step 3: Append raw lines + meta to session, evict if over cap ─────────
    let (total_lines, byte_count, first_ts, last_ts) = {
        let mut sessions = match state.sessions.lock() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("[adb flush_batch] sessions lock poisoned (step 3): {e}");
                return;
            }
        };
        let session = match sessions.get_mut(session_id) {
            Some(s) => s,
            None => return,
        };

        // Intern tags first (needs &mut session for tag_interner).
        let metas: Vec<LineMeta> = parsed.iter().map(|pl| {
            let tag_id = session.intern_tag(&pl.meta.tag);
            LineMeta {
                level: pl.meta.level,
                tag_id,
                timestamp: pl.meta.timestamp,
                byte_offset: pl.meta.byte_offset,
                byte_len: pl.meta.byte_len,
                is_section_boundary: pl.meta.is_section_boundary,
            }
        }).collect();

        // Append to stream source.
        let stream = match session.stream_source_mut() {
            Some(s) => s,
            None => return,
        };

        for (pl, meta) in parsed.iter().zip(metas.into_iter()) {
            stream.add_bytes((pl.raw.len() + 1) as u64);
            stream.push_raw_line(pl.raw.clone());
            stream.maybe_set_first_ts(pl.meta.timestamp);
            stream.push_meta(meta);
        }

        // Evict oldest lines from the front if over the cap.
        let excess = stream.retained_count().saturating_sub(max_raw_lines);
        if excess > 0 {
            stream.evict(excess);
        }

        // Collect stats for the batch event payload.
        let total = stream.total_lines();
        let bc = stream.stream_byte_count();
        let first_ts = stream.cached_first_ts();
        let last_ts = stream.line_meta_slice()
            .iter()
            .rev()
            .find(|m| m.timestamp > 0)
            .map(|m| m.timestamp);

        (total, bc, first_ts, last_ts)
    };

    // Collect ViewLines for the batch event
    let view_lines: Vec<ViewLine> = parsed.iter().map(|pl| pl.view_line.clone()).collect();

    // ── Step 3.5: StateTracker layer (consolidated lock pattern) ────────────
    // Trackers see original (pre-PII) messages for capture regexes — use
    // the cached ctx from the initial parse directly (no re-parse needed).
    {
        let tracker_ids: Vec<String> = {
            match state.stream_tracker_state.lock() {
                Ok(st) => st.get(session_id).map(|m| m.keys().cloned().collect()).unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        };

        if !tracker_ids.is_empty() {
            let tracker_defs: HashMap<String, crate::processors::state_tracker::schema::StateTrackerDef> = {
                match state.processors.lock() {
                    Ok(procs) => tracker_ids.iter()
                        .filter_map(|id| procs.get(id.as_str()).and_then(|p| p.as_state_tracker()).map(|d| (id.clone(), d.clone())))
                        .collect(),
                    Err(e) => {
                        eprintln!("[adb flush_batch] processors lock poisoned (trackers): {e}");
                        HashMap::new()
                    }
                }
            };

            // Extract ALL tracker continuous states in one lock (2N → 2 lock acquisitions)
            let mut tracker_states: HashMap<String, crate::processors::state_tracker::types::ContinuousTrackerState> = {
                match state.stream_tracker_state.lock() {
                    Ok(mut st) => {
                        if let Some(inner) = st.get_mut(session_id) {
                            tracker_ids.iter()
                                .filter_map(|id| inner.remove(id).map(|s| (id.clone(), s)))
                                .collect()
                        } else {
                            HashMap::new()
                        }
                    }
                    Err(_) => HashMap::new(),
                }
            };

            // Process all trackers (no locks held)
            let mut tracker_updates: Vec<(String, crate::processors::state_tracker::types::ContinuousTrackerState, usize)> = Vec::new();
            for t_id in &tracker_ids {
                let def = match tracker_defs.get(t_id) {
                    Some(d) => d,
                    None => continue,
                };

                let cont_state = tracker_states.remove(t_id).unwrap_or_default();
                let mut run = crate::processors::state_tracker::engine::StateTrackerRun::new_seeded(
                    t_id, def, cont_state,
                );

                // Reuse cached LineContext — no re-parse needed
                for pl in &parsed {
                    if let Some(ref ctx) = pl.ctx {
                        run.process_line(ctx);
                    }
                }

                let new_cont = run.into_continuous_state(first_new_line + parsed.len());
                let transition_count = new_cont.transitions.len();
                tracker_updates.push((t_id.clone(), new_cont, transition_count));
            }

            // Re-insert ALL tracker states in one lock, emit events after
            if !tracker_updates.is_empty() {
                // Collect event data before consuming the vec
                let event_data: Vec<(String, usize)> = tracker_updates.iter()
                    .map(|(t_id, _, tc)| (t_id.clone(), *tc))
                    .collect();

                if let Ok(mut st) = state.stream_tracker_state.lock() {
                    let inner = st.entry(session_id.to_string()).or_default();
                    for (t_id, new_cont, _) in tracker_updates {
                        inner.insert(t_id, new_cont); // moved, no clone
                    }
                }

                for (t_id, transition_count) in event_data {
                    let _ = app.emit("adb-tracker-update", AdbTrackerUpdate {
                        session_id: session_id.to_string(),
                        tracker_id: t_id,
                        transition_count,
                    });
                }
            }
        }
    }

    // ── Step 4: Run active reporters on new lines (consolidated lock pattern)
    // Reporters see post-PII/transform messages. Reuse cached LineContext,
    // patching message/raw only if PII or transformers modified them.
    let proc_ids: Vec<String> = {
        let sp_state: std::sync::MutexGuard<'_, HashMap<String, HashMap<String, ContinuousRunState>>> =
            match state.stream_processor_state.lock() {
                Ok(g) => g,
                Err(_) => {
                    send_batch(on_event, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);
                    return;
                }
            };
        match sp_state.get(session_id) {
            Some(m) => m.keys().cloned().collect(),
            None => {
                send_batch(on_event, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);
                return;
            }
        }
    };

    if proc_ids.is_empty() {
        send_batch(on_event, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);
        return;
    }

    // Clone processor defs (brief lock)
    let defs: HashMap<String, ReporterDef> = {
        let procs = match state.processors.lock() {
            Ok(g) => g,
            Err(_) => {
                send_batch(on_event, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);
                return;
            }
        };
        proc_ids
            .iter()
            .filter_map(|id| procs.get(id.as_str()).and_then(|p| p.as_reporter()).map(|d| (id.clone(), d.clone())))
            .collect()
    };

    // Build reporter-ready contexts: if PII/transformer modified messages,
    // patch the cached ctx (cheap Arc clone, no regex re-parse).
    let reporter_ctxs: Option<Vec<Option<LineContext>>> = if pii_modified {
        Some(parsed.iter().map(|pl| {
            pl.ctx.as_ref().map(|c| {
                let mut rc = c.clone();
                rc.message = std::sync::Arc::from(pl.view_line.message.as_str());
                rc.raw = std::sync::Arc::from(pl.view_line.raw.as_str());
                rc
            })
        }).collect())
    } else {
        None
    };

    // Extract ALL reporter continuous states in one lock (2N → 2 lock acquisitions)
    let mut proc_states: HashMap<String, ContinuousRunState> = {
        match state.stream_processor_state.lock() {
            Ok(mut sp) => {
                if let Some(inner) = sp.get_mut(session_id) {
                    defs.keys()
                        .filter_map(|id| inner.remove(id).map(|s| (id.clone(), s)))
                        .collect()
                } else {
                    HashMap::new()
                }
            }
            Err(_) => {
                send_batch(on_event, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);
                return;
            }
        }
    };

    // Process all reporters (no locks held)
    let mut proc_updates: Vec<AdbProcessorUpdate> = Vec::new();
    let mut new_states: Vec<(String, ContinuousRunState)> = Vec::new();

    for (proc_id, def) in &defs {
        let cont_state = match proc_states.remove(proc_id) {
            Some(s) => s,
            None => continue,
        };

        let mut run = ProcessorRun::new_seeded(def, cont_state);

        // Reuse cached LineContext — no re-parse needed
        for (i, pl) in parsed.iter().enumerate() {
            let ctx_ref = match &reporter_ctxs {
                Some(patched) => patched[i].as_ref(),
                None => pl.ctx.as_ref(),
            };
            if let Some(ctx) = ctx_ref {
                run.process_line(ctx);
            }
        }

        // Snapshot results
        let result = run.current_result();
        let matched_lines = result.matched_line_nums.len();
        let emission_count = result.emissions.len();

        // Store results in pipeline_results (best effort)
        if let Ok(mut pr) = state.pipeline_results.lock() {
            pr.entry(session_id.to_string())
                .or_default()
                .insert(proc_id.clone(), result);
        }

        let new_state = run.into_continuous_state(total_lines, true);
        new_states.push((proc_id.clone(), new_state));

        proc_updates.push(AdbProcessorUpdate {
            session_id: session_id.to_string(),
            processor_id: proc_id.clone(),
            matched_lines,
            emission_count,
        });
    }

    // Re-insert ALL reporter states in one lock
    if let Ok(mut sp_state) = state.stream_processor_state.lock() {
        let inner = sp_state.entry(session_id.to_string()).or_default();
        for (id, new_state) in new_states {
            inner.insert(id, new_state);
        }
    }

    // ── Step 4b: Re-insert anonymizer and persist PII mappings ───────────────
    if let Some(a) = anon {
        // Update the session's token→original map so the PII dashboard can show it.
        let forward = a.mappings.all_mappings();
        let inverted: std::collections::HashMap<String, String> =
            forward.into_iter().map(|(raw, tok)| (tok, raw)).collect();
        if let Ok(mut pm) = state.pii_mappings.lock() {
            pm.insert(session_id.to_string(), inverted);
        }
        // Re-insert for the next batch.
        if let Ok(mut sa) = state.stream_anonymizers.lock() {
            sa.insert(session_id.to_string(), a);
        }
    }

    // ── Step 4c: Evaluate active watches on new lines ──────────────────────────
    let watch_refs: Vec<crate::commands::watch::WatchLineRef<'_>> = parsed.iter()
        .map(|pl| crate::commands::watch::WatchLineRef {
            raw: &pl.view_line.raw,
            tag: &pl.view_line.tag,
            level: pl.meta.level,
            timestamp: pl.meta.timestamp,
            pid: pl.view_line.pid,
        })
        .collect();
    let watch_results = crate::commands::watch::evaluate_watches(state, session_id, &watch_refs);
    if !watch_results.is_empty() {
        use crate::core::watch::WatchMatchEvent;
        for (watch_id, new_matches, total_matches) in &watch_results {
            let _ = app.emit("watch-match", WatchMatchEvent {
                watch_id: watch_id.clone(),
                session_id: session_id.to_string(),
                new_matches: *new_matches,
                total_matches: *total_matches,
            });
        }
    }

    // ── Step 5: Send events via Channel ───────────────────────────────────────
    send_batch(on_event, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);

    for update in proc_updates {
        let _ = on_event.send(AdbStreamEvent::ProcessorUpdate(update));
    }
}

fn send_batch(
    on_event: &Channel<AdbStreamEvent>,
    session_id: &str,
    lines: Vec<ViewLine>,
    total_lines: usize,
    byte_count: u64,
    first_timestamp: Option<i64>,
    last_timestamp: Option<i64>,
) {
    let _ = on_event.send(AdbStreamEvent::Batch(AdbBatch {
        session_id: session_id.to_string(),
        lines,
        total_lines,
        byte_count,
        first_timestamp,
        last_timestamp,
    }));
}

// ---------------------------------------------------------------------------
// Save live capture to file
// ---------------------------------------------------------------------------

/// Write all retained raw lines from a live stream session to a file.
/// Returns the number of lines written.
#[tauri::command]
pub fn save_live_capture(
    state: State<'_, AppState>,
    session_id: String,
    output_path: String,
) -> Result<u32, String> {
    use std::io::Write;

    let sessions = state.sessions.lock().map_err(|_| "lock poisoned")?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

    let source = session
        .stream_source()
        .ok_or_else(|| "Session is not a streaming source".to_string())?;

    let file = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create file: {e}"))?;
    let mut writer = std::io::BufWriter::new(file);

    let mut count = 0u32;

    // If there's a spill file, copy spilled lines first.
    if let Some(ref spill) = source.spill {
        for i in 0..spill.total_spilled() {
            if let Some(line) = spill.read_line(i) {
                writer.write_all(line.as_bytes()).map_err(|e| format!("Write error: {e}"))?;
                writer.write_all(b"\n").map_err(|e| format!("Write error: {e}"))?;
                count += 1;
            }
        }
    }

    // Then write in-memory (retained) lines.
    for raw in &source.raw_lines {
        writer.write_all(raw.as_bytes()).map_err(|e| format!("Write error: {e}"))?;
        writer.write_all(b"\n").map_err(|e| format!("Write error: {e}"))?;
        count += 1;
    }
    writer.flush().map_err(|e| format!("Flush error: {e}"))?;

    Ok(count)
}

// ---------------------------------------------------------------------------
// Tests — chunks_timeout stream behaviour
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify that chunks_timeout yields a full batch when the count threshold
    /// is reached before the time limit expires.
    #[tokio::test]
    async fn chunks_by_count() {
        let (tx, rx) = tokio::sync::mpsc::channel::<String>(1024);
        let stream = ReceiverStream::new(rx).chunks_timeout(3, Duration::from_millis(200));
        tokio::pin!(stream);

        for i in 0..3 {
            tx.send(format!("line {i}")).await.unwrap();
        }
        let batch = stream.next().await.unwrap();
        assert_eq!(batch.len(), 3);
    }

    /// Verify that chunks_timeout yields a partial batch when the time limit
    /// fires before the count threshold is reached.
    #[tokio::test]
    async fn chunks_by_timeout() {
        let (tx, rx) = tokio::sync::mpsc::channel::<String>(1024);
        let stream = ReceiverStream::new(rx).chunks_timeout(100, Duration::from_millis(50));
        tokio::pin!(stream);

        tx.send("only one".to_string()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;

        let batch = stream.next().await.unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0], "only one");
    }

    /// Verify that when the sender drops mid-batch, the partial batch is
    /// flushed before the stream yields None.
    #[tokio::test]
    async fn partial_batch_on_sender_drop() {
        let (tx, rx) = tokio::sync::mpsc::channel::<String>(1024);
        let stream = ReceiverStream::new(rx).chunks_timeout(100, Duration::from_millis(500));
        tokio::pin!(stream);

        tx.send("a".to_string()).await.unwrap();
        tx.send("b".to_string()).await.unwrap();
        drop(tx); // simulate EOF

        let batch = stream.next().await.unwrap();
        assert_eq!(batch, vec!["a", "b"]);
        assert!(stream.next().await.is_none());
    }
}
