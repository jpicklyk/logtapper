//! `insights` service — MCP agent-facing digest of a session's per-processor
//! signals and summary.
//!
//! Ported from `mcp_bridge::routes::insights::h_insights`'s inline
//! evaluation — the sole existing caller, and still the only one: this is not
//! (yet) exposed to the desktop UI. Returns a typed, camelCase [`Insights`]
//! value rather than the route's old `json!{}`; the route itself still
//! renders TODAY's exact snake_case wire shape from these fields (WP-13
//! flips the wire itself to camelCase, once every route stops hand-building
//! JSON).

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use crate::processors::marketplace::{McpSchema, Severity, SignalType};
use crate::processors::signals::{eval_parsed_condition, render_template};

use super::error::ServiceError;
use super::{lock_svc, ServiceCtx};

// ---------------------------------------------------------------------------
// Typed output
// ---------------------------------------------------------------------------

/// One evaluated signal for one processor — either a single emission that
/// matched a per-emission signal's condition, or one aggregate rollup
/// computed from the processor's final accumulated vars.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InsightSignal {
    pub name: String,
    /// Lowercase severity string (`"critical"` / `"warning"` / `"info"`) —
    /// matches `processors::marketplace::Severity`'s wire spelling without
    /// requiring that internal type to become IPC-reachable itself.
    pub severity: String,
    /// First matching line for an aggregate signal; the matching line itself
    /// for a per-emission signal.
    pub line: Option<usize>,
    /// Last matching line — only meaningful when [`Self::is_aggregate`] is
    /// `true`. Kept as a real field (rather than folded into `line`) so a
    /// future direct consumer of this struct can tell "one line" from "a
    /// range" without also inspecting `isAggregate`.
    pub last_line: Option<usize>,
    /// Whether this signal was computed once from the processor's final vars
    /// (`true`) or per matching emission (`false`) — see `SignalType`. Drives
    /// whether the route's legacy JSON rendering includes a `last_line` key
    /// at all (today's wire omits it entirely for per-emission signals,
    /// rather than sending it as `null`).
    pub is_aggregate: bool,
    /// Always `null` on the wire today — reserved, never populated by any
    /// signal definition yet.
    #[ts(type = "number | null")]
    pub timestamp: Option<i64>,
    pub message: Option<String>,
    #[ts(type = "Record<string, unknown>")]
    pub fields: HashMap<String, Value>,
}

/// One processor's contribution to a session's insights digest.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProcessorInsight {
    pub processor_id: String,
    pub processor_name: String,
    /// Rendered from the processor's `mcp.summary` template, when declared
    /// and the processor has run. `None` when the processor declares no MCP
    /// schema, no summary template, or has not produced results yet.
    pub summary: Option<String>,
    pub signals: Vec<InsightSignal>,
    #[ts(type = "Record<string, number>")]
    pub signal_counts: HashMap<String, usize>,
    pub total_emissions: usize,
    /// `true` when more signals matched than `max_signals` allowed to return.
    pub truncated: bool,
}

/// A session's full insights digest: one entry per processor considered
/// (filtered by `processor_ids` when given), regardless of whether it
/// declares an MCP schema.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Insights {
    pub session_id: String,
    pub processors: Vec<ProcessorInsight>,
}

// ---------------------------------------------------------------------------
// digest()
// ---------------------------------------------------------------------------

fn severity_str(s: &Severity) -> &'static str {
    match s {
        Severity::Critical => "critical",
        Severity::Warning => "warning",
        Severity::Info => "info",
    }
}

fn severity_rank(s: &Severity) -> u8 {
    match s {
        Severity::Critical => 0,
        Severity::Warning => 1,
        Severity::Info => 2,
    }
}

/// Snapshot of one processor's evaluated signals, computed while holding the
/// `pipeline_results` lock (pure CPU, no I/O) — see `digest`'s inner block.
struct ProcSnap {
    id: String,
    name: String,
    total_emissions: usize,
    summary: Option<String>,
    all_signals: Vec<InsightSignal>,
    signal_counts: HashMap<String, usize>,
    has_mcp_schema: bool,
}

