//! ADB log streaming — device discovery, the live capture task, and everything
//! that mutates a stream's continuous processor state.
//!
//! This is the whole of what `commands/adb.rs` used to be, minus Tauri. Both
//! transports drive the same task: the desktop hands it a
//! [`crate::commands::adapters::AdbChannelSink`] (one IPC `Channel` to one
//! pane), an agent hands it a [`super::events::RingSink`] it later drains with
//! a `?since=` cursor. Nothing about the capture loop, the batching window, or
//! the state bookkeeping differs between them — only the `Sink<AdbStreamEvent>`
//! implementation on the far end.
//!
//! ## The streaming epoch guard (do not restructure)
//!
//! [`flush_batch`] follows an extract → process (no locks held) → re-insert
//! pattern. Every writer that clears or replaces a session's continuous stream
//! state ([`stop`], [`set_anonymize`], [`update_processors`],
//! [`update_trackers`], [`update_transformers`], and
//! `services::sessions::close`) bumps or drops the session's `stream_epochs`
//! stamp **while holding the `stream_epochs` lock**; `flush_batch` records the
//! stamp at batch start and re-reads it under the same lock at every re-insert,
//! dropping its now-stale state when the stamp changed or vanished. Lock order
//! is always `stream_epochs` (outer) → the specific stream-state map (inner).
//! See `AppState::stream_epochs` for the full contract — this module is the
//! only reader of it and the invariant is moved here byte-for-byte.
//!
//! ## Where the lines come from
//!
//! The child `adb logcat` process sits behind [`LineSourceFactory`] so the
//! batching window, the epoch guard, watch evaluation and ring semantics are
//! all testable without a device attached. [`AdbLineSource`] is the production
//! implementation; tests inject a canned one.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_stream::{wrappers::ReceiverStream, StreamExt as _};
use ts_rs::TS;

use crate::anonymizer::LogAnonymizer;
use crate::commands::files::LoadResult;
use crate::commands::pipeline_core::{
    excluded_by_declared_source_types, ContinuousStates, PartitionedDefs, PipelineCore,
};
use crate::commands::{lock_or_err, AppState};
use crate::core::line::{
    LineContext, LineMeta, LogLevel, ParsedLineMeta, PipelineContext, ViewLine,
};
use crate::core::log_source::LogSource;
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;
use crate::core::session::AnalysisSession;
use crate::processors::interpreter::{ContinuousRunState, ProcessorRun};
use crate::processors::reporter::schema::ReporterDef;
use crate::processors::state_tracker::engine::build_defaults;

use super::events::{RingSink, SeqItem, Sink};
use super::{lock_svc, pipeline, policy, Caller, ServiceCtx, ServiceError};

// ---------------------------------------------------------------------------
// Wire types (moved verbatim from commands/adb.rs, serde + TS derives intact)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
    pub model: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AdbBatch {
    pub session_id: String,
    pub lines: Vec<ViewLine>,
    pub total_lines: usize,
    /// Cumulative bytes received from ADB (for Size display in file info panel).
    #[ts(type = "number")]
    pub byte_count: u64,
    /// First non-zero timestamp in the stream (nanoseconds since 2000-01-01 UTC).
    #[ts(type = "number | null")]
    pub first_timestamp: Option<i64>,
    /// Most recent non-zero timestamp (nanoseconds since 2000-01-01 UTC).
    #[ts(type = "number | null")]
    pub last_timestamp: Option<i64>,
    /// Cumulative count of evicted lines that could NOT be spilled to disk and
    /// are therefore permanently lost (spill-file create/write failure). 0 in
    /// the normal case; a non-zero value makes otherwise-silent loss visible.
    pub lost_line_count: usize,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AdbProcessorUpdate {
    pub session_id: String,
    pub processor_id: String,
    pub matched_lines: usize,
    pub emission_count: usize,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AdbStreamStopped {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AdbTrackerUpdate {
    pub session_id: String,
    pub tracker_id: String,
    pub transition_count: usize,
}

/// Typed channel event for ADB streaming — replaces high-frequency `app.emit()` calls.
/// Serializes as a tagged union: `{ "event": "batch", "data": {...} }`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum AdbStreamEvent {
    Batch(AdbBatch),
    ProcessorUpdate(AdbProcessorUpdate),
    StreamStopped(AdbStreamStopped),
}

// ---------------------------------------------------------------------------
// Service-level request / response shapes
// ---------------------------------------------------------------------------

/// Everything a caller chooses when starting a live capture.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StartStreamRequest {
    /// Device serial. `None` picks the single connected device, or errors when
    /// zero or more than one is attached.
    #[serde(default)]
    pub device_id: Option<String>,
    /// Package name to resolve to a `--pid` filter. `None` streams unfiltered.
    #[serde(default)]
    pub package_filter: Option<String>,
    /// Processors to run continuously over the stream. Resolved through
    /// [`pipeline::resolve_effective_chain`]; `None`/empty means "no chain"
    /// (plus the PII anonymizer when this caller must be redacted).
    #[serde(default)]
    pub processor_ids: Option<Vec<String>>,
    /// Raw lines kept in the backend buffer; oldest evicted above this.
    /// `None` defaults to 500,000.
    #[serde(default)]
    pub max_raw_lines: Option<u32>,
}

/// A live (or just-stopped) stream, as both transports see it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatus {
    pub session_id: String,
    pub source_name: String,
    /// True while the capture task is still registered in `stream_tasks`.
    pub streaming: bool,
    pub total_lines: usize,
    #[ts(type = "number")]
    pub byte_count: u64,
    #[ts(type = "number | null")]
    pub first_timestamp: Option<i64>,
    #[ts(type = "number | null")]
    pub last_timestamp: Option<i64>,
    pub lost_line_count: usize,
    /// Whether a live anonymizer is attached to this stream.
    pub anonymize: bool,
    /// Active continuous reporter ids.
    pub processor_ids: Vec<String>,
    /// Active continuous state-tracker ids.
    pub tracker_ids: Vec<String>,
    /// Active continuous transformer ids.
    pub transformer_ids: Vec<String>,
    /// Highest sequence number in this session's agent event ring, or `None`
    /// when no ring is registered (a UI-started stream has no ring).
    #[ts(type = "number | null")]
    pub latest_event_seq: Option<u64>,
}

/// One page drained from a session's agent event ring.
#[derive(Debug, Clone)]
pub struct StreamEventsPage {
    pub session_id: String,
    pub events: Vec<SeqItem<AdbStreamEvent>>,
    /// Highest sequence the ring has ever issued.
    pub latest_seq: u64,
    /// Cursor to pass as `since` on the next poll.
    pub next_since: u64,
    /// True when events between the caller's cursor and the oldest retained
    /// item were evicted — the caller missed data and cannot get it back.
    pub gap: bool,
}

/// Capacity of the per-session agent event ring.
pub const AGENT_RING_CAPACITY: usize = 2000;

/// Character cap applied to line text drained through [`events`], matching the
/// bridge's existing raw-line routes.
const STREAM_LINE_CHARS: usize = 500;

/// Default backend retention for a live capture.
const DEFAULT_MAX_RAW_LINES: u32 = 500_000;

// ---------------------------------------------------------------------------
// Line source seam
// ---------------------------------------------------------------------------

/// Handle to a running line producer. [`StreamHandle::kill`] is called when the
/// capture is cancelled; dropping the handle must also stop production.
pub trait StreamHandle: Send {
    fn kill(&mut self);
}

/// A started producer: the line channel plus its kill handle.
pub struct LineStream {
    pub lines: tokio::sync::mpsc::Receiver<String>,
    pub handle: Box<dyn StreamHandle>,
}

/// Opens the process (or fake) that produces raw log lines for one stream.
///
/// The seam exists so [`flush_batch`]'s epoch guard, watch evaluation, and the
/// EOF path are testable without an attached device.
pub trait LineSourceFactory: Send + Sync {
    fn open(&self, device_serial: &str, pid_filter: Option<u32>) -> Result<LineStream, String>;
}

/// The production line source: `adb -s <serial> logcat -v threadtime -T 1`.
pub struct AdbLineSource;

struct ChildHandle(tokio::process::Child);

impl StreamHandle for ChildHandle {
    fn kill(&mut self) {
        // `start_kill` is the non-async half of `Child::kill`; the child is
        // spawned with `kill_on_drop(true)`, so reaping happens when the
        // handle drops immediately after.
        let _ = self.0.start_kill();
    }
}

impl LineSourceFactory for AdbLineSource {
    fn open(&self, device_serial: &str, pid_filter: Option<u32>) -> Result<LineStream, String> {
        // -T 1 = replay the last 1 buffered entry then stream new lines only,
        // avoiding a full ring-buffer dump on connect.
        let mut cmd = Command::new("adb");
        cmd.arg("-s")
            .arg(device_serial)
            .arg("logcat")
            .arg("-v")
            .arg("threadtime")
            .arg("-T")
            .arg("1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped()) // capture so errors surface in logs
            .kill_on_drop(true);

        if let Some(pid) = pid_filter {
            cmd.arg("--pid").arg(pid.to_string());
        }

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn adb: {e}"))?;

        let Some(stdout) = child.stdout.take() else {
            return Err("Failed to capture adb stdout".to_string());
        };

        // Log stderr from adb so errors surface in the dev console.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[adb stderr] {line}");
                }
            });
        }

        // Dedicated reader task: `next_line()` is not cancellation-safe inside
        // `tokio::select!`, channel `recv()` is.
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

        Ok(LineStream {
            lines: line_rx,
            handle: Box::new(ChildHandle(child)),
        })
    }
}

// ---------------------------------------------------------------------------
// Reads — devices, package pids (never journaled)
// ---------------------------------------------------------------------------

/// List all connected ADB devices. Returns an empty vec if ADB is not on PATH
/// but reachable; a spawn failure is a typed error, never a panic.
///
/// Retries once after a short delay if the first call returns no devices, which
/// handles the case where the ADB daemon wasn't running and needs time to start.
pub async fn devices(_ctx: &ServiceCtx) -> Result<Vec<AdbDevice>, ServiceError> {
    let found = query_adb_devices().await?;
    if !found.is_empty() {
        return Ok(found);
    }
    // ADB daemon may have just started — retry after a brief delay.
    tokio::time::sleep(Duration::from_millis(500)).await;
    query_adb_devices().await
}

async fn query_adb_devices() -> Result<Vec<AdbDevice>, ServiceError> {
    let output = Command::new("adb")
        .arg("devices")
        .arg("-l")
        .output()
        .await
        .map_err(|e| {
            ServiceError::Internal(format!(
                "Failed to run adb: {e}. Make sure adb is on your PATH."
            ))
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_adb_devices(&stdout))
}

fn parse_adb_devices(output: &str) -> Vec<AdbDevice> {
    let mut found = Vec::new();
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
            .map_or_else(|| serial.clone(), |t| t["model:".len()..].to_string());

        found.push(AdbDevice { serial, model, state });
    }

    found
}

