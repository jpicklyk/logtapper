//! State-tracker and correlator endpoints: events, correlations, state_at,
//! sections, section_at.

use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::processors::marketplace::resolve_processor_id_checked;
use crate::processors::state_tracker::engine::build_defaults;
use crate::processors::state_tracker::types::StateTransition;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{get_session_and_source, lock_or_json_err, section_json};

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/events
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct EventParams {
    /// Max transitions to return, most-recent first (default 50, max 200).
    limit: Option<usize>,
}

pub(crate) async fn h_events(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<EventParams>,
) -> Json<Value> {
    let state = &*ctx.state;
    let limit = params.limit.unwrap_or(50).min(200);

    let events: Vec<Value> = {
        let pipeline_res = lock_or_json_err!(state.state_tracker_results, "state_tracker_results");
        let stream_res   = lock_or_json_err!(state.stream_tracker_state, "stream_tracker_state");

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
pub(crate) struct CorrelationParams {
    /// Filter to a single correlator by ID.
    correlator_id: Option<String>,
    /// Max events to return (default 50, max 200).
    limit: Option<usize>,
    /// Offset for pagination (default 0).
    offset: Option<usize>,
}

pub(crate) async fn h_correlations(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<CorrelationParams>,
) -> Json<Value> {
    let state = &*ctx.state;
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);

    let correlators: Vec<Value> = {
        let cr = lock_or_json_err!(state.correlator_results, "correlator_results");
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
pub(crate) struct StateAtParams {
    /// Line number to compute state at (required).
    line: usize,
}

pub(crate) async fn h_state_at_line(
    State(ctx): State<BridgeCtx>,
    Path((session_id, tracker_id)): Path<(String, String)>,
    Query(params): Query<StateAtParams>,
) -> Json<Value> {
    let state = &*ctx.state;
    let line_num = params.line;

    // Resolve bare ID → qualified ID (e.g. "wifi-state" → "wifi-state@official")
    let resolved_id = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match resolve_processor_id_checked(&procs, &tracker_id) {
            Ok(r) => r.unwrap_or_else(|| tracker_id.clone()),
            Err(e) => return Json(json!({ "error": e, "sessionId": session_id, "trackerId": tracker_id })),
        }
    };

    // Resolve transitions from pipeline or stream state. Deliberately two
    // plain blocks rather than `.or_else(|| { .. })` — `lock_or_json_err!`
    // expands to an early `return` on poison, which must return from this
    // handler, not from a closure.
    let from_pipeline: Option<Vec<StateTransition>> = {
        let pipeline_res = lock_or_json_err!(state.state_tracker_results, "state_tracker_results");
        pipeline_res.get(&session_id)
            .and_then(|session_map| session_map.get(&resolved_id))
            .map(|r| r.transitions.clone())
    };
    let transitions: Option<Vec<StateTransition>> = if from_pipeline.is_some() {
        from_pipeline
    } else {
        let stream_res = lock_or_json_err!(state.stream_tracker_state, "stream_tracker_state");
        stream_res.get(&session_id)
            .and_then(|m| m.get(&resolved_id))
            .map(|cont| cont.transitions.clone())
    };

    let Some(transitions) = transitions else {
        return Json(json!({
            "error": format!("no tracker results for session {session_id} / tracker {resolved_id}"),
        }));
    };

    // Replay transitions up to line_num against declared defaults
    let defaults: HashMap<String, serde_json::Value> = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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
// GET /mcp/sessions/{session_id}/sections
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct SectionsParams {
    /// Max sections to return (default 50, max 200).
    limit: Option<usize>,
    /// Number of sections to skip (default 0).
    offset: Option<usize>,
    /// Case-insensitive substring filter on section name.
    query: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct SectionAtParams {
    /// 0-based line number to resolve.
    line: usize,
}

/// GET /mcp/sessions/{session_id}/section_at?line=N
///
/// Resolves which section contains a line. Returns the **innermost** section —
/// the value `filter.section` matches against in processor YAML — plus the
/// enclosing chain from outermost to innermost.
///
/// The chain matters: a dumpsys subsection like `wifi` lives inside
/// `DUMPSYS NORMAL`, and a processor rule naming the parent will never match a
/// line inside the child. Without this endpoint the only way to establish that
/// was to page through `sections` and cross-reference `parentIndex` against
/// line ranges by hand.
pub(crate) async fn h_section_at(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<SectionAtParams>,
) -> Json<Value> {
    let state = &*ctx.state;

    get_session_and_source!(state, session_id => sessions, session, source);

    let sections = source.sections();
    let total_lines = source.total_lines();
    let line = params.line;

    let describe = |i: usize| section_json(&sections[i]);

    // Every section whose line range covers this line, outermost first. This is
    // the honest "where am I" answer.
    let containing: Vec<Value> = sections
        .iter()
        .enumerate()
        .filter(|(_, s)| line >= s.start_line && line <= s.end_line)
        .map(|(i, _)| describe(i))
        .collect();

    // What `filter.section` would actually match — which is NOT simply the
    // innermost containing section. Resolution takes the last section *starting*
    // at or before the line and gives up if the line is past that section's end,
    // rather than walking outward. So a line sitting inside a parent but after a
    // subsection ended matches nothing at all.
    let matched = crate::core::line::section_index_for_line(sections, line);

    let note = if sections.is_empty() {
        Some("This source has no parsed sections — not a bugreport/dumpstate, or detected as the wrong source type.")
    } else if matched.is_none() && !containing.is_empty() {
        Some("This line lies inside a section by range, but `filter.section` resolves it to nothing: resolution stops at the last section starting before the line and does not walk outward to an enclosing parent. A processor rule naming any of `containingSections` will NOT match this line.")
    } else if matched.is_none() {
        Some("Line falls outside every section — before the first, or in a gap between them.")
    } else {
        None
    };

    let mut out = json!({
        "sessionId": session_id,
        "line": line,
        // The name a processor's `filter.section` must use to match this line.
        // Null means no rule can target it by section.
        "matchesFilterSection": matched.map_or(Value::Null, |i| json!(sections[i].name)),
        "containingSections": containing,
        "totalLinesInSession": total_lines,
    });
    if let Some(n) = note {
        out["note"] = json!(n);
    }
    Json(out)
}

pub(crate) async fn h_sections(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<SectionsParams>,
) -> Json<Value> {
    let state = &*ctx.state;

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
        .map(|&s| section_json(s))
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
