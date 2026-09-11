//! In-process HTTP harness for the MCP bridge router (WP-T2).
//!
//! Drives the REAL `mcp_bridge::router(ctx)` — CSRF middleware, activity
//! stamping, and every route handler — via `tower::ServiceExt::oneshot`, with
//! no TCP listener and no live `AppHandle`. `BridgeCtx::from_parts` (added by
//! WP-0) is what makes this possible: it builds a `BridgeCtx` with `app:
//! None`, so the handlers not yet converted to `ServiceCtx` (`h_open_file`,
//! `h_close_session`, artifact mutations, `h_run_pipeline`) surface
//! `TRANSPORT_UNAVAILABLE` here instead of touching a real Tauri handle — see
//! the open_file gating tests below for how that is asserted *around* rather
//! than worked past.
//!
//! Requires `services::testing` (`RecordingSink`, session fixtures), which is
//! `cfg(any(test, feature = "test-support"))` — invisible to a separate
//! integration-test crate under plain `#[cfg(test)]` alone. The `log-tapper`
//! self-dependency with `features = ["test-support"]` in `Cargo.toml`
//! `[dev-dependencies]` activates that feature for the `cargo test` build via
//! normal feature unification. Verified: plain `cargo test --manifest-path
//! src-tauri/Cargo.toml` (no extra flags) builds and runs this file.
//!
//! Route-table probe (§2 below) replaces the weak guarantee flagged in
//! WP-0c's review: `mcp_bridge::route_table_matches_expected` only compares
//! the `ROUTES` const against a second hardcoded literal, never against
//! `router()`'s actual `.route(...)` registrations. Driving the live router
//! here catches a route silently dropped, renamed, or reordered in
//! `router()` alone.

use std::sync::Arc;

use app_lib::commands::AppState;
use app_lib::mcp_bridge;
use app_lib::services::activity::ACTIVITY_CAP;
use app_lib::services::testing::fixture_session_with_pii;
use app_lib::services::Caller;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::{NamedTempFile, TempDir};
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
//
// Moved into `tests/support/mod.rs` (WP-14) so `tests/wire_parity.rs` can
// share the exact same `app()`/`ctx_only()` construction instead of a second
// hand-copied one — see that module's doc comment for the full rationale.

mod support;

use support::*;

// ---------------------------------------------------------------------------
// 1. CSRF wiring
// ---------------------------------------------------------------------------

#[tokio::test]
async fn csrf_missing_host_is_rejected() {
    let (router, _state, _sink, _tmp) = app();
    let (status, _) = get_raw(&router, "/mcp/status", &[]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn csrf_host_with_other_port_is_rejected() {
    let (router, _state, _sink, _tmp) = app();
    let (status, _) = get_raw(&router, "/mcp/status", &[("host", "127.0.0.1:9999")]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn csrf_any_origin_is_rejected_even_with_good_host() {
    let (router, _state, _sink, _tmp) = app();
    let headers = [("host", "127.0.0.1:40404"), ("origin", "http://evil.com")];
    let (status, _) = get_raw(&router, "/mcp/status", &headers).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn csrf_suffix_matched_referer_is_rejected() {
    // `http://127.0.0.1:40404.evil.com/` shares the bridge origin as a string
    // PREFIX but targets a different host — the boundary-correct check in
    // `is_trusted_request` must reject it, not just a naive `starts_with`.
    let (router, _state, _sink, _tmp) = app();
    let headers = [
        ("host", "127.0.0.1:40404"),
        ("referer", "http://127.0.0.1:40404.evil.com/"),
    ];
    let (status, _) = get_raw(&router, "/mcp/status", &headers).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn csrf_trusted_request_reaches_the_handler() {
    let (router, _state, _sink, _tmp) = app();
    let (status, body) = get(&router, "/mcp/status", &trusted_headers()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["running"], true);
}

#[tokio::test]
async fn csrf_rejection_leaves_last_activity_unset_but_acceptance_sets_it() {
    // The middleware-ordering invariant: `require_local` must run BEFORE
    // `record_activity` so a rejected (untrusted) request never stamps
    // `mcp_last_activity`. No existing test pinned this before WP-T2.
    let (router, state, _sink, _tmp) = app();
    assert!(state.mcp_last_activity.lock().unwrap().is_none());

    let (status, _) = get_raw(&router, "/mcp/status", &[]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        state.mcp_last_activity.lock().unwrap().is_none(),
        "a rejected request must not stamp mcp_last_activity"
    );

    let (status, _) = get(&router, "/mcp/status", &trusted_headers()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        state.mcp_last_activity.lock().unwrap().is_some(),
        "an accepted request must stamp mcp_last_activity"
    );
}

// ---------------------------------------------------------------------------
// 2. Route-table probe (replaces the WP-0c review's weak copy-comparison)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn route_table_probe_every_route_resolves_through_the_live_router() {
    let (router, _state, _sink, _tmp) = app();
    let routes = mcp_bridge::ROUTES;

    // Pinned alongside `mcp_bridge::route_table_matches_expected` (39 at the
    // time WP-T2 landed, 70 once every Wave-2 package had appended its routes,
    // 69 after WP-13 deleted the orphaned `tag-stats` route) — a drift here
    // means BOTH tests need updating, which is the point: it forces a route
    // addition or removal to touch this file.
    assert_eq!(
        routes.len(),
        69,
        "mcp_bridge::ROUTES count drifted — update this assertion alongside the route table"
    );

    let mut checked = 0usize;
    for (method_str, template) in routes {
        checked += 1;
        let path = substitute_placeholders(template);
        let method = Method::from_bytes(method_str.as_bytes()).expect("ROUTES entries are valid HTTP methods");
        let needs_body = matches!(method, Method::POST | Method::PUT);

        let mut builder = Request::builder().method(method.clone()).uri(&path);
        for (k, v) in trusted_headers() {
            builder = builder.header(k, v);
        }
        let body = if needs_body {
            builder = builder.header("content-type", "application/json");
            Body::from(serde_json::to_vec(&json!({})).unwrap())
        } else {
            Body::empty()
        };
        let req = builder.body(body).expect("build probe request");

        let res = router.clone().oneshot(req).await.expect("router must not error");
        let status = res.status();
        let bytes = res
            .into_body()
            .collect()
            .await
            .expect("collect probe response body")
            .to_bytes();

        // A route that `router()` dropped or mismatched surfaces as axum's
        // own routing failure: 405 (path matched, method didn't) or a bare
        // empty-bodied 404 (no path matched at all). A HANDLER-level "session
        // not found" JSON 404 is fine and expected here, since every
        // `{session_id}` was substituted with a nonexistent id.
        assert_ne!(
            status,
            StatusCode::METHOD_NOT_ALLOWED,
            "{method_str} {template} -> 405: router() likely dropped or mismatched this route"
        );
        assert!(
            !(status == StatusCode::NOT_FOUND && bytes.is_empty()),
            "{method_str} {template} -> bare empty-bodied 404: router() likely dropped this route"
        );
    }
    assert_eq!(checked, routes.len());
}

// ---------------------------------------------------------------------------
// 3. Activity
// ---------------------------------------------------------------------------

#[tokio::test]
async fn activity_route_returns_empty_array_initially() {
    let (router, _state, _sink, _tmp) = app();
    let (status, body) = get(&router, "/mcp/activity", &trusted_headers()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!([]));
}

#[tokio::test]
async fn activity_route_returns_pushed_entries_newest_last() {
    let (router, state, _sink, _tmp) = app();
    state.activity.push(Caller::Ui, "session.open", Some("s1"), "opened a.log");
    state.activity.push(Caller::agent("mcp"), "bookmark.create", Some("s1"), "line 3");
    state.activity.push(Caller::Ui, "session.close", Some("s1"), "closed a.log");

    let (status, body) = get(&router, "/mcp/activity", &trusted_headers()).await;
    assert_eq!(status, StatusCode::OK);
    let entries = body.as_array().expect("array body");
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["action"], "session.open");
    assert_eq!(entries[2]["action"], "session.close");
    assert!(entries[0]["id"].as_u64().unwrap() < entries[2]["id"].as_u64().unwrap());
}

#[tokio::test]
async fn activity_route_honors_since_and_limit() {
    let (router, state, _sink, _tmp) = app();
    let mut ids = Vec::new();
    for i in 0..5 {
        let e = state.activity.push(Caller::Ui, "x", None, format!("n{i}"));
        ids.push(e.id);
    }

    // `since`: strictly-newer-than entries only.
    let (status, body) = get(&router, &format!("/mcp/activity?since={}", ids[1]), &trusted_headers()).await;
    assert_eq!(status, StatusCode::OK);
    let entries = body.as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["summary"], "n2");

    // `limit`: keeps the newest N, not the oldest.
    let (status, body) = get(&router, "/mcp/activity?limit=2", &trusted_headers()).await;
    assert_eq!(status, StatusCode::OK);
    let entries = body.as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["summary"], "n3");
    assert_eq!(entries[1]["summary"], "n4");
}

#[tokio::test]
async fn activity_journal_is_bounded_and_evicts_the_oldest() {
    let (router, state, _sink, _tmp) = app();
    for i in 0..(ACTIVITY_CAP + 10) {
        state.activity.push(Caller::Ui, "x", None, format!("n{i}"));
    }

    let (status, body) = get(&router, "/mcp/activity", &trusted_headers()).await;
    assert_eq!(status, StatusCode::OK);
    let entries = body.as_array().unwrap();
    assert_eq!(entries.len(), ACTIVITY_CAP);
    // Ids 1..=10 evicted; the oldest retained entry is id 11.
    assert_eq!(entries[0]["id"].as_u64().unwrap(), 11);
}

#[tokio::test]
async fn journal_emits_exactly_one_activity_event_with_the_stored_id() {
    // `h_activity` never journals (reads aren't journaled), so this exercises
    // `BridgeCtx::svc()` -> `ServiceCtx::journal` directly rather than through
    // a route — the same path a converted Wave-1/2 mutation handler will use.
    let (ctx, state, sink, _tmp) = ctx_only();
    let svc = ctx.svc("test-agent");

    let entry = svc.journal("bookmark.create", Some("s1"), "line 42: ANR");

    let payload = sink.only_event("activity");
    assert_eq!(payload["id"], entry.id);
    assert_eq!(payload["action"], "bookmark.create");
    assert_eq!(payload["caller"]["kind"], "agent");
    assert_eq!(state.activity.list(None, None).len(), 1, "journal() must store, not just emit");
}

// ---------------------------------------------------------------------------
// 4. open_file gating
// ---------------------------------------------------------------------------

#[tokio::test]
async fn open_file_outside_allowlist_is_forbidden() {
    let (router, _state, _sink, _tmp) = app();
    let file = NamedTempFile::new().expect("create temp file");
    let path = file.path().to_string_lossy().to_string();

    let (status, body) = send_json(
        &router,
        Method::POST,
        "/mcp/open_file",
        &trusted_headers(),
        &json!({ "path": path }),
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "NOT_ALLOWED");
}

#[tokio::test]
async fn open_file_denied_and_missing_are_byte_identical() {
    let (router, state, _sink, tmp) = app();
    state
        .mcp_open_allowlist
        .lock()
        .unwrap()
        .allowed_dirs
        .push(tmp.path().to_string_lossy().to_string());

    // Denied: a real file OUTSIDE the allowlist.
    let outside = NamedTempFile::new().expect("create outside temp file");
    let (status_a, bytes_a) = send_json_raw(
        &router,
        Method::POST,
        "/mcp/open_file",
        &trusted_headers(),
        &json!({ "path": outside.path().to_string_lossy() }),
    )
    .await;

    // Missing: a nonexistent path INSIDE the allowlist.
    let missing = tmp.path().join("does-not-exist.log");
    let (status_b, bytes_b) = send_json_raw(
        &router,
        Method::POST,
        "/mcp/open_file",
        &trusted_headers(),
        &json!({ "path": missing.to_string_lossy() }),
    )
    .await;

    assert_eq!(status_a, StatusCode::FORBIDDEN);
    assert_eq!(status_b, StatusCode::FORBIDDEN);
    assert_eq!(
        bytes_a, bytes_b,
        "denied (outside allowlist) and missing (inside allowlist) must be byte-identical bodies — \
         a client must not be able to probe the filesystem through this error"
    );
}

#[tokio::test]
async fn open_file_rejects_malformed_paths_as_invalid() {
    let (router, _state, _sink, _tmp) = app();
    for bad in [r"relative\path.log", r"\\server\share\file.log", r"\\?\C:\x"] {
        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/open_file",
            &trusted_headers(),
            &json!({ "path": bad }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "path {bad:?} should be rejected as INVALID_PATH");
        assert_eq!(body["error"]["code"], "INVALID_PATH", "path {bad:?}");
    }
}

#[tokio::test]
async fn open_file_allowed_and_existing_is_not_403_or_400() {
    // WP-6 converted `h_open_file` to `services::sessions::open`, which no
    // longer needs a Tauri `AppHandle` at all — this harness's `BridgeCtx`
    // (no `app` field, retired in the same package) is now sufficient to
    // drive a real open end to end. An allowed, existing file now resolves to
    // a genuine 200 with a session in the body, not just "not 403/400".
    let (router, state, _sink, tmp) = app();
    let file_path = tmp.path().join("device.log");
    std::fs::write(&file_path, "01-01 00:00:00.000  1000  1000 I Tag: hello\n")
        .expect("write a real log file so the open actually succeeds");
    state
        .mcp_open_allowlist
        .lock()
        .unwrap()
        .allowed_dirs
        .push(tmp.path().to_string_lossy().to_string());

    let (status, body) = send_json(
        &router,
        Method::POST,
        "/mcp/open_file",
        &trusted_headers(),
        &json!({ "path": file_path.to_string_lossy() }),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "an allowed, existing file must now open for real: {body:?}");
    assert!(body["sessionId"].as_str().is_some_and(|s| !s.is_empty()), "body must carry a session id: {body:?}");
}

// ---------------------------------------------------------------------------
// 5. Anonymization gating skeleton
// ---------------------------------------------------------------------------
//
// h_query / h_search / h_search_with_context / h_lines_around all gate on the
// per-session `mcp_anonymize` flag directly against `AppState` (not through a
// `Caller`-aware `ServiceCtx` yet) — fail-closed when absent, raw when
// explicitly `false`. These four routes are being refactored concurrently by
// WP-1/WP-2; if a route's JSON shape changes under this test at merge time,
// the gating behavior itself (this test's actual concern) is pinned
// separately in `services::policy` and is expected to survive unchanged —
// the orchestrator adjusts the response-shape assertions here as needed.

/// Exercise the two-state gate for one route: `mcp_anonymize` absent (fails
/// closed, must redact) vs. explicitly `false` (must serve raw text).
/// `build_path` renders the request path for a given session id.
async fn assert_agent_redaction_gating(build_path: impl Fn(&str) -> String) {
    const SESSION: &str = "pii-session";
    const NEEDLE: &str = "user0@example.com";

    // mcp_anonymize ABSENT -> fails closed -> redacted.
    {
        let (router, state, _sink, _tmp) = app();
        state
            .sessions
            .lock()
            .unwrap()
            .insert(SESSION.to_string(), fixture_session_with_pii(SESSION, 5));

        let (status, bytes) = get_raw(&router, &build_path(SESSION), &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "path {}", build_path(SESSION));
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains(NEEDLE),
            "mcp_anonymize absent must fail closed and redact; leaked PII: {text}"
        );
    }

    // mcp_anonymize[session] = false -> raw.
    {
        let (router, state, _sink, _tmp) = app();
        state
            .sessions
            .lock()
            .unwrap()
            .insert(SESSION.to_string(), fixture_session_with_pii(SESSION, 5));
        state.mcp_anonymize.lock().unwrap().insert(SESSION.to_string(), false);

        let (status, bytes) = get_raw(&router, &build_path(SESSION), &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "path {}", build_path(SESSION));
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains(NEEDLE),
            "mcp_anonymize=false must serve raw text; missing expected PII: {text}"
        );
    }
}

