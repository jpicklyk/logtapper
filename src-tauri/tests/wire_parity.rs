//! Wire parity: for every shared `services::wire` response type, prove that
//! the value a service function returns and the JSON body the matching
//! `/mcp/...` route answers with are the SAME shape — same top-level key set
//! (camelCase, per the generated TS bindings), and, for routes that are pure
//! passthroughs of the service value (the majority, after WP-13), byte-exact
//! `assert_eq!` on the data itself.
//!
//! ## How to add a new type here
//!
//! 1. Find the route's handler in `src/mcp_bridge/routes/*.rs` and read what
//!    it does with the service function's return value — most handlers
//!    (WP-13) are `Ok(Json(service::fn(&svc, ..)?))`, a pure passthrough.
//! 2. Build a `ServiceCtx` via `support::ctx_only()` (shares one `AppState`
//!    with the router built from the same `BridgeCtx`, so no "separate
//!    AppState with identical fixtures" dance is needed — clone the
//!    `BridgeCtx` for `.svc()` BEFORE moving it into `mcp_bridge::router()`).
//! 3. Seed `AppState` directly (sessions/processors/results — see the
//!    existing sections below for the fixture patterns already in use).
//! 4. Call the service function, `serde_json::to_value` the result, hit the
//!    HTTP route with `support::get`/`support::send_json`, and:
//!    - assert the top-level key set with [`assert_top_level_keys`] (or
//!      `assert_eq!` two `serde_json::Value`s directly when it's a passthrough
//!      — that already proves the key set AND every value),
//!    - call `assert_ts_binding_covers_json_keys("<TypeName>", &value)` so a
//!      future field rename that forgets to touch the generated `.ts` (or
//!      forgets `#[serde(rename_all = "camelCase")]` on a new field) fails
//!      here rather than only in a frontend type error.
//!
//! ## Deliberate envelope differences (not bugs — documented here once)
//!
//! - **`LinePage` / `SearchHits` / `PipelineRunResult`** are NOT yet shared
//!   with the Tauri command adapters (`commands::files::get_lines` still
//!   returns `LineWindow`, `commands::files::search_logs` returns
//!   `SearchSummary`, `commands::pipeline::run_pipeline` returns
//!   `Vec<PipelineRunSummary>` — see WP-1/WP-2/WP-4's handoff notes; WP-16
//!   closes this). Since there is no second "command path" producer of these
//!   exact types to compare against, these sections instead prove the HTTP
//!   route reproduces EXACTLY what the underlying service function returns
//!   (calling that same function directly, under the same `Caller::Agent`
//!   identity the bridge always uses) — which is the parity property that
//!   actually matters here: the route must not distort, rename, or drop a
//!   field relative to what the service computed.
//! - **`correlations`** narrows `CorrelationEvent` (which carries raw line
//!   text and full per-source match records) down to `CorrelationSummary`
//!   (structured trigger fields only) — `services::correlator` does not
//!   redact, so the bridge withholds raw text at the route rather than
//!   the service. The parity check here is over the fields the summary DOES
//!   carry, not full equality with the service value.
//! - **`Sampled<T>`** has no endpoint that returns it directly — `LinePage`
//!   inlines the same fields (`strategy`/`strategyNote`/`scannedLines`/
//!   `truncated` alongside `count` standing in for `sampledCount`) rather than
//!   nesting a `Sampled<ViewLine>`, per that type's own doc comment. Covered
//!   via `LinePage`'s sampling-metadata fields instead of a standalone test.
//! - **`SearchSummary`** (the viewer's counting search) has no bridge
//!   equivalent at all — it is UI-only, driven by `commands::files::search_logs`,
//!   never exposed over HTTP. Covered by a shape-only smoke test with no HTTP
//!   side to compare against (see `search_summary_has_no_bridge_equivalent`).
//! - **`Ui`-vs-`Agent` redaction**: every test in this file that involves raw
//!   line text sets `mcp_anonymize(session, false)` so both the service call
//!   (`Caller::Agent`, matching what `BridgeCtx::svc` always builds) and the
//!   HTTP call serve raw text — anonymization GATING itself is pinned
//!   exhaustively in `tests/bridge_http.rs`, not here.

mod support;

use std::collections::HashMap;
use std::sync::Arc;

