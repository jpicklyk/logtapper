//! HTTP bridge for the LogTapper MCP server.
//!
//! A TypeScript MCP server process (stdio transport) talks to Claude Code/Desktop.
//! That process queries THIS local HTTP server on `127.0.0.1:40404` to read live
//! AppState data — sessions, sampled log lines, and state-tracker events.
//!
//! Lock discipline: acquire a Mutex, copy/clone the data needed, drop the lock,
//! THEN build the JSON response. Never hold a lock across an `.await`.

use std::collections::HashMap;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    middleware,
    routing::get,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Wry};

use crate::anonymizer::LogAnonymizer;
use crate::commands::AppState;

pub const PORT: u16 = 40404;

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

pub async fn start(handle: Handle) {
    // Clone handle for the router state; keep original for the port flag.
    let router = Router::new()
        .route("/mcp/status", get(h_status))
        .route("/mcp/sessions", get(h_sessions))
        .route("/mcp/sessions/{session_id}/query", get(h_query))
        .route("/mcp/sessions/{session_id}/pipeline", get(h_pipeline))
        .route("/mcp/sessions/{session_id}/events", get(h_events))
        .layer(middleware::from_fn_with_state(handle.clone(), record_activity))
        .with_state(handle.clone());

    match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(listener) => {
            // Record that the bridge is running so the frontend can show status.
            let state = handle.state::<AppState>();
            if let Ok(mut p) = state.mcp_bridge_port.lock() {
                *p = Some(PORT);
            }
            drop(state);
            log::info!("MCP bridge listening on 127.0.0.1:{PORT}");
            if let Err(e) = axum::serve(listener, router).await {
                log::error!("MCP bridge error: {e}");
            }
        }
        Err(e) => {
            log::error!(
                "MCP bridge: cannot bind to 127.0.0.1:{PORT} — {e}. \
                 Is another instance running?"
            );
        }
    }
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
                let sources: Vec<Value> = session
                    .sources
                    .iter()
                    .map(|src| {
                        json!({
                            "id": src.id,
                            "name": src.name,
                            "sourceType": src.source_type.to_string(),
                            "totalLines": src.total_lines(),
                        })
                    })
                    .collect();
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
}

