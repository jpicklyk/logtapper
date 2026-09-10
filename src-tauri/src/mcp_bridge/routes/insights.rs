//! GET /mcp/sessions/{session_id}/insights

use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::lock_or_json_err;

#[derive(Deserialize)]
pub(crate) struct InsightsParams {
    /// Max total signal events to return across all processors (default 20).
    max_signals: Option<usize>,
    /// Comma-separated list of processor IDs to include. If absent, all are included.
    processor_ids: Option<String>,
}

pub(crate) async fn h_insights(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<InsightsParams>,
) -> Json<Value> {
    use crate::processors::marketplace::{McpSchema, Severity, SignalType};
    use crate::processors::signals::{eval_parsed_condition, render_template};

    let state = &*ctx.state;
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
            let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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
        let all_results = lock_or_json_err!(state.pipeline_results, "pipeline_results");
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