#[tokio::test]
async fn query_route_honors_the_anonymization_gate() {
    assert_agent_redaction_gating(|id| format!("/mcp/sessions/{id}/query?n=5")).await;
}

#[tokio::test]
async fn search_route_honors_the_anonymization_gate() {
    assert_agent_redaction_gating(|id| format!("/mcp/sessions/{id}/search?pattern=user0")).await;
}

#[tokio::test]
async fn search_with_context_route_honors_the_anonymization_gate() {
    assert_agent_redaction_gating(|id| format!("/mcp/sessions/{id}/search_with_context?query=user0")).await;
}

#[tokio::test]
async fn lines_around_route_honors_the_anonymization_gate() {
    assert_agent_redaction_gating(|id| format!("/mcp/sessions/{id}/lines_around?line=0")).await;
}

// ---------------------------------------------------------------------------
// 5b. Anonymization gating, exhaustive (WP-14)
// ---------------------------------------------------------------------------
//
// Every route whose response can carry raw line/log text gets the same
// two-state gate proven above for query/search/search_with_context/
// lines_around: `mcp_anonymize` absent fails closed (redacted), explicit
// `false` serves raw text. Routes that carry NO raw text at all (a filter's
// `info`, an `Ack`, `Insights`' structured signals, …) are recorded in
// [`RAW_TEXT_ROUTE_COVERAGE`] as deliberately not gated, WITH the reason —
// so the exhaustiveness check below can tell "considered and exempt" from
// "simply forgotten".

/// One processor whose reporter pipeline is irrelevant — `processor_detail`'s
/// `matched_lines`/`include_line_text` path resolves raw text straight out of
/// `matched_line_nums` regardless of whether any pipeline stage ever ran.
const PII_GATE_REPORTER: &str = r#"
meta:
  id: pii-gate-reporter
  name: PII Gate Reporter
  version: 1.0.0
"#;

