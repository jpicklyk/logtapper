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
use app_lib::mcp_bridge::{self, BridgeCtx};
use app_lib::services::activity::ACTIVITY_CAP;
use app_lib::services::paths::{FixedPaths, NullSpawner};
use app_lib::services::testing::{fixture_session_with_pii, RecordingSink};
use app_lib::services::{AppPaths, Caller, EventSink, Spawner};

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::{NamedTempFile, TempDir};
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

mod harness {
    use super::*;

    /// Build a fresh router over an isolated `AppState`, plus the handles a
    /// test needs to seed state before a request (sessions, allowlist,
    /// `mcp_anonymize`) or assert on after one (`mcp_last_activity`, emitted
    /// events). Every call gets its own `AppState` — tests never share one.
    pub fn app() -> (Router, Arc<AppState>, Arc<RecordingSink>, TempDir) {
        let (ctx, state, sink, tmp) = ctx_only();
        let router = mcp_bridge::router(ctx);
        (router, state, sink, tmp)
    }

    /// Like [`app`], but hands back the `BridgeCtx` itself before `router()`
    /// consumes it. Needed only by the test that exercises `BridgeCtx::svc()`
    /// / `ServiceCtx::journal` directly — reads are never journaled, so no
    /// GET route can be used to observe a journal write.
    pub fn ctx_only() -> (BridgeCtx, Arc<AppState>, Arc<RecordingSink>, TempDir) {
        let state = Arc::new(AppState::new());
        let sink = Arc::new(RecordingSink::new());
        let tmp = tempfile::tempdir().expect("tempdir for test AppPaths");
        let paths: Arc<dyn AppPaths> = Arc::new(FixedPaths(tmp.path().to_path_buf()));
        let spawner: Arc<dyn Spawner> = Arc::new(NullSpawner);
        let ctx = BridgeCtx::from_parts(
            Arc::clone(&state),
            Arc::clone(&sink) as Arc<dyn EventSink>,
            paths,
            spawner,
        );
        (ctx, state, sink, tmp)
    }

    /// Headers that pass `require_local`: exactly the bridge's own `Host`, no
    /// `Origin`, no `Referer`.
    pub fn trusted_headers() -> Vec<(&'static str, &'static str)> {
        vec![("host", "127.0.0.1:40404")]
    }

    /// Placeholder-substitute a `ROUTES` path template so it can actually be
    /// requested: `{session_id}` -> `nosuch` (a plausible-but-absent session
    /// id), any other `{...}` -> `x`.
    pub fn substitute_placeholders(template: &str) -> String {
        template
            .split('/')
            .map(|seg| match seg.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
                Some("session_id") => "nosuch",
                Some(_) => "x",
                None => seg,
            })
            .collect::<Vec<_>>()
            .join("/")
    }

    /// `GET path` with `headers`, returning the status and raw response body
    /// bytes — some assertions (byte-identical error bodies) need the bytes,
    /// not a re-serialized parse of them.
    pub async fn get_raw(router: &Router, path: &str, headers: &[(&str, &str)]) -> (StatusCode, Vec<u8>) {
        let mut builder = Request::builder().method(Method::GET).uri(path);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let req = builder.body(Body::empty()).expect("build GET request");
        send(router, req).await
    }

    /// `GET path` with `headers`, returning the status and parsed JSON body.
    pub async fn get(router: &Router, path: &str, headers: &[(&str, &str)]) -> (StatusCode, Value) {
        let (status, bytes) = get_raw(router, path, headers).await;
        (status, json(&bytes))
    }

    /// `method path` with `headers` plus a JSON `body`, returning the status
    /// and raw response bytes.
    pub async fn send_json_raw(
        router: &Router,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: &Value,
    ) -> (StatusCode, Vec<u8>) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let req = builder
            .body(Body::from(serde_json::to_vec(body).expect("serialize request body")))
            .expect("build request");
        send(router, req).await
    }

    /// Same as [`send_json_raw`], but with the parsed JSON body.
    pub async fn send_json(
        router: &Router,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: &Value,
    ) -> (StatusCode, Value) {
        let (status, bytes) = send_json_raw(router, method, path, headers, body).await;
        (status, json(&bytes))
    }

    async fn send(router: &Router, req: Request<Body>) -> (StatusCode, Vec<u8>) {
        let res = router.clone().oneshot(req).await.expect("router must not error");
        let status = res.status();
        let bytes = res
            .into_body()
            .collect()
            .await
            .expect("collect response body")
            .to_bytes()
            .to_vec();
        (status, bytes)
    }

    /// Parse `bytes` as JSON, or `Value::Null` for an empty body.
    pub fn json(bytes: &[u8]) -> Value {
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(bytes).unwrap_or(Value::Null)
        }
    }
}

use harness::*;

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
    // time WP-T2 landed, 47 after WP-9 added the processors/marketplace
    // surface) — a drift here means BOTH tests need updating, which is the
    // point: it forces a route addition/removal to touch this file.
    assert_eq!(
        routes.len(),
        47,
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
    assert_eq!(body["code"], "NOT_ALLOWED");
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
        assert_eq!(body["code"], "INVALID_PATH", "path {bad:?}");
    }
}

#[tokio::test]
async fn open_file_allowed_and_existing_is_not_403_or_400() {
    // The allowlist + path-hygiene gate (the part this test package owns)
    // passes for an allowed, existing file. Today's actual outcome is 503
    // TRANSPORT_UNAVAILABLE: `BridgeCtx::from_parts` (this harness) carries no
    // Tauri `AppHandle`, and `h_open_file` still calls `open_file_inner`
    // through one. WP-6 converts that handler to `ServiceCtx`, after which
    // this becomes a real 200 — this test only pins that the gate itself does
    // not stand in the way.
    let (router, state, _sink, tmp) = app();
    let file = NamedTempFile::new_in(tmp.path()).expect("create temp file inside the allowlist dir");
    state
        .mcp_open_allowlist
        .lock()
        .unwrap()
        .allowed_dirs
        .push(tmp.path().to_string_lossy().to_string());

    let (status, _body) = send_json(
        &router,
        Method::POST,
        "/mcp/open_file",
        &trusted_headers(),
        &json!({ "path": file.path().to_string_lossy() }),
    )
    .await;

    assert_ne!(status, StatusCode::FORBIDDEN, "gate should have permitted this path");
    assert_ne!(status, StatusCode::BAD_REQUEST, "gate should have permitted this path");
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
        assert_eq!(body["code"], "NOT_FOUND");
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
        assert_eq!(body["code"], "INVALID_ARGUMENT");
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