/// Build the insights digest for `session_id`.
///
/// `max_signals` caps how many signals (across all severities, after the
/// severity-ascending sort) each processor reports — matching
/// `InsightsParams::max_signals`'s default of 20 at the route. `filter_ids`
/// restricts which processors are considered at all (matched against either
/// the qualified id or the bare `meta.id`), matching the route's
/// comma-separated `processor_ids` query param; `None` considers every
/// installed processor.
pub fn digest(
    ctx: &ServiceCtx,
    session_id: &str,
    max_signals: usize,
    filter_ids: Option<&HashSet<String>>,
) -> Result<Insights, ServiceError> {
    let state = ctx.state();

    let proc_snaps: Vec<ProcSnap> = {
        // Collect (qualified_id, display_name, schema) while holding only the
        // `processors` lock — dropped before `pipeline_results` is acquired,
        // so at most one `AppState` lock is ever held at a time.
        let proc_meta: Vec<(String, String, Option<McpSchema>)> = {
            let procs = lock_svc(&state.processors, "processors")?;
            procs
                .iter()
                .filter(|(qid, p)| {
                    filter_ids.map_or(true, |ids| ids.contains(qid.as_str()) || ids.contains(&p.meta.id))
                })
                .map(|(qid, p)| (qid.clone(), p.meta.name.clone(), p.schema.as_ref().and_then(|s| s.mcp.clone())))
                .collect()
        };

        let all_results = lock_svc(&state.pipeline_results, "pipeline_results")?;
        let session_map = all_results.get(session_id);

        proc_meta
            .into_iter()
            .map(|(id, name, schema_mcp)| {
                let rr = session_map.and_then(|m| m.get(&id));
                let total_emissions = rr.map_or(0, |r| r.emissions.len());

                let Some(ref mcp) = schema_mcp else {
                    return ProcSnap {
                        id,
                        name,
                        total_emissions,
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
                        mcp_summary
                            .include_vars
                            .iter()
                            .filter_map(|k| rr.vars.get(k).map(|v| (k.clone(), v.clone())))
                            .collect()
                    };
                    Some(render_template(&mcp_summary.template, &vars_map))
                } else {
                    None
                };

                // (severity_rank, signal) pairs, sorted stably below and then
                // stripped of the rank — avoids re-parsing severity back out
                // of a rendered string the way the original bridge json!-based
                // implementation had to.
                let mut ranked_signals: Vec<(u8, InsightSignal)> = Vec::new();
                let mut signal_counts: HashMap<String, usize> = HashMap::new();

                if let Some(rr) = rr {
                    for sig_def in &mcp.signals {
                        let count_entry = signal_counts.entry(sig_def.name.clone()).or_insert(0);

                        if sig_def.signal_type == SignalType::Aggregate {
                            if eval_parsed_condition(sig_def.parsed_condition.as_ref(), &rr.vars) {
                                *count_entry += 1;
                                let first_line = rr.emissions.first().map(|e| e.line_num);
                                let last_line = rr.emissions.last().map(|e| e.line_num);
                                let requested_fields: HashMap<String, Value> = sig_def
                                    .fields
                                    .iter()
                                    .filter_map(|f| rr.vars.get(f).map(|v| (f.clone(), v.clone())))
                                    .collect();
                                let message = sig_def.format.as_deref().map(|fmt| render_template(fmt, &rr.vars));
                                ranked_signals.push((
                                    severity_rank(&sig_def.severity),
                                    InsightSignal {
                                        name: sig_def.name.clone(),
                                        severity: severity_str(&sig_def.severity).to_string(),
                                        line: first_line,
                                        last_line,
                                        is_aggregate: true,
                                        timestamp: None,
                                        message,
                                        fields: requested_fields,
                                    },
                                ));
                            }
                        } else {
                            for emission in &rr.emissions {
                                let emission_fields: HashMap<String, Value> =
                                    emission.fields.iter().cloned().collect();
                                if eval_parsed_condition(sig_def.parsed_condition.as_ref(), &emission_fields) {
                                    *count_entry += 1;
                                    let requested_fields: HashMap<String, Value> = sig_def
                                        .fields
                                        .iter()
                                        .filter_map(|f| emission_fields.get(f).map(|v| (f.clone(), v.clone())))
                                        .collect();
                                    let message = sig_def.format.as_deref().map(|fmt| render_template(fmt, &emission_fields));
                                    ranked_signals.push((
                                        severity_rank(&sig_def.severity),
                                        InsightSignal {
                                            name: sig_def.name.clone(),
                                            severity: severity_str(&sig_def.severity).to_string(),
                                            line: Some(emission.line_num),
                                            last_line: None,
                                            is_aggregate: false,
                                            timestamp: None,
                                            message,
                                            fields: requested_fields,
                                        },
                                    ));
                                }
                            }
                        }
                    }
                }

                // Stable sort by severity (critical first) — ties keep their
                // original evaluation order, matching the original `sort_by`.
                ranked_signals.sort_by_key(|(rank, _)| *rank);
                let all_signals: Vec<InsightSignal> = ranked_signals.into_iter().map(|(_, s)| s).collect();

                ProcSnap {
                    id,
                    name,
                    total_emissions,
                    summary,
                    all_signals,
                    signal_counts,
                    has_mcp_schema: true,
                }
            })
            .collect()
    };

    let mut processors = Vec::with_capacity(proc_snaps.len());
    for mut snap in proc_snaps {
        if !snap.has_mcp_schema {
            processors.push(ProcessorInsight {
                processor_id: snap.id,
                processor_name: snap.name,
                summary: None,
                signals: Vec::new(),
                signal_counts: HashMap::new(),
                total_emissions: snap.total_emissions,
                truncated: false,
            });
            continue;
        }

        let truncated = snap.all_signals.len() > max_signals;
        snap.all_signals.truncate(max_signals);

        processors.push(ProcessorInsight {
            processor_id: snap.id,
            processor_name: snap.name,
            summary: snap.summary,
            signals: snap.all_signals,
            signal_counts: snap.signal_counts,
            total_emissions: snap.total_emissions,
            truncated,
        });
    }

    Ok(Insights {
        session_id: session_id.to_string(),
        processors,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processors::marketplace::{McpSummary, SchemaContract, SignalDef};
    use crate::processors::reporter::engine::{Emission, RunResult};
    use crate::processors::signals::{parse_condition, ParsedCondition};
    use crate::processors::state_tracker::schema::{StateTrackerDef, StateTrackerOutput, TrackerMode};
    use crate::processors::{AnyProcessor, ProcessorKind, ProcessorMeta};
    use crate::services::testing::test_ctx;
    use serde_json::json;
    use std::sync::Arc;

    /// Parse a signal condition expression into the AST form
    /// `SchemaContract::prepare_conditions()` would have produced at
    /// install/load time — `SignalDef::parsed_condition` is otherwise
    /// unpopulated (`#[serde(skip)]`, in-memory only).
    fn condition(expr: &str) -> ParsedCondition {
        match parse_condition(expr).expect("valid test condition") {
            Some(e) => ParsedCondition::Expr(e),
            None => ParsedCondition::Always,
        }
    }

    fn signal(name: &str, severity: Severity, condition_expr: &str, signal_type: SignalType, format: Option<&str>) -> SignalDef {
        SignalDef {
            name: name.to_string(),
            description: None,
            severity,
            condition: Some(condition_expr.to_string()),
            parsed_condition: Some(condition(condition_expr)),
            fields: vec![],
            format: format.map(str::to_string),
            signal_type,
        }
    }

    /// Install a processor under `id` for `digest` to see. The processor
    /// `kind` is irrelevant to `digest` (only `meta` and `schema` are read),
    /// so an empty `StateTracker` stands in — same minimal-fixture pattern
    /// `services::tracker`'s own tests use.
    fn install_processor(ctx: &ServiceCtx, id: &str, name: &str, mcp: Option<McpSchema>) {
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
                name: name.to_string(),
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
            schema: mcp.map(|mcp| SchemaContract {
                source_types: vec![],
                emissions: vec![],
                mcp: Some(mcp),
            }),
            source: None,
        };
        ctx.state().processors.lock().unwrap().insert(id.to_string(), processor);
    }

    fn seed_result(ctx: &ServiceCtx, session_id: &str, processor_id: &str, result: RunResult) {
        ctx.state()
            .pipeline_results
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .insert(processor_id.to_string(), result);
    }

    #[test]
    fn digest_processor_without_mcp_schema_reports_zero_signals() {
        let (ctx, _tmp) = test_ctx().build();
        install_processor(&ctx, "plain-reporter", "Plain Reporter", None);

        let insights = digest(&ctx, "s1", 20, None).expect("digest");
        assert_eq!(insights.processors.len(), 1);
        let p = &insights.processors[0];
        assert_eq!(p.processor_id, "plain-reporter");
        assert!(p.signals.is_empty());
        assert!(p.summary.is_none());
        assert!(!p.truncated);
    }

    #[test]
    fn digest_renders_summary_from_included_vars() {
        let (ctx, _tmp) = test_ctx().build();
        let mcp = McpSchema {
            summary: Some(McpSummary {
                template: "{{count}} events seen".to_string(),
                include_vars: vec!["count".to_string()],
            }),
            signals: vec![],
        };
        install_processor(&ctx, "heap-monitor", "Heap Monitor", Some(mcp));

        let mut result = RunResult::default();
        result.vars.insert("count".to_string(), json!(7));
        result.vars.insert("ignored".to_string(), json!("noise"));
        seed_result(&ctx, "s1", "heap-monitor", result);

        let insights = digest(&ctx, "s1", 20, None).expect("digest");
        let p = &insights.processors[0];
        assert_eq!(p.summary.as_deref(), Some("7 events seen"));
    }

    #[test]
    fn digest_aggregate_signal_carries_last_line_and_is_flagged_aggregate() {
        let (ctx, _tmp) = test_ctx().build();
        let mcp = McpSchema {
            summary: None,
            signals: vec![signal(
                "heap_critical",
                Severity::Critical,
                "heap_pct >= 90",
                SignalType::Aggregate,
                Some("Heap at {{heap_pct}}%"),
            )],
        };
        install_processor(&ctx, "heap-monitor", "Heap Monitor", Some(mcp));

        let mut result = RunResult::default();
        result.vars.insert("heap_pct".to_string(), json!(95));
        result.emissions.push(Emission { line_num: 10, fields: vec![] });
        result.emissions.push(Emission { line_num: 20, fields: vec![] });
        seed_result(&ctx, "s1", "heap-monitor", result);

        let insights = digest(&ctx, "s1", 20, None).expect("digest");
        let p = &insights.processors[0];
        assert_eq!(p.signals.len(), 1);
        let sig = &p.signals[0];
        assert!(sig.is_aggregate);
        assert_eq!(sig.line, Some(10));
        assert_eq!(sig.last_line, Some(20));
        assert_eq!(sig.severity, "critical");
        assert_eq!(sig.message.as_deref(), Some("Heap at 95%"));
        assert_eq!(p.signal_counts.get("heap_critical"), Some(&1));
    }

    #[test]
    fn digest_emission_signal_has_no_last_line_and_is_not_flagged_aggregate() {
        let (ctx, _tmp) = test_ctx().build();
        let mcp = McpSchema {
            summary: None,
            signals: vec![signal("anr", Severity::Warning, "kind == \"anr\"", SignalType::Emission, None)],
        };
        install_processor(&ctx, "anr-watch", "ANR Watch", Some(mcp));

        let mut result = RunResult::default();
        result.emissions.push(Emission {
            line_num: 42,
            fields: vec![("kind".to_string(), json!("anr"))],
        });
        seed_result(&ctx, "s1", "anr-watch", result);

        let insights = digest(&ctx, "s1", 20, None).expect("digest");
        let sig = &insights.processors[0].signals[0];
        assert!(!sig.is_aggregate);
        assert_eq!(sig.line, Some(42));
        assert_eq!(sig.last_line, None);
    }

    #[test]
    fn digest_sorts_signals_by_severity_critical_first() {
        let (ctx, _tmp) = test_ctx().build();
        let mcp = McpSchema {
            summary: None,
            signals: vec![
                signal("info-sig", Severity::Info, "", SignalType::Emission, None),
                signal("critical-sig", Severity::Critical, "", SignalType::Emission, None),
                signal("warning-sig", Severity::Warning, "", SignalType::Emission, None),
            ],
        };
        install_processor(&ctx, "multi", "Multi", Some(mcp));
        let mut result = RunResult::default();
        result.emissions.push(Emission { line_num: 1, fields: vec![] });
        seed_result(&ctx, "s1", "multi", result);

        let insights = digest(&ctx, "s1", 20, None).expect("digest");
        let severities: Vec<&str> = insights.processors[0].signals.iter().map(|s| s.severity.as_str()).collect();
        assert_eq!(severities, vec!["critical", "warning", "info"]);
    }

    #[test]
    fn digest_truncates_signals_past_max_signals_and_flags_it() {
        let (ctx, _tmp) = test_ctx().build();
        let signals: Vec<SignalDef> = (0..5)
            .map(|i| signal(&format!("sig-{i}"), Severity::Info, "", SignalType::Emission, None))
            .collect();
        let mcp = McpSchema { summary: None, signals };
        install_processor(&ctx, "chatty", "Chatty", Some(mcp));
        let mut result = RunResult::default();
        result.emissions.push(Emission { line_num: 1, fields: vec![] });
        seed_result(&ctx, "s1", "chatty", result);

        let insights = digest(&ctx, "s1", 2, None).expect("digest");
        let p = &insights.processors[0];
        assert_eq!(p.signals.len(), 2);
        assert!(p.truncated);
    }

    #[test]
    fn digest_filters_processors_by_id() {
        let (ctx, _tmp) = test_ctx().build();
        install_processor(&ctx, "a@official", "A", None);
        install_processor(&ctx, "b@official", "B", None);

        let filter: HashSet<String> = ["a@official".to_string()].into_iter().collect();
        let insights = digest(&ctx, "s1", 20, Some(&filter)).expect("digest");
        assert_eq!(insights.processors.len(), 1);
        assert_eq!(insights.processors[0].processor_id, "a@official");
    }

    #[test]
    fn digest_empty_session_still_lists_processors_with_zero_emissions() {
        let (ctx, _tmp) = test_ctx().build();
        install_processor(&ctx, "idle", "Idle", None);
        let insights = digest(&ctx, "no-such-session", 20, None).expect("digest");
        assert_eq!(insights.processors.len(), 1);
        assert_eq!(insights.processors[0].total_emissions, 0);
    }
}
