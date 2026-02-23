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
use crate::processors::ProcessorKind;
use crate::processors::reporter::engine::RunResult;
use crate::processors::state_tracker::types::StateTransition;

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
        .route("/mcp/sessions/{session_id}/correlations", get(h_correlations))
        .route("/mcp/sessions/{session_id}/processor/{processor_id}", get(h_processor_detail))
        .route("/mcp/sessions/{session_id}/tracker/{tracker_id}/state_at", get(h_state_at_line))
        .route("/mcp/sessions/{session_id}/search", get(h_search))
        .route("/mcp/processors", get(h_processor_defs_list))
        .route("/mcp/processors/{processor_id}", get(h_processor_defs_single))
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
// Helpers
// ---------------------------------------------------------------------------

/// Truncate a string to at most `max_chars` characters, appending "..." if cut.
/// Uses char boundaries to avoid splitting multi-byte UTF-8 sequences.
fn truncate_str(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let end = s.char_indices()
            .nth(max_chars)
            .map(|(i, _)| i)
            .unwrap_or(s.len());
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
                    let all_numeric = o.values().all(|v| v.is_number());
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
                    map.insert(ln, truncate_str(raw, 500));
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
                // uniform: scan all lines in order so rare events aren't missed
                (0..total_lines).collect()
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
                if session.resolve_tag(meta.tag_id) != tf { continue; }
            }
            // Message filter (case-insensitive)
            if let Some(ref needle) = msg_needle {
                if !raw.to_lowercase().contains(needle.as_str()) { continue; }
            }
            // Level filter
            if let Some(ref lf) = params.level {
                if !level_at_least(&level_str, lf) { continue; }
            }
            matched.push(LineSnap { line_num: i, level: level_str, tag: session.resolve_tag(meta.tag_id).to_string(), raw: raw.to_string() });
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
                .filter(|(pid, _)| {
                    params.processor_id.as_ref().map_or(true, |fid| fid == *pid)
                })
                .map(|(proc_id, run_result)| {
                    let proc = procs.get(proc_id);
                    let name = proc.map(|p| p.meta.name.clone()).unwrap_or_else(|| proc_id.clone());
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
                .filter(|tid| params.processor_id.as_ref().map_or(true, |fid| fid == tid))
                .map(|tracker_id| {
                    let proc = procs.get(&tracker_id);
                    let name = proc.map(|p| p.meta.name.clone()).unwrap_or_else(|| tracker_id.clone());
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

    // Check what type of processor this is
    let processor_type: Option<String> = {
        let procs = state.processors.lock().unwrap();
        procs.get(&processor_id).map(|p| p.processor_type().to_string())
    };

    match processor_type.as_deref() {
        Some("reporter") | None => {
            // Try reporter results (None processor_type means it might still have results)
            let result_data: Option<(RunResult, String, String)> = {
                let results = state.pipeline_results.lock().unwrap();
                let procs = state.processors.lock().unwrap();
                results.get(&session_id)
                    .and_then(|m| m.get(&processor_id))
                    .map(|rr| {
                        let proc = procs.get(&processor_id);
                        let name = proc.map(|p| p.meta.name.clone()).unwrap_or_else(|| processor_id.clone());
                        let desc = proc.map(|p| p.meta.description.clone()).unwrap_or_default();
                        (RunResult {
                            emissions: rr.emissions.clone(),
                            vars: rr.vars.clone(),
                            matched_line_nums: rr.matched_line_nums.clone(),
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

                let proc = procs.get(&processor_id);
                let name = proc.map(|p| p.meta.name.clone()).unwrap_or_else(|| processor_id.clone());
                let desc = proc.map(|p| p.meta.description.clone()).unwrap_or_default();

                let from_pipeline = pipeline_res.get(&session_id).and_then(|m| m.get(&processor_id));
                let from_stream = stream_res.get(&session_id).and_then(|m| m.get(&processor_id));

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

    // Resolve transitions from pipeline or stream state
    let transitions: Option<Vec<StateTransition>> = {
        let pipeline_res = state.state_tracker_results.lock().unwrap();
        pipeline_res.get(&session_id)
            .and_then(|session_map| session_map.get(&tracker_id))
            .map(|r| r.transitions.clone())
    }.or_else(|| {
        let stream_res = state.stream_tracker_state.lock().unwrap();
        stream_res.get(&session_id)
            .and_then(|m| m.get(&tracker_id))
            .map(|cont| cont.transitions.clone())
    });

    let Some(transitions) = transitions else {
        return Json(json!({
            "error": format!("no tracker results for session {session_id} / tracker {tracker_id}"),
        }));
    };

    // Replay transitions up to line_num against declared defaults
    let defaults: HashMap<String, serde_json::Value> = {
        let procs = state.processors.lock().unwrap();
        match procs.get(&tracker_id).and_then(|p| p.as_state_tracker()) {
            Some(def) => def.state.iter().map(|f| (f.name.clone(), f.default.clone())).collect(),
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
        "trackerId": tracker_id,
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
        let sessions = state.sessions.lock().unwrap();
        let Some(session) = sessions.get(&session_id) else {
            return Json(json!({ "error": "session not found", "sessionId": session_id }));
        };
        let Some(source) = session.primary_source() else {
            return Json(json!({ "error": "session has no sources", "sessionId": session_id }));
        };

        let total = source.total_lines();
        let mut results: Vec<MatchResult> = Vec::new();

        for i in 0..total {
            if results.len() >= limit { break; }
            let Some(raw) = source.raw_line(i) else { continue };

            if let Some(caps) = regex.captures(raw) {
                // Collect capture groups (skip group 0 = full match)
                let captures: Vec<String> = (1..caps.len())
                    .filter_map(|j| caps.get(j).map(|m| m.as_str().to_string()))
                    .collect();

                // Context lines
                let context_before: Vec<(usize, String)> = if context > 0 {
                    let start = i.saturating_sub(context);
                    (start..i)
                        .filter_map(|j| source.raw_line(j).map(|r| (j, truncate_str(r, 500))))
                        .collect()
                } else {
                    vec![]
                };

                let context_after: Vec<(usize, String)> = if context > 0 {
                    let end = (i + 1 + context).min(total);
                    ((i + 1)..end)
                        .filter_map(|j| source.raw_line(j).map(|r| (j, truncate_str(r, 500))))
                        .collect()
                } else {
                    vec![]
                };

                results.push(MatchResult {
                    line_num: i,
                    raw: truncate_str(raw, 500),
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
        procs.values().map(|p| {
            json!({
                "id": p.meta.id,
                "name": p.meta.name,
                "processorType": p.processor_type(),
                "description": p.meta.description,
                "version": p.meta.version,
                "builtin": p.meta.builtin,
                "tags": p.meta.tags,
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
    let Some(p) = procs.get(&processor_id) else {
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
                            crate::processors::reporter::schema::FilterRule::MessageContains { value } => format!("message_contains: \"{}\"", value),
                            crate::processors::reporter::schema::FilterRule::MessageContainsAny { values } => format!("message_contains_any: [{}]", values.join(", ")),
                            crate::processors::reporter::schema::FilterRule::MessageRegex { pattern } => format!("message_regex: \"{}\"", pattern),
                            crate::processors::reporter::schema::FilterRule::LevelMin { level } => format!("level_min: {}", level),
                            crate::processors::reporter::schema::FilterRule::TimeRange { from, to } => format!("time_range: {} - {}", from, to),
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
                                "cast": f.cast.as_ref().map(|c| format!("{:?}", c).to_lowercase()),
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
        ProcessorKind::Transformer(_) | ProcessorKind::Annotator(_) => {
            // Minimal info already in base result
        }
    }

    Json(result)
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