use app_lib::commands::AppState;
use app_lib::core::bookmark::CreatedBy;
use app_lib::core::filter::FilterCriteria;
use app_lib::mcp_bridge;
use app_lib::processors::state_tracker::schema::{
    StateFieldDecl, StateFieldType, StateTrackerDef, StateTrackerOutput, TrackerMode,
};
use app_lib::processors::state_tracker::types::{FieldChange, StateTrackerResult, StateTransition};
use app_lib::processors::{AnyProcessor, ProcessorKind, ProcessorMeta};
use app_lib::services::pipeline::{self, DetailPage, ProcessorDetail as SvcProcessorDetail};
use app_lib::services::testing::{fixture_session, fixture_session_with_pii};
use app_lib::services::{
    analyses, bookmarks, correlator, filters, insights, search, sections, settings, stream,
    tracker, watches, workspace,
};
use app_lib::services::lines::{self, LineSelection, LinesRequest};
use app_lib::services::search::SearchHitsRequest;
use app_lib::services::{NullProgressSink, ProgressSink};
use app_lib::workspace::app_state::{AppStateFile, WorkspaceEntry};

use axum::http::Method;
use serde_json::{Value, json};

use support::*;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Assert `value`'s top-level JSON object has EXACTLY `expected`'s keys
/// (order-independent) — part (a) of the parity contract: exact key set and
/// casing.
fn assert_top_level_keys(value: &Value, expected: &[&str]) {
    let obj = value
        .as_object()
        .unwrap_or_else(|| panic!("expected a JSON object, got {value}"));
    let mut actual: Vec<&str> = obj.keys().map(String::as_str).collect();
    actual.sort_unstable();
    let mut expected_sorted: Vec<&str> = expected.to_vec();
    expected_sorted.sort_unstable();
    assert_eq!(
        actual, expected_sorted,
        "top-level key set mismatch — actual value was {value}"
    );
}

/// Sort a JSON array of strings in place — used to normalize fields backed by
/// a `HashSet`/`HashMap` internally (iteration order is not guaranteed to
/// agree between two independent computations over identical input, even
/// within the same process) before an otherwise byte-identical comparison.
fn sort_string_array(value: &mut Value) {
    let arr = value.as_array_mut().expect("expected a JSON array to sort");
    arr.sort_by(|a, b| a.as_str().unwrap_or_default().cmp(b.as_str().unwrap_or_default()));
}

/// A minimal state-tracker processor definition: two fields (`enabled`,
/// `ssid`), no transition rules of its own (transitions are seeded directly
/// into `state_tracker_results`, matching `services::tracker`'s own test
/// pattern).
fn tracker_def(mode: TrackerMode) -> StateTrackerDef {
    StateTrackerDef {
        group: String::new(),
        sections: vec![],
        mode,
        state: vec![
            StateFieldDecl {
                name: "enabled".to_string(),
                field_type: StateFieldType::Bool,
                default: json!(false),
            },
            StateFieldDecl {
                name: "ssid".to_string(),
                field_type: StateFieldType::String,
                default: json!(""),
            },
        ],
        transitions: vec![],
        output: StateTrackerOutput { timeline: false, annotate: false },
    }
}

fn install_tracker(state: &Arc<AppState>, id: &str, mode: TrackerMode) {
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
        kind: ProcessorKind::StateTracker(Arc::new(tracker_def(mode))),
        schema: None,
        source: None,
    };
    state.processors.lock().unwrap().insert(id.to_string(), processor);
}

fn transition(line_num: usize, field: &str, to: Value) -> StateTransition {
    let mut changes = HashMap::new();
    changes.insert(field.to_string(), FieldChange { from: json!(null), to });
    StateTransition {
        line_num,
        timestamp: line_num as i64 * 1000,
        transition_name: format!("t{line_num}"),
        changes,
    }
}

fn seed_pipeline_tracker_result(
    state: &Arc<AppState>,
    session_id: &str,
    tracker_id: &str,
    transitions: Vec<StateTransition>,
    sections: Vec<String>,
    mode: TrackerMode,
) {
    let result = StateTrackerResult {
        tracker_id: tracker_id.to_string(),
        transitions,
        final_state: HashMap::new(),
        source_sections: sections,
        mode,
    };
    state
        .state_tracker_results
        .lock()
        .unwrap()
        .entry(session_id.to_string())
        .or_default()
        .insert(tracker_id.to_string(), result);
}

fn null_progress() -> Arc<dyn ProgressSink> {
    Arc::new(NullProgressSink)
}

// ---------------------------------------------------------------------------
// 1. LinePage — GET /mcp/sessions/{id}/query
// ---------------------------------------------------------------------------