/// Resolve a package name to its current PID(s) on the device.
/// Uses `adb shell pidof <package>` which works on Android 4.4+.
/// Returns an empty vec if the package is not running.
pub async fn package_pids(
    _ctx: &ServiceCtx,
    device_serial: &str,
    package_name: &str,
) -> Result<Vec<u32>, ServiceError> {
    let output = Command::new("adb")
        .arg("-s")
        .arg(device_serial)
        .arg("shell")
        .arg("pidof")
        .arg(package_name)
        .output()
        .await
        .map_err(|e| ServiceError::Internal(format!("adb error: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_pidof_output(&stdout))
}

/// Parse whitespace-separated PIDs from `adb shell pidof` stdout. Extracted so
/// the parsing logic is unit-testable without spawning `adb`.
fn parse_pidof_output(stdout: &str) -> Vec<u32> {
    stdout.split_whitespace().filter_map(|s| s.parse().ok()).collect()
}

/// Decide the single `--pid` value (if any) to pass to `adb logcat` given the
/// PIDs resolved for a package filter.
///
/// `adb logcat --pid` accepts exactly one PID — Android's logcat parses it
/// into a single `g_pid` variable that a repeated `--pid` flag simply
/// overwrites, it does not union multiple PIDs. So for a multi-process
/// package we deliberately filter on only the first PID `pidof` reported
/// (typically the main process) rather than passing multiple `--pid` flags,
/// which would silently filter on the last one only and drop the rest
/// without any indication why. `None` means "stream unfiltered" — used when
/// the package has no running process to filter by.
fn resolve_pid_filter(pids: &[u32]) -> Option<u32> {
    pids.first().copied()
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/// Start streaming logcat from a connected ADB device.
///
/// Creates a new session and spawns the capture task on `ctx.spawner()`.
/// Returns immediately with an empty-session [`LoadResult`]; lines arrive on
/// `sink`. Journals `stream.start`.
pub async fn start(
    ctx: ServiceCtx,
    req: StartStreamRequest,
    sink: Arc<dyn Sink<AdbStreamEvent>>,
) -> Result<LoadResult, ServiceError> {
    start_with_source(ctx, req, sink, Arc::new(AdbLineSource)).await
}

/// [`start`] with an injectable line producer. The seam tests use; production
/// callers want [`start`].
pub async fn start_with_source(
    ctx: ServiceCtx,
    req: StartStreamRequest,
    sink: Arc<dyn Sink<AdbStreamEvent>>,
    source: Arc<dyn LineSourceFactory>,
) -> Result<LoadResult, ServiceError> {
    // ── Resolve device ────────────────────────────────────────────────────────
    let serial = match req.device_id {
        Some(id) => id,
        None => {
            let found = devices(&ctx).await?;
            match found.len() {
                0 => {
                    return Err(ServiceError::invalid_arg(
                        "No ADB devices connected. Connect a device and enable USB debugging.",
                    ))
                }
                1 => found.into_iter().next().unwrap().serial,
                _ => {
                    return Err(ServiceError::invalid_arg(
                        "Multiple ADB devices connected. Specify a device_id.",
                    ))
                }
            }
        }
    };

    // ── Create session ────────────────────────────────────────────────────────
    // Deterministic per (sanitized serial, start epoch). Streams are excluded
    // from .ltw saves, so cross-restart stability is moot; the epoch suffix keeps
    // a stop/start cycle from aliasing the previous run's pipeline results.
    // See core::session_identity (design §Q5).
    let start_epoch_ms = crate::workspace::now_ms() as u128;
    let session_id = crate::core::session_identity::derive_adb_session_id(&serial, start_epoch_ms);
    let source_id = format!("adb-{}", serial.replace(':', "-"));
    let device_label = format!("ADB: {serial}");

    let temp_dir = ctx
        .paths()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());

    let mut session = AnalysisSession::new(session_id.clone());
    session.add_stream_source(source_id.clone(), device_label.clone(), temp_dir);

    {
        let mut sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        sessions.insert(session_id.clone(), session);
    }

    // Seed the streaming epoch guard for this session before any batch can run,
    // so every `flush_batch` re-insert has a concrete `Some(_)` to compare against.
    // See `AppState::stream_epochs`.
    ctx.state().seed_stream_epoch(&session_id);

    // ── Resolve the effective processor chain ─────────────────────────────────
    let chain = resolve_stream_chain(&ctx, &session_id, req.processor_ids.as_deref())?;

    // ── Initialize continuous processor states ────────────────────────────────
    seed_continuous_state(&ctx, &session_id, &chain, 0)?;

    // ── Cancellation channel ──────────────────────────────────────────────────
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut tasks = lock_svc(&ctx.state().stream_tasks, "stream_tasks")?;
        tasks.insert(session_id.clone(), cancel_tx);
    }

    // ── Spawn streaming task ──────────────────────────────────────────────────
    let args = StreamTaskArgs {
        cancel: cancel_rx,
        session_id: session_id.clone(),
        source_id: source_id.clone(),
        device_serial: serial,
        package_filter: req.package_filter,
        max_raw_lines: req.max_raw_lines.unwrap_or(DEFAULT_MAX_RAW_LINES) as usize,
    };
    let task_ctx = ctx.clone();
    ctx.spawner().spawn(Box::pin(async move {
        run_streaming_task(task_ctx, args, sink, source).await;
    }));

    ctx.journal(
        "stream.start",
        Some(&session_id),
        format!("{device_label} ({} processors)", chain.len()),
    );

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
        has_crlf: false, // ADB streams use LF
        encoding: "UTF-8".to_string(),
    })
}

/// Decide which processors run continuously over a new stream.
///
/// An explicit list goes through [`pipeline::resolve_effective_chain`] — the
/// single place bare ids become qualified ones and an unknown id becomes an
/// error instead of a silently-dropped processor.
///
/// An absent/empty list can NOT go through it: a stream session is created
/// milliseconds earlier and has no `session_pipeline_meta` entry yet, so
/// `resolve_effective_chain(None)` would reject every stream started without a
/// chain. The empty chain is today's behaviour (no continuous state seeded) —
/// but the PII gate still applies, exactly as `resolve_effective_chain` applies
/// it, so an agent's stream is anonymized in-chain whether or not it named
/// processors.
fn resolve_stream_chain(
    ctx: &ServiceCtx,
    session_id: &str,
    requested: Option<&[String]>,
) -> Result<Vec<String>, ServiceError> {
    match requested {
        Some(ids) if !ids.is_empty() => {
            pipeline::resolve_effective_chain(ctx, session_id, Some(ids))
        }
        _ => {
            let mut chain = Vec::new();
            if policy::should_anonymize(ctx, session_id) {
                chain.push(pipeline::PII_ANONYMIZER_ID.to_string());
            }
            Ok(chain)
        }
    }
}

