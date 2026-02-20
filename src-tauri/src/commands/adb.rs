use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::anonymizer::LogAnonymizer;
use crate::commands::AppState;
use crate::commands::files::LoadResult;
use crate::core::line::{LineMeta, LogLevel, ViewLine};
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;
use crate::core::session::{AnalysisSession, LogSourceData};
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

// ---------------------------------------------------------------------------
// list_adb_devices
// ---------------------------------------------------------------------------

/// List all connected ADB devices. Returns an empty vec if ADB is not on PATH.
#[tauri::command]
pub async fn list_adb_devices() -> Result<Vec<AdbDevice>, String> {
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
/// `adb-batch` events.
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
    let session_id = "default".to_string();
    let source_id = format!("adb-{}", serial.replace(':', "-"));
    let device_label = format!("ADB: {serial}");

    let mut session = AnalysisSession::new(session_id.clone());
    session.add_stream_source(source_id.clone(), device_label.clone());

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
                proc_states.insert(proc_id.clone(), run.into_continuous_state(0));
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
        )
        .await;
    });

    Ok(LoadResult {
        session_id,
        source_id,
        source_name: device_label,
        total_lines: 0,
        file_size: 0,
        first_timestamp: None,
        last_timestamp: None,
        source_type: "Logcat".to_string(),
        is_streaming: true,
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
                inner.insert(proc_id.clone(), run.into_continuous_state(current_total));
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

async fn run_streaming_task(
    mut cancel: tokio::sync::oneshot::Receiver<()>,
    session_id: String,
    source_id: String,
    device_serial: String,
    package_filter: Option<String>,
    app: AppHandle,
    max_raw_lines: usize,
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
            let _ = app.emit(
                "adb-stream-stopped",
                AdbStreamStopped {
                    session_id: session_id.clone(),
                    reason: format!("Failed to spawn adb: {e}"),
                },
            );
            return;
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = app.emit(
                "adb-stream-stopped",
                AdbStreamStopped {
                    session_id: session_id.clone(),
                    reason: "Failed to capture adb stdout".to_string(),
                },
            );
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
    let (line_tx, mut line_rx) = tokio::sync::mpsc::channel::<String>(1024);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line_tx.send(line).await.is_err() {
                break; // Main task dropped the receiver (cancelled)
            }
        }
        // Sender drops here → main task sees None from line_rx.recv()
    });

    let mut buffer: Vec<String> = Vec::new();
    let mut ticker = tokio::time::interval(tokio::time::Duration::from_millis(50));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            msg = line_rx.recv() => {
                match msg {
                    Some(line) => {
                        buffer.push(line);
                        if buffer.len() >= 100 {
                            flush_batch(&mut buffer, &session_id, &source_id, &app, max_raw_lines);
                        }
                    }
                    None => {
                        // Reader task ended (EOF or device disconnect)
                        if !buffer.is_empty() {
                            flush_batch(&mut buffer, &session_id, &source_id, &app, max_raw_lines);
                        }
                        let _ = app.emit(
                            "adb-stream-stopped",
                            AdbStreamStopped {
                                session_id: session_id.clone(),
                                reason: "eof".to_string(),
                            },
                        );
                        break;
                    }
                }
            }
            _ = &mut cancel => {
                if !buffer.is_empty() {
                    flush_batch(&mut buffer, &session_id, &source_id, &app, max_raw_lines);
                }
                child.kill().await.ok();
                let _ = app.emit(
                    "adb-stream-stopped",
                    AdbStreamStopped {
                        session_id: session_id.clone(),
                        reason: "user".to_string(),
                    },
                );
                break;
            }
            _ = ticker.tick() => {
                if !buffer.is_empty() {
                    flush_batch(&mut buffer, &session_id, &source_id, &app, max_raw_lines);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Batch flush — parses lines, appends to session, runs processors, emits events
// ---------------------------------------------------------------------------

fn flush_batch(
    buffer: &mut Vec<String>,
    session_id: &str,
    source_id: &str,
    app: &AppHandle,
    max_raw_lines: usize,
) {
    if buffer.is_empty() {
        return;
    }

    let state_guard = app.state::<AppState>();
    let state: &AppState = &state_guard;
    let parser = LogcatParser;

    // ── Step 1: Snapshot current total_lines (before appending) ───────────────
    let first_new_line = {
        let sessions = match state.sessions.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        sessions
            .get(session_id)
            .and_then(|s| s.primary_source())
            .map(|src| src.total_lines())
            .unwrap_or(0)
    };

    // ── Step 2: Parse buffer lines with correct absolute line numbers ──────────
    let mut parsed: Vec<(String, LineMeta, ViewLine)> = Vec::new();
    for (i, raw) in buffer.drain(..).enumerate() {
        let line_num = first_new_line + i;
        let meta = parser
            .parse_meta(&raw, 0)
            .unwrap_or_else(|| LineMeta {
                level: LogLevel::Info,
                tag: String::new(),
                timestamp: 0,
                byte_offset: 0,
                byte_len: raw.len(),
            });

        let view_line = if let Some(ctx) = parser.parse_line(&raw, source_id, line_num) {
            ViewLine {
                line_num,
                raw: ctx.raw.clone(),
                level: ctx.level,
                tag: ctx.tag,
                message: ctx.message,
                timestamp: ctx.timestamp,
                pid: ctx.pid,
                tid: ctx.tid,
                source_id: source_id.to_string(),
                highlights: vec![],
                matched_by: vec![],
                is_context: false,
            }
        } else {
            ViewLine {
                line_num,
                raw: raw.clone(),
                level: meta.level,
                tag: meta.tag.clone(),
                message: raw.clone(),
                timestamp: meta.timestamp,
                pid: 0,
                tid: 0,
                source_id: source_id.to_string(),
                highlights: vec![],
                matched_by: vec![],
                is_context: false,
            }
        };

        parsed.push((raw, meta, view_line));
    }

    if parsed.is_empty() {
        return;
    }

    // ── Step 2b: Apply PII anonymization to ViewLines (if enabled) ────────────
    // Extract the anonymizer for this session (same extract-use-reinsert pattern
    // as stream_processor_state). Using the same instance across batches keeps
    // token numbering stable: the same raw value always maps to the same token.
    let anon: Option<LogAnonymizer> = {
        let mut sa = match state.stream_anonymizers.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        sa.remove(session_id)
    };

    if let Some(ref a) = anon {
        for (_, _, vl) in &mut parsed {
            let (anon_msg, _) = a.anonymize(&vl.message);
            // Reconstruct raw: keep the logcat header prefix, replace message.
            let prefix_len = vl.raw.len().saturating_sub(vl.message.len());
            vl.raw = format!("{}{}", &vl.raw[..prefix_len], &anon_msg);
            vl.message = anon_msg;
        }
    }

    // ── Step 3: Append raw lines + meta to session, evict if over cap ─────────
    let (total_lines, byte_count, first_ts, last_ts) = {
        let mut sessions = match state.sessions.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let source = match sessions
            .get_mut(session_id)
            .and_then(|s| s.sources.first_mut())
        {
            Some(s) => s,
            None => return,
        };

        // Append parsed lines to both raw_lines and line_meta.
        // Access source.data and source.line_meta as separate fields to satisfy borrow checker.
        for (raw, meta, _) in &parsed {
            if let LogSourceData::Stream {
                ref mut raw_lines,
                ref mut byte_count,
                ref mut cached_first_ts,
                ..
            } = source.data
            {
                *byte_count += (raw.len() + 1) as u64; // +1 for the newline
                raw_lines.push(raw.clone());
                if cached_first_ts.is_none() && meta.timestamp > 0 {
                    *cached_first_ts = Some(meta.timestamp);
                }
            }
            // source.data borrow released at end of if-let block; now safe to borrow line_meta
            source.line_meta.push(meta.clone());
        }

        // Evict oldest lines from the front if over the cap.
        // Compute excess separately to avoid simultaneous mutable + immutable borrows.
        let excess = if let LogSourceData::Stream { ref raw_lines, .. } = source.data {
            raw_lines.len().saturating_sub(max_raw_lines)
        } else {
            0
        };

        if excess > 0 {
            if let LogSourceData::Stream {
                ref mut raw_lines,
                ref mut evicted_count,
                ..
            } = source.data
            {
                raw_lines.drain(0..excess);
                *evicted_count += excess;
            }
            // source.data borrow released; now drain the parallel line_meta slice
            source.line_meta.drain(0..excess);
        }

        // Collect stats for the batch event payload.
        let total = source.total_lines();
        let (bc, first_ts, last_ts) = if let LogSourceData::Stream {
            byte_count,
            cached_first_ts,
            ..
        } = &source.data
        {
            let last = source
                .line_meta
                .iter()
                .rev()
                .find(|m| m.timestamp > 0)
                .map(|m| m.timestamp);
            (*byte_count, *cached_first_ts, last)
        } else {
            (0, None, None)
        };

        (total, bc, first_ts, last_ts)
    };

    // Collect ViewLines for the batch event
    let view_lines: Vec<ViewLine> = parsed.iter().map(|(_, _, vl)| vl.clone()).collect();

    // ── Step 3.5: StateTracker layer ──────────────────────────────────────────
    {
        let tracker_ids: Vec<String> = {
            match state.stream_tracker_state.lock() {
                Ok(st) => st.get(session_id).map(|m| m.keys().cloned().collect()).unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        };

        if !tracker_ids.is_empty() {
            let tracker_defs: HashMap<String, crate::processors::state_tracker::schema::StateTrackerDef> = {
                let procs = match state.processors.lock() {
                    Ok(g) => g,
                    Err(_) => {
                        // Can't get defs, skip tracker pass this batch
                        return;
                    }
                };
                tracker_ids.iter()
                    .filter_map(|id| procs.get(id.as_str()).and_then(|p| p.as_state_tracker()).map(|d| (id.clone(), d.clone())))
                    .collect()
            };

            for t_id in &tracker_ids {
                let def = match tracker_defs.get(t_id) {
                    Some(d) => d,
                    None => continue,
                };

                // Extract continuous state (extract-use-reinsert)
                let cont_state = {
                    let mut st = match state.stream_tracker_state.lock() {
                        Ok(g) => g,
                        Err(_) => continue,
                    };
                    match st.get_mut(session_id).and_then(|m| m.remove(t_id.as_str())) {
                        Some(s) => s,
                        None => crate::processors::state_tracker::types::ContinuousTrackerState::default(),
                    }
                };

                let mut run = crate::processors::state_tracker::engine::StateTrackerRun::new_seeded(
                    t_id, def, cont_state,
                );

                for (i, (raw, _, _)) in parsed.iter().enumerate() {
                    if let Some(ctx) = parser.parse_line(raw, source_id, first_new_line + i) {
                        run.process_line(&ctx);
                    }
                }

                let new_cont = run.into_continuous_state(first_new_line + parsed.len());
                let transition_count = new_cont.transitions.len();

                // Re-insert updated state
                if let Ok(mut st) = state.stream_tracker_state.lock() {
                    st.entry(session_id.to_string())
                        .or_default()
                        .insert(t_id.clone(), new_cont);
                }

                let _ = app.emit("adb-tracker-update", AdbTrackerUpdate {
                    session_id: session_id.to_string(),
                    tracker_id: t_id.clone(),
                    transition_count,
                });
            }
        }
    }

    // ── Step 4: Run active processors on new lines ────────────────────────────
    let proc_ids: Vec<String> = {
        let sp_state: std::sync::MutexGuard<'_, HashMap<String, HashMap<String, ContinuousRunState>>> =
            match state.stream_processor_state.lock() {
                Ok(g) => g,
                Err(_) => {
                    emit_batch(app, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);
                    return;
                }
            };
        match sp_state.get(session_id) {
            Some(m) => m.keys().cloned().collect(),
            None => {
                emit_batch(app, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);
                return;
            }
        }
    };

    if proc_ids.is_empty() {
        emit_batch(app, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);
        return;
    }

    // Clone processor defs (brief lock)
    let defs: HashMap<String, ReporterDef> = {
        let procs = match state.processors.lock() {
            Ok(g) => g,
            Err(_) => {
                emit_batch(app, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);
                return;
            }
        };
        proc_ids
            .iter()
            .filter_map(|id| procs.get(id.as_str()).and_then(|p| p.as_reporter()).map(|d| (id.clone(), d.clone())))
            .collect()
    };

    let mut proc_updates: Vec<AdbProcessorUpdate> = Vec::new();

    for (proc_id, def) in &defs {
        // Extract existing continuous state (remove then re-insert)
        let cont_state: ContinuousRunState = {
            let mut sp_state: std::sync::MutexGuard<'_, HashMap<String, HashMap<String, ContinuousRunState>>> =
                match state.stream_processor_state.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
            let inner: &mut HashMap<String, ContinuousRunState> =
                match sp_state.get_mut(session_id) {
                    Some(m) => m,
                    None => continue,
                };
            match inner.remove(proc_id.as_str()) {
                Some(s) => s,
                None => continue,
            }
        };

        // Create seeded run and process new lines
        let mut run = ProcessorRun::new_seeded(
            def,
            cont_state.vars,
            cont_state.emissions,
            cont_state.matched_line_nums,
            cont_state.history,
        );

        for (i, (_, _, vl)) in parsed.iter().enumerate() {
            if let Some(ctx) = parser.parse_line(&vl.raw, source_id, first_new_line + i) {
                run.process_line(&ctx);
            }
        }

        // Snapshot results
        let result = run.current_result();
        let matched_lines = result.matched_line_nums.len();
        let emission_count = result.emissions.len();

        // Store results in pipeline_results (best effort — streaming results accumulate)
        if let Ok(mut pr) = state.pipeline_results.lock() {
            pr.entry(session_id.to_string())
                .or_default()
                .insert(proc_id.clone(), result);
        }

        // Save updated continuous state (always — this drives the next batch)
        let new_state = run.into_continuous_state(total_lines);
        if let Ok(mut sp_state) = state.stream_processor_state.lock() {
            sp_state
                .entry(session_id.to_string())
                .or_default()
                .insert(proc_id.clone(), new_state);
        }

        proc_updates.push(AdbProcessorUpdate {
            session_id: session_id.to_string(),
            processor_id: proc_id.clone(),
            matched_lines,
            emission_count,
        });
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

    // ── Step 5: Emit events ────────────────────────────────────────────────────
    emit_batch(app, session_id, view_lines, total_lines, byte_count, first_ts, last_ts);

    for update in proc_updates {
        let _ = app.emit("adb-processor-update", update);
    }
}

fn emit_batch(
    app: &AppHandle,
    session_id: &str,
    lines: Vec<ViewLine>,
    total_lines: usize,
    byte_count: u64,
    first_timestamp: Option<i64>,
    last_timestamp: Option<i64>,
) {
    let _ = app.emit(
        "adb-batch",
        AdbBatch {
            session_id: session_id.to_string(),
            lines,
            total_lines,
            byte_count,
            first_timestamp,
            last_timestamp,
        },
    );
}