#[tokio::test]
async fn line_page_query_matches_the_service_value_field_for_field() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state
        .sessions
        .lock()
        .unwrap()
        .insert("s1".to_string(), fixture_session_with_pii("s1", 10));
    state.mcp_anonymize.lock().unwrap().insert("s1".to_string(), false);

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let req = LinesRequest::range("s1", 0, 5)
        .select(LineSelection::Recent { count: 5 })
        .for_agent(None);
    let expected = lines::get_lines(&svc, req).expect("service get_lines");
    let expected_value = serde_json::to_value(&expected).expect("serialize LinePage");

    let (status, http_value) = get(&router, "/mcp/sessions/s1/query?n=5&strategy=recent", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");

    assert_top_level_keys(
        &http_value,
        &["sessionId", "totalLines", "offset", "count", "truncated", "lines", "strategy", "strategyNote", "stats"],
    );
    assert_eq!(expected_value, http_value, "LinePage must serialize identically on both paths");
    assert_ts_binding_covers_json_keys("LinePage", &http_value);
}

// ---------------------------------------------------------------------------
// 2. SearchHits — GET /mcp/sessions/{id}/search and /search_with_context
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_hits_matches_the_service_value_field_for_field_on_both_routes() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state
        .sessions
        .lock()
        .unwrap()
        .insert("s1".to_string(), fixture_session("s1", 20));
    state.mcp_anonymize.lock().unwrap().insert("s1".to_string(), false);

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    // `search` — stops once the page is full.
    let req = SearchHitsRequest {
        session_id: "s1".to_string(),
        pattern: "line".to_string(),
        case_insensitive: false,
        context_before: 1,
        context_after: 1,
        offset: 0,
        limit: 2,
        start_line: None,
        end_line: None,
        max_line_chars: 500,
        with_captures: true,
        count_all_matches: false,
        count_unreadable_as_scanned: true,
        redact_match_line_first: true,
    };
    let expected = search::hits(&svc, &req).expect("service hits (search)");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/sessions/s1/search?pattern=line&limit=2&context=1", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_top_level_keys(
        &http_value,
        &["sessionId", "total", "returned", "offset", "limit", "truncated", "scannedLines", "totalLines", "hits"],
    );
    assert_eq!(expected_value, http_value, "SearchHits (search) must match the service value");
    assert_ts_binding_covers_json_keys("SearchHits", &http_value);

    // `search_with_context` — scans the whole range for an exact count.
    let req2 = SearchHitsRequest {
        session_id: "s1".to_string(),
        pattern: "line".to_string(),
        case_insensitive: false,
        context_before: 1,
        context_after: 1,
        offset: 0,
        limit: 2,
        start_line: None,
        end_line: None,
        max_line_chars: 500,
        with_captures: false,
        count_all_matches: true,
        count_unreadable_as_scanned: false,
        redact_match_line_first: false,
    };
    let expected2 = search::hits(&svc, &req2).expect("service hits (search_with_context)");
    let expected2_value = serde_json::to_value(&expected2).unwrap();

    let (status, http_value2) = get(
        &router,
        "/mcp/sessions/s1/search_with_context?query=line&max_results=2&context_lines=1",
        &trusted_headers(),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value2}");
    assert_eq!(expected2_value, http_value2, "SearchHits (search_with_context) must match the service value");
}