/// Seed reporter / tracker / transformer continuous state for `chain`, each
/// starting at `from_line`.
fn seed_continuous_state(
    ctx: &ServiceCtx,
    session_id: &str,
    chain: &[String],
    from_line: usize,
) -> Result<(), ServiceError> {
    if chain.is_empty() {
        return Ok(());
    }
    let state = ctx.state();

    let mut proc_states: HashMap<String, ContinuousRunState> = HashMap::new();
    let mut tracker_states: HashMap<
        String,
        crate::processors::state_tracker::types::ContinuousTrackerState,
    > = HashMap::new();
    let mut transformer_states: HashMap<
        String,
        crate::processors::transformer::types::ContinuousTransformerState,
    > = HashMap::new();

    {
        let procs = lock_svc(&state.processors, "processors")?;
        for proc_id in chain {
            if let Some(any_proc) = procs.get(proc_id) {
                if let Some(def) = any_proc.as_reporter() {
                    let run = ProcessorRun::new(def);
                    proc_states.insert(proc_id.clone(), run.into_continuous_state(from_line, false));
                } else if let Some(def) = any_proc.as_state_tracker() {
                    let current_state = build_defaults(def);
                    tracker_states.insert(
                        proc_id.clone(),
                        crate::processors::state_tracker::types::ContinuousTrackerState {
                            current_state,
                            transitions: Vec::new(),
                            last_processed_line: from_line,
                        },
                    );
                } else if any_proc.as_transformer().is_some() {
                    transformer_states.insert(
                        proc_id.clone(),
                        crate::processors::transformer::types::ContinuousTransformerState {
                            last_processed_line: from_line,
                            pii_mappings: None,
                        },
                    );
                }
            }
        }
    }

    if !proc_states.is_empty() {
        lock_svc(&state.stream_processor_state, "stream_processor_state")?
            .insert(session_id.to_string(), proc_states);
    }
    if !tracker_states.is_empty() {
        lock_svc(&state.stream_tracker_state, "stream_tracker_state")?
            .insert(session_id.to_string(), tracker_states);
    }
    if !transformer_states.is_empty() {
        lock_svc(&state.stream_transformer_state, "stream_transformer_state")?
            .insert(session_id.to_string(), transformer_states);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

/// Stop an active ADB stream. The session remains in `AppState` as a static log.
///
/// Emits `adb-stream-stopped` as a broadcast, which is the fallback for the
/// case where the capture task already exited (its own `StreamStopped` went
/// down a channel nobody is reading any more). Emitting it from the service
/// rather than only from the Tauri command means an agent-initiated stop also
/// lights up the desktop — the same widening WP-5 made for `watch-update`.
///
/// Journals `stream.stop`.
pub fn stop(ctx: &ServiceCtx, session_id: &str) -> Result<(), ServiceError> {
    let state = ctx.state();

    // Send cancellation signal
    let sender = {
        let mut tasks = lock_svc(&state.stream_tasks, "stream_tasks")?;
        tasks.remove(session_id)
    };

    if let Some(tx) = sender {
        let _ = tx.send(());
    }

    ctx.events().emit_json(
        "adb-stream-stopped",
        serde_json::to_value(AdbStreamStopped {
            session_id: session_id.to_string(),
            reason: "user".to_string(),
        })
        .unwrap_or_default(),
    );

    // Clean up all continuous stream state that an in-flight `flush_batch` could
    // re-insert into, plus the accumulated streaming pipeline results, and drop
    // the epoch — all atomically under the epoch lock so a batch that is mid-flight
    // cannot resurrect any of it after the stream has stopped. Session data
    // remains in `sessions` for search/pipeline. See `AppState::stream_epochs`.
    //
    // The closure signature is fixed to `Result<(), String>` by `commands/mod.rs`,
    // so `lock_or_err` stays inside it and the whole call is mapped at the boundary.
    state
        .clear_stream_epoch_with(session_id, || {
            lock_or_err(&state.stream_processor_state, "stream_processor_state")?
                .remove(session_id);
            lock_or_err(&state.stream_anonymizers, "stream_anonymizers")?.remove(session_id);
            lock_or_err(&state.stream_transformer_state, "stream_transformer_state")?
                .remove(session_id);
            lock_or_err(&state.stream_tracker_state, "stream_tracker_state")?.remove(session_id);
            if let Ok(mut pr) = state.pipeline_results.lock() {
                pr.remove(session_id);
            }
            Ok(())
        })
        .map_err(ServiceError::Internal)?;

    // Clean up state tracker results from streaming. `flush_batch` never writes
    // this map in streaming mode, so it needs no epoch guard.
    if let Ok(mut str_results) = state.state_tracker_results.lock() {
        str_results.remove(session_id);
    }

    ctx.journal("stream.stop", Some(session_id), "stream stopped");

    Ok(())
}

// ---------------------------------------------------------------------------
// set_anonymize
// ---------------------------------------------------------------------------

/// Enable or disable PII anonymization for a live ADB stream.
///
/// When enabled, a `LogAnonymizer` is created from the current config and
/// applied to every incoming line in [`flush_batch`] before display and
/// processing. The same anonymizer instance persists across batches so token
/// numbering is consistent (e.g. `user@corp.com` always maps to `<EMAIL-1>`).
pub fn set_anonymize(
    ctx: &ServiceCtx,
    session_id: &str,
    enabled: bool,
) -> Result<(), ServiceError> {
    let state = ctx.state();

    // Snapshot the config outside the epoch section (leaf lock, avoids nesting an
    // unrelated lock under `stream_epochs`).
    let config = if enabled {
        Some(lock_svc(&state.anonymizer_config, "anonymizer_config")?.clone())
    } else {
        None
    };

    // Enable/disable the anonymizer and bump the epoch atomically, so an in-flight
    // `flush_batch` cannot re-insert the extracted anonymizer after we disabled it
    // (nor keep an old instance after we replaced it). See `AppState::stream_epochs`.
    state
        .bump_stream_epoch_with(session_id, || {
            let mut sa = lock_or_err(&state.stream_anonymizers, "stream_anonymizers")?;
            match config {
                Some(cfg) => {
                    sa.insert(session_id.to_string(), LogAnonymizer::from_config(&cfg));
                }
                None => {
                    sa.remove(session_id);
                }
            }
            Ok(())
        })
        .map_err(ServiceError::Internal)
}

// ---------------------------------------------------------------------------
// update_processors / update_trackers / update_transformers
// ---------------------------------------------------------------------------

/// Current `total_lines` for a stream session, so newly-added processors are
/// seeded from the right position.
fn current_total(state: &AppState, session_id: &str) -> Result<usize, ServiceError> {
    let sessions = lock_svc(&state.sessions, "sessions")?;
    Ok(sessions
        .get(session_id)
        .and_then(AnalysisSession::primary_source)
        .map_or(0, LogSource::total_lines))
}

/// Update the set of active reporter processors for a running ADB stream.
/// Called whenever the user toggles processors during streaming. New
/// processors start fresh at the current stream position; removed processors
/// have their state dropped.
pub fn update_processors(
    ctx: &ServiceCtx,
    session_id: &str,
    processor_ids: &[String],
) -> Result<(), ServiceError> {
    let state = ctx.state();
    let total = current_total(state, session_id)?;

    // Clone the Arc pointers for any new processors (O(1) per def).
    let new_proc_defs: HashMap<String, Arc<ReporterDef>> = {
        let procs = lock_svc(&state.processors, "processors")?;
        processor_ids
            .iter()
            .filter_map(|id| {
                procs
                    .get(id)
                    .and_then(crate::processors::AnyProcessor::as_reporter_arc)
                    .map(|arc| (id.clone(), arc))
            })
            .collect()
    };

    // Replace the active reporter set and bump the epoch atomically, so a batch
    // in flight cannot re-insert the state of a processor we just removed (nor
    // clobber the freshly-seeded set). See `AppState::stream_epochs`.
    state
        .bump_stream_epoch_with(session_id, || {
            let mut sp_state =
                lock_or_err(&state.stream_processor_state, "stream_processor_state")?;

            let inner = sp_state.entry(session_id.to_string()).or_default();

            // Remove processors no longer in the requested set.
            inner.retain(|id, _| processor_ids.contains(id));

            // Add new processors (those not already tracked) with fresh state.
            for proc_id in processor_ids {
                if !inner.contains_key(proc_id.as_str()) {
                    if let Some(def) = new_proc_defs.get(proc_id) {
                        let run = ProcessorRun::new(def);
                        inner.insert(proc_id.clone(), run.into_continuous_state(total, false));
                    }
                }
            }
            Ok(())
        })
        .map_err(ServiceError::Internal)
}

/// Update the set of active StateTracker processors for a running ADB stream.
/// New trackers start fresh; removed trackers have their state dropped.
pub fn update_trackers(
    ctx: &ServiceCtx,
    session_id: &str,
    tracker_ids: &[String],
) -> Result<(), ServiceError> {
    let state = ctx.state();
    let total = current_total(state, session_id)?;

    let tracker_defs: HashMap<
        String,
        Arc<crate::processors::state_tracker::schema::StateTrackerDef>,
    > = {
        let procs = lock_svc(&state.processors, "processors")?;
        tracker_ids
            .iter()
            .filter_map(|id| {
                procs
                    .get(id)
                    .and_then(crate::processors::AnyProcessor::as_state_tracker_arc)
                    .map(|arc| (id.clone(), arc))
            })
            .collect()
    };

    // Replace the active tracker set and bump the epoch atomically. This is
    // race (d): without the bump, an in-flight batch that cloned the pre-update
    // tracker set could re-insert it and clobber this update. See
    // `AppState::stream_epochs`.
    state
        .bump_stream_epoch_with(session_id, || {
            let mut st = lock_or_err(&state.stream_tracker_state, "stream_tracker_state")?;
            let inner = st.entry(session_id.to_string()).or_default();
            inner.retain(|id, _| tracker_ids.contains(id));
            for t_id in tracker_ids {
                if !inner.contains_key(t_id.as_str()) {
                    if let Some(def) = tracker_defs.get(t_id) {
                        let current_state = build_defaults(def);
                        inner.insert(
                            t_id.clone(),
                            crate::processors::state_tracker::types::ContinuousTrackerState {
                                current_state,
                                transitions: Vec::new(),
                                last_processed_line: total,
                            },
                        );
                    }
                }
            }
            Ok(())
        })
        .map_err(ServiceError::Internal)
}

/// Update the set of active Transformer processors for a running ADB stream.
pub fn update_transformers(
    ctx: &ServiceCtx,
    session_id: &str,
    transformer_ids: &[String],
) -> Result<(), ServiceError> {
    let state = ctx.state();
    let total = current_total(state, session_id)?;

    // Replace the active transformer set and bump the epoch atomically, so a
    // batch in flight cannot re-insert the state of a transformer we just removed.
    // See `AppState::stream_epochs`.
    state
        .bump_stream_epoch_with(session_id, || {
            let mut st =
                lock_or_err(&state.stream_transformer_state, "stream_transformer_state")?;
            let inner = st.entry(session_id.to_string()).or_default();
            inner.retain(|id, _| transformer_ids.contains(id));
            for t_id in transformer_ids {
                if !inner.contains_key(t_id.as_str()) {
                    inner.insert(
                        t_id.clone(),
                        crate::processors::transformer::types::ContinuousTransformerState {
                            last_processed_line: total,
                            pii_mappings: None,
                        },
                    );
                }
            }
            Ok(())
        })
        .map_err(ServiceError::Internal)
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/// Snapshot of a stream session: retention counters, the active continuous
/// chain, and the agent ring cursor. Read-only, never journaled.
pub fn status(ctx: &ServiceCtx, session_id: &str) -> Result<StreamStatus, ServiceError> {
    let state = ctx.state();

    let (source_name, total_lines, byte_count, first_timestamp, last_timestamp, lost_line_count) = {
        let sessions = lock_svc(&state.sessions, "sessions")?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| ServiceError::session_not_found(session_id))?;
        let stream = session.stream_source().ok_or_else(|| {
            ServiceError::invalid_arg("Session is not a streaming source")
        })?;
        (
            stream.name().to_string(),
            stream.total_lines(),
            stream.stream_byte_count(),
            stream.cached_first_ts(),
            stream
                .line_meta_slice()
                .iter()
                .rev()
                .find(|m| m.timestamp > 0)
                .map(|m| m.timestamp),
            stream.lost_line_count(),
        )
    };

    let streaming = lock_svc(&state.stream_tasks, "stream_tasks")?.contains_key(session_id);
    let anonymize =
        lock_svc(&state.stream_anonymizers, "stream_anonymizers")?.contains_key(session_id);
    let processor_ids = sorted_ids(
        lock_svc(&state.stream_processor_state, "stream_processor_state")?
            .get(session_id)
            .map(|m| m.keys().cloned().collect()),
    );
    let tracker_ids = sorted_ids(
        lock_svc(&state.stream_tracker_state, "stream_tracker_state")?
            .get(session_id)
            .map(|m| m.keys().cloned().collect()),
    );
    let transformer_ids = sorted_ids(
        lock_svc(&state.stream_transformer_state, "stream_transformer_state")?
            .get(session_id)
            .map(|m| m.keys().cloned().collect()),
    );
    let latest_event_seq = lock_svc(&state.stream_rings, "stream_rings")?
        .get(session_id)
        .map(|r| r.latest_seq());

    Ok(StreamStatus {
        session_id: session_id.to_string(),
        source_name,
        streaming,
        total_lines,
        byte_count,
        first_timestamp,
        last_timestamp,
        lost_line_count,
        anonymize,
        processor_ids,
        tracker_ids,
        transformer_ids,
        latest_event_seq,
    })
}

/// `HashMap` key order is arbitrary; sort so `status` is stable between calls.
fn sorted_ids(ids: Option<Vec<String>>) -> Vec<String> {
    let mut out = ids.unwrap_or_default();
    out.sort();
    out
}

// ---------------------------------------------------------------------------
// Agent event ring
// ---------------------------------------------------------------------------

/// A fresh agent event ring, sized to [`AGENT_RING_CAPACITY`].
///
/// The bridge builds one *before* calling [`start`] — it is the sink the
/// capture task writes to, so nothing can be produced between start and
/// [`register_ring`] and then lost.
pub fn new_ring() -> Arc<RingSink<AdbStreamEvent>> {
    Arc::new(RingSink::new(AGENT_RING_CAPACITY))
}

/// Register this session's agent event ring so [`events`] can drain it.
///
/// Called by the bridge when an agent starts a stream; a UI-started stream has
/// no ring at all. Rings for sessions that no longer exist are pruned here, so
/// the map stays bounded without needing a hook in session close.
pub fn register_ring(
    ctx: &ServiceCtx,
    session_id: &str,
    ring: Arc<RingSink<AdbStreamEvent>>,
) -> Result<(), ServiceError> {
    let live: Vec<String> = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        sessions.keys().cloned().collect()
    };
    let mut rings = lock_svc(&ctx.state().stream_rings, "stream_rings")?;
    rings.retain(|id, _| live.iter().any(|s| s == id));
    rings.insert(session_id.to_string(), ring);
    Ok(())
}

/// Drain everything newer than `since` from this session's agent event ring.
///
/// Line text goes through [`policy::redact_line`] — fail-closed for an agent
/// against a session whose `mcp_anonymize` flag was never signalled. The ring
/// itself holds whatever the capture produced (the in-chain `__pii_anonymizer`
/// is the other, earlier, redaction point); this is the gate on the read path.
///
/// `gap` is true when the caller's cursor is older than the oldest retained
/// item — it fell behind by more than [`AGENT_RING_CAPACITY`] events and the
/// missing ones are gone for good.
pub fn events(
    ctx: &ServiceCtx,
    session_id: &str,
    since: u64,
    limit: usize,
) -> Result<StreamEventsPage, ServiceError> {
    let ring = {
        let rings = lock_svc(&ctx.state().stream_rings, "stream_rings")?;
        rings.get(session_id).map(Arc::clone)
    };
    let Some(ring) = ring else {
        return Err(ServiceError::NotFound(format!(
            "No event stream registered for session '{session_id}'"
        )));
    };

    let latest_seq = ring.latest_seq();
    let mut drained = ring.drain_since(since);
    // A gap means eviction dropped items between the caller's cursor and the
    // oldest item still retained.
    let gap = drained.first().is_some_and(|e| e.seq > since + 1);
    drained.truncate(limit);

    let next_since = drained.last().map_or(since, |e| e.seq);
    let events = drained
        .into_iter()
        .map(|item| SeqItem {
            seq: item.seq,
            item: redact_event(ctx, session_id, item.item),
        })
        .collect();

    Ok(StreamEventsPage {
        session_id: session_id.to_string(),
        events,
        latest_seq,
        next_since,
        gap,
    })
}

/// Apply [`policy::redact_line`] to every line text carried by an event.
/// Non-`Batch` variants carry no raw text and pass through untouched.
fn redact_event(ctx: &ServiceCtx, session_id: &str, ev: AdbStreamEvent) -> AdbStreamEvent {
    match ev {
        AdbStreamEvent::Batch(mut batch) => {
            for line in &mut batch.lines {
                line.raw = policy::redact_line(ctx, session_id, &line.raw, STREAM_LINE_CHARS);
                line.message =
                    policy::redact_line(ctx, session_id, &line.message, STREAM_LINE_CHARS);
            }
            AdbStreamEvent::Batch(batch)
        }
        other => other,
    }
}

// ---------------------------------------------------------------------------
// save_live_capture
// ---------------------------------------------------------------------------

/// Write all retained raw lines from a live stream session to a file.
/// Returns the number of lines written. Journals `stream.save`.
pub fn save_live_capture(
    ctx: &ServiceCtx,
    session_id: &str,
    output_path: &str,
) -> Result<u32, ServiceError> {
    use std::io::Write;

    let dest = authorize_save_dest(ctx, output_path)?;

    let count = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| ServiceError::NotFound(format!("Session not found: {session_id}")))?;

        let source = session.stream_source().ok_or_else(|| {
            ServiceError::invalid_arg("Session is not a streaming source")
        })?;

        let file = std::fs::File::create(&dest)
            .map_err(|e| ServiceError::Internal(format!("Failed to create file: {e}")))?;
        let mut writer = std::io::BufWriter::new(file);

        let count = source.write_stream_lines(&mut writer).map_err(ServiceError::Internal)?;
        writer
            .flush()
            .map_err(|e| ServiceError::Internal(format!("Flush error: {e}")))?;
        count
    };

    ctx.journal(
        "stream.save",
        Some(session_id),
        format!("{count} lines -> {}", dest.display()),
    );

    Ok(count)
}

