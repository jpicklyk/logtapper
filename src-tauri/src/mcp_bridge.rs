//! HTTP bridge for the LogTapper MCP server.
//!
//! A TypeScript MCP server process (stdio transport) talks to Claude Code/Desktop.
//! That process queries THIS local HTTP server on `127.0.0.1:40404` to read live
//! AppState data — sessions, sampled log lines, and state-tracker events.
//!
//! Lock discipline: acquire a Mutex, copy/clone the data needed, drop the lock,
//! THEN build the JSON response. Never hold a lock across an `.await`.

use std::borrow::Cow;
use std::collections::HashMap;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    middleware,
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Wry};

use crate::anonymizer::LogAnonymizer;
use crate::commands::AppState;
use crate::processors::{AnyProcessor, ProcessorKind};
use crate::processors::marketplace::{resolve_processor_id, split_qualified_id};
use crate::processors::reporter::engine::RunResult;
use crate::processors::state_tracker::engine::build_defaults;
use crate::processors::state_tracker::types::StateTransition;

pub const PORT: u16 = 40404;

// ---------------------------------------------------------------------------
// Session lookup macros
// ---------------------------------------------------------------------------

/// Acquire the sessions lock, look up `$session_id`, bind `$sessions` (the lock
/// guard), `$session` (the `&AnalysisSession`), and `$source` (the `&dyn LogSource`).
/// Returns a JSON error response on lookup failure.
macro_rules! get_session_and_source {
    ($state:expr, $session_id:expr => $sessions:ident, $session:ident, $source:ident) => {
        let $sessions = $state.sessions.lock().unwrap();
        let Some($session) = $sessions.get(&$session_id) else {
            return Json(json!({ "error": format!("Session not found: {}", $session_id) }));
        };
        let Some($source) = $session.primary_source() else {
            return Json(json!({ "error": format!("Session has no sources: {}", $session_id) }));
        };
    };
}

/// Verify a session exists (by key) and return a JSON error if not.
/// Does not bind the session — drops the lock immediately.
macro_rules! verify_session_exists {
    ($state:expr, $session_id:expr) => {{
        let sessions = $state.sessions.lock().unwrap();
        if !sessions.contains_key(&$session_id) {
            return Json(json!({ "error": format!("Session not found: {}", $session_id) }));
        }
    }};
}

// ---------------------------------------------------------------------------
// Processor metadata extraction helpers
// ---------------------------------------------------------------------------

/// Extract the `sections` list from any processor kind.
///
/// Returns a borrowed slice for reporters (already stored) and an owned Vec
/// for state trackers (computed from transition filters). Other kinds get `[]`.
fn extract_sections(p: &AnyProcessor) -> Cow<'_, [String]> {
    match &p.kind {
        ProcessorKind::Reporter(def) => Cow::Borrowed(&def.sections),
        ProcessorKind::StateTracker(def) => {
            let mut sections: Vec<String> = def.transitions.iter()
                .filter_map(|t| t.filter.section.clone())
                .collect();
            sections.sort();
            sections.dedup();
            Cow::Owned(sections)
        }
        _ => Cow::Borrowed(&[]),
    }
}

/// Extract `source_types` from the processor's schema contract.
fn extract_source_types(p: &AnyProcessor) -> &[String] {
    p.schema.as_ref()
        .map_or(&[], |s| s.source_types.as_slice())
}

/// Check whether a qualified (or bare) processor ID matches an optional filter.
/// Returns `true` if no filter is set, or if the filter matches the full or bare ID.
fn processor_id_matches(candidate: &str, filter: Option<&String>) -> bool {
    filter.map_or(true, |fid| {
        fid == candidate || split_qualified_id(candidate).0 == fid.as_str()
    })
}

/// Concrete handle type — Wry is the only desktop runtime Tauri ships.
type Handle = AppHandle<Wry>;

// ---------------------------------------------------------------------------
// Entry point (spawned as a tokio task from lib.rs setup)
// ---------------------------------------------------------------------------

/// Middleware: stamp `mcp_last_activity` on every inbound request.
async fn record_activity(
    State(handle): State<Handle>,
    req: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    let state = handle.state::<AppState>();
    if let Ok(mut ts) = state.mcp_last_activity.lock() {
        *ts = Some(std::time::Instant::now());
    }
    next.run(req).await
}

pub async fn start(handle: Handle, shutdown_rx: tokio::sync::oneshot::Receiver<()>) {
    // Clone handle for the router state; keep original for the port flag.
    let router = Router::new()
        .route("/mcp/status", get(h_status))
        .route("/mcp/sessions", get(h_sessions))
        .route("/mcp/sessions/{session_id}/query", get(h_query))
        .route("/mcp/sessions/{session_id}/pipeline", get(h_pipeline))
        .route("/mcp/sessions/{session_id}/events", get(h_events))
        .route("/mcp/sessions/{session_id}/correlations", get(h_correlations))
        .route("/mcp/sessions/{session_id}/processor/{processor_id}", get(h_processor_detail))
        .route("/mcp/sessions/{session_id}/tracker/{tracker_id}/state_at", get(h_state_at_line))
        .route("/mcp/sessions/{session_id}/search", get(h_search))
        .route("/mcp/sessions/{session_id}/metadata", get(h_metadata))
        .route("/mcp/sessions/{session_id}/sections", get(h_sections))
        .route("/mcp/sessions/{session_id}/tag-stats", get(h_tag_stats))
        .route("/mcp/sessions/{session_id}/lines_around", get(h_lines_around))
        .route("/mcp/sessions/{session_id}/search_with_context", get(h_search_with_context))
        .route("/mcp/processors", get(h_processor_defs_list))
        .route("/mcp/processors/{processor_id}", get(h_processor_defs_single))
        // Phase 2 — Bookmarks
        .route("/mcp/sessions/{session_id}/bookmarks", get(h_list_bookmarks).post(h_create_bookmark))
        .route("/mcp/sessions/{session_id}/bookmarks/{bookmark_id}", delete(h_delete_bookmark).put(h_update_bookmark))
        // Phase 2 — Analysis artifacts
        .route("/mcp/sessions/{session_id}/analyses", get(h_list_analyses).post(h_publish_analysis))
        .route("/mcp/sessions/{session_id}/analyses/{artifact_id}", get(h_get_analysis).put(h_update_analysis).delete(h_delete_analysis))
        // Phase 3 — Insights
        .route("/mcp/sessions/{session_id}/insights", get(h_insights))
        // Pipeline run trigger (MCP)
        .route("/mcp/sessions/{session_id}/run_pipeline", post(h_run_pipeline))
        // Phase 4 — Watches
        .route("/mcp/sessions/{session_id}/watches", get(h_list_watches).post(h_create_watch))
        .route("/mcp/sessions/{session_id}/watches/{watch_id}", delete(h_cancel_watch))
        .layer(middleware::from_fn_with_state(handle.clone(), record_activity))
        .with_state(handle.clone());

    match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(listener) => {
            // Record that the bridge is running so the frontend can show status.
            let state = handle.state::<AppState>();
            if let Ok(mut p) = state.mcp_bridge_port.lock() {
                *p = Some(PORT);
            }
            #[allow(clippy::drop_non_drop)]
            drop(state);
            log::info!("MCP bridge listening on 127.0.0.1:{PORT}");
            let graceful = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                });
            if let Err(e) = graceful.await {
                log::error!("MCP bridge error: {e}");
            }
            // Clear the port flag so the frontend knows the bridge is no longer running.
            let state = handle.state::<AppState>();
            if let Ok(mut p) = state.mcp_bridge_port.lock() {
                *p = None;
            }
            // Clear the shutdown sender so start_mcp_bridge can restart cleanly.
            if let Ok(mut s) = state.mcp_bridge_shutdown.lock() {
                s.take();
            }
            log::info!("MCP bridge stopped");
        }
        Err(e) => {
            log::error!(
                "MCP bridge: cannot bind to 127.0.0.1:{PORT} — {e}. \
                 Is another instance running?"
            );
            // Clear the shutdown sender on bind failure too, so the bridge can be restarted.
            if let Ok(mut s) = handle.state::<AppState>().mcp_bridge_shutdown.lock() {
                s.take();
            };
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse a datetime string into the same timestamp format used by the logcat
/// parser: BASE_NS (946_684_800_000_000_000, i.e. 2000-01-01 as Unix nanos)
/// plus day-of-year offset. This matches `parse_timestamp_ns()` in
/// `logcat_parser.rs`.
///
/// Accepts formats:
/// - "MM-DD HH:MM:SS.mmm"  (logcat native — recommended)
/// - "YYYY-MM-DDThh:mm:ss[.fff]" or "YYYY-MM-DD hh:mm:ss[.fff]"
///   (ISO 8601 — year is IGNORED; only month-day is used, since logcat
///   timestamps have no year and are stored with a year-2000 base)
///
/// Returns None if the string cannot be parsed.
fn parse_iso_to_nanos_2000(s: &str) -> Option<i64> {
    // Must match logcat_parser.rs: BASE_NS + yday * 86_400e9 + time nanos
    const BASE_NS: i64 = 946_684_800_000_000_000; // 2000-01-01 00:00:00 UTC as Unix nanos
    const MONTH_DAYS: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

    let s = s.trim();
    let s_normalized = s.replace('T', " ");
    let parts: Vec<&str> = s_normalized.splitn(2, ' ').collect();
    if parts.len() != 2 { return None; }

    let date_part = parts[0];
    let time_part = parts[1];

    // Extract month and day (ignore year if present)
    let date_segments: Vec<&str> = date_part.split('-').collect();
    let (month, day) = if date_segments.len() == 3 {
        // YYYY-MM-DD — ignore year
        let m = date_segments[1].parse::<i64>().ok()?;
        let d = date_segments[2].parse::<i64>().ok()?;
        (m, d)
    } else if date_segments.len() == 2 {
        // MM-DD
        let m = date_segments[0].parse::<i64>().ok()?;
        let d = date_segments[1].parse::<i64>().ok()?;
        (m, d)
    } else {
        return None;
    };

    let yday = MONTH_DAYS.get((month as usize).saturating_sub(1)).copied().unwrap_or(0) + (day - 1);

    // Parse time: "HH:MM:SS[.mmm]"
    let t: Vec<&str> = time_part.splitn(4, [':', '.']).collect();
    let h: i64 = t.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let m: i64 = t.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let sec: i64 = t.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let ms: i64 = t.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);

    Some(
        BASE_NS
            + yday * 86_400_000_000_000
            + h * 3_600_000_000_000
            + m * 60_000_000_000
            + sec * 1_000_000_000
            + ms * 1_000_000,
    )
}