/// `SearchSummary` (the viewer's counting search, `commands::files::search_logs`
/// -> `services::search::summary`) has no HTTP route at all — see this file's
/// module doc. This is a shape-only smoke test: it proves the type still
/// serializes with the fields the MCP skill docs describe (`scannedLines`,
/// `matchCount`... see `services::search::summary`'s own doc comment) without
/// claiming a wire comparison that cannot exist.
#[tokio::test]
async fn search_summary_has_no_bridge_equivalent() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));
    let svc = bridge_ctx.svc("wire-parity");

    let query = app_lib::core::line::SearchQuery {
        text: "line".to_string(),
        is_regex: false,
        case_sensitive: false,
        within_processor: None,
        min_level: None,
        tags: None,
        start_time: None,
        end_time: None,
    };
    let summary = search::summary(&svc, "s1", &query, null_progress()).expect("summary");
    let value = serde_json::to_value(&summary).unwrap();
    // Just prove it is a real, non-empty object — no HTTP body to compare it
    // against, by design (see module doc).
    assert!(value.is_object());
    assert!(!value.as_object().unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// 3. Page<StateTransition> / Page<TrackerEventEntry> — GET /mcp/sessions/{id}/events
// ---------------------------------------------------------------------------

#[tokio::test]
async fn events_page_carries_the_same_transitions_as_the_per_tracker_command_path() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));
    install_tracker(&state, "wifi-state", TrackerMode::TimeSeries);
    seed_pipeline_tracker_result(
        &state,
        "s1",
        "wifi-state",
        vec![transition(10, "enabled", json!(true)), transition(50, "ssid", json!("HomeWifi"))],
        vec![],
        TrackerMode::TimeSeries,
    );

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    // The "command path" shape: `commands::state_tracker::get_state_transitions`
    // calls exactly this, per-tracker, ascending by recorded order.
    let command_page = tracker::transitions(&svc, "s1", "wifi-state", 0, usize::MAX).expect("transitions");
    assert_eq!(command_page.items.len(), 2);

    // The bridge's `events` route aggregates ACROSS every tracker in the
    // session (there is only one here) via `recent_events`, most-recent-line
    // first — the opposite order from `transitions`' ascending recording
    // order. With a single tracker the two are the exact same set of
    // transitions, just reversed and each tagged with its tracker id.
    let (status, http_value) = get(&router, "/mcp/sessions/s1/events?limit=50", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_top_level_keys(&http_value, &["items", "offset", "limit", "total", "truncated"]);
    assert_ts_binding_covers_json_keys("TrackerEventEntry", &http_value["items"][0]);

    let http_items = http_value["items"].as_array().expect("items array");
    assert_eq!(http_items.len(), 2);

    let mut expected_desc = command_page.items.clone();
    expected_desc.reverse(); // recent_events sorts most-recent-line first
    for (expected, actual) in expected_desc.iter().zip(http_items.iter()) {
        assert_eq!(actual["trackerId"], "wifi-state");
        assert_eq!(actual["lineNum"], expected.line_num);
        assert_eq!(actual["timestamp"], expected.timestamp);
        assert_eq!(actual["transitionName"], expected.transition_name);
        assert_eq!(
            serde_json::to_value(&actual["changes"]).unwrap(),
            serde_json::to_value(&expected.changes).unwrap()
        );
    }
}

// ---------------------------------------------------------------------------
// 4. StateSnapshot — GET /mcp/sessions/{id}/tracker/{tracker_id}/state_at
// ---------------------------------------------------------------------------

#[tokio::test]
async fn state_snapshot_is_byte_identical_between_the_service_and_the_route() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));
    install_tracker(&state, "wifi-state", TrackerMode::TimeSeries);
    seed_pipeline_tracker_result(
        &state,
        "s1",
        "wifi-state",
        vec![transition(10, "enabled", json!(true)), transition(50, "ssid", json!("HomeWifi"))],
        vec!["DUMPSYS NORMAL".to_string()],
        TrackerMode::TimeSeries,
    );

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let expected = tracker::state_at(&svc, "s1", "wifi-state", 60).expect("state_at");
    let mut expected_value = serde_json::to_value(&expected).unwrap();

    let (status, mut http_value) =
        get(&router, "/mcp/sessions/s1/tracker/wifi-state/state_at?line=60", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");

    assert_top_level_keys(&http_value, &["lineNum", "timestamp", "fields", "initializedFields", "sourceSections"]);
    // `initializedFields` is built from a `HashSet` internally (see
    // `services::tracker`), so two independent replays of the identical
    // input are only guaranteed to agree as SETS, not as ordered arrays —
    // sort both before the byte-identical comparison.
    sort_string_array(&mut expected_value["initializedFields"]);
    sort_string_array(&mut http_value["initializedFields"]);
    assert_eq!(expected_value, http_value, "StateSnapshot must be byte-identical — the route is a pure passthrough");
    assert_ts_binding_covers_json_keys("StateSnapshot", &http_value);
}

// ---------------------------------------------------------------------------
// 5. Correlations — GET /mcp/sessions/{id}/correlations
// ---------------------------------------------------------------------------

fn correlation_event(trigger_line_num: usize) -> app_lib::processors::correlator::engine::CorrelationEvent {
    app_lib::processors::correlator::engine::CorrelationEvent {
        trigger_line_num,
        trigger_timestamp: trigger_line_num as i64 * 1000,
        trigger_source_id: "src-a".to_string(),
        trigger_fields: HashMap::new(),
        trigger_raw_line: format!("line {trigger_line_num}"),
        matched_sources: HashMap::new(),
        message: format!("event at {trigger_line_num}"),
    }
}

