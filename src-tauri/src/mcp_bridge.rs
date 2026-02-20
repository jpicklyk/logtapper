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
    routing::get,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::AppState;

pub const PORT: u16 = 40404;

/// Concrete handle type — Wry is the only desktop runtime Tauri ships.
type Handle = AppHandle<Wry>;

// ---------------------------------------------------------------------------
// Entry point (spawned as a tokio task from lib.rs setup)
// ---------------------------------------------------------------------------

pub async fn start(handle: Handle) {
    let router = Router::new()
        .route("/mcp/status", get(h_status))
        .route("/mcp/sessions", get(h_sessions))
        .route("/mcp/sessions/{session_id}/query", get(h_query))
        .route("/mcp/sessions/{session_id}/events", get(h_events))
        .with_state(handle);

    match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(listener) => {
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
        let results = state.state_tracker_results.lock().unwrap();
        let Some(session_results) = results.get(&session_id) else {
            return Json(json!({ "sessionId": session_id, "events": [], "count": 0 }));
        };

        // Collect all transitions from all trackers, sort by line_num desc.
        let mut all: Vec<Value> = session_results
            .values()
            .flat_map(|r| {
                r.transitions.iter().map(|t| {
                    json!({
                        "trackerId": r.tracker_id,
                        "transitionName": t.transition_name,
                        "lineNum": t.line_num,
                        "timestamp": t.timestamp,
                        "changes": t.changes,
                    })
                })
            })
            .collect();

        all.sort_by(|a, b| {
            b["lineNum"].as_u64().cmp(&a["lineNum"].as_u64())
        });

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