/// Truncate a string to at most `max_chars` characters, appending "..." if cut.
/// Uses char boundaries to avoid splitting multi-byte UTF-8 sequences.
fn truncate_str(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let end = s.char_indices()
            .nth(max_chars)
            .map_or(s.len(), |(i, _)| i);
        let mut t = s[..end].to_string();
        t.push_str("...");
        t
    }
}

/// Truncate large map vars: for any Value::Object with >20 keys where values
/// are numeric, sort by value desc, keep top 20, add _truncated and _totalKeys.
fn truncate_var_maps(vars: &HashMap<String, Value>) -> serde_json::Map<String, Value> {
    vars.iter()
        .filter_map(|(k, v)| {
            match v {
                Value::Array(a) if a.is_empty() => None,
                Value::Object(o) if o.is_empty() => None,
                Value::Object(o) if o.len() > 20 => {
                    // Check if values are numeric
                    let all_numeric = o.values().all(serde_json::Value::is_number);
                    if all_numeric {
                        let total_keys = o.len();
                        let mut entries: Vec<(&String, &Value)> = o.iter().collect();
                        entries.sort_by(|a, b| {
                            let va = a.1.as_f64().unwrap_or(0.0);
                            let vb = b.1.as_f64().unwrap_or(0.0);
                            vb.partial_cmp(&va).unwrap_or(std::cmp::Ordering::Equal)
                        });
                        let mut truncated = serde_json::Map::new();
                        for (ek, ev) in entries.into_iter().take(20) {
                            truncated.insert(ek.clone(), ev.clone());
                        }
                        truncated.insert("_truncated".to_string(), Value::Bool(true));
                        truncated.insert("_totalKeys".to_string(), Value::Number(total_keys.into()));
                        Some((k.clone(), Value::Object(truncated)))
                    } else {
                        Some((k.clone(), v.clone()))
                    }
                }
                _ => Some((k.clone(), v.clone())),
            }
        })
        .collect()
}

/// Resolve multiple line numbers to raw text, returning a map of line_num -> text.
fn resolve_line_texts(
    sessions: &HashMap<String, crate::core::session::AnalysisSession>,
    session_id: &str,
    line_nums: &[usize],
) -> HashMap<usize, String> {
    let mut map = HashMap::new();
    if let Some(session) = sessions.get(session_id) {
        if let Some(source) = session.primary_source() {
            for &ln in line_nums {
                if let Some(raw) = source.raw_line(ln) {
                    map.insert(ln, truncate_str(&raw, 500));
                }
            }
        }
    }
    map
}

// ---------------------------------------------------------------------------
// GET /mcp/status
// ---------------------------------------------------------------------------