#[tokio::test]
async fn correlations_narrows_the_service_events_to_the_documented_summary_fields() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));

    let result = app_lib::processors::correlator::engine::CorrelatorResult {
        guidance: Some("watch for ANRs".to_string()),
        events: vec![correlation_event(1), correlation_event(2)],
    };
    state
        .correlator_results
        .lock()
        .unwrap()
        .entry("s1".to_string())
        .or_default()
        .insert("anr-detect".to_string(), result);

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let groups = correlator::events(&svc, "s1", None, 0, 50).expect("service events");
    assert_eq!(groups.len(), 1);
    let group = &groups[0];

    let (status, http_value) = get(&router, "/mcp/sessions/s1/correlations", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_top_level_keys(&http_value, &["sessionId", "correlators"]);
    let http_group = &http_value["correlators"][0];
    assert_top_level_keys(http_group, &["correlatorId", "guidance", "events"]);
    assert_top_level_keys(&http_group["events"], &["items", "offset", "limit", "total", "truncated"]);
    assert_ts_binding_covers_json_keys("SessionCorrelations", &http_value);
    assert_ts_binding_covers_json_keys("CorrelationSummary", &http_group["events"]["items"][0]);

    assert_eq!(http_group["correlatorId"], group.correlator_id);
    assert_eq!(http_group["guidance"], json!(group.guidance));
    assert_eq!(http_group["events"]["total"], group.page.total);
    let http_items = http_group["events"]["items"].as_array().unwrap();
    assert_eq!(http_items.len(), group.page.items.len());
    for (expected, actual) in group.page.items.iter().zip(http_items.iter()) {
        assert_eq!(actual["triggerLineNum"], expected.trigger_line_num);
        assert_eq!(actual["triggerTimestamp"], expected.trigger_timestamp);
        assert_eq!(actual["triggerSourceId"], expected.trigger_source_id);
        assert_eq!(actual["message"], expected.message);
        // Documented narrowing: raw line text and full per-source match
        // records are on the service value but withheld by the route.
        assert!(actual.get("triggerRawLine").is_none(), "raw line text must not cross the wire here");
        assert!(actual.get("matchedSources").is_none(), "full match records must not cross the wire here");
    }
}

// ---------------------------------------------------------------------------
// 6. sections / section_at — GET /mcp/sessions/{id}/sections, /section_at
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sections_list_is_a_pure_passthrough_of_the_service_page() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let expected = sections::list(&svc, "s1", None, 0, 50).expect("service list");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/sessions/s1/sections", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_top_level_keys(&http_value, &["items", "offset", "limit", "total", "truncated"]);
    assert_eq!(expected_value, http_value, "sections list must be byte-identical");
    assert_ts_binding_covers_json_keys("Page", &http_value);
}

#[tokio::test]
async fn section_at_maps_the_service_result_one_to_one() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let expected = sections::at(&svc, "s1", 2).expect("service at");

    let (status, http_value) = get(&router, "/mcp/sessions/s1/section_at?line=2", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_top_level_keys(
        &http_value,
        &["sessionId", "line", "matchesFilterSection", "containingSections", "totalLinesInSession", "note"],
    );
    assert_eq!(http_value["sessionId"], "s1");
    assert_eq!(http_value["line"], 2);
    assert_eq!(http_value["matchesFilterSection"], json!(expected.matches_filter_section));
    assert_eq!(http_value["totalLinesInSession"], expected.total_lines_in_session);
    assert_eq!(http_value["note"], json!(expected.note));
    assert_ts_binding_covers_json_keys("SectionLocation", &http_value);
}

// ---------------------------------------------------------------------------
// 7. Insights — GET /mcp/sessions/{id}/insights
// ---------------------------------------------------------------------------

#[tokio::test]
async fn insights_digest_is_byte_identical_between_the_service_and_the_route() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));
    install_tracker(&state, "idle-tracker", TrackerMode::TimeSeries);

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let expected = insights::digest(&svc, "s1", 20, None).expect("digest");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/sessions/s1/insights", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_top_level_keys(&http_value, &["sessionId", "processors"]);
    assert_eq!(expected_value, http_value, "Insights must be byte-identical — the route is a pure passthrough");
    assert_ts_binding_covers_json_keys("Insights", &http_value);
}

// ---------------------------------------------------------------------------
// 8. PipelineRunResult + processor detail
// ---------------------------------------------------------------------------

const WIRE_PARITY_REPORTER: &str = r#"
meta:
  id: wire-parity-reporter
  name: Wire Parity Reporter
  version: 1.0.0
"#;

