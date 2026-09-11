//! Pipeline result and trigger endpoints: pipeline, processor detail, run_pipeline.
//!
//! All three handlers are renderers: `services::pipeline` decides what the
//! answer is, and the code below maps it into the typed `services::wire`
//! envelopes. Nothing here reads `AppState` directly, and the pipeline run owns
//! its own `spawn_blocking` inside the service.
//!
//! **Wire changes (WP-13).**
//!
//! `GET .../pipeline` → [`SessionPipelineResults`]:
//!
//! | was | now |
//! |---|---|
//! | `reporters[].matchedLines` (a *count*) | `matchedLineCount` |
//! | `reporters[].sampleMatchedLines[].rawLine: ""` when absent | `rawLine: null` when the caller did not ask for text |
//! | `reporters[].recentEmissions[]` — `Emission`'s own `{ line_num, fields }` (snake_case) | [`EmissionEntry`] — `{ lineNum, fields, rawLine }` |
//! | `stateTrackers[].recentTransitions[].rawLine: ""` when absent | `rawLine: null` |
//!
//! `GET .../processor/{id}` → [`ProcessorDetail`] (untagged; switch on
//! `processorType`):
//!
//! | was | now |
//! |---|---|
//! | `emissions: null` when not requested, else a bare array | `emissions: null`, else a `Page<EmissionEntry>` |
//! | `emissionOffset` / `emissionLimit` | `emissions.offset` / `emissions.limit` |
//! | `emissions[]` with `rawLine` spliced into `Emission`'s snake_case object | [`EmissionEntry`] |
//! | `transitions[]` (bare array) + `offset` / `limit` | `transitions: Page<TransitionEntry>` |
//! | `matchedLines[]` — `rawLine` key absent when not requested | `rawLine: null` |
//!
//! `POST .../run_pipeline` → [`PipelineRunResult`] — `processorCount` is gone
//! (it was `summaries.length`) and `effectiveProcessorIds` is new: the chain
//! the backend actually ran, which a caller that passed no ids previously had
//! no way to learn.
//!
//! Errors are [`ServiceError`]: a `404` for an unknown session/processor, a
//! `400` for an unsupported processor type or an unresolvable chain. The
//! pre-WP-13 `processorId` / `sessionId` keys that rode alongside the error
//! string are gone — both are in the request path.

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::Value;

use crate::services::ServiceError;
use crate::services::pipeline::{self, DetailPage, ProcessorDetail as SvcDetail, TransitionRow};
use crate::services::wire::{
    EmissionEntry, MatchedLineEntry, Page, PipelineRunResult, ProcessorDetail, ReporterDetail,
    ReporterSummary, SessionPipelineResults, TrackerDetail, TrackerSummary, TransitionEntry,
};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{JsonBody, Qs, client_name, truncate_var_maps};

// ---------------------------------------------------------------------------
// Value → typed conversions
// ---------------------------------------------------------------------------

/// Turn one serialized `Emission` back into a typed [`EmissionEntry`].
///
/// `services::pipeline` hands emissions across as `serde_json::Value` because
/// `processors::reporter::engine::Emission` has a hand-written `Serialize` that
/// renders `{ "line_num": N, "fields": { … } }` — snake_case, in an otherwise
/// camelCase wire. Reading those two keys back here is what lets the bridge
/// answer a real type without changing `Emission` (which is `processors/`
/// territory and is also what the `.lts` on-disk format carries).
///
/// A shape that does not match is not an error worth failing a whole response
/// over: the entry degrades to line 0 with no fields, which is visibly wrong
/// rather than silently plausible.
fn emission_entry(value: &Value, raw: Option<String>) -> EmissionEntry {
    EmissionEntry {
        line_num: value
            .get("line_num")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        fields: value
            .get("fields")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        raw_line: raw,
    }
}

