//! Pipeline result and trigger endpoints: pipeline, processor detail, run_pipeline.
//!
//! All three handlers are renderers now: `services::pipeline` decides what the
//! answer is, and the code below turns it into the exact JSON today's MCP
//! clients already parse. Nothing here reads `AppState` directly, and nothing
//! here reaches for the transitional `BridgeCtx::app()` handle — the pipeline
//! run owns its own `spawn_blocking` inside the service.
//!
//! The JSON shapes are frozen on purpose: WP-13 flips `h_pipeline` /
//! `h_processor_detail` onto the shared `wire` envelopes and WP-16 flips
//! `h_run_pipeline` onto `PipelineRunResult`. Until then these render the
//! legacy bodies, and the golden tests at the bottom of this file pin them.



use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::services::pipeline::{
    self, DetailPage, ProcessorDetail, UNSUPPORTED_PROCESSOR_TYPE,
};
use crate::services::ServiceError;

use crate::mcp_bridge::respond::truncate_var_maps;
use crate::mcp_bridge::BridgeCtx;

/// The self-reported MCP client name, defaulting to `"mcp"`.
///
/// Labels the activity feed only — never trusted for authorization (see
/// [`crate::services::Caller`]). Local to this module until a shared extractor
/// lands with the rest of the bridge's service migration.
fn client_of(headers: &HeaderMap) -> &str {
    headers
        .get("x-logtapper-client")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .unwrap_or("mcp")
}