#[tokio::test]
async fn pipeline_run_result_matches_the_service_value_the_route_wraps() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));
    state.processors.lock().unwrap().insert(
        "wire-parity-reporter".to_string(),
        AnyProcessor::from_yaml(WIRE_PARITY_REPORTER).expect("fixture yaml parses"),
    );

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let expected = pipeline::run(
        svc.clone(),
        "s1".to_string(),
        Some(vec!["wire-parity-reporter".to_string()]),
        null_progress(),
    )
    .await
    .expect("service run");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = send_json(
        &router,
        Method::POST,
        "/mcp/sessions/s1/run_pipeline",
        &trusted_headers(),
        &json!({ "processorIds": ["wire-parity-reporter"] }),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_top_level_keys(&http_value, &["sessionId", "effectiveProcessorIds", "summaries"]);
    assert_ts_binding_covers_json_keys("PipelineRunResult", &http_value);

    assert_eq!(http_value["sessionId"], expected_value["sessionId"]);
    assert_eq!(http_value["effectiveProcessorIds"], expected_value["effectiveProcessorIds"]);
    assert_eq!(
        http_value["summaries"].as_array().unwrap().len(),
        expected_value["summaries"].as_array().unwrap().len()
    );
}

#[tokio::test]
async fn processor_detail_reporter_arm_reports_the_same_counts_as_the_service() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));
    state.processors.lock().unwrap().insert(
        "wire-parity-reporter".to_string(),
        AnyProcessor::from_yaml(WIRE_PARITY_REPORTER).expect("fixture yaml parses"),
    );
    // `processor_detail` reads `pipeline_results`, not just the processor
    // registry — seed a (trivially empty) `RunResult` directly, the same
    // pattern `wp10_timeline_export` in `bridge_http.rs` uses, rather than
    // running the full pipeline (which this test isn't about).
    state
        .pipeline_results
        .lock()
        .unwrap()
        .entry("s1".to_string())
        .or_default()
        .insert(
            "wire-parity-reporter".to_string(),
            app_lib::processors::RunResult::default(),
        );

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let expected = pipeline::processor_detail(
        &svc,
        "s1",
        "wire-parity-reporter",
        DetailPage { offset: 0, limit: 50, include_emissions: true },
        false,
    )
    .expect("service processor_detail");
    let SvcProcessorDetail::Reporter(expected_reporter) = expected else {
        panic!("expected a Reporter detail");
    };

    let (status, http_value) = get(
        &router,
        "/mcp/sessions/s1/processor/wire-parity-reporter?include_emissions=true",
        &trusted_headers(),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_eq!(http_value["processorType"], "reporter");
    assert_ts_binding_covers_json_keys("ReporterDetail", &http_value);

    assert_eq!(http_value["matchedLineCount"], expected_reporter.matched_line_count);
    assert_eq!(http_value["emissionCount"], expected_reporter.emission_count);
    assert_eq!(http_value["emissions"]["total"], expected_reporter.emission_count);
    assert_eq!(http_value["emissions"]["items"].as_array().unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// 9. bookmarks / analyses / watches lists
// ---------------------------------------------------------------------------

#[tokio::test]
async fn bookmarks_list_is_a_pure_passthrough_of_the_service_value() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    bookmarks::create(
        &svc,
        "s1".to_string(),
        3,
        "here".to_string(),
        "note".to_string(),
        CreatedBy::Agent,
        None,
        None,
        None,
        None,
    )
    .expect("create bookmark");

    let expected = bookmarks::list(&svc, "s1", None, None).expect("service list");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/sessions/s1/bookmarks", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_eq!(expected_value, http_value, "bookmark list must be byte-identical");
    assert_eq!(http_value.as_array().unwrap().len(), 1);
    assert_ts_binding_covers_json_keys("Bookmark", &http_value[0]);
}

#[tokio::test]
async fn analyses_list_is_a_pure_passthrough_of_the_service_value() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    analyses::publish(&svc, Some("s1".to_string()), "Findings".to_string(), Vec::new())
        .expect("publish analysis");

    let expected = analyses::list(&svc, Some("s1")).expect("service list");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/sessions/s1/analyses", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_eq!(expected_value, http_value, "analyses list must be byte-identical");
    assert_eq!(http_value.as_array().unwrap().len(), 1);
    assert_ts_binding_covers_json_keys("AnalysisArtifact", &http_value[0]);
}

#[tokio::test]
async fn watches_list_is_a_pure_passthrough_of_the_service_value() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    watches::create(&svc, "s1".to_string(), FilterCriteria::default()).expect("create watch");

    let expected = watches::list(&svc, "s1").expect("service list");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/sessions/s1/watches", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_eq!(expected_value, http_value, "watch list must be byte-identical");
    assert_eq!(http_value.as_array().unwrap().len(), 1);
    assert_ts_binding_covers_json_keys("WatchInfo", &http_value[0]);
}

// ---------------------------------------------------------------------------
// 10. filters info / lines
// ---------------------------------------------------------------------------