#[tokio::test]
async fn processor_detail_route_honors_the_anonymization_gate() {
    const SESSION: &str = "pii-session-detail";
    const NEEDLE: &str = "user0@example.com";
    let path = format!("/mcp/sessions/{SESSION}/processor/pii-gate-reporter?include_line_text=true");

    fn seed(state: &Arc<AppState>) {
        state
            .sessions
            .lock()
            .unwrap()
            .insert(SESSION.to_string(), fixture_session_with_pii(SESSION, 5));
        state.processors.lock().unwrap().insert(
            "pii-gate-reporter".to_string(),
            app_lib::processors::AnyProcessor::from_yaml(PII_GATE_REPORTER).expect("fixture yaml parses"),
        );
        state.pipeline_results.lock().unwrap().entry(SESSION.to_string()).or_default().insert(
            "pii-gate-reporter".to_string(),
            app_lib::processors::RunResult { matched_line_nums: vec![0, 1], ..Default::default() },
        );
    }

    // mcp_anonymize ABSENT -> fails closed -> redacted.
    {
        let (router, state, _sink, _tmp) = app();
        seed(&state);
        let (status, body) = get(&router, &path, &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let text = serde_json::to_string(&body).unwrap();
        assert!(!text.contains(NEEDLE), "mcp_anonymize absent must fail closed and redact; leaked PII: {text}");
    }

    // mcp_anonymize[session] = false -> raw.
    {
        let (router, state, _sink, _tmp) = app();
        seed(&state);
        state.mcp_anonymize.lock().unwrap().insert(SESSION.to_string(), false);
        let (status, body) = get(&router, &path, &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let text = serde_json::to_string(&body).unwrap();
        assert!(text.contains(NEEDLE), "mcp_anonymize=false must serve raw text; missing expected PII: {text}");
    }
}

/// Same gate as the reporter arm above, but for `ProcessorDetail::StateTracker`
/// (`TrackerDetail`) — its `transitions[].raw` goes through the identical
/// `include_line_text` + `policy::redact_line` gate the reporter arm uses
/// (`services/pipeline.rs` tracker branch mirrors the reporter branch), but
/// was never exercised at the HTTP layer under an `Agent` caller (WP-14
/// review, should-fix #1).
#[tokio::test]
async fn processor_detail_tracker_arm_route_honors_the_anonymization_gate() {
    const SESSION: &str = "pii-session-detail-tracker";
    const NEEDLE: &str = "user0@example.com";
    const TRACKER_ID: &str = "pii-gate-tracker";
    let path = format!("/mcp/sessions/{SESSION}/processor/{TRACKER_ID}?include_line_text=true");

    fn seed(state: &Arc<AppState>) {
        use app_lib::processors::state_tracker::schema::{
            StateFieldDecl, StateFieldType, StateTrackerDef, StateTrackerOutput, TrackerMode,
        };
        use app_lib::processors::state_tracker::types::{FieldChange, StateTrackerResult, StateTransition};
        use app_lib::processors::{AnyProcessor, ProcessorKind, ProcessorMeta};
        use std::collections::HashMap;

        state
            .sessions
            .lock()
            .unwrap()
            .insert(SESSION.to_string(), fixture_session_with_pii(SESSION, 5));

        let def = StateTrackerDef {
            group: String::new(),
            sections: vec![],
            mode: TrackerMode::TimeSeries,
            state: vec![StateFieldDecl {
                name: "enabled".to_string(),
                field_type: StateFieldType::Bool,
                default: serde_json::json!(false),
            }],
            transitions: vec![],
            output: StateTrackerOutput { timeline: false, annotate: false },
        };
        state.processors.lock().unwrap().insert(
            TRACKER_ID.to_string(),
            AnyProcessor {
                meta: ProcessorMeta {
                    id: TRACKER_ID.to_string(),
                    name: TRACKER_ID.to_string(),
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
                kind: ProcessorKind::StateTracker(Arc::new(def)),
                schema: None,
                source: None,
            },
        );

        // Line 0 of `fixture_session_with_pii` contains `user0@example.com` —
        // reference it from a transition so the tracker arm's raw-text
        // resolution has PII to gate.
        let mut changes = HashMap::new();
        changes.insert(
            "enabled".to_string(),
            FieldChange { from: serde_json::json!(null), to: serde_json::json!(true) },
        );
        let transition = StateTransition {
            line_num: 0,
            timestamp: 1000,
            transition_name: "t0".to_string(),
            changes,
        };
        state
            .state_tracker_results
            .lock()
            .unwrap()
            .entry(SESSION.to_string())
            .or_default()
            .insert(
                TRACKER_ID.to_string(),
                StateTrackerResult {
                    tracker_id: TRACKER_ID.to_string(),
                    transitions: vec![transition],
                    final_state: HashMap::new(),
                    source_sections: vec![],
                    mode: TrackerMode::TimeSeries,
                },
            );
    }

    // mcp_anonymize ABSENT -> fails closed -> redacted.
    {
        let (router, state, _sink, _tmp) = app();
        seed(&state);
        let (status, body) = get(&router, &path, &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let text = serde_json::to_string(&body).unwrap();
        assert!(!text.contains(NEEDLE), "mcp_anonymize absent must fail closed and redact; leaked PII: {text}");
    }

    // mcp_anonymize[session] = false -> raw.
    {
        let (router, state, _sink, _tmp) = app();
        seed(&state);
        state.mcp_anonymize.lock().unwrap().insert(SESSION.to_string(), false);
        let (status, body) = get(&router, &path, &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let text = serde_json::to_string(&body).unwrap();
        assert!(text.contains(NEEDLE), "mcp_anonymize=false must serve raw text; missing expected PII: {text}");
    }
}

#[tokio::test]
async fn export_route_honors_the_anonymization_gate_explicit_false_too() {
    // `wp10_timeline_export::export_route_inside_the_allowlist_succeeds_and_redacts_for_an_agent`
    // already pins the fail-closed (absent) half of this gate. This is the
    // other half: `mcp_anonymize = false` must produce an UNREDACTED export —
    // exhaustiveness (§5b below) requires both states be proven for every
    // raw-text route, not just one.
    const SESSION: &str = "pii-session-export";
    const NEEDLE: &str = "user0@example.com";

    let (router, state, _sink, tmp) = app();
    state.sessions.lock().unwrap().insert(SESSION.to_string(), fixture_session_with_pii(SESSION, 3));
    state.mcp_anonymize.lock().unwrap().insert(SESSION.to_string(), false);

    let out_dir = tmp.path().join("allowed-out");
    std::fs::create_dir_all(&out_dir).unwrap();
    state.mcp_open_allowlist.lock().unwrap().allowed_dirs.push(out_dir.to_string_lossy().to_string());
    let dest = out_dir.join("agent-export-raw.lts");

    let body = json!({
        "destPath": dest.to_string_lossy(),
        "includeBookmarks": false,
        "includeAnalyses": false,
        "includeProcessors": false,
        "editorTabs": [],
    });
    let (status, resp) = send_json(&router, Method::POST, "/mcp/export", &trusted_headers(), &body).await;
    assert_eq!(status, StatusCode::OK, "{resp}");
    assert!(dest.exists());

    let bytes = std::fs::read(&dest).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut found_source = false;
    let mut found_needle = false;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).unwrap();
        if file.name().contains("source/") {
            found_source = true;
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut file, &mut buf).unwrap();
            if String::from_utf8_lossy(&buf).contains(NEEDLE) {
                found_needle = true;
            }
        }
    }
    assert!(found_source, "the archive must contain a source entry");
    assert!(found_needle, "mcp_anonymize=false must serve a raw (unredacted) export");
}

/// Every `mcp_bridge::ROUTES` template, mapped to why it either IS or is NOT
/// gated by `mcp_anonymize`. This is the exhaustiveness list: every route
/// whose path contains a keyword a raw-line-returning route is likely to use
/// must appear here — see `no_raw_text_capable_route_is_missing_from_the_gate_coverage_list`
/// below, which enforces that mechanically so a future route cannot be added
/// without someone deciding (and recording) whether it needs gating.
const RAW_TEXT_ROUTE_COVERAGE: &[(&str, &str, &str)] = &[
    ("GET", "/mcp/sessions/{session_id}/query", "gated: query_route_honors_the_anonymization_gate"),
    ("GET", "/mcp/sessions/{session_id}/lines_around", "gated: lines_around_route_honors_the_anonymization_gate"),
    ("GET", "/mcp/sessions/{session_id}/search", "gated: search_route_honors_the_anonymization_gate"),
    (
        "GET",
        "/mcp/sessions/{session_id}/search_with_context",
        "gated: search_with_context_route_honors_the_anonymization_gate",
    ),
    (
        "GET",
        "/mcp/sessions/{session_id}/events",
        "no raw text: TrackerEventEntry carries only structured transition fields (tracker id, line/timestamp, named changes) — never raw log lines",
    ),
    (
        "GET",
        "/mcp/sessions/{session_id}/insights",
        "no raw text: InsightSignal carries only structured fields rendered from processor vars/templates — services::insights::digest never touches raw line text",
    ),
    (
        "POST",
        "/mcp/sessions/{session_id}/filters",
        "no raw text: FilterCreateResult is {filterId, sessionId, totalLines} — counts only",
    ),
    ("GET", "/mcp/filters/{filter_id}", "no raw text: FilterInfo is counts/status only"),
    ("GET", "/mcp/filters/{filter_id}/lines", "gated: wp7_filters::lines_are_redacted_when_mcp_anonymize_is_absent_for_the_session / lines_stay_raw_when_mcp_anonymize_is_explicitly_false"),
    ("POST", "/mcp/filters/{filter_id}/cancel", "no raw text: Ack only"),
    ("DELETE", "/mcp/filters/{filter_id}", "no raw text: Ack only"),
    (
        "GET",
        "/mcp/export/info",
        "no raw text: ExportAllSessionsInfo is session/file metadata (ids, sizes, paths) — never line content",
    ),
    ("POST", "/mcp/export", "gated: export_route_inside_the_allowlist_succeeds_and_redacts_for_an_agent (wp10) / export_route_honors_the_anonymization_gate_explicit_false_too"),
    (
        "GET",
        "/mcp/sessions/{session_id}/stream/events",
        "gated: wp11_stream::events_are_redacted_when_mcp_anonymize_is_absent_for_the_session / events_stay_raw_when_mcp_anonymize_is_explicitly_false",
    ),
];

#[test]
fn no_raw_text_capable_route_is_missing_from_the_gate_coverage_list() {
    // A cheap heuristic, deliberately over-inclusive: any route whose path
    // contains one of these words is treated as "plausibly returns raw line
    // text" and MUST have a decision recorded in `RAW_TEXT_ROUTE_COVERAGE`
    // (either "gated: <test>" or "no raw text: <reason>") — so a future route
    // added under one of these names cannot silently skip the question.
    const KEYWORDS: &[&str] = &["lines", "search", "query", "events", "export", "insights", "filters"];

    let mut missing = Vec::new();
    for (method, template) in mcp_bridge::ROUTES {
        if !KEYWORDS.iter().any(|k| template.contains(k)) {
            continue;
        }
        let covered = RAW_TEXT_ROUTE_COVERAGE
            .iter()
            .any(|(m, t, _)| m == method && t == template);
        if !covered {
            missing.push(format!("{method} {template}"));
        }
    }

    assert!(
        missing.is_empty(),
        "the following routes look like they might return raw line text (path contains one of {KEYWORDS:?}) \
         but have no entry in RAW_TEXT_ROUTE_COVERAGE — add one recording whether they are gated and by which \
         test, or why they carry no raw text: {missing:?}"
    );
}

// ---------------------------------------------------------------------------
// 6. WP-12 settings
// ---------------------------------------------------------------------------
//
// `route_table_probe_every_route_resolves_through_the_live_router`'s pinned
// count (§2 above) was bumped 39 -> 42 to include the three routes WP-12
// appended (`GET /mcp/settings/anonymizer`, `GET /mcp/settings/
// open_allowlist`, `POST /mcp/settings/anonymizer/test`) — see the comment
// there: other Wave-2 packages bump the same number concurrently in sibling
// worktrees, so expect (and resolve) a merge conflict by summing every
// package's additions rather than picking one side.
mod wp12_settings {
    use super::*;
    use app_lib::anonymizer::config::AnonymizerConfig;
    use app_lib::commands::bridge_access::McpOpenAllowlist;
    use app_lib::services::settings;
    use app_lib::services::testing::test_ctx;

    // ── HTTP routes: typed JSON over the live router ────────────────────────

    #[tokio::test]
    async fn get_anonymizer_config_route_returns_typed_json() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) = get(&router, "/mcp/settings/anonymizer", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["detectors"].is_array(), "body: {body}");
    }

    #[tokio::test]
    async fn get_open_allowlist_route_returns_the_configured_allowlist() {
        let (router, state, _sink, _tmp) = app();
        state
            .mcp_open_allowlist
            .lock()
            .unwrap()
            .allowed_dirs
            .push("C:\\logs".to_string());

        let (status, body) = get(&router, "/mcp/settings/open_allowlist", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["allowedDirs"], json!(["C:\\logs"]));
    }

    #[tokio::test]
    async fn test_anonymizer_route_redacts_and_returns_typed_json() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/settings/anonymizer/test",
            &trusted_headers(),
            &json!({ "text": "contact user@example.com now" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body["anonymized"].as_str().unwrap().contains("user@example.com"));
        assert_eq!(body["replacements"].as_array().unwrap().len(), 1);
    }

    // ── No write routes exist by design — the gate is unit-tested directly
    //    against `services::settings` through a `ServiceCtx` per caller. ────

    #[test]
    fn agent_cannot_set_anonymizer_config() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = settings::set_anonymizer_config(&ctx, AnonymizerConfig::with_defaults())
            .expect_err("agents must not be able to widen their own redaction rules");
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[test]
    fn ui_can_set_anonymizer_config() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(settings::set_anonymizer_config(&ctx, AnonymizerConfig::with_defaults()).is_ok());
    }

    #[test]
    fn agent_cannot_set_the_open_allowlist() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = settings::set_open_allowlist(
            &ctx,
            McpOpenAllowlist { allowed_dirs: vec!["C:\\".to_string()], allow_all: true },
        )
        .expect_err("agents must not be able to widen their own open-file gate");
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[test]
    fn ui_can_set_the_open_allowlist() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(settings::set_open_allowlist(
            &ctx,
            McpOpenAllowlist { allowed_dirs: vec!["C:\\logs".to_string()], allow_all: false },
        )
        .is_ok());
    }

    #[test]
    fn agent_cannot_read_pii_mappings() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = settings::pii_mappings(&ctx, "s1")
            .expect_err("agents must never receive the token -> original map");
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[test]
    fn ui_can_read_pii_mappings() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(settings::pii_mappings(&ctx, "s1").is_ok());
    }
}

