//! Pipeline result and trigger endpoints: pipeline, processor detail, run_pipeline.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::processors::marketplace::{resolve_processor_id_checked, split_qualified_id};
use crate::processors::reporter::engine::RunResult;
use crate::processors::state_tracker::types::StateTransition;
use crate::services::policy::anonymize_line_texts;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{lock_or_json_err, resolve_line_texts, truncate_var_maps, verify_session_exists};

/// Check whether a qualified (or bare) processor ID matches an optional filter.
/// Returns `true` if no filter is set, or if the filter matches the full or bare ID.
fn processor_id_matches(candidate: &str, filter: Option<&String>) -> bool {
    filter.map_or(true, |fid| {
        fid == candidate || split_qualified_id(candidate).0 == fid.as_str()
    })
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/pipeline
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct PipelineParams {
    /// Filter to a single processor by ID.
    processor_id: Option<String>,
}

pub(crate) async fn h_pipeline(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<PipelineParams>,
) -> Json<Value> {
    let state = &*ctx.state;

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
        let results = lock_or_json_err!(state.pipeline_results, "pipeline_results");
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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
        let pipeline_res = lock_or_json_err!(state.state_tracker_results, "state_tracker_results");
        let stream_res = lock_or_json_err!(state.stream_tracker_state, "stream_tracker_state");
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

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

    // --- Phase 2: Resolve line text from sessions (separate lock), then
    // anonymize per the session's `mcp_anonymize` flag AFTER the `sessions`
    // lock is dropped (see `anonymize_line_texts` doc comment). ---
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

        let raw = {
            let sessions = lock_or_json_err!(state.sessions, "sessions");
            resolve_line_texts(&sessions, &session_id, &needed)
        };
        anonymize_line_texts(state, &session_id, raw)
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
pub(crate) struct ProcessorDetailParams {
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

pub(crate) async fn h_processor_detail(
    State(ctx): State<BridgeCtx>,
    Path((session_id, processor_id)): Path<(String, String)>,
    Query(params): Query<ProcessorDetailParams>,
) -> Json<Value> {
    let state = &*ctx.state;
    let include_emissions = params.include_emissions.unwrap_or(false);
    let emission_limit = params.emission_limit.unwrap_or(50).min(200);
    let emission_offset = params.emission_offset.unwrap_or(0);
    let include_line_text = params.include_line_text.unwrap_or(false);

    // Resolve bare → qualified ID and check processor type in a single lock.
    let (resolved_id, processor_type) = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let resolved = match resolve_processor_id_checked(&procs, &processor_id) {
            Ok(r) => r.unwrap_or_else(|| processor_id.clone()),
            Err(e) => return Json(json!({ "error": e, "processorId": processor_id, "sessionId": session_id })),
        };
        let ptype = procs.get(&resolved).map(|p| p.processor_type().to_string());
        (resolved, ptype)
    };

    match processor_type.as_deref() {
        Some("reporter") | None => {
            // Try reporter results (None processor_type means it might still have results)
            let result_data: Option<(RunResult, String, String)> = {
                let results = lock_or_json_err!(state.pipeline_results, "pipeline_results");
                let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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
                let raw = {
                    let sessions = lock_or_json_err!(state.sessions, "sessions");
                    resolve_line_texts(&sessions, &session_id, &needed_lines)
                };
                anonymize_line_texts(state, &session_id, raw)
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
                let pipeline_res = lock_or_json_err!(state.state_tracker_results, "state_tracker_results");
                let stream_res = lock_or_json_err!(state.stream_tracker_state, "stream_tracker_state");
                let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

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
                let raw = {
                    let sessions = lock_or_json_err!(state.sessions, "sessions");
                    resolve_line_texts(&sessions, &session_id, &needed)
                };
                anonymize_line_texts(state, &session_id, raw)
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
// POST /mcp/sessions/{session_id}/run_pipeline
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunPipelineBody {
    /// Processor IDs to run. If omitted, runs all installed processors.
    processor_ids: Option<Vec<String>>,
}

pub(crate) async fn h_run_pipeline(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Json(body): Json<RunPipelineBody>,
) -> Json<Value> {
    use crate::commands::pipeline::execute_pipeline;

    let state = &*ctx.state;

    verify_session_exists!(state, session_id);

    // Resolve processor IDs — use provided list or all installed processors.
    // Bare IDs (e.g. "wifi-state") are resolved to qualified keys ("wifi-state@official").
    let processor_ids: Vec<String> = match body.processor_ids {
        Some(ids) if !ids.is_empty() => {
            let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let resolved: Result<Vec<String>, String> = ids.into_iter()
                .map(|id| resolve_processor_id_checked(&procs, &id).map(|r| r.unwrap_or(id)))
                .collect();
            match resolved {
                Ok(v) => v,
                Err(e) => return Json(json!({ "error": e, "sessionId": session_id })),
            }
        }
        _ => {
            let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            procs.keys().cloned().collect()
        }
    };

    // Pipeline is CPU-heavy (rayon); run on a blocking thread to avoid starving
    // the Axum async runtime.
    let handle_clone = ctx.app.clone();
    let state_for_task = Arc::clone(&ctx.state);
    let sid = session_id.clone();
    let pids = processor_ids.clone();

    let result = tokio::task::spawn_blocking(move || {
        execute_pipeline(&state_for_task, &handle_clone, &sid, &pids)
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