/// Destination gate for [`save_live_capture`].
///
/// `Ui` passes through (the native save dialog is the consent step). `Agent`
/// gets the same raw-form hygiene `bridge_access::validate_open_path` applies,
/// then containment of the destination's **parent directory** against the MCP
/// open allowlist — the file itself does not exist yet, so the parent is what
/// can be canonicalized. A parent that is missing and a parent that is outside
/// the allowlist collapse into the identical refusal, same anti-probing
/// rationale as [`policy::authorize_open`].
fn authorize_save_dest(ctx: &ServiceCtx, dest: &str) -> Result<std::path::PathBuf, ServiceError> {
    use crate::commands::bridge_access::canonical_compare_form;
    use std::path::{Component, Path, Prefix};

    let path = Path::new(dest);

    if matches!(ctx.caller(), Caller::Ui) {
        return Ok(crate::simplified_path(path));
    }

    // Raw-form hygiene — pure string checks, no filesystem access.
    if !path.is_absolute() {
        return Err(ServiceError::InvalidArg {
            code: super::error::INVALID_PATH,
            message: "path must be absolute".to_string(),
        });
    }
    match path.components().next() {
        Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)) => {}
        _ => {
            return Err(ServiceError::InvalidArg {
                code: super::error::INVALID_PATH,
                message: "only local drive paths (C:\\...) are allowed; UNC (\\\\server\\share), verbatim (\\\\?\\...), and device (\\\\.\\...) paths are not".to_string(),
            });
        }
    }
    if dest.match_indices(':').any(|(i, _)| i > 1) {
        return Err(ServiceError::InvalidArg {
            code: super::error::INVALID_PATH,
            message: "alternate data stream paths are not allowed".to_string(),
        });
    }

    let (allowed, allow_all): (Vec<String>, bool) = {
        let cfg = ctx
            .state()
            .mcp_open_allowlist
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (cfg.allowed_dirs.clone(), cfg.allow_all)
    };

    let denied = || ServiceError::not_allowed("path is not allowed");

    let parent = path.parent().ok_or_else(denied)?;
    let parent_form = canonical_compare_form(parent).ok_or_else(denied)?;

    if allow_all {
        return Ok(path.to_path_buf());
    }
    for dir in &allowed {
        let Some(dir_form) = canonical_compare_form(Path::new(dir)) else {
            continue;
        };
        if Path::new(&parent_form).starts_with(Path::new(&dir_form)) {
            return Ok(path.to_path_buf());
        }
    }
    Err(denied())
}

// ---------------------------------------------------------------------------
// Background streaming task
// ---------------------------------------------------------------------------

/// Remove this session's cancel-sender entry from `AppState::stream_tasks`.
/// Idempotent — safe to call even if [`stop`] already removed the entry (the
/// normal user-initiated-stop path).
fn remove_stream_task(state: &AppState, session_id: &str) {
    if let Ok(mut tasks) = state.stream_tasks.lock() {
        tasks.remove(session_id);
    }
}

/// RAII guard that removes this session's `stream_tasks` entry when
/// [`run_streaming_task`] exits, on every exit path — spawn failure,
/// EOF/device disconnect, and the explicit cancellation branch — not just the
/// [`stop`] path.
///
/// Without this, a task that ended on its own (adb crash, device unplugged,
/// EOF) left a stale cancel-sender in the map forever.
struct StreamTaskGuard {
    state: Arc<AppState>,
    session_id: String,
}

impl Drop for StreamTaskGuard {
    fn drop(&mut self) {
        remove_stream_task(&self.state, &self.session_id);
    }
}

/// Everything the capture task needs beyond its context, sink and line source.
pub struct StreamTaskArgs {
    pub cancel: tokio::sync::oneshot::Receiver<()>,
    pub session_id: String,
    pub source_id: String,
    pub device_serial: String,
    pub package_filter: Option<String>,
    pub max_raw_lines: usize,
}