// 6. WP-7 — filter endpoints
// ---------------------------------------------------------------------------
//
// `support::app()` wires a `NullSpawner` (see `services::testing`), so
// `services::filters::create`'s spawned background scan never actually runs
// under this harness — exactly like a filter observed a moment after
// creation. The scan loop itself is covered by `services::filters`'s own
// `#[tokio::test]`s, which call it directly; these tests are about the HTTP
// surface: routing, the create/info/lines/cancel/close round trip, the
// error-body shape for an unknown id, and the anonymization gate.
mod wp7_filters {
    use super::*;

    #[tokio::test]
    async fn create_info_lines_cancel_close_round_trip_over_the_harness() {
        let (router, state, _sink, _tmp) = app();
        state.sessions.lock().unwrap().insert(
            "s1".to_string(),
            app_lib::services::testing::fixture_session("s1", 10),
        );

        // create
        let (status, body) =
            send_json(&router, Method::POST, "/mcp/sessions/s1/filters", &trusted_headers(), &json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["sessionId"], "s1");
        assert_eq!(body["totalLines"], 10);
        let filter_id = body["filterId"].as_str().expect("filterId must be a string").to_string();

        // info
        let (status, body) = get(&router, &format!("/mcp/filters/{filter_id}"), &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["filterId"], filter_id);
        assert_eq!(body["sessionId"], "s1");
        assert_eq!(body["totalLines"], 10);
        assert_eq!(body["status"], "scanning");

        // lines — nothing matched yet (the background scan never runs under
        // this harness's NullSpawner), but the route itself must respond.
        let (status, body) =
            get(&router, &format!("/mcp/filters/{filter_id}/lines"), &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["filterId"], filter_id);
        assert_eq!(body["totalMatches"], 0);
        assert!(body["lines"].as_array().expect("lines must be an array").is_empty());

        // lines respects offset/limit query params without erroring even
        // when the page they describe is empty.
        let (status, _body) = get(
            &router,
            &format!("/mcp/filters/{filter_id}/lines?offset=5&limit=10"),
            &trusted_headers(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // cancel
        let (status, body) = send_json(
            &router,
            Method::POST,
            &format!("/mcp/filters/{filter_id}/cancel"),
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);

        let (status, body) = get(&router, &format!("/mcp/filters/{filter_id}"), &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "cancelled");

        // close
        let (status, body) = send_json(
            &router,
            Method::DELETE,
            &format!("/mcp/filters/{filter_id}"),
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);

        // gone — both `info` and `lines` now report a real 404 for it.
        let (status, body) = get(&router, &format!("/mcp/filters/{filter_id}"), &trusted_headers()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "NOT_FOUND");
        assert!(body["error"]["message"].as_str().unwrap().contains(&filter_id));

        let (status, body) =
            get(&router, &format!("/mcp/filters/{filter_id}/lines"), &trusted_headers()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "NOT_FOUND");
    }

    #[tokio::test]
    async fn unknown_filter_id_gets_a_not_found_style_error_body_on_every_route() {
        let (router, _state, _sink, _tmp) = app();

        let (status, body) = get(&router, "/mcp/filters/nosuch", &trusted_headers()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "NOT_FOUND");
        assert!(body["error"]["message"].as_str().unwrap().contains("nosuch"));

        let (status, body) = get(&router, "/mcp/filters/nosuch/lines", &trusted_headers()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "NOT_FOUND");

        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/filters/nosuch/cancel",
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "NOT_FOUND");

        // close is idempotent — closing an id that was never created is
        // success, not NOT_FOUND (matches `services::filters::close`).
        let (status, body) = send_json(
            &router,
            Method::DELETE,
            "/mcp/filters/nosuch",
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn create_rejects_an_invalid_regex_with_an_error_body() {
        let (router, state, _sink, _tmp) = app();
        state.sessions.lock().unwrap().insert(
            "s1".to_string(),
            app_lib::services::testing::fixture_session("s1", 5),
        );

        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/sessions/s1/filters",
            &trusted_headers(),
            &json!({ "regex": "[invalid" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "INVALID_ARGUMENT");
        assert!(body["error"]["message"].as_str().unwrap().contains("[invalid"));
    }

    /// Fail-closed anonymization: an Agent caller (every bridge request is one)
    /// against a session with NO `mcp_anonymize` entry must still be redacted.
    /// Every bridge request is an `Agent` caller by construction
    /// (`BridgeCtx::svc`), so this is exercised without any special headers.
    #[tokio::test]
    async fn lines_are_redacted_when_mcp_anonymize_is_absent_for_the_session() {
        let (router, state, _sink, _tmp) = app();
        state
            .sessions
            .lock()
            .unwrap()
            .insert("pii-session".to_string(), fixture_session_with_pii("pii-session", 3));
        // Deliberately NOT setting `mcp_anonymize` for "pii-session".

        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/sessions/pii-session/filters",
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let filter_id = body["filterId"].as_str().unwrap().to_string();

        // Populate matches directly: this harness's `NullSpawner` never runs
        // the real background scan, and this test is only about the
        // redaction gate in `services::filters::lines`, not the scan loop
        // (covered by `services::filters`'s own unit tests).
        {
            let filters = state.active_filters.lock().unwrap();
            filters.get(&filter_id).expect("filter must be registered").append_matches(&[0, 1, 2]);
        }

        let (status, body) =
            get(&router, &format!("/mcp/filters/{filter_id}/lines"), &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        let lines = body["lines"].as_array().expect("lines must be an array");
        assert_eq!(lines.len(), 3);
        for line in lines {
            let raw = line["raw"].as_str().unwrap();
            assert!(
                !raw.contains("user0@example.com") && !raw.contains('@'),
                "an agent must not see raw PII when mcp_anonymize is unset for the session: {raw}"
            );
        }
    }

    #[tokio::test]
    async fn lines_stay_raw_when_mcp_anonymize_is_explicitly_false() {
        let (router, state, _sink, _tmp) = app();
        state
            .sessions
            .lock()
            .unwrap()
            .insert("pii-session".to_string(), fixture_session_with_pii("pii-session", 2));
        state.mcp_anonymize.lock().unwrap().insert("pii-session".to_string(), false);

        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/sessions/pii-session/filters",
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let filter_id = body["filterId"].as_str().unwrap().to_string();
        {
            let filters = state.active_filters.lock().unwrap();
            filters.get(&filter_id).unwrap().append_matches(&[0, 1]);
        }

        let (status, body) =
            get(&router, &format!("/mcp/filters/{filter_id}/lines"), &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        let lines = body["lines"].as_array().unwrap();
        assert!(
            lines.iter().any(|l| l["raw"].as_str().unwrap().contains('@')),
            "mcp_anonymize=false must serve raw text"
        );
    }
}

// ---------------------------------------------------------------------------
// 7. WP-10 timeline / chart / export
// ---------------------------------------------------------------------------
//
// `route_table_probe_every_route_resolves_through_the_live_router`'s pinned
// count (§2 above) was bumped 42 -> 46 to include the four routes this
// package appended (`GET /mcp/sessions/{session_id}/chart`, `GET
// /mcp/sessions/{session_id}/timeline`, `GET /mcp/export/info`,
// `POST /mcp/export`).
mod wp10_timeline_export {
    use super::*;
    use app_lib::processors::{AnyProcessor, Emission, RunResult};

    const TIMELINE_REPORTER_YAML: &str = r##"
meta:
  id: rep-1
  name: R
pipeline:
  - stage: output
    charts:
      - id: bar-1
        type: bar
        title: Bar
        source: emissions
        x:
          field: category
        timeline:
          field: value
          label: My Value
"##;

    fn seed_reporter_with_emissions(state: &Arc<AppState>, session_id: &str, emissions: Vec<Emission>) {
        let proc = AnyProcessor::from_yaml(TIMELINE_REPORTER_YAML).expect("fixture yaml parses");
        state.processors.lock().unwrap().insert("rep-1".to_string(), proc);
        state
            .pipeline_results
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .insert("rep-1".to_string(), RunResult { emissions, ..Default::default() });
    }

    // ── chart / timeline ──────────────────────────────────────────────────

    #[tokio::test]
    async fn chart_route_returns_typed_chart_data() {
        let (router, state, _sink, _tmp) = app();
        seed_reporter_with_emissions(
            &state,
            "s1",
            vec![Emission { line_num: 0, fields: vec![("category".to_string(), json!("a"))] }],
        );

        let (status, body) = get(&router, "/mcp/sessions/s1/chart?processor_id=rep-1", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body[0]["id"], "bar-1");
    }

    #[tokio::test]
    async fn timeline_route_returns_a_downsampled_series_seeded_like_wp3s_tracker_fixtures() {
        // Seeded via the same "install a processor, then write directly into
        // AppState's result maps" pattern WP-3's tracker tests use — here it's
        // `pipeline_results` (reporter emissions) rather than
        // `state_tracker_results`, since chart/timeline data is Reporter-only.
        let (router, state, _sink, _tmp) = app();
        let emissions = (0..5)
            .map(|i| Emission { line_num: i, fields: vec![("value".to_string(), json!(i as f64))] })
            .collect();
        seed_reporter_with_emissions(&state, "s1", emissions);

        let (status, body) = get(&router, "/mcp/sessions/s1/timeline?processor_ids=rep-1", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body[0]["field"], "value");
        assert_eq!(body[0]["label"], "My Value");
    }

    // ── export ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn export_info_route_returns_typed_json() {
        let (router, state, _sink, _tmp) = app();
        state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session_with_pii("s1", 3));

        let (status, body) = get(&router, "/mcp/export/info", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["sessions"][0]["sessionId"], "s1");
    }

    #[tokio::test]
    async fn export_route_inside_the_allowlist_succeeds_and_redacts_for_an_agent() {
        let (router, state, _sink, tmp) = app();
        // `mcp_anonymize` is never signalled for "s1" — fails closed to
        // anonymized, so an Agent export must redact its PII regardless.
        state.sessions.lock().unwrap().insert("s1".to_string(), fixture_session_with_pii("s1", 3));

        let out_dir = tmp.path().join("allowed-out");
        std::fs::create_dir_all(&out_dir).unwrap();
        state.mcp_open_allowlist.lock().unwrap().allowed_dirs.push(out_dir.to_string_lossy().to_string());
        let dest = out_dir.join("agent-export.lts");

        let body = json!({
            "destPath": dest.to_string_lossy(),
            "includeBookmarks": false,
            "includeAnalyses": false,
            "includeProcessors": false,
            "editorTabs": [],
        });
        let (status, resp) = send_json(&router, Method::POST, "/mcp/export", &trusted_headers(), &body).await;
        assert_eq!(status, StatusCode::OK, "body: {resp}");
        assert_eq!(resp["ok"], true);
        assert!(dest.exists(), "the .lts file must be written");

        let bytes = std::fs::read(&dest).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut found_source = false;
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).unwrap();
            if file.name().contains("source/") {
                found_source = true;
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut file, &mut buf).unwrap();
                let text = String::from_utf8_lossy(&buf);
                assert!(!text.contains("@example.com"), "raw PII leaked into an agent's export: {text}");
            }
        }
        assert!(found_source, "the archive must contain a source entry");
    }

    #[tokio::test]
    async fn export_route_outside_the_allowlist_is_forbidden() {
        let (router, _state, _sink, tmp) = app();
        let dest = tmp.path().join("nope.lts");

        let body = json!({
            "destPath": dest.to_string_lossy(),
            "includeBookmarks": false,
            "includeAnalyses": false,
            "includeProcessors": false,
            "editorTabs": [],
        });
        let (status, resp) = send_json(&router, Method::POST, "/mcp/export", &trusted_headers(), &body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body: {resp}");
        assert_eq!(resp["error"]["code"], "NOT_ALLOWED");
        assert!(!dest.exists(), "no file must be written on a denied destination");
    }
}

// 6. WP-9 processors + marketplace
// ---------------------------------------------------------------------------
//
// These routes are pure `ServiceCtx` from day one (no `ctx.app` involved), so
// unlike open_file/run_pipeline above they exercise real success paths over
// the live router, not just "the gate doesn't stand in the way".

mod wp9_processors {
    use super::*;
    use app_lib::processors::AnyProcessor;

    const MINIMAL_REPORTER: &str = r#"
meta:
  id: wp9-test-reporter
  name: WP9 Test Reporter
  version: 1.0.0
"#;

    #[tokio::test]
    async fn list_and_definition_see_a_processor_installed_via_test_ctx() {
        // `test_ctx().with_processor(...)` does not exist on the shared
        // builder (adding it is out of this item's file ownership) — seeding
        // `AppState::processors` directly, the same way `services::testing`'s
        // own session fixtures seed `AppState::sessions`, gives equivalent
        // coverage without touching `services/testing.rs`.
        let (router, state, _sink, _tmp) = app();
        state.processors.lock().unwrap().insert(
            "wp9-test-reporter".to_string(),
            AnyProcessor::from_yaml(MINIMAL_REPORTER).unwrap(),
        );

        let (status, body) = get(&router, "/mcp/processors", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["processorCount"], json!(1));
        assert_eq!(body["processors"][0]["id"], json!("wp9-test-reporter"));

        let (status, body) = get(&router, "/mcp/processors/wp9-test-reporter", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], json!("wp9-test-reporter"));
        assert!(body.get("vars").is_some(), "reporter detail should include the reporter-specific fields");
    }

    #[tokio::test]
    async fn install_yaml_then_list_shows_it() {
        let (router, _state, _sink, _tmp) = app();

        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/processors/install",
            &trusted_headers(),
            &json!({ "yaml": MINIMAL_REPORTER }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "install failed: {body}");
        assert_eq!(body["id"], json!("wp9-test-reporter"));

        let (status, body) = get(&router, "/mcp/processors", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["processorCount"], json!(1));
    }

    #[tokio::test]
    async fn install_then_uninstall_via_the_router() {
        let (router, _state, _sink, _tmp) = app();
        let (status, _) = send_json(
            &router,
            Method::POST,
            "/mcp/processors/install",
            &trusted_headers(),
            &json!({ "yaml": MINIMAL_REPORTER }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, body) = send_json(
            &router,
            Method::DELETE,
            "/mcp/processors/wp9-test-reporter",
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], json!(true));

        let (status, body) = get(&router, "/mcp/processors", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["processorCount"], json!(0));
    }

    #[tokio::test]
    async fn packs_route_lists_installed_packs() {
        let (router, state, _sink, _tmp) = app();
        state.processors.lock().unwrap().insert(
            "wp9-test-reporter".to_string(),
            AnyProcessor::from_yaml(MINIMAL_REPORTER).unwrap(),
        );
        let mut pack = app_lib::processors::pack::parse_pack_yaml(
            "name: WP9 Pack\nversion: 1.0.0\nprocessors:\n  - wp9-test-reporter\n",
        )
        .unwrap();
        pack.id = "wp9-pack".to_string();
        state.packs.lock().unwrap().push(pack);

        let (status, body) = get(&router, "/mcp/packs", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 1);
        assert_eq!(body[0]["id"], json!("wp9-pack"));
    }

    #[tokio::test]
    async fn marketplace_sources_route_lists_configured_sources_camelcase() {
        use app_lib::processors::marketplace::{Source, SourceType};
        let (router, state, _sink, _tmp) = app();
        state.sources.lock().unwrap().push(Source {
            name: "official".to_string(),
            source_type: SourceType::Local { path: "/some/path".to_string() },
            enabled: true,
            auto_update: false,
            last_checked: None,
        });

        let (status, body) = get(&router, "/mcp/marketplace/sources", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["name"], json!("official"));
        // Bug ee4ddb0b: must be `autoUpdate`, not `auto_update`.
        assert_eq!(body[0]["autoUpdate"], json!(false));
        assert!(body[0].get("auto_update").is_none());
    }

    #[tokio::test]
    async fn marketplace_updates_route_returns_empty_result_with_no_sources_configured() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) = get(&router, "/mcp/marketplace/updates", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["updates"], json!([]));
        assert_eq!(body["packUpdates"], json!([]));
        assert_eq!(body["errors"], json!([]));
    }

    #[tokio::test]
    async fn marketplace_fetch_on_unknown_source_is_not_found() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) = get(&router, "/mcp/marketplace/sources/nope/fetch", &trusted_headers()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "NOT_FOUND");
    }

    #[tokio::test]
    async fn marketplace_install_requires_exactly_one_of_entry_or_pack() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/marketplace/install",
            &trusted_headers(),
            &json!({ "sourceName": "official" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "INVALID_ARGUMENT");
    }

    /// Agent `add_source` is `Forbidden` at the service level — there is no
    /// bridge route to add a source at all (see `h_marketplace_sources`'s doc
    /// comment: a marketplace source is a supply-chain surface), so this is
    /// asserted directly against the service rather than over HTTP.
    #[test]
    fn agent_add_source_is_forbidden_at_the_service_level() {
        use app_lib::processors::marketplace::{Source, SourceType};
        use app_lib::services::marketplace;
        use app_lib::services::testing::test_ctx;

        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = marketplace::add_source(
            &ctx,
            Source {
                name: "official".to_string(),
                source_type: SourceType::Local { path: "/some/path".to_string() },
                enabled: true,
                auto_update: false,
                last_checked: None,
            },
        )
        .unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    /// The corresponding `Ui` caller must succeed at the same mutation —
    /// proves the gate is caller-specific, not a blanket refusal.
    #[test]
    fn ui_add_source_succeeds_at_the_service_level() {
        use app_lib::processors::marketplace::{Source, SourceType};
        use app_lib::services::marketplace;
        use app_lib::services::testing::test_ctx;

        let (ctx, _tmp) = test_ctx().build();
        marketplace::add_source(
            &ctx,
            Source {
                name: "official".to_string(),
                source_type: SourceType::Local { path: "/some/path".to_string() },
                enabled: true,
                auto_update: false,
                last_checked: None,
            },
        )
        .expect("a Ui caller may add a marketplace source");
        assert_eq!(marketplace::sources(&ctx).unwrap().len(), 1);
    }
}