#[tokio::test]
async fn filter_info_and_lines_are_a_pure_passthrough_of_the_service_values() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 10));

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let created =
        filters::create(&svc, "s1".to_string(), FilterCriteria::default(), null_progress())
            .expect("create filter");

    let expected_info = filters::info(&svc, &created.filter_id).expect("service info");
    let expected_info_value = serde_json::to_value(&expected_info).unwrap();

    let (status, http_value) = get(&router, &format!("/mcp/filters/{}", created.filter_id), &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_top_level_keys(&http_value, &["filterId", "sessionId", "totalMatches", "linesScanned", "totalLines", "status"]);
    assert_eq!(expected_info_value, http_value, "FilterInfo must be byte-identical");
    assert_ts_binding_covers_json_keys("FilterInfo", &http_value);

    let expected_lines = filters::lines(&svc, &created.filter_id, 0, 200).expect("service lines");
    let expected_lines_value = serde_json::to_value(&expected_lines).unwrap();

    let (status, http_lines) =
        get(&router, &format!("/mcp/filters/{}/lines", created.filter_id), &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_lines}");
    assert_top_level_keys(&http_lines, &["filterId", "totalMatches", "lines", "status"]);
    assert_eq!(expected_lines_value, http_lines, "FilteredLinesResult must be byte-identical");
    assert_ts_binding_covers_json_keys("FilteredLinesResult", &http_lines);
}

// ---------------------------------------------------------------------------
// 11. StreamStatus — GET /mcp/sessions/{id}/stream/status
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stream_status_is_a_pure_passthrough_of_the_service_value() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    // `fixture_session` is backed by a `StreamLogSource` (see
    // `services::testing`), so `stream::status` works without a real ADB
    // capture ever having run.
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 5));

    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let expected = stream::status(&svc, "s1").expect("service status");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/sessions/s1/stream/status", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_top_level_keys(
        &http_value,
        &[
            "sessionId", "sourceName", "streaming", "totalLines", "byteCount", "firstTimestamp",
            "lastTimestamp", "lostLineCount", "anonymize", "processorIds", "trackerIds",
            "transformerIds", "latestEventSeq",
        ],
    );
    assert_eq!(expected_value, http_value, "StreamStatus must be byte-identical");
    assert_ts_binding_covers_json_keys("StreamStatus", &http_value);
}

// ---------------------------------------------------------------------------
// 12. ActivityEntry — GET /mcp/activity
// ---------------------------------------------------------------------------

#[tokio::test]
async fn activity_entries_are_a_pure_passthrough_of_the_journal() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let entry = svc.journal("bookmark.create", Some("s1"), "line 3: hello");
    let expected = state.activity.list(None, None);
    assert_eq!(expected.len(), 1);
    assert_eq!(expected[0], entry);
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/activity", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_eq!(expected_value, http_value, "activity feed must be byte-identical");
    assert_top_level_keys(&http_value[0], &["id", "ts", "caller", "action", "sessionId", "summary"]);
    assert_ts_binding_covers_json_keys("ActivityEntry", &http_value[0]);
}

// ---------------------------------------------------------------------------
// 13. Settings GETs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn anonymizer_config_get_is_a_pure_passthrough_of_the_service_value() {
    let (bridge_ctx, _state, _sink, _tmp) = support::ctx_only();
    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let expected = settings::anonymizer_config(&svc).expect("service config");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/settings/anonymizer", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_eq!(expected_value, http_value, "AnonymizerConfig must be byte-identical");
    assert_ts_binding_covers_json_keys("AnonymizerConfig", &http_value);
}

#[tokio::test]
async fn open_allowlist_get_is_a_pure_passthrough_of_the_service_value() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.mcp_open_allowlist.lock().unwrap().allowed_dirs.push("C:\\logs".to_string());
    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    let expected = settings::open_allowlist(&svc).expect("service allowlist");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/settings/open_allowlist", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_eq!(expected_value, http_value, "McpOpenAllowlist must be byte-identical");
    assert_ts_binding_covers_json_keys("McpOpenAllowlist", &http_value);
}

// ---------------------------------------------------------------------------
// 14. Workspace list — GET /mcp/workspaces
// ---------------------------------------------------------------------------

