use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::commands::AppState;
use crate::commands::files::LoadResult;
use crate::core::line::{LineMeta, LogLevel, ViewLine};
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;
use crate::core::session::{AnalysisSession, LogSourceData};
use crate::processors::interpreter::{ContinuousRunState, ProcessorRun};
use crate::processors::schema::ProcessorDef;

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
            if let Some(def) = procs.get(proc_id) {
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
    tokio::spawn(async move {
        run_streaming_task(
            cancel_rx,
            sid,
            src_id,
            serial_clone,
            package_filter,
            app_clone,
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
                            flush_batch(&mut buffer, &session_id, &source_id, &app);
                        }
                    }
                    None => {
                        // Reader task ended (EOF or device disconnect)
                        if !buffer.is_empty() {
                            flush_batch(&mut buffer, &session_id, &source_id, &app);
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
                    flush_batch(&mut buffer, &session_id, &source_id, &app);
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
                    flush_batch(&mut buffer, &session_id, &source_id, &app);
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

    // ── Step 3: Append raw lines + meta to session (brief lock) ───────────────
    let total_lines = {
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
        for (raw, meta, _) in &parsed {
            if let LogSourceData::Stream { raw_lines } = &mut source.data {
                raw_lines.push(raw.clone());
            }
            source.line_meta.push(meta.clone());
        }
        source.total_lines()
    };

    // Collect ViewLines for the batch event
    let view_lines: Vec<ViewLine> = parsed.iter().map(|(_, _, vl)| vl.clone()).collect();

    // ── Step 4: Run active processors on new lines ────────────────────────────
    let proc_ids: Vec<String> = {
        let sp_state: std::sync::MutexGuard<'_, HashMap<String, HashMap<String, ContinuousRunState>>> =
            match state.stream_processor_state.lock() {
                Ok(g) => g,
                Err(_) => {
                    emit_batch(app, session_id, view_lines, total_lines);
                    return;
                }
            };
        match sp_state.get(session_id) {
            Some(m) => m.keys().cloned().collect(),
            None => {
                emit_batch(app, session_id, view_lines, total_lines);
                return;
            }
        }
    };

    if proc_ids.is_empty() {
        emit_batch(app, session_id, view_lines, total_lines);
        return;
    }

    // Clone processor defs (brief lock)
    let defs: HashMap<String, ProcessorDef> = {
        let procs: std::sync::MutexGuard<'_, HashMap<String, ProcessorDef>> =
            match state.processors.lock() {
                Ok(g) => g,
                Err(_) => {
                    emit_batch(app, session_id, view_lines, total_lines);
                    return;
                }
            };
        proc_ids
            .iter()
            .filter_map(|id| procs.get(id.as_str()).map(|d| (id.clone(), d.clone())))
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

    // ── Step 5: Emit events ────────────────────────────────────────────────────
    emit_batch(app, session_id, view_lines, total_lines);

    for update in proc_updates {
        let _ = app.emit("adb-processor-update", update);
    }
}

fn emit_batch(app: &AppHandle, session_id: &str, lines: Vec<ViewLine>, total_lines: usize) {
    let _ = app.emit(
        "adb-batch",
        AdbBatch {
            session_id: session_id.to_string(),
            lines,
            total_lines,
        },
    );
}
