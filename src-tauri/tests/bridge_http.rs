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
    // time WP-T2 landed, 70 after every Wave-2 package appended its routes) — a
    // drift here means BOTH tests need updating, which is the point: it
    // forces a route addition/removal to touch this file. Other Wave-2
    // packages append their own routes concurrently in sibling worktrees, so
    // this exact number is expected to hit a merge conflict when those
    // branches combine — resolve it by summing every package's additions,
    // not by picking one side.
    assert_eq!(
        routes.len(),
        70,
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
// `harness::app()` wires a `NullSpawner` (see `services::testing`), so
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

        // gone — both `info` and `lines` now report NOT_FOUND for it.
        let (status, body) = get(&router, &format!("/mcp/filters/{filter_id}"), &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "pre-WP-13 envelope is always 200");
        assert_eq!(body["code"], "NOT_FOUND");
        assert!(body["error"].as_str().unwrap().contains(&filter_id));

        let (status, body) =
            get(&router, &format!("/mcp/filters/{filter_id}/lines"), &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["code"], "NOT_FOUND");
    }

    #[tokio::test]
    async fn unknown_filter_id_gets_a_not_found_style_error_body_on_every_route() {
        let (router, _state, _sink, _tmp) = app();

        let (status, body) = get(&router, "/mcp/filters/nosuch", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK, "pre-WP-13 envelope is always 200");
        assert_eq!(body["code"], "NOT_FOUND");
        assert!(body["error"].as_str().unwrap().contains("nosuch"));

        let (status, body) = get(&router, "/mcp/filters/nosuch/lines", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["code"], "NOT_FOUND");

        let (status, body) = send_json(
            &router,
            Method::POST,
            "/mcp/filters/nosuch/cancel",
            &trusted_headers(),
            &json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["code"], "NOT_FOUND");

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
        assert_eq!(status, StatusCode::OK, "pre-WP-13 envelope is always 200");
        assert_eq!(body["code"], "INVALID_ARGUMENT");
        assert!(body["error"].as_str().unwrap().contains("[invalid"));
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
        assert_eq!(resp["code"], "NOT_ALLOWED");
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
        assert_eq!(body["code"], "NOT_ALLOWED");
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
        assert_eq!(body["code"], "NOT_ALLOWED");
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
        assert_eq!(body["code"], "INVALID_ARGUMENT");
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
// `harness::app()` wires a `NullSpawner`, so `POST /mcp/adb/stream` would
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
        assert_eq!(status, StatusCode::OK);
        if body.get("devices").is_some() {
            assert!(body["devices"].is_array(), "devices must be an array: {body}");
        } else {
            assert!(body["error"].is_string(), "expected a typed error body: {body}");
            assert!(body["code"].is_string(), "a typed error must carry a code: {body}");
        }
    }

    #[tokio::test]
    async fn status_for_an_unknown_session_is_a_typed_error_body() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) =
            get(&router, "/mcp/sessions/nosuch/stream/status", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["code"], "NOT_FOUND");
        assert_eq!(body["error"], "Session 'nosuch' not found");
    }

    #[tokio::test]
    async fn events_for_a_session_with_no_ring_is_a_typed_error_body() {
        let (router, _state, _sink, _tmp) = app();
        let (status, body) =
            get(&router, "/mcp/sessions/nosuch/stream/events", &trusted_headers()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["code"], "NOT_FOUND");
        assert!(
            body["error"].as_str().unwrap().contains("No event stream registered"),
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
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["code"], "NOT_ALLOWED", "{body}");
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