async fn h_status(State(handle): State<Handle>) -> Json<Value> {
    let state = handle.state::<AppState>();

    let session_ids: Vec<String> = {
        let sessions = state.sessions.lock().unwrap();
        sessions.keys().cloned().collect()
    };

    let processor_ids: Vec<String> = {
        let procs = state.processors.lock().unwrap();
        procs.keys().cloned().collect()
    };

    Json(json!({
        "running": true,
        "port": PORT,
        "sessionCount": session_ids.len(),
        "sessionIds": session_ids,
        "installedProcessors": processor_ids.len(),
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions
// ---------------------------------------------------------------------------

async fn h_sessions(State(handle): State<Handle>) -> Json<Value> {
    let state = handle.state::<AppState>();

    // Collect session info without holding the lock into the JSON builder.
    let sessions_info: Vec<Value> = {
        let sessions = state.sessions.lock().unwrap();
        sessions
            .values()
            .map(|session| {
                let sources: Vec<Value> = if let Some(src) = session.primary_source() {
                    vec![json!({
                        "id": src.id(),
                        "name": src.name(),
                        "sourceType": src.source_type().to_string(),
                        "totalLines": src.total_lines(),
                    })]
                } else {
                    vec![]
                };
                json!({
                    "id": session.id,
                    "sources": sources,
                })
            })
            .collect()
    };

    // Processor IDs that have pipeline results for any session.
    let processors_with_results: Vec<String> = {
        let results = state.pipeline_results.lock().unwrap();
        let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for session_map in results.values() {
            ids.extend(session_map.keys().cloned());
        }
        ids.into_iter().collect()
    };

    // Installed processors (id + name + type).
    let installed: Vec<Value> = {
        let procs = state.processors.lock().unwrap();
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
// GET /mcp/sessions/{session_id}/query
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct QueryParams {
    /// Number of lines to return (default 50, max 200).
    n: Option<usize>,
    /// Sampling strategy: "uniform" | "recent" | "around" (default "recent").
    strategy: Option<String>,
    /// Center line number for the "around" strategy.
    around_line: Option<usize>,
    /// Minimum log level filter: V D I W E F (first char compared).
    level: Option<String>,
    /// Exact tag filter.
    tag: Option<String>,
    /// Substring filter applied to the raw line.
    message: Option<String>,
    /// Restrict results to lines >= start_line (0-based, inclusive).
    start_line: Option<usize>,
    /// Restrict results to lines < end_line (0-based, exclusive).
    end_line: Option<usize>,
    /// Filter to lines with timestamp >= this value (ISO 8601, e.g. "2024-01-15T10:30:00").
    time_start: Option<String>,
    /// Filter to lines with timestamp <= this value (ISO 8601, e.g. "2024-01-15T11:00:00").
    time_end: Option<String>,
}

async fn h_query(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<QueryParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let n = params.n.unwrap_or(50).min(200);
    let strategy = params.strategy.as_deref().unwrap_or("recent");

    // Parse time range filters upfront (ISO 8601 → nanos since 2000-01-01)
    let time_start_ns = params.time_start.as_deref().and_then(parse_iso_to_nanos_2000);
    let time_end_ns = params.time_end.as_deref().and_then(parse_iso_to_nanos_2000);

    // Snapshot the lines we need without holding the lock into async territory.
    struct LineSnap {
        line_num: usize,
        level: &'static str,   // e.g. "Info", "Error"
        tag: String,
        raw: String,
    }

    let (snaps, total_lines): (Vec<LineSnap>, usize) = {
        get_session_and_source!(state, session_id => sessions, session, source);

        let total = source.total_lines();

        // Clamp sample range to [start_line, end_line)
        let range_start = params.start_line.unwrap_or(0).min(total);
        let range_end = params.end_line.unwrap_or(total).min(total);
        let clamped_total = range_end.saturating_sub(range_start);

        let indices = if params.start_line.is_some() || params.end_line.is_some() {
            // Apply range clamping to sample_indices
            sample_indices(clamped_total, n, strategy, params.around_line.map(|a| a.saturating_sub(range_start)))
                .into_iter()
                .map(|i| i + range_start)
                .collect()
        } else {
            sample_indices(total, n, strategy, params.around_line)
        };

        let snaps = indices
            .into_iter()
            .filter_map(|i| {
                let raw = source.raw_line(i)?.into_owned();
                let meta = source.meta_at(i)?;
                Some(LineSnap {
                    line_num: i,
                    level: meta.level.as_str(),
                    tag: session.resolve_tag(meta.tag_id).to_string(),
                    raw,
                })
            })
            .collect();

        (snaps, total)
    };

    // If any filter is active, scanning a fixed sample produces poor results for
    // rare events in large logs.  Instead, scan all lines (up to SCAN_CAP) and
    // collect up to `n` matches.  The "strategy" still controls scan direction:
    //   recent   → scan newest→oldest (stop after n matches)
    //   around   → scan outward from around_line (stop after n matches)
    //   uniform  → scan all, then space the matches evenly
    let has_filter = params.tag.is_some() || params.message.is_some()
        || params.level.is_some() || time_start_ns.is_some() || time_end_ns.is_some();
    const SCAN_CAP: usize = 100_000;

    let snaps = if has_filter {
        // Rebuild snap list by scanning real lines instead of using the sample.
        get_session_and_source!(state, session_id => sessions, session, source);

        // Clamp scan range to [start_line, end_line)
        let range_start = params.start_line.unwrap_or(0).min(total_lines);
        let range_end = params.end_line.unwrap_or(total_lines).min(total_lines);

        // Build the scan order based on strategy (clamped to range).
        let scan_indices: Vec<usize> = match strategy {
            "recent" => {
                let start = range_start.max(range_end.saturating_sub(SCAN_CAP));
                (start..range_end).rev().collect()
            }
            "around" => {
                let center = params.around_line.unwrap_or_else(|| range_end.saturating_sub(1))
                    .clamp(range_start, range_end.saturating_sub(1));
                let half = SCAN_CAP / 2;
                let start = center.saturating_sub(half).max(range_start);
                let end = (center + half).min(range_end);
                // Interleave outward from center: center, center-1, center+1, …
                (start..=center).rev().zip(((center + 1)..end).map(Some).chain(std::iter::repeat(None)))
                    .flat_map(|(b, a)| std::iter::once(b).chain(a))
                    .collect()
            }
            _ => {
                // uniform: scan all lines in order so rare events aren't missed
                (range_start..range_end).collect()
            }
        };

        let msg_needle = params.message.as_ref().map(|m| m.to_lowercase());
        let mut matched: Vec<LineSnap> = Vec::new();
        for i in scan_indices {
            if matched.len() >= n { break; }
            let Some(raw) = source.raw_line(i) else { continue };
            let Some(meta) = source.meta_at(i) else { continue };
            let level_str = meta.level.as_str();
            // Tag filter
            if let Some(ref tf) = params.tag {
                if session.resolve_tag(meta.tag_id) != tf { continue; }
            }
            // Message filter (case-insensitive)
            if let Some(ref needle) = msg_needle {
                if !raw.to_lowercase().contains(needle.as_str()) { continue; }
            }
            // Level filter
            if let Some(ref lf) = params.level {
                if !level_at_least(level_str, lf) { continue; }
            }
            // Time range filter
            if let Some(ts) = time_start_ns {
                if meta.timestamp < ts { continue; }
            }
            if let Some(ts) = time_end_ns {
                if meta.timestamp > ts { continue; }
            }
            matched.push(LineSnap { line_num: i, level: level_str, tag: session.resolve_tag(meta.tag_id).to_string(), raw: raw.into_owned() });
        }
        // For "recent" we scanned newest→oldest; restore chronological order.
        if strategy == "recent" { matched.reverse(); }
        matched
    } else {
        snaps
    };

    // ── PII anonymization ─────────────────────────────────────────────────────
    // Anonymize only when the frontend has __pii_anonymizer in the pipeline chain
    // (signalled via set_mcp_anonymize).  One persistent LogAnonymizer per session
    // ensures token numbering is stable across multiple MCP queries.
    let snaps = {
        let should_anonymize = *state.mcp_anonymize.lock().unwrap();
        if should_anonymize {
            let config = state.anonymizer_config.lock().unwrap().clone();
            let mut anon_map = state.mcp_anonymizers.lock().unwrap();
            let anon = anon_map
                .entry(session_id.clone())
                .or_insert_with(|| LogAnonymizer::from_config(&config));
            snaps
                .into_iter()
                .map(|s| {
                    let (clean, _) = anon.anonymize(&s.raw);
                    LineSnap { raw: clean, ..s }
                })
                .collect::<Vec<_>>()
        } else {
            snaps
        }
    };

    // Build JSON output.
    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    let mut level_counts: HashMap<&str, usize> = HashMap::new();

    let lines: Vec<Value> = snaps
        .into_iter()
        .map(|snap| {
            *tag_counts.entry(snap.tag.clone()).or_insert(0) += 1;
            *level_counts.entry(snap.level).or_insert(0) += 1;
            json!({
                "lineNum": snap.line_num,
                "level": snap.level,
                "tag": snap.tag,
                "raw": snap.raw,
            })
        })
        .collect();

    let count = lines.len();
    Json(json!({
        "sessionId": session_id,
        "totalLinesInSession": total_lines,
        "sampledCount": count,
        "strategy": if has_filter { "scan" } else { strategy },
        "lines": lines,
        "stats": {
            "tagCounts": tag_counts,
            "levelCounts": level_counts,
        },
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/pipeline
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PipelineParams {
    /// Filter to a single processor by ID.
    processor_id: Option<String>,
}

async fn h_pipeline(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<PipelineParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();

    // --- Phase 1: Clone pipeline results and processor metadata ---
    struct ReporterSnap {
        proc_id: String,
        name: String,
        description: String,
        matched_line_count: usize,
        sample_line_nums: Vec<usize>,
        emission_count: usize,
        recent_emissions: Vec<Value>,
        vars: HashMap<String, Value>,
    }

    struct TrackerSnap {
        tracker_id: String,
        name: String,
        description: String,
        transition_count: usize,
        final_state: Value,
        recent_transitions: Vec<StateTransition>,
    }

    // Collect reporter data (clone out of lock)
    let reporter_snaps: Vec<ReporterSnap> = {
        let results = state.pipeline_results.lock().unwrap();
        let procs = state.processors.lock().unwrap();
        match results.get(&session_id) {
            None => vec![],
            Some(session_map) => session_map
                .iter()
                .filter(|(pid, _)| processor_id_matches(pid, params.processor_id.as_ref()))
                .map(|(proc_id, run_result)| {
                    let proc = procs.get(proc_id);
                    let name = proc.map_or_else(|| proc_id.clone(), |p| p.meta.name.clone());
                    let description = proc.map(|p| p.meta.description.clone()).unwrap_or_default();

                    // Last 10 emissions, serialized
                    let recent_emissions: Vec<Value> = run_result.emissions.iter().rev().take(10)
                        .map(|e| serde_json::to_value(e).unwrap_or(json!(null)))
                        .collect();

                    // First 5 matched line nums for sample
                    let matched_sample: Vec<usize> = run_result.matched_line_nums.iter().take(5).copied().collect();

                    ReporterSnap {
                        proc_id: proc_id.clone(),
                        name,
                        description,
                        matched_line_count: run_result.matched_line_nums.len(),
                        sample_line_nums: matched_sample,
                        emission_count: run_result.emissions.len(),
                        recent_emissions,
                        vars: run_result.vars.clone(),
                    }
                })
                .collect(),
        }
    };

    // Collect tracker data (clone out of lock)
    let tracker_snaps: Vec<TrackerSnap> = {
        let pipeline_res = state.state_tracker_results.lock().unwrap();
        let stream_res = state.stream_tracker_state.lock().unwrap();
        let procs = state.processors.lock().unwrap();

        let from_pipeline = pipeline_res.get(&session_id);
        let from_stream = stream_res.get(&session_id);

        if from_pipeline.is_none() && from_stream.is_none() {
            vec![]
        } else {
            let mut tracker_ids: Vec<String> = from_pipeline
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            if let Some(sm) = from_stream {
                for id in sm.keys() {
                    if !tracker_ids.contains(id) { tracker_ids.push(id.clone()); }
                }
            }
            tracker_ids.into_iter()
                .filter(|tid| processor_id_matches(tid, params.processor_id.as_ref()))
                .map(|tracker_id| {
                    let proc = procs.get(&tracker_id);
                    let name = proc.map_or_else(|| tracker_id.clone(), |p| p.meta.name.clone());
                    let description = proc.map(|p| p.meta.description.clone()).unwrap_or_default();

                    let (transitions, final_state): (&[StateTransition], Value) =
                        if let Some(pr) = from_pipeline.and_then(|m| m.get(&tracker_id)) {
                            (pr.transitions.as_slice(), json!(pr.final_state))
                        } else if let Some(sr) = from_stream.and_then(|m| m.get(&tracker_id)) {
                            (sr.transitions.as_slice(), json!(sr.current_state))
                        } else {
                            (&[], json!({}))
                        };

                    // Last 20 transitions
                    let recent: Vec<StateTransition> = transitions.iter().rev().take(20).cloned().collect();

                    TrackerSnap {
                        tracker_id,
                        name,
                        description,
                        transition_count: transitions.len(),
                        final_state,
                        recent_transitions: recent,
                    }
                }).collect()
        }
    };

    // --- Phase 2: Resolve line text from sessions (separate lock) ---
    let line_text_map: HashMap<usize, String> = {
        // Collect all line nums we need to resolve
        let mut needed: Vec<usize> = Vec::new();
        for snap in &reporter_snaps {
            needed.extend(&snap.sample_line_nums);
        }
        for snap in &tracker_snaps {
            for t in &snap.recent_transitions {
                needed.push(t.line_num);
            }
        }
        needed.sort_unstable();
        needed.dedup();

        let sessions = state.sessions.lock().unwrap();
        resolve_line_texts(&sessions, &session_id, &needed)
    };

    // --- Phase 3: Build JSON ---
    let reporter_results: Vec<Value> = reporter_snaps.into_iter().map(|snap| {
        let sample_lines: Vec<Value> = snap.sample_line_nums.iter().map(|&ln| {
            json!({
                "lineNum": ln,
                "rawLine": line_text_map.get(&ln).cloned().unwrap_or_default(),
            })
        }).collect();

        let vars = truncate_var_maps(&snap.vars);

        json!({
            "processorId": snap.proc_id,
            "processorType": "reporter",
            "name": snap.name,
            "description": snap.description,
            "matchedLines": snap.matched_line_count,
            "emissionCount": snap.emission_count,
            "recentEmissions": snap.recent_emissions,
            "sampleMatchedLines": sample_lines,
            "vars": vars,
        })
    }).collect();

    let tracker_results: Vec<Value> = tracker_snaps.into_iter().map(|snap| {
        let transitions: Vec<Value> = snap.recent_transitions.iter().map(|t| {
            json!({
                "lineNum": t.line_num,
                "transitionName": t.transition_name,
                "changes": t.changes,
                "rawLine": line_text_map.get(&t.line_num).cloned().unwrap_or_default(),
            })
        }).collect();

        json!({
            "processorId": snap.tracker_id,
            "processorType": "state_tracker",
            "name": snap.name,
            "description": snap.description,
            "transitionCount": snap.transition_count,
            "finalState": snap.final_state,
            "recentTransitions": transitions,
        })
    }).collect();

    let has_any = !reporter_results.is_empty() || !tracker_results.is_empty();
    Json(json!({
        "sessionId": session_id,
        "hasResults": has_any,
        "reporters": reporter_results,
        "stateTrackers": tracker_results,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/processor/{processor_id}
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ProcessorDetailParams {
    /// Include full emissions list (default false).
    #[serde(default)]
    include_emissions: Option<bool>,
    /// Max emissions to return (default 50, max 200).
    emission_limit: Option<usize>,
    /// Offset for emission pagination (default 0).
    emission_offset: Option<usize>,
    /// Include raw line text for matched lines / transitions (default false).
    #[serde(default)]
    include_line_text: Option<bool>,
}

async fn h_processor_detail(
    State(handle): State<Handle>,
    Path((session_id, processor_id)): Path<(String, String)>,
    Query(params): Query<ProcessorDetailParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let include_emissions = params.include_emissions.unwrap_or(false);
    let emission_limit = params.emission_limit.unwrap_or(50).min(200);
    let emission_offset = params.emission_offset.unwrap_or(0);
    let include_line_text = params.include_line_text.unwrap_or(false);

    // Resolve bare → qualified ID and check processor type in a single lock.
    let (resolved_id, processor_type) = {
        let procs = state.processors.lock().unwrap();
        let resolved = resolve_processor_id(&procs, &processor_id)
            .unwrap_or_else(|| processor_id.clone());
        let ptype = procs.get(&resolved).map(|p| p.processor_type().to_string());
        (resolved, ptype)
    };

    match processor_type.as_deref() {
        Some("reporter") | None => {
            // Try reporter results (None processor_type means it might still have results)
            let result_data: Option<(RunResult, String, String)> = {
                let results = state.pipeline_results.lock().unwrap();
                let procs = state.processors.lock().unwrap();
                results.get(&session_id)
                    .and_then(|m| m.get(&resolved_id))
                    .map(|rr| {
                        let proc = procs.get(&resolved_id);
                        let name = proc.map_or_else(|| resolved_id.clone(), |p| p.meta.name.clone());
                        let desc = proc.map(|p| p.meta.description.clone()).unwrap_or_default();
                        (RunResult {
                            emissions: rr.emissions.clone(),
                            vars: rr.vars.clone(),
                            matched_line_nums: rr.matched_line_nums.clone(),
                            script_errors: rr.script_errors,
                            first_script_error: rr.first_script_error.clone(),
                        }, name, desc)
                    })
            };

            let Some((rr, name, description)) = result_data else {
                return Json(json!({ "error": "no results for this processor/session", "processorId": processor_id, "sessionId": session_id }));
            };

            // Collect line nums to resolve
            let mut needed_lines: Vec<usize> = Vec::new();
            if include_line_text {
                // First 100 matched lines
                needed_lines.extend(rr.matched_line_nums.iter().take(100));
                if include_emissions {
                    for e in rr.emissions.iter().skip(emission_offset).take(emission_limit) {
                        needed_lines.push(e.line_num);
                    }
                }
            }
            needed_lines.sort_unstable();
            needed_lines.dedup();

            let line_texts: HashMap<usize, String> = if include_line_text {
                let sessions = state.sessions.lock().unwrap();
                resolve_line_texts(&sessions, &session_id, &needed_lines)
            } else {
                HashMap::new()
            };

            // Build emissions
            let emissions_json: Value = if include_emissions {
                let page: Vec<Value> = rr.emissions.iter()
                    .skip(emission_offset)
                    .take(emission_limit)
                    .map(|e| {
                        let mut v = serde_json::to_value(e).unwrap_or(json!(null));
                        if include_line_text {
                            if let Some(text) = line_texts.get(&e.line_num) {
                                v.as_object_mut().map(|o| o.insert("rawLine".to_string(), json!(text)));
                            }
                        }
                        v
                    })
                    .collect();
                json!(page)
            } else {
                json!(null)
            };

            // Matched lines (first 100)
            let matched_lines: Vec<Value> = rr.matched_line_nums.iter().take(100).map(|&ln| {
                let mut entry = json!({ "lineNum": ln });
                if include_line_text {
                    if let Some(text) = line_texts.get(&ln) {
                        entry.as_object_mut().map(|o| o.insert("rawLine".to_string(), json!(text)));
                    }
                }
                entry
            }).collect();

            let vars = truncate_var_maps(&rr.vars);

            Json(json!({
                "processorId": processor_id,
                "sessionId": session_id,
                "processorType": "reporter",
                "name": name,
                "description": description,
                "matchedLineCount": rr.matched_line_nums.len(),
                "emissionCount": rr.emissions.len(),
                "vars": vars,
                "matchedLines": matched_lines,
                "emissions": emissions_json,
                "emissionOffset": emission_offset,
                "emissionLimit": emission_limit,
            }))
        }
        Some("state_tracker") => {
            // Resolve tracker data
            let tracker_data: Option<(Vec<StateTransition>, Value, String, String)> = {
                let pipeline_res = state.state_tracker_results.lock().unwrap();
                let stream_res = state.stream_tracker_state.lock().unwrap();
                let procs = state.processors.lock().unwrap();

                let proc = procs.get(&resolved_id);
                let name = proc.map_or_else(|| resolved_id.clone(), |p| p.meta.name.clone());
                let desc = proc.map(|p| p.meta.description.clone()).unwrap_or_default();

                let from_pipeline = pipeline_res.get(&session_id).and_then(|m| m.get(&resolved_id));
                let from_stream = stream_res.get(&session_id).and_then(|m| m.get(&resolved_id));

                if let Some(pr) = from_pipeline {
                    Some((pr.transitions.clone(), json!(pr.final_state), name, desc))
                } else {
                    from_stream.map(|sr| (sr.transitions.clone(), json!(sr.current_state), name, desc))
                }
            };

            let Some((transitions, final_state, name, description)) = tracker_data else {
                return Json(json!({ "error": "no tracker results for this processor/session", "processorId": processor_id, "sessionId": session_id }));
            };

            // Paginate transitions
            let page: Vec<StateTransition> = transitions.iter()
                .skip(emission_offset)
                .take(emission_limit)
                .cloned()
                .collect();

            // Resolve line text if requested
            let line_texts: HashMap<usize, String> = if include_line_text {
                let needed: Vec<usize> = page.iter().map(|t| t.line_num).collect();
                let sessions = state.sessions.lock().unwrap();
                resolve_line_texts(&sessions, &session_id, &needed)
            } else {
                HashMap::new()
            };

            let transitions_json: Vec<Value> = page.iter().map(|t| {
                let mut v = json!({
                    "lineNum": t.line_num,
                    "timestamp": t.timestamp,
                    "transitionName": t.transition_name,
                    "changes": t.changes,
                });
                if include_line_text {
                    if let Some(text) = line_texts.get(&t.line_num) {
                        v.as_object_mut().map(|o| o.insert("rawLine".to_string(), json!(text)));
                    }
                }
                v
            }).collect();

            Json(json!({
                "processorId": processor_id,
                "sessionId": session_id,
                "processorType": "state_tracker",
                "name": name,
                "description": description,
                "transitionCount": transitions.len(),
                "finalState": final_state,
                "transitions": transitions_json,
                "offset": emission_offset,
                "limit": emission_limit,
            }))
        }
        Some(other) => {
            Json(json!({ "error": format!("processor type '{other}' detail not supported"), "processorId": processor_id }))
        }
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/events
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct EventParams {
    /// Max transitions to return, most-recent first (default 50, max 200).
    limit: Option<usize>,
}

async fn h_events(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<EventParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let limit = params.limit.unwrap_or(50).min(200);

    let events: Vec<Value> = {
        let pipeline_res = state.state_tracker_results.lock().unwrap();
        let stream_res   = state.stream_tracker_state.lock().unwrap();

        // Collect transitions from pipeline results first, then streaming state.
        // Both may coexist; streaming transitions use tracker_id as the key.
        let mut all: Vec<Value> = Vec::new();

        if let Some(session_map) = pipeline_res.get(&session_id) {
            for r in session_map.values() {
                for t in &r.transitions {
                    all.push(json!({
                        "trackerId": r.tracker_id,
                        "transitionName": t.transition_name,
                        "lineNum": t.line_num,
                        "timestamp": t.timestamp,
                        "changes": t.changes,
                    }));
                }
            }
        }

        if let Some(session_map) = stream_res.get(&session_id) {
            for (tracker_id, cont) in session_map {
                for t in &cont.transitions {
                    all.push(json!({
                        "trackerId": tracker_id,
                        "transitionName": t.transition_name,
                        "lineNum": t.line_num,
                        "timestamp": t.timestamp,
                        "changes": t.changes,
                    }));
                }
            }
        }

        all.sort_by(|a, b| b["lineNum"].as_u64().cmp(&a["lineNum"].as_u64()));
        all.into_iter().take(limit).collect()
    };

    let count = events.len();
    Json(json!({
        "sessionId": session_id,
        "events": events,
        "count": count,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/correlations
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CorrelationParams {
    /// Filter to a single correlator by ID.
    correlator_id: Option<String>,
    /// Max events to return (default 50, max 200).
    limit: Option<usize>,
    /// Offset for pagination (default 0).
    offset: Option<usize>,
}

async fn h_correlations(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<CorrelationParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);

    let correlators: Vec<Value> = {
        let cr = state.correlator_results.lock().unwrap();
        match cr.get(&session_id) {
            None => vec![],
            Some(session_map) => session_map
                .iter()
                .filter(|(cid, _)| {
                    params.correlator_id.as_ref().map_or(true, |fid| fid == *cid)
                })
                .map(|(corr_id, result)| {
                    let events: Vec<Value> = result.events.iter()
                        .skip(offset)
                        .take(limit)
                        .map(|evt| {
                            json!({
                                "triggerLineNum": evt.trigger_line_num,
                                "triggerTimestamp": evt.trigger_timestamp,
                                "triggerSourceId": evt.trigger_source_id,
                                "triggerFields": evt.trigger_fields,
                                "message": evt.message,
                                "matchedSourceIds": evt.matched_sources.keys().collect::<Vec<_>>(),
                            })
                        }).collect();
                    json!({
                        "correlatorId": corr_id,
                        "totalEvents": result.events.len(),
                        "eventCount": events.len(),
                        "events": events,
                        "offset": offset,
                        "limit": limit,
                    })
                })
                .collect(),
        }
    };

    Json(json!({
        "sessionId": session_id,
        "correlators": correlators,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/tracker/{tracker_id}/state_at
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct StateAtParams {
    /// Line number to compute state at (required).
    line: usize,
}

async fn h_state_at_line(
    State(handle): State<Handle>,
    Path((session_id, tracker_id)): Path<(String, String)>,
    Query(params): Query<StateAtParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let line_num = params.line;

    // Resolve bare ID → qualified ID (e.g. "wifi-state" → "wifi-state@official")
    let resolved_id = {
        let procs = state.processors.lock().unwrap();
        resolve_processor_id(&procs, &tracker_id).unwrap_or_else(|| tracker_id.clone())
    };

    // Resolve transitions from pipeline or stream state
    let transitions: Option<Vec<StateTransition>> = {
        let pipeline_res = state.state_tracker_results.lock().unwrap();
        pipeline_res.get(&session_id)
            .and_then(|session_map| session_map.get(&resolved_id))
            .map(|r| r.transitions.clone())
    }.or_else(|| {
        let stream_res = state.stream_tracker_state.lock().unwrap();
        stream_res.get(&session_id)
            .and_then(|m| m.get(&resolved_id))
            .map(|cont| cont.transitions.clone())
    });

    let Some(transitions) = transitions else {
        return Json(json!({
            "error": format!("no tracker results for session {session_id} / tracker {resolved_id}"),
        }));
    };

    // Replay transitions up to line_num against declared defaults
    let defaults: HashMap<String, serde_json::Value> = {
        let procs = state.processors.lock().unwrap();
        match procs.get(&resolved_id).and_then(|p| p.as_state_tracker()) {
            Some(def) => build_defaults(def),
            None => HashMap::new(),
        }
    };

    let pos = transitions.partition_point(|t| t.line_num <= line_num);
    let mut fields = defaults;
    let mut initialized: Vec<String> = Vec::new();

    for t in &transitions[..pos] {
        for (field, change) in &t.changes {
            fields.insert(field.clone(), change.to.clone());
            if !initialized.contains(field) {
                initialized.push(field.clone());
            }
        }
    }

    let (snap_line, snap_ts) = if pos > 0 {
        let t = &transitions[pos - 1];
        (t.line_num, t.timestamp)
    } else {
        (0, 0)
    };

    Json(json!({
        "trackerId": resolved_id,
        "sessionId": session_id,
        "lineNum": snap_line,
        "timestamp": snap_ts,
        "fields": fields,
        "initializedFields": initialized,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/search
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SearchParams {
    /// Regex pattern to search for (required).
    pattern: String,
    /// Max results (default 50, max 200).
    limit: Option<usize>,
    /// Case insensitive search (default false).
    #[serde(default)]
    case_insensitive: Option<bool>,
    /// Context lines before and after each match (default 0, max 5).
    context: Option<usize>,
    /// Restrict search to lines >= start_line (0-based, inclusive).
    start_line: Option<usize>,
    /// Restrict search to lines < end_line (0-based, exclusive).
    end_line: Option<usize>,
}

async fn h_search(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<SearchParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let limit = params.limit.unwrap_or(50).min(200);
    let context = params.context.unwrap_or(0).min(5);
    let case_insensitive = params.case_insensitive.unwrap_or(false);

    // Compile the pattern
    let pattern_str = if case_insensitive {
        format!("(?i){}", params.pattern)
    } else {
        params.pattern.clone()
    };

    let regex = match regex::Regex::new(&pattern_str) {
        Ok(re) => re,
        Err(e) => {
            return Json(json!({
                "error": format!("invalid regex pattern: {e}"),
                "pattern": params.pattern,
            }));
        }
    };

    // Scan lines
    struct MatchResult {
        line_num: usize,
        raw: String,
        captures: Vec<String>,
        context_before: Vec<(usize, String)>,
        context_after: Vec<(usize, String)>,
    }

    let matches: Vec<MatchResult> = {
        get_session_and_source!(state, session_id => sessions, session, source);

        let total = source.total_lines();
        let range_start = params.start_line.unwrap_or(0).min(total);
        let range_end = params.end_line.unwrap_or(total).min(total);
        let mut results: Vec<MatchResult> = Vec::new();

        for i in range_start..range_end {
            if results.len() >= limit { break; }
            let Some(raw) = source.raw_line(i) else { continue };

            if let Some(caps) = regex.captures(&raw) {
                // Collect capture groups (skip group 0 = full match)
                let captures: Vec<String> = (1..caps.len())
                    .filter_map(|j| caps.get(j).map(|m| m.as_str().to_string()))
                    .collect();

                // Context lines
                let context_before: Vec<(usize, String)> = if context > 0 {
                    let start = i.saturating_sub(context);
                    (start..i)
                        .filter_map(|j| source.raw_line(j).map(|r| (j, truncate_str(&r, 500))))
                        .collect()
                } else {
                    vec![]
                };

                let context_after: Vec<(usize, String)> = if context > 0 {
                    let end = (i + 1 + context).min(total);
                    ((i + 1)..end)
                        .filter_map(|j| source.raw_line(j).map(|r| (j, truncate_str(&r, 500))))
                        .collect()
                } else {
                    vec![]
                };

                results.push(MatchResult {
                    line_num: i,
                    raw: truncate_str(&raw, 500),
                    captures,
                    context_before,
                    context_after,
                });
            }
        }
        results
    };

    let total_matches = matches.len();
    let results_json: Vec<Value> = matches.into_iter().map(|m| {
        let mut entry = json!({
            "lineNum": m.line_num,
            "raw": m.raw,
        });
        if !m.captures.is_empty() {
            entry.as_object_mut().map(|o| o.insert("captures".to_string(), json!(m.captures)));
        }
        if !m.context_before.is_empty() {
            let before: Vec<Value> = m.context_before.into_iter()
                .map(|(ln, text)| json!({ "lineNum": ln, "raw": text }))
                .collect();
            entry.as_object_mut().map(|o| o.insert("contextBefore".to_string(), json!(before)));
        }
        if !m.context_after.is_empty() {
            let after: Vec<Value> = m.context_after.into_iter()
                .map(|(ln, text)| json!({ "lineNum": ln, "raw": text }))
                .collect();
            entry.as_object_mut().map(|o| o.insert("contextAfter".to_string(), json!(after)));
        }
        entry
    }).collect();

    Json(json!({
        "sessionId": session_id,
        "pattern": params.pattern,
        "caseInsensitive": case_insensitive,
        "matchCount": total_matches,
        "limit": limit,
        "matches": results_json,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/processors — list all processor definitions
// ---------------------------------------------------------------------------

async fn h_processor_defs_list(State(handle): State<Handle>) -> Json<Value> {
    let state = handle.state::<AppState>();

    let processors: Vec<Value> = {
        let procs = state.processors.lock().unwrap();
        procs.iter().map(|(qualified_id, p)| {
            json!({
                "id": qualified_id,
                "name": p.meta.name,
                "processorType": p.processor_type(),
                "description": p.meta.description,
                "version": p.meta.version,
                "builtin": p.meta.builtin,
                "tags": p.meta.tags,
                "sections": extract_sections(p),
                "sourceTypes": extract_source_types(p),
            })
        }).collect()
    };

    Json(json!({
        "processorCount": processors.len(),
        "processors": processors,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/processors/{processor_id} — single processor definition detail
// ---------------------------------------------------------------------------

async fn h_processor_defs_single(
    State(handle): State<Handle>,
    Path(processor_id): Path<String>,
) -> Json<Value> {
    let state = handle.state::<AppState>();

    let procs = state.processors.lock().unwrap();
    let resolved = resolve_processor_id(&procs, &processor_id);
    let Some(p) = resolved.as_ref().and_then(|rid| procs.get(rid)) else {
        return Json(json!({ "error": "processor not found", "processorId": processor_id }));
    };

    let mut result = json!({
        "id": p.meta.id,
        "name": p.meta.name,
        "processorType": p.processor_type(),
        "description": p.meta.description,
        "version": p.meta.version,
        "author": p.meta.author,
        "builtin": p.meta.builtin,
        "tags": p.meta.tags,
        "sections": extract_sections(p),
        "sourceTypes": extract_source_types(p),
    });

    match &p.kind {
        ProcessorKind::Reporter(def) => {
            // Summarize filter rules
            let filters: Vec<Value> = def.pipeline.iter().filter_map(|stage| {
                use crate::processors::reporter::schema::PipelineStage;
                match stage {
                    PipelineStage::Filter(fs) => {
                        let rules: Vec<String> = fs.rules.iter().map(|r| match r {
                            crate::processors::reporter::schema::FilterRule::TagMatch { tags, .. } => format!("tag_match: [{}]", tags.join(", ")),
                            crate::processors::reporter::schema::FilterRule::MessageContains { value } => format!("message_contains: \"{value}\""),
                            crate::processors::reporter::schema::FilterRule::MessageContainsAny { values } => format!("message_contains_any: [{}]", values.join(", ")),
                            crate::processors::reporter::schema::FilterRule::MessageRegex { pattern } => format!("message_regex: \"{pattern}\""),
                            crate::processors::reporter::schema::FilterRule::LevelMin { level } => format!("level_min: {level}"),
                            crate::processors::reporter::schema::FilterRule::TimeRange { from, to, .. } => format!("time_range: {from} - {to}"),
                            crate::processors::reporter::schema::FilterRule::SourceTypeIs { source_type } => format!("source_type_is: {source_type}"),
                            crate::processors::reporter::schema::FilterRule::TagRegex { pattern } => format!("tag_regex: \"{pattern}\""),
                            crate::processors::reporter::schema::FilterRule::SectionIs { section } => format!("section_is: {section}"),
                        }).collect();
                        Some(json!(rules))
                    }
                    _ => None,
                }
            }).collect();

            // Extract patterns
            let extracts: Vec<Value> = def.pipeline.iter().filter_map(|stage| {
                use crate::processors::reporter::schema::PipelineStage;
                match stage {
                    PipelineStage::Extract(es) => {
                        let fields: Vec<Value> = es.fields.iter().map(|f| {
                            json!({
                                "name": f.name,
                                "pattern": f.pattern,
                                "cast": f.cast.as_ref().map(|c| format!("{c:?}").to_lowercase()),
                            })
                        }).collect();
                        Some(json!(fields))
                    }
                    _ => None,
                }
            }).collect();

            // Aggregation types
            let aggregations: Vec<String> = def.pipeline.iter().filter_map(|stage| {
                use crate::processors::reporter::schema::PipelineStage;
                match stage {
                    PipelineStage::Aggregate(agg) => {
                        let types: Vec<String> = agg.groups.iter().map(|g| format!("{:?}", g.agg_type).to_lowercase()).collect();
                        Some(types.join(", "))
                    }
                    _ => None,
                }
            }).collect();

            let has_script = def.pipeline.iter().any(|s| matches!(s, crate::processors::reporter::schema::PipelineStage::Script(_)));

            // Var declarations
            let vars: Vec<Value> = def.vars.iter().map(|v| {
                json!({
                    "name": v.name,
                    "type": format!("{:?}", v.var_type).to_lowercase(),
                    "display": v.display,
                    "label": v.label,
                })
            }).collect();

            let obj = result.as_object_mut().unwrap();
            obj.insert("filters".to_string(), json!(filters));
            obj.insert("extracts".to_string(), json!(extracts));
            obj.insert("aggregations".to_string(), json!(aggregations));
            obj.insert("hasScript".to_string(), json!(has_script));
            obj.insert("vars".to_string(), json!(vars));
        }
        ProcessorKind::StateTracker(def) => {
            let state_fields: Vec<Value> = def.state.iter().map(|f| {
                json!({
                    "name": f.name,
                    "type": format!("{:?}", f.field_type).to_lowercase(),
                    "default": f.default,
                })
            }).collect();

            let transition_names: Vec<String> = def.transitions.iter().map(|t| t.name.clone()).collect();

            let obj = result.as_object_mut().unwrap();
            obj.insert("group".to_string(), json!(def.group));
            obj.insert("stateFields".to_string(), json!(state_fields));
            obj.insert("transitionNames".to_string(), json!(transition_names));
        }
        ProcessorKind::Correlator(def) => {
            let source_ids: Vec<String> = def.sources.iter().map(|s| s.id.clone()).collect();

            let obj = result.as_object_mut().unwrap();
            obj.insert("sourceIds".to_string(), json!(source_ids));
            obj.insert("trigger".to_string(), json!(def.correlate.trigger));
            obj.insert("withinLines".to_string(), json!(def.correlate.within_lines));
            obj.insert("withinMs".to_string(), json!(def.correlate.within_ms));
            obj.insert("guidance".to_string(), json!(def.correlate.guidance));
        }
        ProcessorKind::Transformer(_) => {
            // Minimal info already in base result
        }
    }

    Json(result)
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/metadata
// ---------------------------------------------------------------------------

async fn h_metadata(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let state = handle.state::<AppState>();

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

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/sections
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SectionsParams {
    /// Max sections to return (default 50, max 200).
    limit: Option<usize>,
    /// Number of sections to skip (default 0).
    offset: Option<usize>,
    /// Case-insensitive substring filter on section name.
    query: Option<String>,
}

async fn h_sections(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<SectionsParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();

    get_session_and_source!(state, session_id => sessions, session, source);

    let all_sections = source.sections();
    let query_lower = params.query.as_deref().map(str::to_lowercase);

    // Apply name filter
    let filtered: Vec<&crate::core::session::SectionInfo> = all_sections.iter()
        .filter(|s| match &query_lower {
            Some(q) => s.name.to_lowercase().contains(q),
            None => true,
        })
        .collect();

    let total = filtered.len();
    let offset = params.offset.unwrap_or(0);
    let limit = params.limit.unwrap_or(50).min(200);

    let page: Vec<Value> = filtered.iter()
        .skip(offset)
        .take(limit)
        .map(|s| {
            let mut obj = json!({
                "name": s.name,
                "startLine": s.start_line,
                "endLine": s.end_line,
            });
            if let Some(pi) = s.parent_index {
                obj["parentIndex"] = json!(pi);
            }
            obj
        })
        .collect();

    Json(json!({
        "sessionId": session_id,
        "total": total,
        "returned": page.len(),
        "offset": offset,
        "limit": limit,
        "sections": page,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/tag-stats?top_n=50
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct TagStatsParams {
    /// Number of top tags to return (default 50).
    top_n: Option<usize>,
}

async fn h_tag_stats(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<TagStatsParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let top_n = params.top_n.unwrap_or(50);

    // Aggregate inside the lock (fast iteration, no allocations), then drop.
    let (total_lines, level_dist, tag_counts, tag_table) = {
        get_session_and_source!(state, session_id => sessions, session, source);

        let mut level_dist: HashMap<&'static str, usize> = HashMap::new();
        let mut tag_counts: HashMap<u16, usize> = HashMap::new();
        for m in source.line_meta_slice() {
            *level_dist.entry(m.level.as_str()).or_insert(0) += 1;
            *tag_counts.entry(m.tag_id).or_insert(0) += 1;
        }
        (
            source.total_lines(),
            level_dist,
            tag_counts,
            session.tag_table().to_vec(),
        )
    }; // lock drops here

    // Resolve tag IDs and sort by count descending
    let mut top_tags: Vec<Value> = tag_counts
        .into_iter()
        .map(|(tag_id, count)| {
            let tag = tag_table
                .get(tag_id as usize)
                .map_or("<unknown>", std::string::String::as_str);
            json!({ "tag": tag, "count": count })
        })
        .collect();
    top_tags.sort_by(|a, b| {
        b["count"].as_u64().unwrap_or(0).cmp(&a["count"].as_u64().unwrap_or(0))
    });
    top_tags.truncate(top_n);

    Json(json!({
        "sessionId": session_id,
        "totalLines": total_lines,
        "logLevelDistribution": level_dist,
        "topTags": top_tags,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/lines_around?line=N&before=50&after=20
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct LinesAroundParams {
    /// Center line number (required).
    line: usize,
    /// Number of lines before the center (default 20, max 100).
    before: Option<usize>,
    /// Number of lines after the center (default 20, max 100).
    after: Option<usize>,
}

async fn h_lines_around(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<LinesAroundParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let before = params.before.unwrap_or(20).min(100);
    let after = params.after.unwrap_or(20).min(100);
    let center = params.line;

    get_session_and_source!(state, session_id => sessions, session, source);

    let total = source.total_lines();
    let start = center.saturating_sub(before);
    let end = (center + after + 1).min(total);

    let lines: Vec<Value> = (start..end)
        .filter_map(|i| {
            let raw = source.raw_line(i)?;
            let meta = source.meta_at(i)?;
            Some(json!({
                "lineNum": i,
                "level": meta.level.as_str(),
                "tag": session.resolve_tag(meta.tag_id),
                "raw": truncate_str(&raw, 500),
                "isCenter": i == center,
            }))
        })
        .collect();

    Json(json!({
        "sessionId": session_id,
        "centerLine": center,
        "totalLinesInSession": total,
        "lineCount": lines.len(),
        "lines": lines,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/search_with_context
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SearchWithContextParams {
    /// Search query (regex pattern).
    query: String,
    /// Max matches to return (default 10, max 50).
    max_results: Option<usize>,
    /// Context lines before and after each match (default 3, max 10).
    context_lines: Option<usize>,
    /// Case insensitive (default false).
    #[serde(default)]
    case_insensitive: Option<bool>,
    /// Number of matches to skip before collecting results (default 0).
    offset: Option<usize>,
    /// Restrict search to lines >= start_line (0-based, inclusive).
    start_line: Option<usize>,
    /// Restrict search to lines < end_line (0-based, exclusive).
    end_line: Option<usize>,
}

async fn h_search_with_context(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<SearchWithContextParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let max_results = params.max_results.unwrap_or(10).min(50);
    let context_lines = params.context_lines.unwrap_or(3).min(10);
    let case_insensitive = params.case_insensitive.unwrap_or(false);
    let offset = params.offset.unwrap_or(0);

    let pattern_str = if case_insensitive {
        format!("(?i){}", params.query)
    } else {
        params.query.clone()
    };

    let regex = match regex::Regex::new(&pattern_str) {
        Ok(re) => re,
        Err(e) => {
            return Json(json!({
                "error": format!("invalid regex: {e}"),
                "query": params.query,
            }));
        }
    };

    get_session_and_source!(state, session_id => sessions, session, source);

    let total = source.total_lines();
    let range_start = params.start_line.unwrap_or(0).min(total);
    let range_end = params.end_line.unwrap_or(total).min(total);
    let mut results: Vec<Value> = Vec::new();
    let mut skipped: usize = 0;

    for i in range_start..range_end {
        if results.len() >= max_results {
            break;
        }
        let Some(raw) = source.raw_line(i) else { continue };

        if regex.is_match(&raw) {
            // Skip the first `offset` matches
            if skipped < offset {
                skipped += 1;
                continue;
            }
            // Build context
            let ctx_start = i.saturating_sub(context_lines);
            let ctx_end = (i + context_lines + 1).min(total);

            let context: Vec<Value> = (ctx_start..ctx_end)
                .filter_map(|j| {
                    let line_raw = source.raw_line(j)?;
                    let meta = source.meta_at(j)?;
                    Some(json!({
                        "lineNum": j,
                        "level": meta.level.as_str(),
                        "tag": session.resolve_tag(meta.tag_id),
                        "raw": truncate_str(&line_raw, 500),
                        "isMatch": j == i,
                    }))
                })
                .collect();

            results.push(json!({
                "matchLineNum": i,
                "context": context,
            }));
        }
    }

    Json(json!({
        "sessionId": session_id,
        "query": params.query,
        "caseInsensitive": case_insensitive,
        "matchCount": results.len(),
        "maxResults": max_results,
        "contextLines": context_lines,
        "offset": offset,
        "totalLinesInSession": total,
        "matches": results,
    }))
}

// ---------------------------------------------------------------------------
// Bookmark endpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct BookmarkListQuery {
    category: Option<String>,
    tag: Option<String>,
}

async fn h_list_bookmarks(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<BookmarkListQuery>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let bookmarks = state.bookmarks.lock().unwrap();
    let list: Vec<_> = bookmarks
        .get(&session_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|bm| {
            if let Some(ref cat) = query.category {
                if bm.category.as_deref() != Some(cat.as_str()) {
                    return false;
                }
            }
            if let Some(ref tag) = query.tag {
                let has_tag = bm
                    .tags
                    .as_ref()
                    .is_some_and(|tags| tags.iter().any(|t| t == tag));
                if !has_tag {
                    return false;
                }
            }
            true
        })
        .collect();
    Json(json!(list))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBookmarkBody {
    line_number: u32,
    #[serde(default)]
    label: String,
    #[serde(default)]
    note: String,
    line_number_end: Option<u32>,
    snippet: Option<Vec<String>>,
    category: Option<String>,
    tags: Option<Vec<String>>,
}

async fn h_create_bookmark(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Json(body): Json<CreateBookmarkBody>,
) -> Json<Value> {
    use crate::core::bookmark::{Bookmark, BookmarkUpdateEvent, CreatedBy};

    let state = handle.state::<AppState>();

    verify_session_exists!(state, session_id);

    let bookmark = Bookmark {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        line_number: body.line_number,
        line_number_end: body.line_number_end,
        snippet: body.snippet,
        category: body.category,
        tags: body.tags,
        label: body.label,
        note: body.note,
        created_by: CreatedBy::Agent,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
    };

    {
        let mut bookmarks = state.bookmarks.lock().unwrap();
        bookmarks
            .entry(session_id.clone())
            .or_default()
            .push(bookmark.clone());
    }

    use tauri::Emitter;
    let _ = handle.emit(
        "bookmark-update",
        BookmarkUpdateEvent {
            session_id,
            action: "created".to_string(),
            bookmark: bookmark.clone(),
        },
    );

    Json(json!(bookmark))
}

async fn h_delete_bookmark(
    State(handle): State<Handle>,
    Path((session_id, bookmark_id)): Path<(String, String)>,
) -> Json<Value> {
    use crate::core::bookmark::BookmarkUpdateEvent;

    let state = handle.state::<AppState>();
    let mut bookmarks = state.bookmarks.lock().unwrap();

    if let Some(list) = bookmarks.get_mut(&session_id) {
        if let Some(idx) = list.iter().position(|b| b.id == bookmark_id) {
            let removed = list.remove(idx);
            drop(bookmarks);

            use tauri::Emitter;
            let _ = handle.emit(
                "bookmark-update",
                BookmarkUpdateEvent {
                    session_id,
                    action: "deleted".to_string(),
                    bookmark: removed,
                },
            );

            return Json(json!({"ok": true}));
        }
    }

    Json(json!({"error": format!("Bookmark not found: {bookmark_id}")}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBookmarkBody {
    label: Option<String>,
    note: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
}

async fn h_update_bookmark(
    State(handle): State<Handle>,
    Path((session_id, bookmark_id)): Path<(String, String)>,
    Json(body): Json<UpdateBookmarkBody>,
) -> Json<Value> {
    use crate::core::bookmark::BookmarkUpdateEvent;

    let state = handle.state::<AppState>();
    let mut bookmarks = state.bookmarks.lock().unwrap();

    if let Some(list) = bookmarks.get_mut(&session_id) {
        if let Some(bm) = list.iter_mut().find(|b| b.id == bookmark_id) {
            if let Some(l) = body.label {
                bm.label = l;
            }
            if let Some(n) = body.note {
                bm.note = n;
            }
            if let Some(c) = body.category {
                bm.category = Some(c);
            }
            if let Some(t) = body.tags {
                bm.tags = Some(t);
            }
            let updated = bm.clone();
            drop(bookmarks);

            use tauri::Emitter;
            let _ = handle.emit(
                "bookmark-update",
                BookmarkUpdateEvent {
                    session_id,
                    action: "updated".to_string(),
                    bookmark: updated.clone(),
                },
            );

            return Json(json!(updated));
        }
    }

    Json(json!({"error": format!("Bookmark not found: {bookmark_id}")}))
}

// ---------------------------------------------------------------------------
// Analysis endpoints
// ---------------------------------------------------------------------------

async fn h_list_analyses(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let analyses = state.analyses.lock().unwrap();
    let list = analyses.get(&session_id).cloned().unwrap_or_default();
    Json(json!(list))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishAnalysisBody {
    title: String,
    sections: Vec<crate::core::analysis::AnalysisSection>,
}

async fn h_publish_analysis(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Json(body): Json<PublishAnalysisBody>,
) -> Json<Value> {
    use crate::core::analysis::{AnalysisArtifact, AnalysisUpdateEvent};

    let state = handle.state::<AppState>();

    verify_session_exists!(state, session_id);

    let artifact = AnalysisArtifact {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        title: body.title,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
        sections: body.sections,
    };

    {
        let mut analyses = state.analyses.lock().unwrap();
        analyses
            .entry(session_id.clone())
            .or_default()
            .push(artifact.clone());
    }

    use tauri::Emitter;
    let _ = handle.emit(
        "analysis-update",
        AnalysisUpdateEvent {
            session_id,
            action: "published".to_string(),
            artifact_id: artifact.id.clone(),
        },
    );

    Json(json!(artifact))
}

async fn h_get_analysis(
    State(handle): State<Handle>,
    Path((session_id, artifact_id)): Path<(String, String)>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let analyses = state.analyses.lock().unwrap();
    if let Some(list) = analyses.get(&session_id) {
        if let Some(art) = list.iter().find(|a| a.id == artifact_id) {
            return Json(json!(art));
        }
    }
    Json(json!({"error": format!("Analysis not found: {artifact_id}")}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAnalysisBody {
    title: Option<String>,
    sections: Option<Vec<crate::core::analysis::AnalysisSection>>,
}

async fn h_update_analysis(
    State(handle): State<Handle>,
    Path((session_id, artifact_id)): Path<(String, String)>,
    Json(body): Json<UpdateAnalysisBody>,
) -> Json<Value> {
    use crate::core::analysis::AnalysisUpdateEvent;

    let state = handle.state::<AppState>();
    let mut analyses = state.analyses.lock().unwrap();

    if let Some(list) = analyses.get_mut(&session_id) {
        if let Some(art) = list.iter_mut().find(|a| a.id == artifact_id) {
            if let Some(t) = body.title {
                art.title = t;
            }
            if let Some(s) = body.sections {
                art.sections = s;
            }
            let updated = art.clone();
            drop(analyses);

            use tauri::Emitter;
            let _ = handle.emit(
                "analysis-update",
                AnalysisUpdateEvent {
                    session_id,
                    action: "updated".to_string(),
                    artifact_id: updated.id.clone(),
                },
            );

            return Json(json!(updated));
        }
    }

    Json(json!({"error": format!("Analysis not found: {artifact_id}")}))
}

async fn h_delete_analysis(
    State(handle): State<Handle>,
    Path((session_id, artifact_id)): Path<(String, String)>,
) -> Json<Value> {
    use crate::core::analysis::AnalysisUpdateEvent;

    let state = handle.state::<AppState>();
    let mut analyses = state.analyses.lock().unwrap();

    if let Some(list) = analyses.get_mut(&session_id) {
        if let Some(idx) = list.iter().position(|a| a.id == artifact_id) {
            list.remove(idx);
            drop(analyses);

            use tauri::Emitter;
            let _ = handle.emit(
                "analysis-update",
                AnalysisUpdateEvent {
                    session_id,
                    action: "deleted".to_string(),
                    artifact_id,
                },
            );

            return Json(json!({"ok": true}));
        }
    }

    Json(json!({"error": format!("Analysis not found: {artifact_id}")}))
}

// ---------------------------------------------------------------------------
// Watch endpoints
// ---------------------------------------------------------------------------

async fn h_list_watches(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let watches = state.active_watches.lock().unwrap();
    let list = watches.get(&session_id);
    let infos: Vec<Value> = list
        .map(|ws| {
            ws.iter()
                .map(|w| {
                    json!({
                        "watchId": w.watch_id,
                        "sessionId": w.session_id,
                        "totalMatches": w.total_matches(),
                        "active": w.is_active(),
                        "criteria": serde_json::to_value(&w.criteria).unwrap_or(json!(null)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Json(json!(infos))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWatchBody {
    #[serde(flatten)]
    criteria: crate::core::filter::FilterCriteria,
}

async fn h_create_watch(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Json(body): Json<CreateWatchBody>,
) -> Json<Value> {
    use std::sync::Arc;
    use crate::core::watch::{WatchSession, WatchInfo};

    let state = handle.state::<AppState>();

    verify_session_exists!(state, session_id);

    let watch_id = uuid::Uuid::new_v4().to_string();
    let watch = Arc::new(WatchSession::new(
        watch_id,
        session_id.clone(),
        body.criteria.clone(),
    ));

    let info = WatchInfo {
        watch_id: watch.watch_id.clone(),
        session_id: watch.session_id.clone(),
        total_matches: 0,
        active: true,
        criteria: body.criteria,
    };

    {
        let mut watches = state.active_watches.lock().unwrap();
        watches
            .entry(session_id)
            .or_default()
            .push(watch);
    }

    Json(json!(info))
}

async fn h_cancel_watch(
    State(handle): State<Handle>,
    Path((session_id, watch_id)): Path<(String, String)>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let watches = state.active_watches.lock().unwrap();
    if let Some(list) = watches.get(&session_id) {
        if let Some(w) = list.iter().find(|w| w.watch_id == watch_id) {
            w.cancel();
            return Json(json!({"ok": true}));
        }
    }
    Json(json!({"error": format!("Watch not found: {watch_id}")}))
}

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/run_pipeline
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunPipelineBody {
    /// Processor IDs to run. If omitted, runs all installed processors.
    processor_ids: Option<Vec<String>>,
}

async fn h_run_pipeline(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Json(body): Json<RunPipelineBody>,
) -> Json<Value> {
    use crate::commands::pipeline::execute_pipeline;

    let state = handle.state::<AppState>();

    verify_session_exists!(state, session_id);

    // Resolve processor IDs — use provided list or all installed processors.
    // Bare IDs (e.g. "wifi-state") are resolved to qualified keys ("wifi-state@official").
    let processor_ids: Vec<String> = match body.processor_ids {
        Some(ids) if !ids.is_empty() => {
            let procs = state.processors.lock().unwrap();
            ids.into_iter()
                .map(|id| resolve_processor_id(&procs, &id).unwrap_or(id))
                .collect()
        }
        _ => {
            let procs = state.processors.lock().unwrap();
            procs.keys().cloned().collect()
        }
    };

    // Pipeline is CPU-heavy (rayon); run on a blocking thread to avoid starving
    // the Axum async runtime.
    let handle_clone = handle.clone();
    let sid = session_id.clone();
    let pids = processor_ids.clone();

    let result = tokio::task::spawn_blocking(move || {
        let state_ref = handle_clone.state::<AppState>();
        execute_pipeline(&state_ref, &handle_clone, &sid, &pids)
    }).await;

    match result {
        Ok(Ok(ref summaries)) => Json(json!({
            "sessionId": session_id,
            "summaries": summaries,
            "processorCount": summaries.len(),
        })),
        Ok(Err(e)) => Json(json!({ "error": e })),
        Err(e) => Json(json!({ "error": format!("Pipeline task panicked: {e}") })),
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/insights
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct InsightsParams {
    /// Max total signal events to return across all processors (default 20).
    max_signals: Option<usize>,
    /// Comma-separated list of processor IDs to include. If absent, all are included.
    processor_ids: Option<String>,
}

async fn h_insights(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<InsightsParams>,
) -> Json<Value> {
    use crate::processors::marketplace::{McpSchema, Severity, SignalType};
    use crate::processors::signals::{eval_parsed_condition, render_template};

    let state = handle.state::<AppState>();
    let max_signals = params.max_signals.unwrap_or(20);

    let filter_ids: Option<std::collections::HashSet<String>> = params.processor_ids.map(|s| {
        s.split(',').map(|id| id.trim().to_string()).filter(|s| !s.is_empty()).collect()
    });

    fn severity_rank(s: &Severity) -> u8 {
        match s {
            Severity::Critical => 0,
            Severity::Warning  => 1,
            Severity::Info     => 2,
        }
    }

    /// Evaluated signals and summary for one processor, computed while holding the lock.
    struct ProcSnap {
        id: String,
        name: String,
        total_emissions: usize,
        summary: Option<String>,
        all_signals: Vec<Value>,
        signal_counts: HashMap<String, usize>,
        has_mcp_schema: bool,
    }

    let proc_snaps: Vec<ProcSnap> = {
        // Collect (qualified_id, display_name, schema) — qualified_id is the HashMap key.
        let proc_meta: Vec<(String, String, Option<McpSchema>)> = {
            let procs = state.processors.lock().unwrap();
            procs.iter()
                .filter(|(qid, p)| {
                    if let Some(ref ids) = filter_ids {
                        ids.contains(qid.as_str()) || ids.contains(&p.meta.id)
                    } else {
                        true
                    }
                })
                .map(|(qid, p)| (
                    qid.clone(),
                    p.meta.name.clone(),
                    p.schema.as_ref().and_then(|s| s.mcp.clone()),
                ))
                .collect()
        };

        // Evaluate signals in-place while holding pipeline_results lock (pure CPU, no I/O).
        let all_results = state.pipeline_results.lock().unwrap();
        let session_map = all_results.get(&session_id);

        proc_meta.into_iter().map(|(id, name, schema_mcp)| {
            let rr = session_map.and_then(|m| m.get(&id));
            let total_emissions = rr.map_or(0, |r| r.emissions.len());

            let Some(ref mcp) = schema_mcp else {
                return ProcSnap {
                    id, name, total_emissions,
                    summary: None,
                    all_signals: Vec::new(),
                    signal_counts: HashMap::new(),
                    has_mcp_schema: false,
                };
            };

            let summary = if let (Some(ref mcp_summary), Some(rr)) = (&mcp.summary, rr) {
                let vars_map: HashMap<String, Value> = if mcp_summary.include_vars.is_empty() {
                    rr.vars.clone()
                } else {
                    mcp_summary.include_vars.iter()
                        .filter_map(|k| rr.vars.get(k).map(|v| (k.clone(), v.clone())))
                        .collect()
                };
                Some(render_template(&mcp_summary.template, &vars_map))
            } else {
                None
            };

            let mut all_signals: Vec<Value> = Vec::new();
            let mut signal_counts: HashMap<String, usize> = HashMap::new();

            if let Some(rr) = rr {
                for sig_def in &mcp.signals {
                    let count_entry = signal_counts.entry(sig_def.name.clone()).or_insert(0);

                    if sig_def.signal_type == SignalType::Aggregate {
                        if eval_parsed_condition(sig_def.parsed_condition.as_ref(), &rr.vars) {
                            *count_entry += 1;
                            let first_line = rr.emissions.first().map(|e| e.line_num);
                            let last_line = rr.emissions.last().map(|e| e.line_num);
                            let requested_fields: HashMap<String, Value> = sig_def.fields.iter()
                                .filter_map(|f| rr.vars.get(f).map(|v| (f.clone(), v.clone())))
                                .collect();
                            let message = sig_def.format.as_deref()
                                .map(|fmt| render_template(fmt, &rr.vars));
                            all_signals.push(json!({
                                "name": sig_def.name,
                                "severity": sig_def.severity,
                                "line": first_line,
                                "last_line": last_line,
                                "timestamp": null,
                                "message": message,
                                "fields": requested_fields,
                            }));
                        }
                    } else {
                        for emission in &rr.emissions {
                            let emission_fields: HashMap<String, Value> =
                                emission.fields.iter().cloned().collect();
                            if eval_parsed_condition(sig_def.parsed_condition.as_ref(), &emission_fields) {
                                *count_entry += 1;
                                let requested_fields: HashMap<String, Value> = sig_def.fields.iter()
                                    .filter_map(|f| emission_fields.get(f).map(|v| (f.clone(), v.clone())))
                                    .collect();
                                let message = sig_def.format.as_deref()
                                    .map(|fmt| render_template(fmt, &emission_fields));
                                all_signals.push(json!({
                                    "name": sig_def.name,
                                    "severity": sig_def.severity,
                                    "line": emission.line_num,
                                    "timestamp": null,
                                    "message": message,
                                    "fields": requested_fields,
                                }));
                            }
                        }
                    }
                }
            }

            all_signals.sort_by(|a, b| {
                let sa = a.get("severity").and_then(|v| serde_json::from_value::<Severity>(v.clone()).ok());
                let sb = b.get("severity").and_then(|v| serde_json::from_value::<Severity>(v.clone()).ok());
                let ra = sa.as_ref().map_or(2, severity_rank);
                let rb = sb.as_ref().map_or(2, severity_rank);
                ra.cmp(&rb)
            });

            ProcSnap { id, name, total_emissions, summary, all_signals, signal_counts, has_mcp_schema: true }
        }).collect()
    };

    let mut processors_out: Vec<Value> = Vec::new();

    for mut snap in proc_snaps {
        if !snap.has_mcp_schema {
            processors_out.push(json!({
                "processor_id": snap.id,
                "processor_name": snap.name,
                "summary": null,
                "signals": [],
                "signal_counts": {},
                "total_emissions": snap.total_emissions,
                "truncated": false,
            }));
            continue;
        }

        let truncated = snap.all_signals.len() > max_signals;
        snap.all_signals.truncate(max_signals);

        processors_out.push(json!({
            "processor_id": snap.id,
            "processor_name": snap.name,
            "summary": snap.summary,
            "signals": snap.all_signals,
            "signal_counts": snap.signal_counts,
            "total_emissions": snap.total_emissions,
            "truncated": truncated,
        }));
    }

    Json(json!({
        "session_id": session_id,
        "processors": processors_out,
    }))
}

// ---------------------------------------------------------------------------
// Sampling helpers
// ---------------------------------------------------------------------------

fn sample_indices(total: usize, n: usize, strategy: &str, around: Option<usize>) -> Vec<usize> {
    if total == 0 {
        return vec![];
    }
    let n = n.min(total);
    match strategy {
        "recent" => {
            let start = total.saturating_sub(n);
            (start..total).collect()
        }
        "around" => {
            let center = around.unwrap_or_else(|| total.saturating_sub(1));
            let half = n / 2;
            let start = center.saturating_sub(half);
            let end = (start + n).min(total);
            (start..end).collect()
        }
        _ => {
            // "uniform" — evenly spaced across the whole log
            if n >= total {
                (0..total).collect()
            } else {
                (0..n).map(|i| (i * total) / n).collect()
            }
        }
    }
}

/// Returns true if `line_level` (e.g. "Info") is >= the minimum `filter`
/// (e.g. "W" or "Warn"). Comparison is by priority: V < D < I < W < E < F.
fn level_at_least(line_level: &str, filter: &str) -> bool {
    fn priority(s: &str) -> u8 {
        match s.to_uppercase().chars().next().unwrap_or('I') {
            'V' => 0,
            'D' => 1,
            'W' => 3,
            'E' => 4,
            'F' => 5,
            _ => 2, // 'I' and unknown
        }
    }
    priority(line_level) >= priority(filter)
}