async fn h_query(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<QueryParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let n = params.n.unwrap_or(50).min(200);
    let strategy = params.strategy.as_deref().unwrap_or("recent");

    // Snapshot the lines we need without holding the lock into async territory.
    struct LineSnap {
        line_num: usize,
        level: String,   // e.g. "Info", "Error"
        tag: String,
        raw: String,
    }

    let (snaps, total_lines): (Vec<LineSnap>, usize) = {
        let sessions = state.sessions.lock().unwrap();
        let Some(session) = sessions.get(&session_id) else {
            return Json(json!({ "error": "session not found", "sessionId": session_id }));
        };
        let Some(source) = session.primary_source() else {
            return Json(json!({ "error": "session has no sources", "sessionId": session_id }));
        };

        let total = source.total_lines();
        let indices = sample_indices(total, n, strategy, params.around_line);

        let snaps = indices
            .into_iter()
            .filter_map(|i| {
                let raw = source.raw_line(i)?.to_string();
                let meta = source.meta_at(i)?;
                Some(LineSnap {
                    line_num: i,
                    level: format!("{:?}", meta.level),
                    tag: meta.tag.clone(),
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
    let has_filter = params.tag.is_some() || params.message.is_some() || params.level.is_some();
    const SCAN_CAP: usize = 100_000;

    let snaps = if has_filter {
        // Rebuild snap list by scanning real lines instead of using the sample.
        let sessions = state.sessions.lock().unwrap();
        let Some(session) = sessions.get(&session_id) else {
            return Json(json!({ "error": "session not found", "sessionId": session_id }));
        };
        let Some(source) = session.primary_source() else {
            return Json(json!({ "error": "session has no sources", "sessionId": session_id }));
        };

        // Build the scan order based on strategy.
        let scan_indices: Vec<usize> = match strategy {
            "recent" => {
                let start = total_lines.saturating_sub(SCAN_CAP);
                (start..total_lines).rev().collect()
            }
            "around" => {
                let center = params.around_line.unwrap_or(total_lines.saturating_sub(1));
                let half = SCAN_CAP / 2;
                let start = center.saturating_sub(half);
                let end = (center + half).min(total_lines);
                // Interleave outward from center: center, center-1, center+1, …
                let before: Vec<usize> = (start..=center).rev().collect();
                let after: Vec<usize> = ((center + 1)..end).collect();
                before.into_iter().zip(after.into_iter().map(Some).chain(std::iter::repeat(None)))
                    .flat_map(|(b, a)| std::iter::once(b).chain(a))
                    .collect()
            }
            _ => {
                // uniform: scan all (up to cap) in order
                let start = total_lines.saturating_sub(SCAN_CAP);
                (start..total_lines).collect()
            }
        };

        let msg_needle = params.message.as_ref().map(|m| m.to_lowercase());
        let mut matched: Vec<LineSnap> = Vec::new();
        for i in scan_indices {
            if matched.len() >= n { break; }
            let Some(raw) = source.raw_line(i) else { continue };
            let Some(meta) = source.meta_at(i) else { continue };
            let level_str = format!("{:?}", meta.level);
            // Tag filter
            if let Some(ref tf) = params.tag {
                if &meta.tag != tf { continue; }
            }
            // Message filter (case-insensitive)
            if let Some(ref needle) = msg_needle {
                if !raw.to_lowercase().contains(needle.as_str()) { continue; }
            }
            // Level filter
            if let Some(ref lf) = params.level {
                if !level_at_least(&level_str, lf) { continue; }
            }
            matched.push(LineSnap { line_num: i, level: level_str, tag: meta.tag.clone(), raw: raw.to_string() });
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
    let mut level_counts: HashMap<String, usize> = HashMap::new();

    let lines: Vec<Value> = snaps
        .into_iter()
        .map(|snap| {
            *tag_counts.entry(snap.tag.clone()).or_insert(0) += 1;
            *level_counts.entry(snap.level.clone()).or_insert(0) += 1;
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

async fn h_pipeline(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let state = handle.state::<AppState>();

    // --- Reporter results ---
    let reporter_results: Vec<Value> = {
        let results = state.pipeline_results.lock().unwrap();
        let procs = state.processors.lock().unwrap();
        match results.get(&session_id) {
            None => vec![],
            Some(session_map) => session_map
                .iter()
                .map(|(proc_id, run_result)| {
                    let name = procs
                        .get(proc_id)
                        .map(|p| p.meta.name.clone())
                        .unwrap_or_else(|| proc_id.clone());
                    // Summarise vars — omit empty maps/lists to keep output compact.
                    let vars: serde_json::Map<String, Value> = run_result
                        .vars
                        .iter()
                        .filter_map(|(k, v)| {
                            match v {
                                Value::Array(a) if a.is_empty() => None,
                                Value::Object(o) if o.is_empty() => None,
                                _ => Some((k.clone(), v.clone())),
                            }
                        })
                        .collect();
                    json!({
                        "processorId": proc_id,
                        "processorType": "reporter",
                        "name": name,
                        "matchedLines": run_result.matched_line_nums.len(),
                        "emissions": run_result.emissions.len(),
                        "vars": vars,
                    })
                })
                .collect(),
        }
    };

    // --- State tracker results (pipeline run OR live stream) ---
    // Pipeline runs store results in state_tracker_results.
    // Streaming runs accumulate in stream_tracker_state.
    // Check both; pipeline results take priority when present.
    let tracker_results: Vec<Value> = {
        let pipeline_res = state.state_tracker_results.lock().unwrap();
        let stream_res   = state.stream_tracker_state.lock().unwrap();
        let procs        = state.processors.lock().unwrap();

        let from_pipeline = pipeline_res.get(&session_id);
        let from_stream   = stream_res.get(&session_id);

        if from_pipeline.is_none() && from_stream.is_none() {
            vec![]
        } else {
            // Collect all tracker IDs from either source.
            let mut tracker_ids: Vec<String> = from_pipeline
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            if let Some(sm) = from_stream {
                for id in sm.keys() {
                    if !tracker_ids.contains(id) { tracker_ids.push(id.clone()); }
                }
            }
            tracker_ids.into_iter().map(|tracker_id| {
                let name = procs.get(&tracker_id)
                    .map(|p| p.meta.name.clone())
                    .unwrap_or_else(|| tracker_id.clone());

                // Prefer pipeline result; fall back to stream state.
                let (transitions, final_state): (&[_], serde_json::Value) =
                    if let Some(pr) = from_pipeline.and_then(|m| m.get(&tracker_id)) {
                        (pr.transitions.as_slice(), json!(pr.final_state))
                    } else if let Some(sr) = from_stream.and_then(|m| m.get(&tracker_id)) {
                        (sr.transitions.as_slice(), json!(sr.current_state))
                    } else {
                        (&[], json!({}))
                    };

                json!({
                    "processorId": tracker_id,
                    "processorType": "state_tracker",
                    "name": name,
                    "transitionCount": transitions.len(),
                    "finalState": final_state,
                    "recentTransitions": transitions.iter().rev().take(5)
                        .map(|t| json!({
                            "lineNum": t.line_num,
                            "transitionName": t.transition_name,
                            "changes": t.changes,
                        }))
                        .collect::<Vec<_>>(),
                })
            }).collect()
        }
    };

    let has_any = !reporter_results.is_empty() || !tracker_results.is_empty();
    Json(json!({
        "sessionId": session_id,
        "hasResults": has_any,
        "reporters": reporter_results,
        "stateTrackers": tracker_results,
    }))
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
            let center = around.unwrap_or(total.saturating_sub(1));
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
            'I' => 2,
            'W' => 3,
            'E' => 4,
            'F' => 5,
            _ => 2,
        }
    }
    priority(line_level) >= priority(filter)
}