fn transition_entry(row: TransitionRow) -> TransitionEntry {
    TransitionEntry {
        line_num: row.transition.line_num,
        timestamp: row.transition.timestamp,
        transition_name: row.transition.transition_name,
        changes: row.transition.changes,
        raw_line: row.raw,
    }
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
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Qs(params): Qs<PipelineParams>,
) -> Result<Json<SessionPipelineResults>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    let results = pipeline::results(&svc, &session_id, params.processor_id.as_deref())?;
    let has_results = results.has_results();

    let reporters: Vec<ReporterSummary> = results
        .reporters
        .into_iter()
        .map(|r| ReporterSummary {
            processor_id: r.processor_id,
            processor_type: "reporter".to_string(),
            name: r.name,
            description: r.description,
            matched_line_count: r.matched_line_count,
            emission_count: r.emission_count,
            recent_emissions: r
                .recent_emissions
                .iter()
                .map(|v| emission_entry(v, None))
                .collect(),
            sample_matched_lines: r
                .sample_matched_lines
                .into_iter()
                .map(|m| MatchedLineEntry { line_num: m.line_num, raw_line: m.raw })
                .collect(),
            vars: truncate_var_maps(&r.vars),
        })
        .collect();

    let state_trackers: Vec<TrackerSummary> = results
        .state_trackers
        .into_iter()
        .map(|t| TrackerSummary {
            processor_id: t.processor_id,
            processor_type: "state_tracker".to_string(),
            name: t.name,
            description: t.description,
            transition_count: t.transition_count,
            final_state: t.final_state,
            recent_transitions: t.recent_transitions.into_iter().map(transition_entry).collect(),
        })
        .collect();

    Ok(Json(SessionPipelineResults {
        session_id,
        has_results,
        reporters,
        state_trackers,
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
    headers: HeaderMap,
    Path((session_id, processor_id)): Path<(String, String)>,
    Qs(params): Qs<ProcessorDetailParams>,
) -> Result<Json<ProcessorDetail>, ServiceError> {
    let include_emissions = params.include_emissions.unwrap_or(false);
    let emission_limit = params.emission_limit.unwrap_or(50).min(200);
    let emission_offset = params.emission_offset.unwrap_or(0);
    let include_line_text = params.include_line_text.unwrap_or(false);

    let svc = ctx.svc(client_name(&headers));
    let detail = pipeline::processor_detail(
        &svc,
        &session_id,
        &processor_id,
        DetailPage {
            offset: emission_offset,
            limit: emission_limit,
            include_emissions,
        },
        include_line_text,
    )?;

    Ok(Json(match detail {
        SvcDetail::Reporter(r) => {
            let emission_count = r.emission_count;
            let emissions = r.emissions.map(|rows| {
                let items: Vec<EmissionEntry> = rows
                    .into_iter()
                    .map(|row| emission_entry(&row.value, row.raw))
                    .collect();
                Page::window(items, r.offset, r.limit, emission_count)
            });

            ProcessorDetail::Reporter(ReporterDetail {
                // The caller's spelling, not the resolved id — bare in, bare out.
                processor_id,
                session_id,
                processor_type: "reporter".to_string(),
                name: r.name,
                description: r.description,
                matched_line_count: r.matched_line_count,
                emission_count,
                vars: truncate_var_maps(&r.vars),
                matched_lines: r
                    .matched_lines
                    .into_iter()
                    .map(|m| MatchedLineEntry { line_num: m.line_num, raw_line: m.raw })
                    .collect(),
                emissions,
            })
        }
        SvcDetail::StateTracker(t) => {
            let transition_count = t.transition_count;
            let items: Vec<TransitionEntry> =
                t.transitions.into_iter().map(transition_entry).collect();
            ProcessorDetail::StateTracker(TrackerDetail {
                processor_id,
                session_id,
                processor_type: "state_tracker".to_string(),
                name: t.name,
                description: t.description,
                transition_count,
                final_state: t.final_state,
                transitions: Page::window(items, t.offset, t.limit, transition_count),
            })
        }
    }))
}

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/run_pipeline
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunPipelineBody {
    /// Processor IDs to run. Omitted (or empty) means "this session's own
    /// chain", resolved by `services::pipeline::resolve_effective_chain` from
    /// `session_pipeline_meta`.
    ///
    /// It used to mean "every installed processor", which was never what an
    /// agent wanted: it ran the user's whole registry against one session,
    /// producing results for processors the session's chain deliberately
    /// excluded. That fallback is gone — a session with no chain configured is
    /// now an error rather than a run of everything.
    processor_ids: Option<Vec<String>>,
}

pub(crate) async fn h_run_pipeline(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    JsonBody(body): JsonBody<RunPipelineBody>,
) -> Result<Json<PipelineRunResult>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));

    // An agent-triggered run still lights up the desktop progress bar: the
    // bridge's `EventSink` is the same `TauriSink` the UI listens on, so
    // `pipeline-progress` lands exactly where `app.emit` used to put it — with
    // no `AppHandle` in this file.
    let progress = std::sync::Arc::new(pipeline::EventSinkProgress::new(
        std::sync::Arc::clone(&ctx.events),
    ));

    Ok(Json(
        pipeline::run(svc, session_id, body.processor_ids, progress).await?,
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// The golden tests that pinned these three handlers' pre-service JSON bodies
// are deleted with WP-13: they existed to prove WP-4's extraction was
// shape-preserving, and the shapes they pinned are exactly what this package
// replaces. What is left below covers the mapping WP-13 introduced — the
// `Emission` → `EmissionEntry` rescue in particular, which is the one piece of
// real logic in this file.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn emission_entry_reads_back_emissions_hand_written_snake_case_shape() {
        // Exactly what `processors::reporter::engine::Emission`'s `Serialize`
        // produces — the shape `services::pipeline` hands over as a `Value`.
        let serialized = serde_json::to_value(
            &crate::processors::reporter::engine::Emission {
                line_num: 42,
                fields: vec![
                    ("kind".to_string(), json!("anr")),
                    ("pkg".to_string(), json!("com.example")),
                ],
            },
        )
        .expect("Emission serializes");

        let entry = emission_entry(&serialized, Some("raw text".to_string()));

        assert_eq!(entry.line_num, 42);
        assert_eq!(entry.fields.get("kind"), Some(&json!("anr")));
        assert_eq!(entry.fields.get("pkg"), Some(&json!("com.example")));
        assert_eq!(entry.raw_line.as_deref(), Some("raw text"));

        // And the wire form is camelCase throughout.
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["lineNum"], 42);
        assert_eq!(v["rawLine"], "raw text");
        assert!(v.get("line_num").is_none());
    }

    #[test]
    fn emission_entry_degrades_visibly_on_an_unexpected_shape() {
        // Not an error worth failing a whole response over, but it must not
        // look like a real emission either.
        let entry = emission_entry(&json!({ "unexpected": true }), None);
        assert_eq!(entry.line_num, 0);
        assert!(entry.fields.is_empty());
        assert!(entry.raw_line.is_none());
    }

    #[test]
    fn transition_entry_inlines_the_transition_and_keeps_raw_optional() {
        use crate::processors::state_tracker::types::{FieldChange, StateTransition};
        use std::collections::HashMap;

        let mut changes = HashMap::new();
        changes.insert(
            "enabled".to_string(),
            FieldChange { from: json!(false), to: json!(true) },
        );
        let row = TransitionRow {
            transition: StateTransition {
                line_num: 7,
                timestamp: 1_700_000_000_000_000_000,
                transition_name: "enable".to_string(),
                changes,
            },
            raw: None,
        };

        let v = serde_json::to_value(transition_entry(row)).unwrap();
        assert_eq!(v["lineNum"], 7);
        assert_eq!(v["transitionName"], "enable");
        assert_eq!(v["changes"]["enabled"]["to"], true);
        assert_eq!(v["rawLine"], json!(null), "absent text is null, not \"\"");
    }
}