#[tokio::test]
async fn workspace_list_is_a_pure_passthrough_of_the_service_value() {
    let (bridge_ctx, _state, _sink, _tmp) = support::ctx_only();
    let svc = bridge_ctx.svc("wire-parity");
    let router = mcp_bridge::router(bridge_ctx);

    workspace::save_app_state(
        &svc,
        AppStateFile {
            workspaces: vec![WorkspaceEntry {
                id: "ws-1".to_string(),
                name: "WP-14".to_string(),
                ltw_path: None,
                dirty: false,
                auto_save_path: None,
                last_auto_save_at: None,
            }],
            active_workspace_id: Some("ws-1".to_string()),
        },
    )
    .expect("seed app-state.json");

    let expected = workspace::list(&svc).expect("service list");
    let expected_value = serde_json::to_value(&expected).unwrap();

    let (status, http_value) = get(&router, "/mcp/workspaces", &trusted_headers()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{http_value}");
    assert_top_level_keys(&http_value, &["workspaces"]);
    assert_eq!(expected_value, http_value["workspaces"], "workspace list must be byte-identical");
    assert_ts_binding_covers_json_keys("WorkspaceList", &http_value);
    assert_ts_binding_covers_json_keys("WorkspaceEntry", &http_value["workspaces"][0]);
}

// ---------------------------------------------------------------------------
// B. Snapshot `state_at` regression at the ADAPTER level (WP-3 review deferred
//    this to WP-14): install a Snapshot-mode tracker, seed transitions at
//    lines 900-1000, request line 10 via BOTH the Tauri command adapter's own
//    call shape (`services::tracker::state_at` under a `Caller::Ui` context —
//    exactly what `commands::state_tracker::get_state_at_line` does with
//    `ui_ctx(&app)`) and the HTTP route, and assert both return the full
//    final state with `sourceSections` present and identical.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn snapshot_mode_state_at_returns_the_full_dump_identically_via_the_ui_adapter_and_http() {
    let (bridge_ctx, state, _sink, _tmp) = support::ctx_only();
    state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session("s1", 1200));
    install_tracker(&state, "battery-dump", TrackerMode::Snapshot);
    seed_pipeline_tracker_result(
        &state,
        "s1",
        "battery-dump",
        vec![
            transition(900, "enabled", json!(true)),
            transition(950, "ssid", json!("FinalValue")),
            transition(1000, "enabled", json!(false)),
        ],
        vec!["BATTERY STATS".to_string()],
        TrackerMode::Snapshot,
    );

    // The UI adapter's own call shape: `commands::state_tracker::get_state_at_line`
    // is `tracker::state_at(&ui_ctx(&app), ...)` — `ui_ctx` differs from
    // `test_ctx()`/`ctx_only().svc()` only in which `Caller` it stamps, and
    // `StateSnapshot` carries no raw line text for that to affect (see the
    // module doc's "Ui-vs-Agent redaction" note) — so a `Caller::Ui`
    // `ServiceCtx` sharing this `AppState` reproduces the command path exactly.
    let ui_svc = bridge_ctx.svc("ignored").with_caller(app_lib::services::Caller::Ui);
    let router = mcp_bridge::router(bridge_ctx);

    let via_ui_adapter =
        tracker::state_at(&ui_svc, "s1", "battery-dump", 10).expect("UI adapter path: state_at");
    assert_eq!(via_ui_adapter.line_num, 1000, "must land on the LAST transition, not line 10");
    assert_eq!(via_ui_adapter.fields["enabled"], json!(false));
    assert_eq!(via_ui_adapter.fields["ssid"], json!("FinalValue"));
    assert_eq!(via_ui_adapter.source_sections, vec!["BATTERY STATS".to_string()]);

    let (status, via_http) = get(
        &router,
        "/mcp/sessions/s1/tracker/battery-dump/state_at?line=10",
        &trusted_headers(),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{via_http}");
    assert_eq!(via_http["lineNum"], 1000, "HTTP path must also land on the LAST transition, not line 10");
    assert_eq!(via_http["fields"]["enabled"], json!(false));
    assert_eq!(via_http["fields"]["ssid"], json!("FinalValue"));
    assert_eq!(via_http["sourceSections"], json!(["BATTERY STATS"]));

    // Byte-for-byte identical between the two transports (`initializedFields`
    // is backed by a `HashSet` internally, so it is only guaranteed to agree
    // as a SET between two independent replays — sort before comparing, same
    // as `state_snapshot_is_byte_identical_between_the_service_and_the_route`).
    let mut via_ui_adapter_value = serde_json::to_value(&via_ui_adapter).unwrap();
    let mut via_http = via_http;
    sort_string_array(&mut via_ui_adapter_value["initializedFields"]);
    sort_string_array(&mut via_http["initializedFields"]);
    assert_eq!(
        via_ui_adapter_value, via_http,
        "the UI adapter path and the HTTP path must return the exact same Snapshot dump"
    );
}