/// The capture loop: open the line source, batch on 100 lines / 50 ms, flush
/// each batch through the pipeline, and report EOF or cancellation as a
/// `StreamStopped` event.
pub async fn run_streaming_task(
    ctx: ServiceCtx,
    args: StreamTaskArgs,
    sink: Arc<dyn Sink<AdbStreamEvent>>,
    source: Arc<dyn LineSourceFactory>,
) {
    let StreamTaskArgs {
        mut cancel,
        session_id,
        source_id,
        device_serial,
        package_filter,
        max_raw_lines,
    } = args;

    // Ensures the `stream_tasks` cancel-sender entry for this session is
    // removed no matter how this function returns below.
    let _stream_task_guard = StreamTaskGuard {
        state: ctx.state_arc(),
        session_id: session_id.clone(),
    };

    // If a package filter was specified, resolve it to a numeric PID via
    // `pidof` and filter by that. `adb logcat --pid` requires a numeric PID,
    // not a package name — passing the package name directly means adb either
    // rejects the flag outright or silently streams everything unfiltered.
    let mut pid_filter = None;
    if let Some(ref pkg) = package_filter {
        match package_pids(&ctx, &device_serial, pkg).await {
            Ok(pids) => match resolve_pid_filter(&pids) {
                Some(pid) => {
                    if pids.len() > 1 {
                        eprintln!(
                            "[adb] package '{pkg}' has {} running PIDs on {device_serial}; \
                             filtering by PID {pid} only (adb logcat --pid accepts a single PID)",
                            pids.len()
                        );
                    }
                    pid_filter = Some(pid);
                }
                None => {
                    // Package has no running process (not launched yet, or
                    // crashed before the stream connected). `--pid` isn't
                    // dynamic — we can't "wait and retry" without restarting
                    // the whole logcat process — so the least-surprising
                    // choice is to fall back to an unfiltered stream (with a
                    // warning) rather than erroring out the whole session or
                    // silently showing nothing forever.
                    eprintln!(
                        "[adb] package '{pkg}' has no running PID on {device_serial}; \
                         streaming unfiltered"
                    );
                }
            },
            Err(e) => {
                // Resolving PIDs itself failed (adb not on PATH, device
                // disconnected mid-resolve, etc). Fall back to unfiltered
                // rather than aborting the stream over a filter convenience
                // feature.
                eprintln!(
                    "[adb] failed to resolve PIDs for package '{pkg}': {}; streaming unfiltered",
                    e.message()
                );
            }
        }
    }

    let LineStream {
        lines: line_rx,
        handle: mut producer,
    } = match source.open(&device_serial, pid_filter) {
        Ok(s) => s,
        Err(e) => {
            sink.send(AdbStreamEvent::StreamStopped(AdbStreamStopped {
                session_id: session_id.clone(),
                reason: e,
            }));
            return;
        }
    };

    // chunks_timeout handles both the 100-line count trigger and the 50ms time
    // trigger — no manual ticker or Vec buffer required.
    // tokio::pin! is required because ChunksTimeout is not Unpin and select! needs
    // to poll the future across loop iterations.
    let batched = ReceiverStream::new(line_rx).chunks_timeout(100, Duration::from_millis(50));
    tokio::pin!(batched);

    loop {
        tokio::select! {
            batch = batched.next() => {
                match batch {
                    Some(lines) => {
                        // KNOWN TRADE-OFF (deliberate deferral, not overlooked): `flush_batch`
                        // runs parsing, regex matching, and the rayon Layer 2 fan-out
                        // synchronously, inline, right here in the select! loop — it briefly
                        // blocks this task's tokio worker thread per batch. Moving that work
                        // into `spawn_blocking` was considered and rejected: `ChunksTimeout`
                        // is not `Unpin` (hence the `tokio::pin!` above) and this is the
                        // streaming hot path the whole cancellation-safety structure above
                        // (dedicated reader task + channel) is built around. The 50ms/100-line
                        // batch cap bounds how long any single blocking call can run.
                        flush_batch(lines, &session_id, &source_id, &ctx, max_raw_lines, &*sink);
                    }
                    None => {
                        // Reader task ended (EOF or device disconnect); chunks_timeout
                        // flushed any partial batch before yielding None.
                        sink.send(AdbStreamEvent::StreamStopped(AdbStreamStopped {
                            session_id: session_id.clone(),
                            reason: "eof".to_string(),
                        }));
                        break;
                    }
                }
            }
            _ = &mut cancel => {
                producer.kill();
                sink.send(AdbStreamEvent::StreamStopped(AdbStreamStopped {
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

/// One parsed line plus everything derived from it during [`flush_batch`].
/// `ctx` is the cached `LineContext` reused by trackers/reporters — it must
/// reflect any transformer mutations (see [`apply_line_transformers`]), not
/// just the parser's original output, or Layer 2 sees stale tag/fields.
struct ParsedLine {
    raw: String,
    meta: ParsedLineMeta,
    view_line: ViewLine,
    ctx: Option<LineContext>, // cached for downstream reuse (trackers, reporters)
    /// Snapshot of `ctx.message` from the initial parse, before PII
    /// anonymization or transformers run. `ctx.message` itself gets
    /// overwritten in place as those steps execute, so trackers — which need
    /// the untouched original for capture regexes (`pre_transform_msgs`) —
    /// read this field instead of `ctx.message`.
    original_message: Option<Arc<str>>,
}

/// Run the active transformer chain over each parsed line's cached
/// `LineContext` and persist the transformed context back onto `pl.ctx`.
///
/// Reassigning `pl.ctx = Some(ctx)` is load-bearing: the Layer 2 batch
/// (`batch_ctxs` in [`flush_batch`]) is built from `pl.ctx`, so a transformer
/// mutation to `tag` (`ReplaceField{field:"tag"}`) or to `fields`
/// (`SetField`/`DropField`/`AddField`/`ReplaceField`) only reaches
/// trackers/reporters — and only persists across batches — because of it.
///
/// Returns the (possibly updated) `pii_modified` flag: set when a transformer
/// changes the message, so downstream PII-aware steps treat the line as
/// modified.
fn apply_line_transformers(
    parsed: &mut [ParsedLine],
    transformer_runs: &mut [(String, crate::processors::transformer::engine::TransformerRun)],
    mut pii_modified: bool,
) -> bool {
    for pl in parsed.iter_mut() {
        let mut ctx = match pl.ctx {
            Some(ref c) if pii_modified => {
                // PII modified the message — patch the clone
                let mut tc = c.clone();
                tc.message = Arc::from(pl.view_line.message.as_str());
                tc.raw = Arc::from(pl.view_line.raw.as_str());
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
            // Persist the full transformed context (tag + fields + message/raw)
            // so the Layer 2 batch_ctxs assembly downstream picks up transformer
            // mutations instead of re-cloning the pre-transform ctx.
            pl.ctx = Some(ctx);
        }
        // Note: we don't drop lines in streaming mode — transformers
        // only modify content, dropping would break the view stream.
    }
    pii_modified
}

fn flush_batch(
    lines: Vec<String>,
    session_id: &str,
    source_id: &str,
    svc: &ServiceCtx,
    max_raw_lines: usize,
    sink: &dyn Sink<AdbStreamEvent>,
) {
    if lines.is_empty() {
        return;
    }

    let state: &AppState = svc.state();
    let parser = LogcatParser;

    // Capture the streaming epoch for this session BEFORE extracting any state.
    // Every re-insert below is gated on this value: if a concurrent writer
    // (stop / set_anonymize / update_* / close_session) changes or drops the
    // epoch while this batch is processing, the corresponding re-insert is
    // skipped and its now-stale state is dropped. See `AppState::stream_epochs`.
    let epoch0 = state.current_stream_epoch(session_id);

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
            .and_then(AnalysisSession::primary_source)
            .map_or(0, LogSource::total_lines)
    };

    let pipeline_ctx = PipelineContext {
        source_type: crate::core::session::SourceType::Logcat,
        source_name: Arc::from(source_id),
        is_streaming: true,
        sections: Arc::from([]),
    };

    // ── Step 2: Parse once — derive ParsedLineMeta, ViewLine, and LineContext
    //    from a single parse_line call (eliminates redundant parse_meta) ────────
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
            let original_message = Some(Arc::clone(&ctx.message));
            parsed.push(ParsedLine { raw, meta, view_line, ctx: Some(ctx), original_message });
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
            parsed.push(ParsedLine { raw, meta, view_line, ctx: None, original_message: None });
        }
    }

    if parsed.is_empty() {
        return;
    }

    // ── Step 2b: Apply PII anonymization to ViewLines (if enabled) ────────────
    // Extract the anonymizer for this session (extract-use-reinsert; unlike the
    // reporter/transformer/tracker snapshots this is a move, not a clone —
    // token maps grow with the capture, and no writer merges into the entry
    // mid-batch, so cloning per batch would cost without protecting anything).
    // Using the same instance across batches keeps token numbering stable: the
    // same raw value always maps to the same token.
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
    // Transformers in streaming mode modify content but do NOT drop lines —
    // dropping would desync the ViewLine stream. The transformer runs are
    // managed through the same extract-process-reinsert pattern.
    {
        let transformer_ids: Vec<String> = match state.stream_transformer_state.lock() {
            Ok(st) => st
                .get(session_id)
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };

        if !transformer_ids.is_empty() {
            let transformer_defs: Vec<(
                String,
                Arc<crate::processors::transformer::schema::TransformerDef>,
            )> = {
                match state.processors.lock() {
                    // Same declared-source_types exclusion the Layer 2 processors
                    // get below, and the same reason file mode applies it to
                    // transformers: one that does not understand this source
                    // rewrites the lines every downstream processor then reads.
                    // An ADB stream is always Logcat.
                    Ok(procs) => transformer_ids
                        .iter()
                        .filter(|id| {
                            procs.get(id.as_str()).map_or(true, |p| {
                                let declared = p
                                    .schema
                                    .as_ref()
                                    .map_or(&[][..], |s| s.source_types.as_slice());
                                !excluded_by_declared_source_types(
                                    declared,
                                    &crate::core::session::SourceType::Logcat,
                                )
                            })
                        })
                        .filter_map(|id| {
                            procs
                                .get(id.as_str())
                                .and_then(crate::processors::AnyProcessor::as_transformer_arc)
                                .map(|arc| (id.clone(), arc))
                        })
                        .collect(),
                    Err(e) => {
                        eprintln!("[adb flush_batch] processors lock poisoned (transformers): {e}");
                        Vec::new()
                    }
                }
            };

            if !transformer_defs.is_empty() {
                // Snapshot ALL transformer states in one lock. Clone (not
                // remove) — same as the reporter/tracker snapshots below — so
                // the map keeps the last-committed state while this batch is
                // in flight: a mid-batch `update_transformers` operates on real
                // state rather than a hole, and nothing is lost when the epoch
                // guard drops this batch's re-insert.
                let mut transformer_states: HashMap<
                    String,
                    crate::processors::transformer::types::ContinuousTransformerState,
                > = match state.stream_transformer_state.lock() {
                    Ok(st) => {
                        if let Some(inner) = st.get(session_id) {
                            transformer_ids
                                .iter()
                                .filter_map(|id| inner.get(id).cloned().map(|s| (id.clone(), s)))
                                .collect()
                        } else {
                            HashMap::new()
                        }
                    }
                    Err(_) => HashMap::new(),
                };

                // Build transformer runs seeded with extracted state
                let mut transformer_runs: Vec<(
                    String,
                    crate::processors::transformer::engine::TransformerRun,
                )> = transformer_defs
                    .iter()
                    .map(|(t_id, def)| {
                        let cont = transformer_states.remove(t_id).unwrap_or_default();
                        let run =
                            crate::processors::transformer::engine::TransformerRun::new_seeded(
                                def.as_ref(),
                                cont,
                            );
                        (t_id.clone(), run)
                    })
                    .collect();

                // Apply transformers using cached LineContext (no re-parse needed).
                // Writes the transformed context back onto `pl.ctx` (not just
                // `pl.view_line`) so tag/field mutations reach Layer 2 and
                // persist across batches — see `apply_line_transformers`.
                pii_modified =
                    apply_line_transformers(&mut parsed, &mut transformer_runs, pii_modified);

                // Re-insert ALL transformer states in one lock, gated on the
                // epoch. This is race (c): the re-insert runs BEFORE the Step-3
                // session-exists check, so a `close_session` (or `stop`) between
                // extract and here would otherwise recreate transformer state
                // under a dead session id. The epoch guard (which those writers
                // drop/bump) skips the re-insert instead. `get_mut` (never
                // `or_default`) means a removed session is never recreated.
                let final_line = first_new_line + parsed.len();
                state.reinsert_stream_state_if_current(session_id, epoch0, || {
                    if let Ok(mut st) = state.stream_transformer_state.lock() {
                        if let Some(inner) = st.get_mut(session_id) {
                            for (t_id, run) in transformer_runs {
                                let new_cont = run.into_continuous_state(final_line);
                                inner.insert(t_id, new_cont);
                            }
                        }
                    }
                });
            }
        }
    }

    // ── Step 3: Append raw lines + meta to session, evict if over cap ─────────
    let (total_lines, byte_count, first_ts, last_ts, lost_line_count) = {
        let mut sessions = match state.sessions.lock() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("[adb flush_batch] sessions lock poisoned (step 3): {e}");
                return;
            }
        };
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };

        // Intern tags first (needs &mut session for tag_interner).
        let metas: Vec<LineMeta> = parsed
            .iter()
            .map(|pl| {
                let tag_id = session.intern_tag(&pl.meta.tag);
                LineMeta {
                    level: pl.meta.level,
                    tag_id,
                    timestamp: pl.meta.timestamp,
                    byte_offset: pl.meta.byte_offset,
                    byte_len: pl.meta.byte_len,
                    is_section_boundary: pl.meta.is_section_boundary,
                }
            })
            .collect();

        // Append to stream source.
        let Some(stream) = session.stream_source_mut() else {
            return;
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
        let last_ts = stream
            .line_meta_slice()
            .iter()
            .rev()
            .find(|m| m.timestamp > 0)
            .map(|m| m.timestamp);
        // Cumulative count of evicted lines that failed to spill (see evict()).
        let lost = stream.lost_line_count();

        (total, bc, first_ts, last_ts, lost)
    };

    // Collect ViewLines for the batch event
    let view_lines: Vec<ViewLine> = parsed.iter().map(|pl| pl.view_line.clone()).collect();

    // ── Step 3.5 + Step 4: Run trackers and reporters via PipelineCore ──────
    // Extract continuous state from AppState, build a PipelineCore, process
    // lines, then persist results and state back. This unifies the execution
    // path with file-mode pipeline processing.
    let mut proc_updates: Vec<AdbProcessorUpdate> = Vec::new();
    {
        // Collect active processor IDs from all state stores
        let tracker_ids: Vec<String> = state
            .stream_tracker_state
            .lock()
            .ok()
            .and_then(|st| st.get(session_id).map(|m| m.keys().cloned().collect()))
            .unwrap_or_default();

        let reporter_ids: Vec<String> = state
            .stream_processor_state
            .lock()
            .ok()
            .and_then(|sp| sp.get(session_id).map(|m| m.keys().cloned().collect()))
            .unwrap_or_default();

        // Only proceed if there are active processors
        if !tracker_ids.is_empty() || !reporter_ids.is_empty() {
            // Clone Arc pointers for processor defs (O(1) per def, brief lock)
            let partitioned = {
                match state.processors.lock() {
                    Ok(procs) => {
                        // An ADB stream is always Logcat (see `pipeline_ctx`
                        // above). Apply the same declared-source_types
                        // exclusion file mode uses, so a processor's
                        // eligibility does not depend on which path executes
                        // it. The streaming channel has no equivalent of the
                        // file-mode skip row yet, so an excluded processor
                        // simply stops producing updates rather than reporting
                        // why — it stays in the chain showing zero, which is
                        // what it did before this exclusion existed.
                        let stream_source_type = crate::core::session::SourceType::Logcat;
                        let eligible = |id: &str| -> bool {
                            // `map_or(true, ..)` rather than `is_none_or`: the
                            // latter is stable only from 1.82 and the crate's
                            // MSRV is lower.
                            procs.get(id).map_or(true, |p| {
                                let declared = p
                                    .schema
                                    .as_ref()
                                    .map_or(&[][..], |s| s.source_types.as_slice());
                                !excluded_by_declared_source_types(declared, &stream_source_type)
                            })
                        };
                        let reporter_defs: Vec<_> = reporter_ids
                            .iter()
                            .filter(|id| eligible(id.as_str()))
                            .filter_map(|id| {
                                procs
                                    .get(id.as_str())
                                    .and_then(crate::processors::AnyProcessor::as_reporter_arc)
                                    .map(|arc| (id.clone(), arc))
                            })
                            .collect();
                        let tracker_defs: Vec<_> = tracker_ids
                            .iter()
                            .filter(|id| eligible(id.as_str()))
                            .filter_map(|id| {
                                procs
                                    .get(id.as_str())
                                    .and_then(crate::processors::AnyProcessor::as_state_tracker_arc)
                                    .map(|arc| (id.clone(), arc))
                            })
                            .collect();
                        Some(PartitionedDefs {
                            transformer_defs: Vec::new(), // transformers already applied above
                            reporter_defs,
                            tracker_defs,
                            correlator_defs: Vec::new(), // TODO: add correlator streaming support
                        })
                    }
                    Err(e) => {
                        eprintln!("[adb flush_batch] processors lock poisoned: {e}");
                        None
                    }
                }
            };

            if let Some(partitioned) = partitioned {
                // Snapshot continuous states from AppState. Clone (not remove)
                // so the map keeps the last-committed state during processing:
                // a mid-batch `update_processors` operates on real accumulated
                // state rather than a hole, and nothing is lost when the epoch
                // guard drops this batch's re-insert. Cheap: streaming drains
                // emissions/matches between batches (drain=true).
                let reporter_states: HashMap<String, ContinuousRunState> = state
                    .stream_processor_state
                    .lock()
                    .ok()
                    .and_then(|sp| {
                        sp.get(session_id).map(|inner| {
                            reporter_ids
                                .iter()
                                .filter_map(|id| {
                                    inner.get(id.as_str()).cloned().map(|s| (id.clone(), s))
                                })
                                .collect()
                        })
                    })
                    .unwrap_or_default();

                // Clone (not remove) tracker states so concurrent reads via
                // getStateTransitions still see data during processing.
                // The processed states are re-inserted after execution.
                let tracker_states = state
                    .stream_tracker_state
                    .lock()
                    .ok()
                    .and_then(|st| {
                        st.get(session_id).map(|inner| {
                            tracker_ids
                                .iter()
                                .filter_map(|id| {
                                    inner.get(id.as_str()).cloned().map(|s| (id.clone(), s))
                                })
                                .collect()
                        })
                    })
                    .unwrap_or_default();

                let continuous = ContinuousStates {
                    reporter_states,
                    tracker_states,
                    transformer_states: HashMap::new(),
                    correlator_states: HashMap::new(),
                };

                // Build PipelineCore from continuous state
                let mut core =
                    PipelineCore::from_continuous_state(&partitioned, pipeline_ctx, continuous);

                // Build LineContext batch for the core to process.
                // Trackers see original (pre-PII) messages for capture regexes.
                // Reporters see post-PII/transform messages.
                // Since PipelineCore handles pre-transform message saving internally,
                // we prepare the reporter-ready contexts here.
                let batch_ctxs: Vec<Option<LineContext>> = if pii_modified {
                    parsed
                        .iter()
                        .map(|pl| {
                            pl.ctx.as_ref().map(|c| {
                                let mut rc = c.clone();
                                rc.message = Arc::from(pl.view_line.message.as_str());
                                rc.raw = Arc::from(pl.view_line.raw.as_str());
                                rc
                            })
                        })
                        .collect()
                } else {
                    parsed.iter().map(|pl| pl.ctx.clone()).collect()
                };

                // Run Layer 2 directly (transformers already handled above)
                let enriched: Vec<LineContext> = batch_ctxs.into_iter().flatten().collect();

                // For trackers: use original (pre-PII, pre-transform) messages.
                // Read from `pl.original_message` — a snapshot taken at parse
                // time in Step 2 — rather than `pl.ctx.message`: since the fix
                // for bug 443c0ad5, `pl.ctx` is reassigned to the transformed
                // context in `apply_line_transformers`, so `pl.ctx.message` no
                // longer holds the untouched original once a transformer ran.
                let pre_transform_msgs: HashMap<usize, Arc<str>> =
                    if pii_modified && !core.tracker_runs.is_empty() {
                        parsed
                            .iter()
                            .filter_map(|pl| {
                                let line_num = pl.ctx.as_ref()?.source_line_num;
                                let msg = pl.original_message.clone()?;
                                Some((line_num, msg))
                            })
                            .collect()
                    } else {
                        HashMap::new()
                    };

                core.run_layer2_parallel(&enriched, &pre_transform_msgs);

                // Snapshot results for event emission, then take the continuous
                // state (consumes `core`).
                let snapshot = core.current_results();
                let cont = core.into_continuous_state(total_lines);
                let reporter_results = snapshot.reporter_results;
                let reporter_states = cont.reporter_states;
                let tracker_states = cont.tracker_states;

                // Merge reporter results into pipeline_results (accumulate across
                // batches) and re-insert reporter continuous state — both gated on
                // the epoch so a concurrent stop/close/update cannot be resurrected
                // or clobbered by this in-flight batch. `proc_updates` is populated
                // inside the guard so no events fire for a state we didn't persist.
                if !reporter_results.is_empty() || !reporter_states.is_empty() {
                    let proc_updates = &mut proc_updates;
                    state.reinsert_stream_state_if_current(session_id, epoch0, || {
                        if !reporter_results.is_empty() {
                            if let Ok(mut pr) = state.pipeline_results.lock() {
                                let session_results =
                                    pr.entry(session_id.to_string()).or_default();
                                for (proc_id, batch_result) in reporter_results {
                                    let existing =
                                        session_results.entry(proc_id.clone()).or_default();
                                    existing.merge(batch_result);

                                    proc_updates.push(AdbProcessorUpdate {
                                        session_id: session_id.to_string(),
                                        processor_id: proc_id,
                                        matched_lines: existing.matched_line_nums.len(),
                                        emission_count: existing.emissions.len(),
                                    });
                                }
                            }
                        }
                        // `get_mut` (never `or_default`) so a removed session is
                        // never recreated here.
                        if !reporter_states.is_empty() {
                            if let Ok(mut sp) = state.stream_processor_state.lock() {
                                if let Some(inner) = sp.get_mut(session_id) {
                                    for (id, new_state) in reporter_states {
                                        inner.insert(id, new_state);
                                    }
                                }
                            }
                        }
                    });
                }

                // Re-insert tracker states (gated on the epoch — this is race (d):
                // a concurrent `update_trackers` bumps the epoch so its new set is
                // not clobbered by this batch's stale clone). Tracker events are
                // emitted only for the states actually persisted.
                if !tracker_states.is_empty() {
                    let mut event_data: Vec<(String, usize)> = Vec::new();
                    state.reinsert_stream_state_if_current(session_id, epoch0, || {
                        if let Ok(mut st) = state.stream_tracker_state.lock() {
                            if let Some(inner) = st.get_mut(session_id) {
                                for (t_id, new_cont) in tracker_states {
                                    event_data.push((t_id.clone(), new_cont.transitions.len()));
                                    inner.insert(t_id, new_cont);
                                }
                            }
                        }
                    });

                    // Unlike `adb-batch` / `adb-processor-update`, tracker updates
                    // are still delivered as an app-wide broadcast rather than down
                    // the per-consumer `Sink<AdbStreamEvent>` used elsewhere in this
                    // function. That's a deliberate, currently-unmigrated gap — not
                    // an oversight to "fix" in passing: tracker-update frequency is
                    // far lower than batch/processor updates, and the frontend
                    // listens for this event name directly, so switching the
                    // transport is a frontend-contract change that needs its own
                    // review.
                    for (t_id, transition_count) in event_data {
                        svc.events().emit_json(
                            "adb-tracker-update",
                            serde_json::to_value(AdbTrackerUpdate {
                                session_id: session_id.to_string(),
                                tracker_id: t_id,
                                transition_count,
                            })
                            .unwrap_or_default(),
                        );
                    }
                }
            }
        }
    }

    // ── Step 4b: Re-insert anonymizer and persist PII mappings ───────────────
    // Gated on the epoch. This is race (a): `set_anonymize(false)` (or a
    // stop/close) removes the anonymizer and bumps/drops the epoch; without the
    // guard, this batch would re-insert the extracted anonymizer and silently keep
    // PII anonymization ON. Key-presence alone can't detect it — the batch itself
    // removed the key during extraction — so the epoch check is required.
    if let Some(a) = anon {
        // Update the session's token→original map so the PII dashboard can show it.
        let forward = a.mappings.all_mappings();
        let inverted: HashMap<String, String> =
            forward.into_iter().map(|(raw, tok)| (tok, raw)).collect();
        state.reinsert_stream_state_if_current(session_id, epoch0, || {
            if let Ok(mut pm) = state.pii_mappings.lock() {
                pm.insert(session_id.to_string(), inverted);
            }
            // Re-insert for the next batch.
            if let Ok(mut sa) = state.stream_anonymizers.lock() {
                sa.insert(session_id.to_string(), a);
            }
        });
    }

    // ── Step 4c: Evaluate active watches on new lines ──────────────────────────
    let watch_refs: Vec<crate::commands::watch::WatchLineRef<'_>> = parsed
        .iter()
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
            svc.events().emit_json(
                "watch-match",
                serde_json::to_value(WatchMatchEvent {
                    watch_id: watch_id.clone(),
                    session_id: session_id.to_string(),
                    new_matches: *new_matches,
                    total_matches: *total_matches,
                })
                .unwrap_or_default(),
            );
        }
    }

    // ── Step 5: Send events down the caller's sink ────────────────────────────
    sink.send(AdbStreamEvent::Batch(AdbBatch {
        session_id: session_id.to_string(),
        lines: view_lines,
        total_lines,
        byte_count,
        first_timestamp: first_ts,
        last_timestamp: last_ts,
        lost_line_count,
    }));

    for update in proc_updates {
        sink.send(AdbStreamEvent::ProcessorUpdate(update));
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::{test_ctx, RecordingSink};
    use crate::services::Caller;

    // ── Fixtures ───────────────────────────────────────────────────────────

    const REPORTER_YAML: &str = r"
meta:
  id: r
  name: R
pipeline:
  - stage: filter
    rules:
      - type: message_contains
        value: boot
";

    fn install(ctx: &ServiceCtx, id: &str, yaml: &str) {
        let mut p = crate::processors::AnyProcessor::from_yaml(yaml).expect("fixture yaml parses");
        p.meta.id = id.to_string();
        ctx.state()
            .processors
            .lock()
            .unwrap()
            .insert(id.to_string(), p);
    }

    /// Register an empty stream session the way `start` does, without spawning
    /// anything: a session with a stream source plus a seeded epoch.
    fn seed_stream_session(ctx: &ServiceCtx, session_id: &str) {
        let mut session = AnalysisSession::new(session_id.to_string());
        session.add_stream_source(
            format!("{session_id}-src"),
            format!("ADB: {session_id}"),
            std::env::temp_dir(),
        );
        ctx.state()
            .sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), session);
        ctx.state().seed_stream_epoch(session_id);
    }

    /// A logcat `threadtime` line the real parser accepts.
    fn logcat_line(msg: &str) -> String {
        format!("01-01 00:00:00.000  1000  1000 I TestTag: {msg}")
    }

    struct FixedLines(Vec<String>);

    struct NoopHandle;
    impl StreamHandle for NoopHandle {
        fn kill(&mut self) {}
    }

    impl LineSourceFactory for FixedLines {
        fn open(&self, _device: &str, _pid: Option<u32>) -> Result<LineStream, String> {
            let (tx, rx) = tokio::sync::mpsc::channel::<String>(1024);
            let lines = self.0.clone();
            tokio::spawn(async move {
                for l in lines {
                    if tx.send(l).await.is_err() {
                        break;
                    }
                }
                // tx drops here → EOF
            });
            Ok(LineStream {
                lines: rx,
                handle: Box::new(NoopHandle),
            })
        }
    }

    // ── Pure parsers (moved from commands/adb.rs) ──────────────────────────

    #[test]
    fn parse_adb_devices_reads_serial_state_and_model() {
        let out = "List of devices attached\n\
                   * daemon not running; starting now\n\
                   ABC123    device product:x model:Pixel_7 device:y\n\
                   DEF456    offline\n";
        let got = parse_adb_devices(out);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].serial, "ABC123");
        assert_eq!(got[0].state, "device");
        assert_eq!(got[0].model, "Pixel_7");
        // No `model:` token → the serial stands in.
        assert_eq!(got[1].model, "DEF456");
    }

    #[test]
    fn parse_pidof_output_parses_multiple_pids() {
        assert_eq!(parse_pidof_output("1234 5678"), vec![1234, 5678]);
    }

    #[test]
    fn parse_pidof_output_empty_when_not_running() {
        assert_eq!(parse_pidof_output(""), Vec::<u32>::new());
        assert_eq!(parse_pidof_output("\n"), Vec::<u32>::new());
    }

    #[test]
    fn parse_pidof_output_ignores_unparseable_tokens() {
        assert_eq!(parse_pidof_output("1234 not-a-pid 5678"), vec![1234, 5678]);
    }

    #[test]
    fn resolve_pid_filter_none_when_no_pids() {
        assert_eq!(resolve_pid_filter(&[]), None, "no running process -> unfiltered stream");
    }

    #[test]
    fn resolve_pid_filter_multiple_pids_picks_first() {
        // adb logcat --pid only accepts one PID; we deliberately filter on
        // the first one pidof reported rather than passing multiple --pid
        // flags (which would silently filter on the last one only).
        assert_eq!(resolve_pid_filter(&[100, 200, 300]), Some(100));
    }

    // ── Processor type classification (moved from commands/adb.rs) ─────────

    #[test]
    fn battery_health_is_state_tracker_not_reporter() {
        let yaml = include_str!("../../../marketplace/processors/battery_health.yaml");
        let proc = crate::processors::AnyProcessor::from_yaml(yaml)
            .expect("battery_health.yaml should parse");

        assert!(
            proc.as_state_tracker().is_some(),
            "battery_health should be classified as a state_tracker"
        );
        assert!(
            proc.as_reporter().is_none(),
            "battery_health should NOT be classified as a reporter"
        );
    }

    #[test]
    fn seed_continuous_state_registers_every_processor_kind() {
        let (ctx, _tmp) = test_ctx().build();
        seed_stream_session(&ctx, "s1");
        let bh = include_str!("../../../marketplace/processors/battery_health.yaml");
        install(&ctx, "battery-health", bh);
        install(&ctx, "r@official", REPORTER_YAML);

        seed_continuous_state(
            &ctx,
            "s1",
            &["battery-health".to_string(), "r@official".to_string()],
            0,
        )
        .unwrap();

        assert!(ctx.state().stream_tracker_state.lock().unwrap()["s1"].contains_key("battery-health"));
        assert!(ctx.state().stream_processor_state.lock().unwrap()["s1"].contains_key("r@official"));
    }

    // ── Streaming epoch guard (moved from commands/adb.rs) ─────────────────
    //
    // These simulate the racing interleavings that `flush_batch`'s
    // extract-process-reinsert pattern is exposed to, by driving the same
    // `AppState` epoch helpers the real code uses, in the racing order:
    //   extract (record epoch0) → concurrent writer (clear/bump/drop epoch) →
    //   attempted re-insert (assert it is dropped, not resurrected).

    fn tracker_state(
        last_line: usize,
    ) -> crate::processors::state_tracker::types::ContinuousTrackerState {
        crate::processors::state_tracker::types::ContinuousTrackerState {
            current_state: HashMap::new(),
            transitions: Vec::new(),
            last_processed_line: last_line,
        }
    }

    #[test]
    fn epoch_reinsert_runs_on_normal_path() {
        let state = AppState::new();
        state.seed_stream_epoch("s1");
        let epoch0 = state.current_stream_epoch("s1");

        let mut ran = false;
        state.reinsert_stream_state_if_current("s1", epoch0, || ran = true);
        assert!(ran, "re-insert must proceed when no writer changed the epoch");
    }

    #[test]
    fn epoch_reinsert_dropped_after_concurrent_bump() {
        let state = AppState::new();
        state.seed_stream_epoch("s1");
        let epoch0 = state.current_stream_epoch("s1");

        // Concurrent writer bumps the epoch mid-batch.
        state.bump_stream_epoch_with("s1", || Ok(())).unwrap();

        let mut ran = false;
        state.reinsert_stream_state_if_current("s1", epoch0, || ran = true);
        assert!(!ran, "stale re-insert must be dropped after a concurrent epoch bump");
    }

    #[test]
    fn epoch_reinsert_dropped_after_terminal_clear() {
        let state = AppState::new();
        state.seed_stream_epoch("s1");
        let epoch0 = state.current_stream_epoch("s1");

        state.clear_stream_epoch_with("s1", || Ok(())).unwrap();

        let mut ran = false;
        state.reinsert_stream_state_if_current("s1", epoch0, || ran = true);
        assert!(!ran, "stale re-insert must be dropped after the session was cleared/closed");
    }

    /// Race (a): `set_anonymize(false)` removes the anonymizer + bumps the
    /// epoch while a batch is in flight. The batch must NOT resurrect the
    /// anonymizer (which would silently keep PII anonymization ON).
    #[test]
    fn race_a_anonymizer_not_resurrected_after_disable() {
        let (ctx, _tmp) = test_ctx().build();
        let state = ctx.state();
        state.seed_stream_epoch("s1");

        // A batch is in flight with an anonymizer enabled: it extracts it and
        // records the epoch.
        let epoch0 = state.current_stream_epoch("s1");
        let extracted = LogAnonymizer::from_config(
            &crate::anonymizer::config::AnonymizerConfig::with_defaults(),
        );

        // Concurrent set_anonymize(false), through the real service function.
        set_anonymize(&ctx, "s1", false).unwrap();

        // Batch's Step-4b re-insert (gated).
        state.reinsert_stream_state_if_current("s1", epoch0, || {
            state
                .stream_anonymizers
                .lock()
                .unwrap()
                .insert("s1".to_string(), extracted);
        });

        assert!(
            !state.stream_anonymizers.lock().unwrap().contains_key("s1"),
            "anonymizer disabled mid-batch must stay disabled, not be resurrected",
        );
    }

    /// Race (d): `update_trackers` replaces the tracker set + bumps the epoch
    /// while a batch is in flight. The batch's stale clone must NOT clobber
    /// the updated set.
    #[test]
    fn race_d_tracker_update_not_clobbered_by_stale_reinsert() {
        let state = AppState::new();
        state.seed_stream_epoch("s1");

        {
            let mut st = state.stream_tracker_state.lock().unwrap();
            let mut inner = HashMap::new();
            inner.insert("t1".to_string(), tracker_state(0));
            st.insert("s1".to_string(), inner);
        }

        let epoch0 = state.current_stream_epoch("s1");
        let stale_clone = tracker_state(10);

        state
            .bump_stream_epoch_with("s1", || {
                let mut st = state.stream_tracker_state.lock().unwrap();
                let inner = st.get_mut("s1").unwrap();
                inner.insert("t1".to_string(), tracker_state(999));
                Ok(())
            })
            .unwrap();

        state.reinsert_stream_state_if_current("s1", epoch0, || {
            if let Some(inner) = state.stream_tracker_state.lock().unwrap().get_mut("s1") {
                inner.insert("t1".to_string(), stale_clone);
            }
        });

        let st = state.stream_tracker_state.lock().unwrap();
        assert_eq!(
            st.get("s1").unwrap().get("t1").unwrap().last_processed_line,
            999,
            "the tracker update must win over the in-flight batch's stale re-insert",
        );
    }

    #[test]
    fn remove_stream_task_clears_entry_and_is_idempotent() {
        let state = AppState::new();
        let (tx, _rx) = tokio::sync::oneshot::channel::<()>();
        state.stream_tasks.lock().unwrap().insert("s1".to_string(), tx);
        remove_stream_task(&state, "s1");
        assert!(!state.stream_tasks.lock().unwrap().contains_key("s1"));
        // Already removed (the normal `stop` path ran first) — must not panic.
        remove_stream_task(&state, "s1");
    }

    // ── flush_batch end-to-end: a stale batch cannot resurrect cleared state ──

    /// Drives the real `flush_batch` twice with a real `stop` in between. The
    /// second call is the "late batch" that the epoch guard plus the
    /// `get_mut`-only re-inserts must refuse to resurrect state from: after a
    /// stop, neither `stream_processor_state` nor `pipeline_results` may come
    /// back for this session.
    #[test]
    fn stale_batch_cannot_resurrect_cleared_state() {
        let (ctx, _tmp) = test_ctx().build();
        seed_stream_session(&ctx, "s1");
        install(&ctx, "r@official", REPORTER_YAML);
        seed_continuous_state(&ctx, "s1", &["r@official".to_string()], 0).unwrap();

        let sink = RecordingSink::new();

        // Batch 1: the live path — reporter state advances and results land.
        flush_batch(
            vec![logcat_line("boot complete")],
            "s1",
            "s1-src",
            &ctx,
            1000,
            &sink,
        );
        assert!(
            ctx.state().pipeline_results.lock().unwrap().contains_key("s1"),
            "a live batch must accumulate reporter results"
        );
        assert!(ctx
            .state()
            .stream_processor_state
            .lock()
            .unwrap()
            .contains_key("s1"));

        // The user stops the stream: every continuous map is cleared and the
        // epoch dropped, atomically.
        stop(&ctx, "s1").unwrap();
        assert!(!ctx.state().pipeline_results.lock().unwrap().contains_key("s1"));
        assert!(!ctx
            .state()
            .stream_processor_state
            .lock()
            .unwrap()
            .contains_key("s1"));

        // Batch 2: a late batch from the in-flight task. It must write nothing
        // back for a session whose state was cleared.
        flush_batch(
            vec![logcat_line("boot complete again")],
            "s1",
            "s1-src",
            &ctx,
            1000,
            &sink,
        );

        assert!(
            !ctx.state().pipeline_results.lock().unwrap().contains_key("s1"),
            "a stale batch must not resurrect pipeline results for a stopped stream"
        );
        assert!(
            !ctx.state()
                .stream_processor_state
                .lock()
                .unwrap()
                .contains_key("s1"),
            "a stale batch must not recreate continuous reporter state for a stopped stream"
        );
    }

    /// `resolve_effective_chain` is the only place the chain is decided: a bare
    /// id must come back qualified, and an unknown one must be an error rather
    /// than a silently-skipped processor.
    #[test]
    fn start_resolves_the_chain_through_resolve_effective_chain() {
        let (ctx, _tmp) = test_ctx().build();
        seed_stream_session(&ctx, "s1");
        install(&ctx, "r@official", REPORTER_YAML);

        let chain =
            resolve_stream_chain(&ctx, "s1", Some(&["r".to_string()])).expect("bare id resolves");
        assert_eq!(
            chain,
            vec!["r@official".to_string()],
            "a bare id must be qualified by resolve_effective_chain"
        );

        let err = resolve_stream_chain(&ctx, "s1", Some(&["nope".to_string()])).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
    }

    /// An agent's stream carries the in-chain PII anonymizer even when it named
    /// no processors — the same gate `resolve_effective_chain` applies.
    #[test]
    fn an_agent_stream_gets_the_pii_anonymizer_in_chain() {
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        seed_stream_session(&ctx, "s1");

        let chain = resolve_stream_chain(&ctx, "s1", None).unwrap();
        assert_eq!(chain, vec![pipeline::PII_ANONYMIZER_ID.to_string()]);

        // A UI stream with no processors stays empty — today's behaviour.
        let (ui, _tmp2) = test_ctx().build();
        seed_stream_session(&ui, "s1");
        assert!(resolve_stream_chain(&ui, "s1", None).unwrap().is_empty());
    }

    // ── Watches ────────────────────────────────────────────────────────────

    #[test]
    fn flush_batch_emits_watch_match_for_a_matching_line() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        seed_stream_session(&ctx, "s1");

        let criteria = crate::core::filter::FilterCriteria {
            text_search: Some("boot".to_string()),
            ..Default::default()
        };
        super::super::watches::create(&ctx, "s1".to_string(), criteria).expect("watch created");

        let stream_sink = RecordingSink::new();
        flush_batch(
            vec![logcat_line("boot complete")],
            "s1",
            "s1-src",
            &ctx,
            1000,
            &stream_sink,
        );

        let matches = sink.events_named("watch-match");
        assert_eq!(matches.len(), 1, "a matching line must emit exactly one watch-match");
        assert_eq!(matches[0].payload["sessionId"], "s1");
        assert_eq!(matches[0].payload["newMatches"], 1);
    }

    #[test]
    fn flush_batch_emits_no_watch_match_when_nothing_matches() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        seed_stream_session(&ctx, "s1");

        let criteria = crate::core::filter::FilterCriteria {
            text_search: Some("zzz-never".to_string()),
            ..Default::default()
        };
        super::super::watches::create(&ctx, "s1".to_string(), criteria).unwrap();

        let stream_sink = RecordingSink::new();
        flush_batch(
            vec![logcat_line("boot complete")],
            "s1",
            "s1-src",
            &ctx,
            1000,
            &stream_sink,
        );
        assert!(sink.events_named("watch-match").is_empty());
    }

    // ── Capture task: EOF ──────────────────────────────────────────────────

    #[tokio::test]
    async fn run_streaming_task_reports_stream_stopped_on_eof() {
        let (ctx, _tmp) = test_ctx().build();
        seed_stream_session(&ctx, "s1");

        let sink = Arc::new(RecordingSink::new());
        let (_cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        ctx.state()
            .stream_tasks
            .lock()
            .unwrap()
            .insert("s1".to_string(), _cancel_tx);

        run_streaming_task(
            ctx.clone(),
            StreamTaskArgs {
                cancel: cancel_rx,
                session_id: "s1".to_string(),
                source_id: "s1-src".to_string(),
                device_serial: "fake".to_string(),
                package_filter: None,
                max_raw_lines: 1000,
            },
            Arc::clone(&sink) as Arc<dyn Sink<AdbStreamEvent>>,
            Arc::new(FixedLines(vec![logcat_line("hello")])),
        )
        .await;

        let sent = sink.events_named("sink");
        let batch = sent
            .iter()
            .find(|e| e.payload["event"] == "batch")
            .expect("a batch must be delivered before EOF");
        assert_eq!(batch.payload["data"]["totalLines"], 1);

        let stopped = sent
            .iter()
            .find(|e| e.payload["event"] == "streamStopped")
            .expect("EOF must produce a StreamStopped event");
        assert_eq!(stopped.payload["data"]["reason"], "eof");

        // The RAII guard must have deregistered the cancel sender.
        assert!(
            !ctx.state().stream_tasks.lock().unwrap().contains_key("s1"),
            "the capture task must remove its stream_tasks entry on every exit path"
        );
    }

    #[tokio::test]
    async fn run_streaming_task_reports_a_spawn_failure_as_stream_stopped() {
        struct Failing;
        impl LineSourceFactory for Failing {
            fn open(&self, _d: &str, _p: Option<u32>) -> Result<LineStream, String> {
                Err("Failed to spawn adb: nope".to_string())
            }
        }

        let (ctx, _tmp) = test_ctx().build();
        seed_stream_session(&ctx, "s1");
        let sink = Arc::new(RecordingSink::new());
        let (_tx, rx) = tokio::sync::oneshot::channel::<()>();

        run_streaming_task(
            ctx,
            StreamTaskArgs {
                cancel: rx,
                session_id: "s1".to_string(),
                source_id: "s1-src".to_string(),
                device_serial: "fake".to_string(),
                package_filter: None,
                max_raw_lines: 1000,
            },
            Arc::clone(&sink) as Arc<dyn Sink<AdbStreamEvent>>,
            Arc::new(Failing),
        )
        .await;

        let sent = sink.only_event("sink");
        assert_eq!(sent["event"], "streamStopped");
        assert!(sent["data"]["reason"].as_str().unwrap().contains("Failed to spawn adb"));
    }

    // ── Agent ring ─────────────────────────────────────────────────────────

    fn batch_event(session_id: &str, raw: &str) -> AdbStreamEvent {
        AdbStreamEvent::Batch(AdbBatch {
            session_id: session_id.to_string(),
            lines: vec![ViewLine {
                line_num: 0,
                virtual_index: 0,
                raw: raw.to_string(),
                level: LogLevel::Info,
                tag: "T".to_string(),
                message: raw.to_string(),
                timestamp: 0,
                pid: 0,
                tid: 0,
                source_id: "src".to_string(),
                highlights: vec![],
                matched_by: vec![],
                is_context: false,
            }],
            total_lines: 1,
            byte_count: 0,
            first_timestamp: None,
            last_timestamp: None,
            lost_line_count: 0,
        })
    }

    #[test]
    fn ring_drains_by_seq_and_reports_a_gap_after_eviction() {
        let (ctx, _tmp) = test_ctx().agent("mcp").mcp_anonymize("s1", false).build();
        seed_stream_session(&ctx, "s1");

        // A deliberately tiny ring so eviction is observable without pushing
        // 2000 events; the real one is AGENT_RING_CAPACITY.
        let ring: Arc<RingSink<AdbStreamEvent>> = Arc::new(RingSink::new(2));
        ctx.state()
            .stream_rings
            .lock()
            .unwrap()
            .insert("s1".to_string(), Arc::clone(&ring));

        ring.send(batch_event("s1", "one"));
        ring.send(batch_event("s1", "two"));

        // Cursor 0 == "everything", no gap.
        let page = events(&ctx, "s1", 0, 100).unwrap();
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.events[0].seq, 1);
        assert_eq!(page.latest_seq, 2);
        assert_eq!(page.next_since, 2);
        assert!(!page.gap);

        // Drain from the cursor we were handed: nothing new.
        assert!(events(&ctx, "s1", page.next_since, 100).unwrap().events.is_empty());

        // A third push evicts seq 1. A consumer still sitting on cursor 0 has
        // provably missed something.
        ring.send(batch_event("s1", "three"));
        let page = events(&ctx, "s1", 0, 100).unwrap();
        assert_eq!(page.events[0].seq, 2, "seq 1 was evicted");
        assert!(page.gap, "a cursor older than the oldest retained item is a gap");

        // A caller whose cursor is current sees no gap.
        assert!(!events(&ctx, "s1", 2, 100).unwrap().gap);

        // `limit` caps the page but leaves `latest_seq` truthful.
        let page = events(&ctx, "s1", 0, 1).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.latest_seq, 3);
        assert_eq!(page.next_since, 2);
    }

    #[test]
    fn events_for_an_unregistered_session_is_not_found() {
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        let err = events(&ctx, "nosuch", 0, 10).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    /// Fail-closed: an agent draining a session with no `mcp_anonymize` entry
    /// must not see raw PII, even though the ring holds it.
    #[test]
    fn events_redacts_line_text_for_an_agent_when_the_flag_is_absent() {
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        seed_stream_session(&ctx, "s1");
        let ring = new_ring();
        register_ring(&ctx, "s1", Arc::clone(&ring)).unwrap();
        ring.send(batch_event("s1", "contact user@example.com now"));

        let page = events(&ctx, "s1", 0, 10).unwrap();
        let AdbStreamEvent::Batch(ref b) = page.events[0].item else {
            panic!("expected a batch event");
        };
        assert!(
            !b.lines[0].raw.contains("user@example.com"),
            "an agent must not see raw PII when mcp_anonymize is unset: {}",
            b.lines[0].raw
        );
        assert!(!b.lines[0].message.contains("user@example.com"));
    }

    #[test]
    fn register_ring_prunes_rings_for_sessions_that_are_gone() {
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        ctx.state()
            .stream_rings
            .lock()
            .unwrap()
            .insert("dead".to_string(), new_ring());
        seed_stream_session(&ctx, "s1");
        register_ring(&ctx, "s1", new_ring()).unwrap();

        let rings = ctx.state().stream_rings.lock().unwrap();
        assert!(rings.contains_key("s1"));
        assert!(!rings.contains_key("dead"), "rings for closed sessions must be pruned");
    }

    // ── status ─────────────────────────────────────────────────────────────

    #[test]
    fn status_reports_the_active_chain_and_streaming_flag() {
        let (ctx, _tmp) = test_ctx().build();
        seed_stream_session(&ctx, "s1");
        install(&ctx, "r@official", REPORTER_YAML);
        seed_continuous_state(&ctx, "s1", &["r@official".to_string()], 0).unwrap();

        let st = status(&ctx, "s1").unwrap();
        assert_eq!(st.session_id, "s1");
        assert_eq!(st.source_name, "ADB: s1");
        assert!(!st.streaming, "no capture task registered yet");
        assert_eq!(st.processor_ids, vec!["r@official".to_string()]);
        assert!(st.tracker_ids.is_empty());
        assert!(!st.anonymize);
        assert_eq!(st.latest_event_seq, None);

        let (tx, _rx) = tokio::sync::oneshot::channel::<()>();
        ctx.state().stream_tasks.lock().unwrap().insert("s1".to_string(), tx);
        set_anonymize(&ctx, "s1", true).unwrap();
        let st = status(&ctx, "s1").unwrap();
        assert!(st.streaming);
        assert!(st.anonymize);
    }

    #[test]
    fn status_of_an_unknown_session_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        assert_eq!(status(&ctx, "nope").unwrap_err().code(), "NOT_FOUND");
    }

    // ── stop ───────────────────────────────────────────────────────────────

    #[test]
    fn stop_emits_the_broadcast_fallback_and_journals() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        seed_stream_session(&ctx, "s1");

        stop(&ctx, "s1").unwrap();

        let stopped = sink.only_event("adb-stream-stopped");
        assert_eq!(stopped["sessionId"], "s1");
        assert_eq!(stopped["reason"], "user");

        let entries = ctx.state().activity.list(None, None);
        assert!(entries.iter().any(|e| e.action == "stream.stop"));
    }

    // ── save destination gate ──────────────────────────────────────────────

    #[test]
    fn save_dest_passes_through_for_the_ui() {
        let (ctx, tmp) = test_ctx().build();
        let dest = tmp.path().join("capture.log");
        let got = authorize_save_dest(&ctx, &dest.to_string_lossy()).unwrap();
        assert!(got.ends_with("capture.log"));
    }

    #[test]
    fn save_dest_denies_an_agent_by_default() {
        let (ctx, tmp) = test_ctx().agent("mcp").build();
        let dest = tmp.path().join("capture.log");
        let err = authorize_save_dest(&ctx, &dest.to_string_lossy()).unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[test]
    fn save_dest_permits_an_agent_inside_the_allowlist_even_when_the_file_is_new() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, _t) = test_ctx().agent("mcp").allowlist(tmp.path()).build();
        let dest = tmp.path().join("not-yet-created.log");
        assert!(authorize_save_dest(&ctx, &dest.to_string_lossy()).is_ok());
    }

    #[test]
    fn save_dest_rejects_a_relative_path_as_invalid_not_denied() {
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        let err = authorize_save_dest(&ctx, "relative/capture.log").unwrap_err();
        assert_eq!(err.code(), "INVALID_PATH");
    }

    #[test]
    fn save_live_capture_writes_retained_lines_and_journals() {
        let (ctx, tmp) = test_ctx().build();
        seed_stream_session(&ctx, "s1");
        let sink = RecordingSink::new();
        flush_batch(
            vec![logcat_line("one"), logcat_line("two")],
            "s1",
            "s1-src",
            &ctx,
            1000,
            &sink,
        );

        let dest = tmp.path().join("capture.log");
        let n = save_live_capture(&ctx, "s1", &dest.to_string_lossy()).unwrap();
        assert_eq!(n, 2);
        let body = std::fs::read_to_string(&dest).unwrap();
        assert!(body.contains("one") && body.contains("two"));
        assert!(ctx
            .state()
            .activity
            .list(None, None)
            .iter()
            .any(|e| e.action == "stream.save"));
    }

    #[test]
    fn save_live_capture_rejects_a_non_stream_session() {
        let (ctx, tmp) = test_ctx().build();
        let err = save_live_capture(
            &ctx,
            "nosuch",
            &tmp.path().join("x.log").to_string_lossy(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    // ── Transformer tag/field propagation to Layer 2 (bug 443c0ad5) ────────

    fn make_parsed_line(tag: &str, message: &str) -> ParsedLine {
        let ctx = LineContext {
            raw: Arc::from(format!("{tag}: {message}").as_str()),
            timestamp: 0,
            level: LogLevel::Info,
            tag: Arc::from(tag),
            pid: 0,
            tid: 0,
            message: Arc::from(message),
            source_id: Arc::from("adb"),
            source_line_num: 0,
            fields: HashMap::new(),
            annotations: vec![],
        };
        let view_line = ViewLine {
            line_num: 0,
            virtual_index: 0,
            raw: ctx.raw.to_string(),
            level: ctx.level,
            tag: ctx.tag.to_string(),
            message: ctx.message.to_string(),
            timestamp: ctx.timestamp,
            pid: ctx.pid,
            tid: ctx.tid,
            source_id: ctx.source_id.to_string(),
            highlights: vec![],
            matched_by: vec![],
            is_context: false,
        };
        let meta = ParsedLineMeta {
            level: ctx.level,
            tag: ctx.tag.to_string(),
            timestamp: ctx.timestamp,
            byte_offset: 0,
            byte_len: 0,
            is_section_boundary: false,
        };
        let original_message = Some(Arc::clone(&ctx.message));
        ParsedLine {
            raw: view_line.raw.clone(),
            meta,
            view_line,
            ctx: Some(ctx),
            original_message,
        }
    }

    /// A transformer that retags a line (`ReplaceField{field:"tag"}`) and sets
    /// a field (`SetField`) must have both mutations visible on `pl.ctx` after
    /// `apply_line_transformers` runs — because that is what flush_batch's
    /// `batch_ctxs` assembly clones for Layer 2.
    #[test]
    fn transformer_tag_and_field_mutation_reaches_pl_ctx() {
        use crate::processors::transformer::engine::TransformerRun;
        use crate::processors::transformer::schema::{TransformOp, TransformerDef};

        let def = TransformerDef {
            filter: None,
            transforms: vec![
                TransformOp::ReplaceField {
                    field: "tag".to_string(),
                    regex: "^OldTag$".to_string(),
                    replacement: "NewTag".to_string(),
                },
                TransformOp::SetField {
                    name: "severity".to_string(),
                    value: serde_yaml::Value::String("high".to_string()),
                },
            ],
            builtin: None,
        };
        let mut transformer_runs = vec![("retag".to_string(), TransformerRun::new(&def))];
        let mut parsed = vec![make_parsed_line("OldTag", "boot complete")];

        apply_line_transformers(&mut parsed, &mut transformer_runs, false);

        let ctx = parsed[0].ctx.as_ref().expect("ctx should still be present");
        assert_eq!(&*ctx.tag, "NewTag", "transformer tag mutation must propagate to pl.ctx");
        assert_eq!(
            ctx.fields.get("severity").and_then(|v| v.as_str()),
            Some("high"),
            "transformer field mutation must propagate to pl.ctx"
        );
        assert_eq!(parsed[0].view_line.tag, "NewTag");
    }

    // ── chunks_timeout batching window ─────────────────────────────────────

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

    /// `Caller` is what decides redaction on the agent read path; pin that the
    /// UI half of `redact_event` is a pass-through so a desktop-side drain (if
    /// one is ever added) is never silently redacted.
    #[test]
    fn redact_event_is_a_pass_through_for_the_ui() {
        let (ctx, _tmp) = test_ctx().build();
        assert_eq!(*ctx.caller(), Caller::Ui);
        let ev = redact_event(&ctx, "s1", batch_event("s1", "user@example.com"));
        let AdbStreamEvent::Batch(b) = ev else {
            panic!("expected a batch");
        };
        assert!(b.lines[0].raw.contains("user@example.com"));
    }
}