/// Render a [`ServiceError`] the way each of these endpoints historically did.
///
/// `h_pipeline`'s only failure mode was a poisoned lock, which the
/// `lock_or_json_err!` macro rendered as a bare `{ "error": ... }`. The detail
/// endpoint added `processorId` + `sessionId` to its own errors, except the
/// "unsupported processor type" branch, which omitted `sessionId`. Reproduced
/// exactly rather than unified, so this package changes no response body.
fn detail_error(err: &ServiceError, processor_id: &str, session_id: &str) -> Json<Value> {
    match err {
        ServiceError::LockPoisoned(_) => Json(json!({ "error": err.message() })),
        ServiceError::InvalidArg { code, .. } if *code == UNSUPPORTED_PROCESSOR_TYPE => {
            Json(json!({ "error": err.message(), "processorId": processor_id }))
        }
        _ => Json(json!({
            "error": err.message(),
            "processorId": processor_id,
            "sessionId": session_id,
        })),
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
    Query(params): Query<PipelineParams>,
) -> Json<Value> {
    let svc = ctx.svc(client_of(&headers));
    let results = match pipeline::results(&svc, &session_id, params.processor_id.as_deref()) {
        Ok(r) => r,
        Err(e) => return Json(json!({ "error": e.message() })),
    };

    let reporters: Vec<Value> = results
        .reporters
        .into_iter()
        .map(|r| {
            let sample_lines: Vec<Value> = r
                .sample_matched_lines
                .iter()
                .map(|m| {
                    json!({
                        "lineNum": m.line_num,
                        "rawLine": m.raw.clone().unwrap_or_default(),
                    })
                })
                .collect();
            json!({
                "processorId": r.processor_id,
                "processorType": "reporter",
                "name": r.name,
                "description": r.description,
                "matchedLines": r.matched_line_count,
                "emissionCount": r.emission_count,
                "recentEmissions": r.recent_emissions,
                "sampleMatchedLines": sample_lines,
                "vars": truncate_var_maps(&r.vars),
            })
        })
        .collect();

    let state_trackers: Vec<Value> = results
        .state_trackers
        .into_iter()
        .map(|t| {
            let transitions: Vec<Value> = t
                .recent_transitions
                .iter()
                .map(|row| {
                    json!({
                        "lineNum": row.transition.line_num,
                        "transitionName": row.transition.transition_name,
                        "changes": row.transition.changes,
                        "rawLine": row.raw.clone().unwrap_or_default(),
                    })
                })
                .collect();
            json!({
                "processorId": t.processor_id,
                "processorType": "state_tracker",
                "name": t.name,
                "description": t.description,
                "transitionCount": t.transition_count,
                "finalState": t.final_state,
                "recentTransitions": transitions,
            })
        })
        .collect();

    let has_any = !reporters.is_empty() || !state_trackers.is_empty();
    Json(json!({
        "sessionId": session_id,
        "hasResults": has_any,
        "reporters": reporters,
        "stateTrackers": state_trackers,
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
    Query(params): Query<ProcessorDetailParams>,
) -> Json<Value> {
    let include_emissions = params.include_emissions.unwrap_or(false);
    let emission_limit = params.emission_limit.unwrap_or(50).min(200);
    let emission_offset = params.emission_offset.unwrap_or(0);
    let include_line_text = params.include_line_text.unwrap_or(false);

    let svc = ctx.svc(client_of(&headers));
    let detail = match pipeline::processor_detail(
        &svc,
        &session_id,
        &processor_id,
        DetailPage {
            offset: emission_offset,
            limit: emission_limit,
            include_emissions,
        },
        include_line_text,
    ) {
        Ok(d) => d,
        Err(e) => return detail_error(&e, &processor_id, &session_id),
    };

    match detail {
        ProcessorDetail::Reporter(r) => {
            // `emissions` is `null` rather than absent when not requested, and
            // `rawLine` is inserted into each emission object rather than
            // wrapping it — both preserved from the hand-rolled body.
            let emissions_json: Value = match r.emissions {
                Some(rows) => json!(rows
                    .into_iter()
                    .map(|row| {
                        let mut v = row.value;
                        if let (Some(text), Some(obj)) = (row.raw, v.as_object_mut()) {
                            obj.insert("rawLine".to_string(), json!(text));
                        }
                        v
                    })
                    .collect::<Vec<Value>>()),
                None => json!(null),
            };

            let matched_lines: Vec<Value> = r
                .matched_lines
                .into_iter()
                .map(|m| match m.raw {
                    Some(text) => json!({ "lineNum": m.line_num, "rawLine": text }),
                    None => json!({ "lineNum": m.line_num }),
                })
                .collect();

            Json(json!({
                // The caller's spelling, not the resolved id — bare in, bare out.
                "processorId": processor_id,
                "sessionId": session_id,
                "processorType": "reporter",
                "name": r.name,
                "description": r.description,
                "matchedLineCount": r.matched_line_count,
                "emissionCount": r.emission_count,
                "vars": truncate_var_maps(&r.vars),
                "matchedLines": matched_lines,
                "emissions": emissions_json,
                "emissionOffset": r.offset,
                "emissionLimit": r.limit,
            }))
        }
        ProcessorDetail::StateTracker(t) => {
            let transitions: Vec<Value> = t
                .transitions
                .into_iter()
                .map(|row| {
                    let mut v = json!({
                        "lineNum": row.transition.line_num,
                        "timestamp": row.transition.timestamp,
                        "transitionName": row.transition.transition_name,
                        "changes": row.transition.changes,
                    });
                    if let (Some(text), Some(obj)) = (row.raw, v.as_object_mut()) {
                        obj.insert("rawLine".to_string(), json!(text));
                    }
                    v
                })
                .collect();

            Json(json!({
                "processorId": processor_id,
                "sessionId": session_id,
                "processorType": "state_tracker",
                "name": t.name,
                "description": t.description,
                "transitionCount": t.transition_count,
                "finalState": t.final_state,
                "transitions": transitions,
                "offset": t.offset,
                "limit": t.limit,
            }))
        }
    }
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
    Json(body): Json<RunPipelineBody>,
) -> Json<Value> {
    let svc = ctx.svc(client_of(&headers));

    // An agent-triggered run still lights up the desktop progress bar: the
    // bridge's `EventSink` is the same `TauriSink` the UI listens on, so
    // `pipeline-progress` lands exactly where `app.emit` used to put it — with
    // no `AppHandle` in this file.
    let progress = std::sync::Arc::new(pipeline::EventSinkProgress::new(
        std::sync::Arc::clone(&ctx.events),
    ));

    match pipeline::run(svc, session_id.clone(), body.processor_ids, progress).await {
        Ok(result) => Json(json!({
            "sessionId": result.session_id,
            "summaries": result.summaries,
            "processorCount": result.summaries.len(),
        })),
        Err(e) => Json(json!({ "error": e.message(), "sessionId": session_id })),
    }
}

// ---------------------------------------------------------------------------
// Golden tests — the response bodies MCP clients parse today
// ---------------------------------------------------------------------------
//
// These pin the JSON these three handlers emitted before the bodies moved into
// `services::pipeline`, so the extraction is provably shape-preserving. WP-13
// and WP-16 will deliberately change them; until then a diff here is a bug.

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    use crate::commands::AppState;
    use crate::processors::reporter::engine::{Emission, RunResult};
    use crate::processors::state_tracker::types::{
        FieldChange, StateTrackerResult, StateTransition,
    };
    use crate::processors::{AnyProcessor, ProcessorMeta};
    use crate::services::events::NullSink;
    use crate::services::paths::{AppPaths, Spawner};
    use crate::services::testing::{fixture_session, RecordingSink};
    use crate::services::ServiceError;

    // ── Harness ────────────────────────────────────────────────────────────

    struct NoPaths;
    impl AppPaths for NoPaths {
        fn app_data_dir(&self) -> Result<std::path::PathBuf, ServiceError> {
            Err(ServiceError::Internal("no app data dir in tests".into()))
        }
    }

    struct NoSpawner;
    impl Spawner for NoSpawner {
        fn spawn(&self, _fut: futures_util::future::BoxFuture<'static, ()>) {}
    }

    /// A bridge context with no Tauri handle. Any handler still reaching for
    /// the transitional `BridgeCtx` app handle would fail here, which is half
    /// the point of the suite.
    fn bridge_ctx(state: Arc<AppState>) -> BridgeCtx {
        BridgeCtx::from_parts(state, Arc::new(NullSink), Arc::new(NoPaths), Arc::new(NoSpawner))
    }

    fn state_with_session(session_id: &str, lines: usize) -> Arc<AppState> {
        let state = Arc::new(AppState::new());
        state
            .sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), fixture_session(session_id, lines));
        // Agents are redacted per-session by default; these fixtures carry no
        // PII, but the flag is set explicitly so the golden bodies do not
        // depend on the fail-closed default changing.
        state
            .mcp_anonymize
            .lock()
            .unwrap()
            .insert(session_id.to_string(), false);
        state
    }

    fn reporter_meta(id: &str) -> ProcessorMeta {
        ProcessorMeta {
            id: id.to_string(),
            name: format!("Name of {id}"),
            version: "1.0.0".into(),
            author: String::new(),
            description: format!("Desc of {id}"),
            tags: vec![],
            builtin: false,
            license: None,
            category: None,
            repository: None,
            deprecated: false,
        }
    }

    const REPORTER_YAML: &str = r#"
meta:
  id: r
  name: R
pipeline:
  - stage: filter
    rules:
      - type: message_contains
        value: "x"
"#;

    const TRACKER_YAML: &str = r#"
type: state_tracker
id: t
name: T
version: 1.0.0
state:
  - name: enabled
    type: bool
    default: false
transitions:
  - name: turn_on
    filter:
      message_contains: on
    set:
      enabled: true
"#;

    fn install(state: &AppState, id: &str, yaml: &str) {
        let mut p = AnyProcessor::from_yaml(yaml).expect("fixture yaml parses");
        p.meta = reporter_meta(id);
        state.processors.lock().unwrap().insert(id.to_string(), p);
    }

    fn seed_reporter(state: &AppState, session_id: &str, proc_id: &str) {
        state.pipeline_results.lock().unwrap().insert(
            session_id.to_string(),
            HashMap::from([(
                proc_id.to_string(),
                RunResult {
                    emissions: vec![Emission {
                        line_num: 1,
                        fields: vec![("kind".to_string(), json!("first"))],
                    }],
                    vars: HashMap::from([("count".to_string(), json!(3))]),
                    matched_line_nums: vec![1, 2],
                    script_errors: 0,
                    first_script_error: None,
                },
            )]),
        );
    }

    fn seed_tracker(state: &AppState, session_id: &str, tracker_id: &str) {
        state.state_tracker_results.lock().unwrap().insert(
            session_id.to_string(),
            HashMap::from([(
                tracker_id.to_string(),
                StateTrackerResult {
                    tracker_id: tracker_id.to_string(),
                    transitions: vec![StateTransition {
                        line_num: 1,
                        timestamp: 42,
                        transition_name: "turn_on".to_string(),
                        changes: HashMap::from([(
                            "enabled".to_string(),
                            FieldChange {
                                from: json!(false),
                                to: json!(true),
                            },
                        )]),
                    }],
                    final_state: HashMap::from([("enabled".to_string(), json!(true))]),
                    source_sections: Vec::new(),
                    mode: Default::default(),
                },
            )]),
        );
    }

    fn detail_params() -> ProcessorDetailParams {
        ProcessorDetailParams {
            include_emissions: None,
            emission_limit: None,
            emission_offset: None,
            include_line_text: None,
        }
    }

    // ── h_pipeline ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn pipeline_body_keeps_every_reporter_and_tracker_key() {
        let state = state_with_session("s1", 5);
        install(&state, "rep@official", REPORTER_YAML);
        install(&state, "trk@official", TRACKER_YAML);
        seed_reporter(&state, "s1", "rep@official");
        seed_tracker(&state, "s1", "trk@official");

        let Json(v) = h_pipeline(
            State(bridge_ctx(state)),
            HeaderMap::new(),
            Path("s1".to_string()),
            Query(PipelineParams { processor_id: None }),
        )
        .await;

        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["hasResults"], true);

        let r = &v["reporters"][0];
        assert_eq!(r["processorId"], "rep@official");
        assert_eq!(r["processorType"], "reporter");
        assert_eq!(r["name"], "Name of rep@official");
        assert_eq!(r["description"], "Desc of rep@official");
        assert_eq!(r["matchedLines"], 2);
        assert_eq!(r["emissionCount"], 1);
        assert!(r["recentEmissions"].is_array());
        assert_eq!(r["sampleMatchedLines"][0]["lineNum"], 1);
        assert_eq!(r["sampleMatchedLines"][0]["rawLine"], "line 1");
        assert_eq!(r["vars"]["count"], 3);

        let t = &v["stateTrackers"][0];
        assert_eq!(t["processorId"], "trk@official");
        assert_eq!(t["processorType"], "state_tracker");
        assert_eq!(t["transitionCount"], 1);
        assert_eq!(t["finalState"]["enabled"], true);
        let tr = &t["recentTransitions"][0];
        assert_eq!(tr["lineNum"], 1);
        assert_eq!(tr["transitionName"], "turn_on");
        assert_eq!(tr["rawLine"], "line 1");
        // The pipeline listing has never carried `timestamp` on a transition —
        // only the detail endpoint does.
        assert!(tr.get("timestamp").is_none());
    }

    #[tokio::test]
    async fn pipeline_body_on_an_unknown_session_reports_no_results() {
        let state = Arc::new(AppState::new());
        let Json(v) = h_pipeline(
            State(bridge_ctx(state)),
            HeaderMap::new(),
            Path("nope".to_string()),
            Query(PipelineParams { processor_id: None }),
        )
        .await;
        assert_eq!(v["hasResults"], false);
        assert_eq!(v["reporters"].as_array().unwrap().len(), 0);
        assert_eq!(v["stateTrackers"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn pipeline_body_filters_to_one_processor_by_bare_id() {
        let state = state_with_session("s1", 5);
        install(&state, "rep@official", REPORTER_YAML);
        install(&state, "trk@official", TRACKER_YAML);
        seed_reporter(&state, "s1", "rep@official");
        seed_tracker(&state, "s1", "trk@official");

        let Json(v) = h_pipeline(
            State(bridge_ctx(state)),
            HeaderMap::new(),
            Path("s1".to_string()),
            Query(PipelineParams {
                processor_id: Some("rep".to_string()),
            }),
        )
        .await;
        assert_eq!(v["reporters"].as_array().unwrap().len(), 1);
        assert_eq!(v["stateTrackers"].as_array().unwrap().len(), 0);
    }

    // ── h_processor_detail ─────────────────────────────────────────────────

    #[tokio::test]
    async fn reporter_detail_body_keeps_every_key_and_nulls_absent_emissions() {
        let state = state_with_session("s1", 5);
        install(&state, "rep@official", REPORTER_YAML);
        seed_reporter(&state, "s1", "rep@official");

        let Json(v) = h_processor_detail(
            State(bridge_ctx(state)),
            HeaderMap::new(),
            Path(("s1".to_string(), "rep".to_string())),
            Query(detail_params()),
        )
        .await;

        // Echoes the caller's spelling, not the resolved id.
        assert_eq!(v["processorId"], "rep");
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["processorType"], "reporter");
        assert_eq!(v["name"], "Name of rep@official");
        assert_eq!(v["matchedLineCount"], 2);
        assert_eq!(v["emissionCount"], 1);
        assert_eq!(v["emissionOffset"], 0);
        assert_eq!(v["emissionLimit"], 50);
        assert!(v["emissions"].is_null(), "absent emissions are null, not missing");
        // No line text requested → bare `{ lineNum }` entries.
        assert_eq!(v["matchedLines"][0], json!({ "lineNum": 1 }));
    }

    #[tokio::test]
    async fn reporter_detail_body_inlines_raw_line_into_each_emission() {
        let state = state_with_session("s1", 5);
        install(&state, "rep@official", REPORTER_YAML);
        seed_reporter(&state, "s1", "rep@official");

        let Json(v) = h_processor_detail(
            State(bridge_ctx(state)),
            HeaderMap::new(),
            Path(("s1".to_string(), "rep".to_string())),
            Query(ProcessorDetailParams {
                include_emissions: Some(true),
                emission_limit: Some(10),
                emission_offset: Some(0),
                include_line_text: Some(true),
            }),
        )
        .await;

        assert_eq!(v["emissionLimit"], 10);
        let e = &v["emissions"][0];
        // An emission serializes through `Emission`'s own hand-written impl:
        // snake_case `line_num`, payload nested under `fields`. Unchanged by
        // this move, and pinned here because it is what MCP clients parse.
        assert_eq!(e["line_num"], 1);
        assert_eq!(e["fields"]["kind"], "first");
        assert_eq!(e["rawLine"], "line 1", "rawLine is inlined, not wrapped");
        assert_eq!(v["matchedLines"][0]["rawLine"], "line 1");
    }

    #[tokio::test]
    async fn tracker_detail_body_carries_timestamp_and_paging_keys() {
        let state = state_with_session("s1", 5);
        install(&state, "trk@official", TRACKER_YAML);
        seed_tracker(&state, "s1", "trk@official");

        let Json(v) = h_processor_detail(
            State(bridge_ctx(state)),
            HeaderMap::new(),
            Path(("s1".to_string(), "trk".to_string())),
            Query(ProcessorDetailParams {
                include_emissions: None,
                emission_limit: None,
                emission_offset: None,
                include_line_text: Some(true),
            }),
        )
        .await;

        assert_eq!(v["processorType"], "state_tracker");
        assert_eq!(v["transitionCount"], 1);
        assert_eq!(v["finalState"]["enabled"], true);
        assert_eq!(v["offset"], 0);
        assert_eq!(v["limit"], 50);
        let t = &v["transitions"][0];
        assert_eq!(t["lineNum"], 1);
        assert_eq!(t["timestamp"], 42);
        assert_eq!(t["transitionName"], "turn_on");
        assert_eq!(t["rawLine"], "line 1");
    }

    #[tokio::test]
    async fn detail_missing_results_error_carries_processor_and_session() {
        let state = state_with_session("s1", 5);
        install(&state, "rep@official", REPORTER_YAML);

        let Json(v) = h_processor_detail(
            State(bridge_ctx(state)),
            HeaderMap::new(),
            Path(("s1".to_string(), "rep".to_string())),
            Query(detail_params()),
        )
        .await;
        assert_eq!(v["error"], "no results for this processor/session");
        assert_eq!(v["processorId"], "rep");
        assert_eq!(v["sessionId"], "s1");
    }

    #[test]
    fn unsupported_processor_type_error_omits_the_session_id() {
        let err = ServiceError::InvalidArg {
            code: UNSUPPORTED_PROCESSOR_TYPE,
            message: "processor type 'correlator' detail not supported".to_string(),
        };
        let Json(v) = detail_error(&err, "corr", "s1");
        assert_eq!(v["error"], "processor type 'correlator' detail not supported");
        assert_eq!(v["processorId"], "corr");
        assert!(
            v.get("sessionId").is_none(),
            "this one branch has always omitted sessionId"
        );
    }

    #[test]
    fn a_poisoned_lock_still_renders_a_bare_error_body() {
        let Json(v) = detail_error(&ServiceError::LockPoisoned("pipeline_results"), "p", "s1");
        assert_eq!(v["error"], "pipeline_results lock poisoned");
        assert!(v.get("processorId").is_none());
        assert!(v.get("sessionId").is_none());
    }

    // ── h_run_pipeline ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn run_pipeline_body_keeps_session_summaries_and_count() {
        let state = state_with_session("s1", 5);
        install(&state, "rep@official", REPORTER_YAML);

        let Json(v) = h_run_pipeline(
            State(bridge_ctx(state)),
            HeaderMap::new(),
            Path("s1".to_string()),
            Json(RunPipelineBody {
                processor_ids: Some(vec!["rep".to_string()]),
            }),
        )
        .await;

        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["processorCount"], 1);
        assert_eq!(v["summaries"][0]["processorId"], "rep@official");
    }

    /// The deleted fallback, pinned: an agent that names no processors on a
    /// session with no configured chain gets an error, NOT a run of every
    /// installed processor.
    #[tokio::test]
    async fn run_pipeline_no_longer_defaults_to_every_installed_processor() {
        let state = state_with_session("s1", 5);
        install(&state, "rep@official", REPORTER_YAML);
        install(&state, "trk@official", TRACKER_YAML);

        let Json(v) = h_run_pipeline(
            State(bridge_ctx(state)),
            HeaderMap::new(),
            Path("s1".to_string()),
            Json(RunPipelineBody { processor_ids: None }),
        )
        .await;

        assert_eq!(v["error"], "no pipeline chain configured for session s1");
        assert_eq!(v["sessionId"], "s1");
        assert!(v.get("summaries").is_none());
    }

    #[tokio::test]
    async fn run_pipeline_on_a_missing_session_reports_the_session_error() {
        let state = Arc::new(AppState::new());
        let Json(v) = h_run_pipeline(
            State(bridge_ctx(state)),
            HeaderMap::new(),
            Path("nope".to_string()),
            Json(RunPipelineBody {
                processor_ids: Some(vec!["rep".to_string()]),
            }),
        )
        .await;
        assert!(v["error"].is_string());
        assert_eq!(v["sessionId"], "nope");
    }

    #[tokio::test]
    async fn an_agent_run_still_emits_pipeline_progress_to_the_ui_sink() {
        let state = state_with_session("s1", 5);
        install(&state, "rep@official", REPORTER_YAML);
        let sink = Arc::new(RecordingSink::new());
        let ctx = BridgeCtx::from_parts(
            state,
            sink.clone(),
            Arc::new(NoPaths),
            Arc::new(NoSpawner),
        );

        let _ = h_run_pipeline(
            State(ctx),
            HeaderMap::new(),
            Path("s1".to_string()),
            Json(RunPipelineBody {
                processor_ids: Some(vec!["rep".to_string()]),
            }),
        )
        .await;

        let progress = sink.events_named("pipeline-progress");
        assert!(
            !progress.is_empty(),
            "an agent-triggered run must still drive the desktop progress bar"
        );
        assert_eq!(progress[0].payload["sessionId"], "s1");
    }

    // ── Client identity ────────────────────────────────────────────────────

    #[test]
    fn client_header_defaults_to_mcp_and_ignores_an_empty_value() {
        let mut h = HeaderMap::new();
        assert_eq!(client_of(&h), "mcp");
        h.insert("x-logtapper-client", "".parse().unwrap());
        assert_eq!(client_of(&h), "mcp");
        h.insert("x-logtapper-client", "claude-code".parse().unwrap());
        assert_eq!(client_of(&h), "claude-code");
    }
}
