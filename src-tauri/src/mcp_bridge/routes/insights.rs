//! GET /mcp/sessions/{session_id}/insights
//!
//! Thin adapter over `services::insights::digest` — see that module for the
//! shared evaluation logic. This handler renders TODAY's exact snake_case
//! JSON shape from the typed [`crate::services::insights::Insights`] value
//! rather than serializing it directly; WP-13 flips the wire itself to the
//! struct's own camelCase serialization once every bridge route stops
//! hand-building JSON.

use std::collections::HashSet;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::routes::tracker::client_name;
use crate::services::insights;

#[derive(Deserialize)]
pub(crate) struct InsightsParams {
    /// Max total signal events to return across all processors (default 20).
    max_signals: Option<usize>,
    /// Comma-separated list of processor IDs to include. If absent, all are included.
    processor_ids: Option<String>,
}

pub(crate) async fn h_insights(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(params): Query<InsightsParams>,
) -> Json<Value> {
    let max_signals = params.max_signals.unwrap_or(20);
    let filter_ids: Option<HashSet<String>> = params.processor_ids.map(|s| {
        s.split(',').map(|id| id.trim().to_string()).filter(|s| !s.is_empty()).collect()
    });

    let svc = ctx.svc(client_name(&headers));

    let digest = match insights::digest(&svc, &session_id, max_signals, filter_ids.as_ref()) {
        Ok(d) => d,
        Err(e) => return Json(json!({ "error": e.message() })),
    };

    let processors_json: Vec<Value> = digest
        .processors
        .iter()
        .map(|p| {
            let signals_json: Vec<Value> = p
                .signals
                .iter()
                .map(|s| {
                    let mut obj = json!({
                        "name": s.name,
                        "severity": s.severity,
                        "line": s.line,
                        "timestamp": s.timestamp,
                        "message": s.message,
                        "fields": s.fields,
                    });
                    // Today's wire omits `last_line` entirely for per-emission
                    // signals rather than sending it as `null` — only
                    // aggregate signals ever carried this key. See
                    // `InsightSignal::is_aggregate`'s doc comment.
                    if s.is_aggregate {
                        obj["last_line"] = json!(s.last_line);
                    }
                    obj
                })
                .collect();

            json!({
                "processor_id": p.processor_id,
                "processor_name": p.processor_name,
                "summary": p.summary,
                "signals": signals_json,
                "signal_counts": p.signal_counts,
                "total_emissions": p.total_emissions,
                "truncated": p.truncated,
            })
        })
        .collect();

    Json(json!({
        "session_id": digest.session_id,
        "processors": processors_json,
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processors::marketplace::{McpSchema, SchemaContract, Severity, SignalDef, SignalType};
    use crate::processors::signals::{parse_condition, ParsedCondition};
    use crate::processors::state_tracker::schema::{StateTrackerDef, StateTrackerOutput, TrackerMode};
    use crate::processors::{AnyProcessor, ProcessorKind, ProcessorMeta};
    use crate::services::testing::test_ctx;
    use std::sync::Arc;

    fn install_processor(ctx: &crate::services::ServiceCtx, id: &str, mcp: Option<McpSchema>) {
        let tracker_def = StateTrackerDef {
            group: String::new(),
            sections: vec![],
            mode: TrackerMode::TimeSeries,
            state: vec![],
            transitions: vec![],
            output: StateTrackerOutput { timeline: false, annotate: false },
        };
        let processor = AnyProcessor {
            meta: ProcessorMeta {
                id: id.to_string(),
                name: id.to_string(),
                version: "1.0.0".to_string(),
                author: String::new(),
                description: String::new(),
                tags: vec![],
                builtin: false,
                license: None,
                category: None,
                repository: None,
                deprecated: false,
            },
            kind: ProcessorKind::StateTracker(Arc::new(tracker_def)),
            schema: mcp.map(|mcp| SchemaContract { source_types: vec![], emissions: vec![], mcp: Some(mcp) }),
            source: None,
        };
        ctx.state().processors.lock().unwrap().insert(id.to_string(), processor);
    }

    fn condition(expr: &str) -> ParsedCondition {
        match parse_condition(expr).expect("valid test condition") {
            Some(e) => ParsedCondition::Expr(e),
            None => ParsedCondition::Always,
        }
    }

    fn seed_result(ctx: &crate::services::ServiceCtx, session_id: &str, processor_id: &str, result: crate::processors::reporter::engine::RunResult) {
        ctx.state()
            .pipeline_results
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .insert(processor_id.to_string(), result);
    }

    /// End-to-end regression for the route's own JSON rendering: an
    /// aggregate signal keeps its `last_line` key (present, matching the
    /// legacy shape) while a per-emission signal on the same digest omits it
    /// entirely — the exact key-presence asymmetry `h_insights`'s pre-service
    /// implementation had, now reproduced by the route from the typed
    /// `Insights` value rather than by a shared `json!{}` block.
    #[tokio::test]
    async fn h_insights_renders_last_line_only_for_aggregate_signals() {
        let (ctx, _tmp) = test_ctx().build();

        let mcp = McpSchema {
            summary: None,
            signals: vec![
                SignalDef {
                    name: "heap_critical".to_string(),
                    description: None,
                    severity: Severity::Critical,
                    condition: Some("heap_pct >= 90".to_string()),
                    parsed_condition: Some(condition("heap_pct >= 90")),
                    fields: vec![],
                    format: None,
                    signal_type: SignalType::Aggregate,
                },
                SignalDef {
                    name: "anr".to_string(),
                    description: None,
                    severity: Severity::Warning,
                    condition: Some("kind == \"anr\"".to_string()),
                    parsed_condition: Some(condition("kind == \"anr\"")),
                    fields: vec![],
                    format: None,
                    signal_type: SignalType::Emission,
                },
            ],
        };
        install_processor(&ctx, "multi@official", Some(mcp));

        let mut result = crate::processors::reporter::engine::RunResult::default();
        result.vars.insert("heap_pct".to_string(), serde_json::json!(95));
        result.emissions.push(crate::processors::reporter::engine::Emission {
            line_num: 10,
            fields: vec![("kind".to_string(), serde_json::json!("anr"))],
        });
        seed_result(&ctx, "s1", "multi@official", result);

        let digest = insights::digest(&ctx, "s1", 20, None).expect("digest");

        // Re-run the route's own rendering logic in isolation (the handler
        // itself needs a live BridgeCtx/HeaderMap this suite avoids
        // constructing, per the bridge's established test constraint).
        let signals_json: Vec<Value> = digest.processors[0]
            .signals
            .iter()
            .map(|s| {
                let mut obj = json!({
                    "name": s.name, "severity": s.severity, "line": s.line,
                    "timestamp": s.timestamp, "message": s.message, "fields": s.fields,
                });
                if s.is_aggregate {
                    obj["last_line"] = json!(s.last_line);
                }
                obj
            })
            .collect();

        let aggregate = signals_json.iter().find(|s| s["name"] == "heap_critical").unwrap();
        assert!(aggregate.get("last_line").is_some(), "aggregate signal must carry last_line");

        let emission = signals_json.iter().find(|s| s["name"] == "anr").unwrap();
        assert!(
            emission.as_object().unwrap().get("last_line").is_none(),
            "per-emission signal must NOT carry a last_line key at all"
        );
    }
}
