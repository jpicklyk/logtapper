//! Shared in-process HTTP harness for the MCP bridge router, used by both
//! `tests/bridge_http.rs` and `tests/wire_parity.rs`.
//!
//! Drives the REAL `mcp_bridge::router(ctx)` — CSRF middleware, activity
//! stamping, and every route handler — via `tower::ServiceExt::oneshot`, with
//! no TCP listener and no live `AppHandle`. `BridgeCtx::from_parts` (added by
//! WP-0) is what makes this possible: it builds a `BridgeCtx` with `app:
//! None`, so handlers not yet converted to `ServiceCtx` surface
//! `TRANSPORT_UNAVAILABLE` here instead of touching a real Tauri handle.
//!
//! Requires `services::testing` (`RecordingSink`, session fixtures), which is
//! `cfg(any(test, feature = "test-support"))` — invisible to a separate
//! integration-test crate under plain `#[cfg(test)]` alone. The `log-tapper`
//! self-dependency with `features = ["test-support"]` in `Cargo.toml`
//! `[dev-dependencies]` activates that feature for the `cargo test` build via
//! normal feature unification.
//!
//! Moved out of `tests/bridge_http.rs` into this shared module (allowed under
//! `tests/support/` per WP-14's scope) once `tests/wire_parity.rs` needed the
//! identical construction — a fresh isolated `AppState` plus a `BridgeCtx`
//! built from it, so a test can grab a [`crate::services::ServiceCtx`] via
//! `BridgeCtx::svc()` (cloned BEFORE the `BridgeCtx` is consumed by
//! `router()`) and a live router that reads and writes the very same state.

#![allow(dead_code)] // Not every helper is used by every test binary that includes this module.

use std::sync::Arc;

use app_lib::commands::AppState;
use app_lib::mcp_bridge::{self, BridgeCtx};
use app_lib::services::paths::{FixedPaths, NullSpawner};
use app_lib::services::testing::RecordingSink;
use app_lib::services::{AppPaths, EventSink, Spawner};

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

/// Build a fresh router over an isolated `AppState`, plus the handles a test
/// needs to seed state before a request (sessions, allowlist,
/// `mcp_anonymize`) or assert on after one (`mcp_last_activity`, emitted
/// events). Every call gets its own `AppState` — tests never share one.
pub fn app() -> (Router, Arc<AppState>, Arc<RecordingSink>, TempDir) {
    let (ctx, state, sink, tmp) = ctx_only();
    let router = mcp_bridge::router(ctx);
    (router, state, sink, tmp)
}

/// Like [`app`], but hands back the `BridgeCtx` itself before `router()`
/// consumes it. `BridgeCtx` is `Clone`, and `BridgeCtx::svc()` takes `&self` —
/// so a caller can build a [`app_lib::services::ServiceCtx`] against the exact
/// same `AppState` a subsequently-built router reads and writes:
///
/// ```ignore
/// let (ctx, state, _sink, _tmp) = support::ctx_only();
/// let svc = ctx.svc("test-agent"); // Caller::Agent, same AppState
/// let router = mcp_bridge::router(ctx); // consumes ctx, not svc
/// ```
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
/// requested: `{session_id}` -> `nosuch` (a plausible-but-absent session id),
/// any other `{...}` -> `x`.
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
/// bytes — some assertions (byte-identical error bodies) need the bytes, not
/// a re-serialized parse of them.
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

/// `method path` with `headers` plus a JSON `body`, returning the status and
/// raw response bytes.
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

// ---------------------------------------------------------------------------
// TS binding cross-checks
// ---------------------------------------------------------------------------

/// Read the generated `src-next/bridge/generated/{type_name}.ts` file. Panics
/// with a helpful message if it is missing — that itself is a signal that a
/// wire type isn't actually `#[derive(TS)]`-exported yet.
pub fn read_generated_ts(type_name: &str) -> String {
    // `CARGO_MANIFEST_DIR` is `.../src-tauri`; the generated bindings live at
    // `../src-next/bridge/generated` from there.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src-next")
        .join("bridge")
        .join("generated")
        .join(format!("{type_name}.ts"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("expected generated TS binding at {}: {e}", path.display()))
}

/// Cheap cross-language guard: every key present in a JSON object must appear
/// in the generated TypeScript type's own text as `key:` or `key?:` (ts-rs
/// renders both required and optional fields that way, doc comments and
/// nested generics notwithstanding — this is a substring check, not a parser).
///
/// Only top-level keys of `value` are checked — nested object fields belong to
/// their own generated type and are checked when that type gets its own call.
pub fn assert_ts_binding_covers_json_keys(type_name: &str, value: &Value) {
    let ts = read_generated_ts(type_name);
    let obj = value
        .as_object()
        .unwrap_or_else(|| panic!("{type_name}: expected a JSON object, got {value}"));
    for key in obj.keys() {
        let required = format!("{key}:");
        let optional = format!("{key}?:");
        assert!(
            ts.contains(&required) || ts.contains(&optional),
            "{type_name}.ts does not mention JSON key '{key}' as `{key}:` or `{key}?:' — \
             generated TS binding: {ts}"
        );
    }
}