// ---------------------------------------------------------------------------
// 8. WP-8 — workspace save / load / restore over the live router
// ---------------------------------------------------------------------------

mod wp8_workspace {
    use super::*;

    /// A file the `.ltw` manifest can point at. Written inside `dir`, which
    /// every test here also puts on the allowlist — an agent workspace open
    /// re-opens each session through `services::sessions::open`, so both the
    /// `.ltw` and every path inside it have to be reachable.
    fn write_log(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "01-01 00:00:00.000  1000  1000 I Tag: hello\n")
            .expect("write a real log file so the open actually succeeds");
        path
    }

    fn allow(state: &Arc<AppState>, dir: &std::path::Path) {
        state
            .mcp_open_allowlist
            .lock()
            .unwrap()
            .allowed_dirs
            .push(dir.to_string_lossy().to_string());
    }

    fn save_body(dest: &std::path::Path) -> Value {
        json!({
            "workspaceId": "ws-8",
            "destPath": dest.to_string_lossy(),
            "workspaceName": "WP-8 Round Trip",
            "editorTabs": [],
            "layout": { "kind": "split", "children": ["a", "b"] },
            "pipelineChain": ["proc-a", "proc-b"],
            "disabledChainIds": ["proc-b"],
        })
    }

    /// The package's headline acceptance: save the live workspace to a `.ltw`
    /// inside the allowlist, close the session it named, then load that file
    /// back through the router and confirm the session is open again with its
    /// pipeline meta intact — and that `workspace-restored` fired exactly once
    /// for the one session that was restored.
    #[tokio::test]
    async fn save_then_load_restores_the_session_and_its_pipeline_meta() {
        let (router, state, sink, tmp) = app();
        allow(&state, tmp.path());
        let log = write_log(tmp.path(), "device.log");

        // Open a session so the save has something to serialise.
        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/open_file",
            &trusted_headers(),
            &json!({ "path": log.to_string_lossy() }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "open must succeed: {body:?}");
        let session_id = body["sessionId"].as_str().expect("sessionId").to_string();

        // Give the session a pipeline chain: it rides into the manifest as
        // `SessionMeta` and is what makes the restore emit at all (the event
        // is gated on having bookmarks, analyses or a chain to report).
        state.session_pipeline_meta.lock().unwrap().insert(
            session_id.clone(),
            app_lib::workspace::SessionMeta {
                active_processor_ids: vec!["proc-a".to_string()],
                disabled_processor_ids: vec!["proc-b".to_string()],
            },
        );

        // save
        let dest = tmp.path().join("round-trip.ltw");
        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/workspace/save",
            &trusted_headers(),
            &save_body(&dest),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "save must succeed: {body:?}");
        assert_eq!(body["saved"], true);
        assert!(dest.exists(), "save must have written the .ltw");

        // Close the session so the load has to genuinely re-open it.
        let (status, _) = send_json(
            &router,
            Method::POST,
            &format!("/mcp/sessions/{session_id}/close"),
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        state.session_pipeline_meta.lock().unwrap().remove(&session_id);
        assert!(
            sink.events_named("workspace-restored").is_empty(),
            "nothing has been restored yet"
        );

        // load
        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/workspace/load",
            &trusted_headers(),
            &json!({ "path": dest.to_string_lossy() }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "load must succeed: {body:?}");
        assert_eq!(body["workspace"]["workspaceName"], "WP-8 Round Trip");
        assert_eq!(body["workspace"]["workspaceId"], "ws-8");
        assert_eq!(body["workspace"]["pipelineChain"]["chain"][0], "proc-a");
        // The layout tree is opaque: it must come back exactly as it went in.
        assert_eq!(
            body["workspace"]["layout"],
            json!({ "kind": "split", "children": ["a", "b"] })
        );

        let entries = body["sessions"].as_array().expect("sessions array");
        assert_eq!(entries.len(), 1, "one manifest entry: {body:?}");
        assert!(entries[0]["error"].is_null(), "entry must restore cleanly: {body:?}");
        let restored_id = entries[0]["sessionIds"][0].as_str().expect("a restored session id");
        assert_eq!(restored_id, session_id, "a deterministic id re-derives the same session");

        // The session really is open again, with its chain back in AppState.
        let (status, listing) = get(&router, "/mcp/sessions", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            listing["sessions"]
                .as_array()
                .expect("sessions")
                .iter()
                .any(|s| s["id"] == session_id.as_str()),
            "the restored session must be listed again: {listing:?}"
        );
        let restored_meta = state
            .session_pipeline_meta
            .lock()
            .unwrap()
            .get(&session_id)
            .map(|m| m.active_processor_ids.clone());
        assert_eq!(
            restored_meta,
            Some(vec!["proc-a".to_string()]),
            "pipeline meta must survive the round trip"
        );

        // Exactly one restored session => exactly one event.
        assert_eq!(
            sink.events_named("workspace-restored").len(),
            1,
            "workspace-restored is emitted once per restored session"
        );
    }

    /// A `.ltw` outside the allowlist is refused by
    /// `services::policy::authorize_open` before anything is read — and the
    /// refusal carries a real 403, not a 200 an unwary client would read as
    /// success.
    #[tokio::test]
    async fn load_outside_the_allowlist_is_forbidden() {
        let (router, state, _sink, tmp) = app();
        allow(&state, tmp.path());

        let outside = TempDir::new().expect("a directory that is NOT allowlisted");
        let ltw = outside.path().join("elsewhere.ltw");
        std::fs::write(&ltw, b"not even a real ltw").expect("write the decoy");

        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/workspace/load",
            &trusted_headers(),
            &json!({ "path": ltw.to_string_lossy() }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "denied .ltw must be 403: {body:?}");
        assert_eq!(body["error"]["code"], "NOT_ALLOWED");
    }

    /// The write gate is the destination's parent directory, so a `.ltw` that
    /// does not exist yet can still be refused — and nothing is written.
    #[tokio::test]
    async fn save_outside_the_allowlist_is_forbidden_and_writes_nothing() {
        let (router, state, _sink, tmp) = app();
        allow(&state, tmp.path());

        let outside = TempDir::new().expect("a directory that is NOT allowlisted");
        let dest = outside.path().join("escape.ltw");

        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/workspace/save",
            &trusted_headers(),
            &save_body(&dest),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "denied destination must be 403: {body:?}");
        assert_eq!(body["error"]["code"], "NOT_ALLOWED");
        assert!(!dest.exists(), "a refused save must not have written anything");
    }

    /// The autosave destination is app-owned — an agent chooses only the id,
    /// which has to be a single path segment.
    #[tokio::test]
    async fn autosave_writes_under_app_data_and_rejects_a_traversing_id() {
        let (router, _state, _sink, tmp) = app();

        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/workspace/autosave",
            &trusted_headers(),
            &json!({
                "workspaceId": "ws-8",
                "workspaceName": "Autosaved",
                "editorTabs": [],
                "layout": null,
                "pipelineChain": [],
                "disabledChainIds": [],
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "autosave must succeed: {body:?}");
        let written = tmp.path().join("workspaces").join("ws-8.ltw");
        assert!(written.exists(), "autosave must land under app_data_dir/workspaces: {body:?}");
        assert_eq!(body["path"], written.to_string_lossy().as_ref());

        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/workspace/autosave",
            &trusted_headers(),
            &json!({
                "workspaceId": "../escape",
                "workspaceName": "Autosaved",
                "editorTabs": [],
                "layout": null,
                "pipelineChain": [],
                "disabledChainIds": [],
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "a traversing id must be rejected: {body:?}");
        assert_eq!(body["error"]["code"], "INVALID_ARGUMENT");
    }

    /// The two read routes: the persisted list and the live summary. Neither
    /// exposes the opaque layout tree.
    #[tokio::test]
    async fn read_routes_report_the_workspace_list_and_the_active_summary() {
        let (router, _state, _sink, tmp) = app();

        let (status, body) = get(&router, "/mcp/workspaces", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body["workspaces"].as_array().expect("workspaces array").is_empty(),
            "a fresh app_data_dir has no persisted workspaces: {body:?}"
        );

        // Before any envelope is pushed, the summary is empty rather than an error.
        let (status, body) = get(&router, "/mcp/workspace", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["workspaceId"].is_null(), "no envelope yet: {body:?}");
        assert_eq!(body["hasLayout"], false);

        // An autosave caches an envelope, which the summary then reflects.
        let (status, _) = send_json(
            &router,
            Method::POST,
            "/mcp/workspace/autosave",
            &trusted_headers(),
            &json!({
                "workspaceId": "ws-8",
                "workspaceName": "Summarised",
                "editorTabs": [],
                "layout": { "kind": "leaf" },
                "pipelineChain": ["proc-a"],
                "disabledChainIds": [],
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let _ = tmp;

        let (status, body) = get(&router, "/mcp/workspace", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["workspaceId"], "ws-8");
        assert_eq!(body["workspaceName"], "Summarised");
        assert_eq!(body["pipelineChain"][0], "proc-a");
        assert_eq!(
            body["hasLayout"], true,
            "presence only — the tree itself never leaves the backend"
        );
        assert!(
            body.get("layout").is_none(),
            "the summary must not carry the layout tree: {body:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// 7. WP-11 — ADB stream endpoints
// ---------------------------------------------------------------------------
//
// `support::app()` wires a `NullSpawner`, so `POST /mcp/adb/stream` would
// never actually run a capture task here even if a device were attached — and
// `adb` itself may or may not be on PATH on the machine running these. These
// tests therefore cover what the HTTP surface owes regardless of the
// environment: the device route answers with a typed body rather than
// panicking, unknown sessions produce the `{error, code}` envelope, and the
// event feed applies the fail-closed redaction gate. The capture loop, the
// epoch guard and the ring semantics are covered directly by
// `services::stream`'s own unit tests.
mod wp11_stream {
    use super::*;

    use app_lib::services::events::{RingSink, Sink};
    use app_lib::services::stream::{AdbBatch, AdbStreamEvent};

    fn pii_batch(session_id: &str) -> AdbStreamEvent {
        AdbStreamEvent::Batch(AdbBatch {
            session_id: session_id.to_string(),
            lines: vec![app_lib::core::line::ViewLine {
                line_num: 0,
                virtual_index: 0,
                raw: "I/Test: contact user0@example.com for access".to_string(),
                level: app_lib::core::line::LogLevel::Info,
                tag: "Test".to_string(),
                message: "contact user0@example.com for access".to_string(),
                timestamp: 0,
                pid: 0,
                tid: 0,
                source_id: "src".to_string(),
                highlights: vec![],
                matched_by: vec![],
                is_context: false,
            }],
            total_lines: 1,
            byte_count: 0,
            first_timestamp: None,
            last_timestamp: None,
            lost_line_count: 0,
        })
    }

    /// The device route must answer with a typed body either way: a `devices`
    /// array when `adb` is present, or the `{error, code}` envelope when it is
    /// not. What it must never do is panic or surface a 500.
    #[tokio::test]
    async fn devices_route_answers_with_a_typed_body_whether_or_not_adb_exists() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) = get(&router, "/mcp/adb/devices", &trusted_headers()).await;
        if status == StatusCode::OK {
            assert!(body["devices"].is_array(), "devices must be an array: {body}");
        } else {
            assert!(body["error"]["code"].is_string(), "a typed error must carry a code: {body}");
            assert!(body["error"]["message"].is_string(), "...and a message: {body}");
        }
    }

    #[tokio::test]
    async fn status_for_an_unknown_session_is_a_typed_error_body() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) =
            get(&router, "/mcp/sessions/nosuch/stream/status", &trusted_headers()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "NOT_FOUND");
        assert_eq!(body["error"]["message"], "Session 'nosuch' not found");
    }

    #[tokio::test]
    async fn events_for_a_session_with_no_ring_is_a_typed_error_body() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) =
            get(&router, "/mcp/sessions/nosuch/stream/events", &trusted_headers()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "NOT_FOUND");
        assert!(
            body["error"]["message"].as_str().unwrap().contains("No event stream registered"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn stopping_a_stream_that_was_never_started_still_answers() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/sessions/nosuch/stream/stop",
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // No task, no state — the clear is a no-op, so this is a success.
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn save_to_a_destination_outside_the_allowlist_is_refused() {
        let (router, state, _sink, _tmp) = app();
        state
            .sessions
            .lock()
            .unwrap()
            .insert("s1".to_string(), fixture_session_with_pii("s1", 2));
        let dest = std::env::temp_dir().join("wp11-should-not-be-written.log");
        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/sessions/s1/stream/save",
            &trusted_headers(),
            &json!({ "destPath": dest.to_string_lossy() }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["code"], "NOT_ALLOWED", "{body}");
        assert!(!dest.exists(), "a refused save must not create the file");
    }

    /// Fail-closed: the session has no `mcp_anonymize` entry, so an agent
    /// draining the ring must not see the PII the ring actually holds.
    #[tokio::test]
    async fn events_are_redacted_when_mcp_anonymize_is_absent_for_the_session() {
        let (router, state, _sink, _tmp) = app();
        state
            .sessions
            .lock()
            .unwrap()
            .insert("s1".to_string(), fixture_session_with_pii("s1", 1));
        // Deliberately NOT setting `mcp_anonymize` for "s1".

        let ring: Arc<RingSink<AdbStreamEvent>> = Arc::new(RingSink::new(2000));
        ring.send(pii_batch("s1"));
        state
            .stream_rings
            .lock()
            .unwrap()
            .insert("s1".to_string(), Arc::clone(&ring));

        let (status, body) =
            get(&router, "/mcp/sessions/s1/stream/events", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["sessionId"], "s1");
        assert_eq!(body["latestSeq"], 1);
        assert_eq!(body["nextSince"], 1);
        assert_eq!(body["gap"], false);

        let events = body["events"].as_array().expect("events must be an array");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["seq"], 1);
        assert_eq!(events[0]["item"]["event"], "batch");
        let raw = events[0]["item"]["data"]["lines"][0]["raw"].as_str().unwrap();
        assert!(
            !raw.contains("user0@example.com") && !raw.contains('@'),
            "an agent must not see raw PII when mcp_anonymize is unset: {raw}"
        );

        // A cursor at the head returns nothing new.
        let (_status, body) = get(
            &router,
            "/mcp/sessions/s1/stream/events?since=1",
            &trusted_headers(),
        )
        .await;
        assert!(body["events"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn events_stay_raw_when_mcp_anonymize_is_explicitly_false() {
        let (router, state, _sink, _tmp) = app();
        state
            .sessions
            .lock()
            .unwrap()
            .insert("s1".to_string(), fixture_session_with_pii("s1", 1));
        state.mcp_anonymize.lock().unwrap().insert("s1".to_string(), false);

        let ring: Arc<RingSink<AdbStreamEvent>> = Arc::new(RingSink::new(2000));
        ring.send(pii_batch("s1"));
        state
            .stream_rings
            .lock()
            .unwrap()
            .insert("s1".to_string(), Arc::clone(&ring));

        let (_status, body) =
            get(&router, "/mcp/sessions/s1/stream/events", &trusted_headers()).await;
        let raw = body["events"][0]["item"]["data"]["lines"][0]["raw"]
            .as_str()
            .unwrap();
        assert!(
            raw.contains("user0@example.com"),
            "mcp_anonymize=false must serve raw text"
        );
    }
}

// ---------------------------------------------------------------------------
// 9. WP-13 — one typed wire contract, real status codes
// ---------------------------------------------------------------------------
//
// The bridge no longer answers `200 + { "error": "…" }`. Every failure is
// `ServiceError`'s real status plus `{ "error": { "code", "message" } }`
// (`mcp_bridge::respond`'s `IntoResponse` impl), and every success is a typed
// `services::wire` value. These tests pin both halves over the live router.
mod wp13_wire_contract {
    use super::*;

    /// Minimal query string a route needs before its handler is even reached.
    ///
    /// Without these, axum's `Query` extractor rejects the request before
    /// `IntoResponse for ServiceError` is involved at all — which is a
    /// different (and correct) failure mode, but not the one under test.
    fn probe_query(template: &str) -> &'static str {
        match template {
            t if t.ends_with("/state_at") => "?line=0",
            t if t.ends_with("/search") => "?pattern=x",
            t if t.ends_with("/search_with_context") => "?query=x",
            t if t.ends_with("/section_at") || t.ends_with("/lines_around") => "?line=0",
            t if t.ends_with("/chart") => "?processor_id=x",
            t if t.ends_with("/timeline") => "?processor_ids=x",
            _ => "",
        }
    }

    /// Every route in the table, driven against a session/filter/processor id
    /// that does not exist: whatever comes back, if it is a failure with a JSON
    /// body then it must be the one envelope — never a bare top-level `error`
    /// string, and never a 200 pretending to be a success.
    ///
    /// Bodies that are not JSON are skipped on purpose: a POST probed with `{}`
    /// can be rejected by axum's own `Json` extractor (missing required field)
    /// before any handler runs, and that rejection is plain text by design.
    #[tokio::test]
    async fn every_route_answers_failures_with_the_typed_error_envelope() {
        let (router, _state, _sink, _tmp) = app();
        let mut asserted = 0usize;

        for (method_str, template) in mcp_bridge::ROUTES {
            let path = format!("{}{}", substitute_placeholders(template), probe_query(template));
            let method = Method::from_bytes(method_str.as_bytes()).expect("valid method");

            let (status, bytes) = if method == Method::GET {
                get_raw(&router, &path, &trusted_headers()).await
            } else {
                send_json_raw(&router, method.clone(), &path, &trusted_headers(), &json!({})).await
            };

            if status.is_success() {
                continue;
            }
            let Ok(body) = serde_json::from_slice::<Value>(&bytes) else {
                // An extractor rejection (plain text) — not this test's concern.
                continue;
            };

            asserted += 1;
            assert!(
                !body["error"].is_string(),
                "{method_str} {template} -> {status}: the pre-WP-13 bare `error` string is gone, \
                 but this route still emits one: {body}"
            );
            assert!(
                body["error"]["code"].is_str_nonempty(),
                "{method_str} {template} -> {status}: error.code must be a non-empty string: {body}"
            );
            assert!(
                body["error"]["message"].is_str_nonempty(),
                "{method_str} {template} -> {status}: error.message must be a non-empty string: {body}"
            );
            assert!(
                body.get("code").is_none(),
                "{method_str} {template}: the old sibling `code` key must be gone: {body}"
            );
        }

        assert!(
            asserted >= 20,
            "the probe should have reached far more failing routes than {asserted} — \
             did `substitute_placeholders` stop producing absent ids?"
        );
    }

    /// Small helper so the assertions above read as one thought.
    trait StrNonEmpty {
        fn is_str_nonempty(&self) -> bool;
    }
    impl StrNonEmpty for Value {
        fn is_str_nonempty(&self) -> bool {
            self.as_str().is_some_and(|s| !s.is_empty())
        }
    }

    /// `require_local`'s refusal used to be a bare, empty-bodied 403. It is
    /// still a 403, but it now carries the same envelope as everything else, so
    /// a client has exactly one error shape to parse.
    #[tokio::test]
    async fn the_csrf_refusal_uses_the_same_envelope() {
        let (router, _state, _sink, _tmp) = app();
        let (status, bytes) = get_raw(&router, "/mcp/status", &[]).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let body: Value = serde_json::from_slice(&bytes).expect("the refusal must be JSON now");
        assert_eq!(body["error"]["code"], "NOT_ALLOWED");
        assert!(body["error"]["message"].as_str().is_some_and(|m| !m.is_empty()));
    }

    /// The deleted orphan. Nothing in `mcp-server/` ever called it, so no
    /// shipped client breaks — but it must genuinely be gone from the table,
    /// not merely unregistered in `router()`.
    #[tokio::test]
    async fn tag_stats_is_gone_from_the_route_table_and_the_router() {
        assert!(
            !mcp_bridge::ROUTES.iter().any(|(_, p)| p.contains("tag-stats")),
            "tag-stats must be removed from ROUTES"
        );

        let (router, _state, _sink, _tmp) = app();
        let (status, bytes) = get_raw(&router, "/mcp/sessions/s1/tag-stats", &trusted_headers()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(bytes.is_empty(), "axum's own routing 404, not a handler's");
    }

    // ── Renamed / retyped success bodies ───────────────────────────────────

    #[tokio::test]
    async fn status_reports_the_processor_count_under_its_own_key() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) = get(&router, "/mcp/status", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["running"], true);
        assert_eq!(body["installedProcessorCount"], 0);
        assert!(
            body.get("installedProcessors").is_none(),
            "that key now means the *list* on GET /mcp/sessions: {body}"
        );
    }

    #[tokio::test]
    async fn query_answers_a_line_page() {
        let (router, state, _sink, _tmp) = app();
        state
            .sessions
            .lock()
            .unwrap()
            .insert("s1".to_string(), fixture_session_with_pii("s1", 10));
        state.mcp_anonymize.lock().unwrap().insert("s1".to_string(), false);

        let (status, body) = get(&router, "/mcp/sessions/s1/query?n=3", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["sessionId"], "s1");
        assert_eq!(body["totalLines"], 10);
        assert_eq!(body["count"], 3);
        assert_eq!(body["strategy"]["kind"], "recent");
        // The renamed keys are gone, not merely duplicated.
        for gone in ["totalLinesInSession", "sampledCount"] {
            assert!(body.get(gone).is_none(), "{gone} should be gone: {body}");
        }
        // Elements are full `ViewLine`s now, not `{lineNum, level, tag, raw}`.
        assert!(body["lines"][0]["message"].is_string(), "{body}");
        assert_eq!(body["lines"][0]["isContext"], false);
    }

    #[tokio::test]
    async fn lines_around_answers_a_line_page_whose_strategy_carries_the_centre() {
        let (router, state, _sink, _tmp) = app();
        state
            .sessions
            .lock()
            .unwrap()
            .insert("s1".to_string(), fixture_session_with_pii("s1", 10));
        state.mcp_anonymize.lock().unwrap().insert("s1".to_string(), false);

        let (status, body) = get(
            &router,
            "/mcp/sessions/s1/lines_around?line=4&before=1&after=1",
            &trusted_headers(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["strategy"]["kind"], "around");
        assert_eq!(body["strategy"]["line"], 4);
        assert_eq!(body["count"], 3);
        assert!(body.get("centerLine").is_none(), "replaced by strategy.line: {body}");
        // `isCenter` became `isContext`, inverted.
        let centres: Vec<&Value> = body["lines"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| l["isContext"] == false)
            .collect();
        assert_eq!(centres.len(), 1);
        assert_eq!(centres[0]["lineNum"], 4);
    }

    #[tokio::test]
    async fn both_search_routes_answer_the_same_search_hits_shape() {
        let (router, state, _sink, _tmp) = app();
        state.sessions.lock().unwrap().insert(
            "s1".to_string(),
            app_lib::services::testing::fixture_session("s1", 20),
        );
        state.mcp_anonymize.lock().unwrap().insert("s1".to_string(), false);

        for path in [
            "/mcp/sessions/s1/search?pattern=line&limit=2&context=1",
            "/mcp/sessions/s1/search_with_context?query=line&max_results=2&context_lines=1",
        ] {
            let (status, body) = get(&router, path, &trusted_headers()).await;
            assert_eq!(status, StatusCode::OK, "{path}: {body}");
            assert_eq!(body["sessionId"], "s1", "{path}");
            assert_eq!(body["limit"], 2, "{path}");
            assert_eq!(body["returned"], 2, "{path}");
            assert_eq!(body["totalLines"], 20, "{path}");
            assert!(body["hits"].is_array(), "{path}: {body}");
            assert!(body["hits"][0]["line"]["lineNum"].is_number(), "{path}: {body}");
            assert!(body["hits"][0]["contextBefore"].is_array(), "{path}: {body}");
            assert!(body["hits"][0]["captures"].is_array(), "{path}: {body}");
            for gone in ["matches", "matchCount", "maxResults", "totalLinesInSession"] {
                assert!(body.get(gone).is_none(), "{path}: {gone} should be gone: {body}");
            }
        }
    }

    #[tokio::test]
    async fn sections_answers_a_page_with_items() {
        let (router, state, _sink, _tmp) = app();
        state.sessions.lock().unwrap().insert(
            "s1".to_string(),
            app_lib::services::testing::fixture_session("s1", 5),
        );

        let (status, body) = get(&router, "/mcp/sessions/s1/sections", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["items"].is_array(), "{body}");
        assert!(body["total"].is_number(), "{body}");
        assert_eq!(body["offset"], 0);
        assert_eq!(body["limit"], 50);
        for gone in ["sections", "returned", "sessionId"] {
            assert!(body.get(gone).is_none(), "{gone} should be gone: {body}");
        }
    }

    #[tokio::test]
    async fn events_answers_a_page_with_items() {
        let (router, state, _sink, _tmp) = app();
        state.sessions.lock().unwrap().insert(
            "s1".to_string(),
            app_lib::services::testing::fixture_session("s1", 5),
        );

        let (status, body) = get(&router, "/mcp/sessions/s1/events", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["items"].is_array(), "{body}");
        for gone in ["events", "count"] {
            assert!(body.get(gone).is_none(), "{gone} should be gone: {body}");
        }
    }

    #[tokio::test]
    async fn the_pipeline_listing_renames_the_matched_line_count() {
        let (router, state, _sink, _tmp) = app();
        state.sessions.lock().unwrap().insert(
            "s1".to_string(),
            app_lib::services::testing::fixture_session("s1", 5),
        );

        let (status, body) = get(&router, "/mcp/sessions/s1/pipeline", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["sessionId"], "s1");
        assert_eq!(body["hasResults"], false);
        assert!(body["reporters"].as_array().unwrap().is_empty());
        assert!(body["stateTrackers"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_deleted_bookmark_acks_and_an_unknown_one_is_a_404() {
        let (router, state, _sink, _tmp) = app();
        state.sessions.lock().unwrap().insert(
            "s1".to_string(),
            app_lib::services::testing::fixture_session("s1", 5),
        );

        let (status, created) = send_json(
            &router,
            Method::POST,
            "/mcp/sessions/s1/bookmarks",
            &trusted_headers(),
            &json!({ "lineNumber": 1, "label": "here" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let id = created["id"].as_str().expect("a bookmark id").to_string();

        let (status, body) = send_json(
            &router,
            Method::DELETE,
            &format!("/mcp/sessions/s1/bookmarks/{id}"),
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);

        let (status, body) = send_json(
            &router,
            Method::DELETE,
            "/mcp/sessions/s1/bookmarks/nosuch",
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["error"]["code"], "NOT_FOUND");
    }
}

// ---------------------------------------------------------------------------
// 10. WP-14 — status-code matrix
// ---------------------------------------------------------------------------
//
// One class per failure kind, each driven across several route families so a
// single handler's status/code choice can't be mistaken for the contract:
// unknown-id -> 404 NOT_FOUND, a denied filesystem destination -> 403
// NOT_ALLOWED, and malformed request parameters -> 400 (with whatever
// `InvalidArg` code that route uses).
mod wp14_status_code_matrix {
    use super::*;

    /// (a) An unknown session/filter/analysis id -> `404` with the one typed
    /// `{error:{code:"NOT_FOUND"}}` envelope, across five independent route
    /// families (session lifecycle, filters x2, analyses x2).
    #[tokio::test]
    async fn unknown_ids_yield_404_not_found_across_route_families() {
        let cases: Vec<(Method, &str)> = vec![
            (Method::GET, "/mcp/sessions/nosuch/metadata"),
            (Method::POST, "/mcp/sessions/nosuch/close"),
            (Method::GET, "/mcp/filters/nosuch"),
            (Method::GET, "/mcp/filters/nosuch/lines"),
            (Method::GET, "/mcp/analyses/nosuch"),
            (Method::DELETE, "/mcp/analyses/nosuch"),
            (Method::GET, "/mcp/sessions/nosuch/stream/status"),
        ];

        for (method, path) in cases {
            let (router, _state, _sink, _tmp) = app();
            let (status, body) = if method == Method::GET {
                get(&router, path, &trusted_headers()).await
            } else {
                send_json(&router, method.clone(), path, &trusted_headers(), &json!({})).await
            };
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path} -> {status}: {body}");
            assert_eq!(body["error"]["code"], "NOT_FOUND", "{method} {path}: {body}");
            assert!(
                body["error"]["message"].as_str().is_some_and(|m| !m.is_empty()),
                "{method} {path}: {body}"
            );
        }
    }

    /// (b) A caller-chosen filesystem destination outside the MCP open
    /// allowlist -> `403 NOT_ALLOWED`, across every gate that authorizes a
    /// write or open: `open_file` (a path outside the allowlist entirely),
    /// `export` (a destination whose directory isn't allowlisted), and
    /// `workspace/save` (same shape, different route).
    #[tokio::test]
    async fn denied_destinations_yield_403_not_allowed_across_route_families() {
        // open_file: an existing file OUTSIDE the allowlist.
        {
            let (router, _state, _sink, _tmp) = app();
            let file = NamedTempFile::new().expect("create temp file");
            let (status, body) = send_json(
                &router,
                Method::POST,
                "/mcp/open_file",
                &trusted_headers(),
                &json!({ "path": file.path().to_string_lossy() }),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            assert_eq!(body["error"]["code"], "NOT_ALLOWED");
        }

        // export: a destination whose directory is never allowlisted.
        {
            let (router, _state, _sink, tmp) = app();
            let dest = tmp.path().join("nope.lts");
            let body = json!({
                "destPath": dest.to_string_lossy(),
                "includeBookmarks": false,
                "includeAnalyses": false,
                "includeProcessors": false,
                "editorTabs": [],
            });
            let (status, resp) = send_json(&router, Method::POST, "/mcp/export", &trusted_headers(), &body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{resp}");
            assert_eq!(resp["error"]["code"], "NOT_ALLOWED");
            assert!(!dest.exists(), "a denied export must not write anything");
        }

        // workspace/save: the allowlist covers one directory; the chosen
        // destination is deliberately in a different one.
        {
            let (router, state, _sink, tmp) = app();
            let allowed = tmp.path().join("allowed");
            std::fs::create_dir_all(&allowed).unwrap();
            state.mcp_open_allowlist.lock().unwrap().allowed_dirs.push(allowed.to_string_lossy().to_string());
            let outside = TempDir::new().expect("a directory that is NOT allowlisted");
            let dest = outside.path().join("escape.ltw");
            let body = json!({
                "workspaceId": "ws-14",
                "destPath": dest.to_string_lossy(),
                "workspaceName": "WP-14",
                "editorTabs": [],
                "layout": null,
                "pipelineChain": [],
                "disabledChainIds": [],
            });
            let (status, resp) = send_json(&router, Method::POST, "/mcp/workspace/save", &trusted_headers(), &body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{resp}");
            assert_eq!(resp["error"]["code"], "NOT_ALLOWED");
            assert!(!dest.exists(), "a denied workspace save must not write anything");
        }
    }

    /// (c) Malformed request parameters -> `400`, on three independently
    /// implemented gates: a malformed path string, an uncompilable regex, and
    /// a request missing a required mutually-exclusive field.
    #[tokio::test]
    async fn malformed_params_yield_400_across_three_routes() {
        // open_file: a relative path is structurally invalid, regardless of
        // the allowlist.
        {
            let (router, _state, _sink, _tmp) = app();
            let (status, body) = send_json(
                &router,
                Method::POST,
                "/mcp/open_file",
                &trusted_headers(),
                &json!({ "path": r"relative\path.log" }),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body["error"]["code"], "INVALID_PATH");
        }

        // filter create: an uncompilable regex.
        {
            let (router, state, _sink, _tmp) = app();
            state
                .sessions
                .lock()
                .unwrap()
                .insert("s1".to_string(), app_lib::services::testing::fixture_session("s1", 5));
            let (status, body) = send_json(
                &router,
                Method::POST,
                "/mcp/sessions/s1/filters",
                &trusted_headers(),
                &json!({ "regex": "[invalid" }),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body["error"]["code"], "INVALID_ARGUMENT");
        }

        // marketplace/install: neither `entry` nor `pack` supplied.
        {
            let (router, _state, _sink, _tmp) = app();
            let (status, body) = send_json(
                &router,
                Method::POST,
                "/mcp/marketplace/install",
                &trusted_headers(),
                &json!({ "sourceName": "official" }),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body["error"]["code"], "INVALID_ARGUMENT");
        }
    }
}
