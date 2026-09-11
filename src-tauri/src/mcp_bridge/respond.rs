//! Shared response-shaping for the MCP bridge's route handlers.
//!
//! There are exactly two response shapes in this bridge:
//!
//! - **Success** — a typed `Serialize` value, rendered by `axum::Json`. Every
//!   handler returns `Result<Json<T>, ServiceError>` (or `Result<Response, _>`
//!   where the success body varies by branch). Nothing here builds a body with
//!   `serde_json::json!`.
//! - **Failure** — [`ServiceError`] itself, via the [`IntoResponse`] impl
//!   below: the status comes from [`ServiceError::http_status`] and the body is
//!   [`WireError`] (`{ "error": { "code", "message" } }`). Because both halves
//!   are derived from the same value, a 200 can never carry an error body and a
//!   4xx can never carry a success one.
//!
//! Lock discipline: acquire a Mutex, copy/clone the data needed, drop the lock,
//! THEN build the response. Never hold a lock across an `.await`.
//!
//! **Lock poisoning is uniform.** Every `AppState` mutex the bridge reaches is
//! now reached through `services::*`, which acquires via `services::lock_svc`
//! and fails closed with [`ServiceError::LockPoisoned`] → HTTP 500 +
//! `{ "error": { "code": "LOCK_POISONED", "message": "{name} lock poisoned" } }`.
//! The pre-WP-13 split — some locks failing the request, others silently
//! recovering a possibly-torn map through the standard library's
//! poison-recovery escape hatch — is gone from this module tree, along with the
//! `lock_or_json_err!` / `lock_or_err_response!` / `get_session_and_source!`
//! macros that implemented it. No code under `mcp_bridge/` recovers from a
//! poisoned lock any more; if one is poisoned the request fails and the next
//! one tries again.

use std::collections::HashMap;

use axum::{
    Json,
    extract::{FromRequest, FromRequestParts, Query, Request},
    http::{HeaderMap, StatusCode, request::Parts},
    response::{IntoResponse, Response},
};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::services::ServiceError;
use crate::services::wire::WireError;

// ---------------------------------------------------------------------------
// The one error rendering
// ---------------------------------------------------------------------------

/// Render a [`ServiceError`] as its real HTTP status plus the [`WireError`]
/// envelope.
///
/// This is the single choke point for every failure the bridge can produce, so
/// a handler declares `Result<Json<T>, ServiceError>` and then just uses `?`.
/// Notable mappings (all from [`ServiceError::http_status`], nothing
/// bridge-specific):
///
/// | variant | status | code |
/// |---|---|---|
/// | `NotFound` | 404 | `NOT_FOUND` |
/// | `InvalidArg` | 400 | `INVALID_ARGUMENT` / `INVALID_PATH` / … |
/// | `Forbidden` | 403 | `NOT_ALLOWED` |
/// | `Conflict` | 409 | `CONFLICT` |
/// | `Cancelled` | 499 | `CANCELLED` |
/// | `LockPoisoned` | 500 | `LOCK_POISONED` |
/// | `Internal` | 500 | `INTERNAL` |
///
/// The open-file gate's anti-probing contract rides on this being a pure
/// function of the error: a denied path and a nonexistent one both produce
/// `ServiceError::not_allowed("path is not allowed")`, so their responses are
/// byte-identical here without the handler having to arrange it.
impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        let status =
            StatusCode::from_u16(self.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(WireError::new(self.code(), self.message()))).into_response()
    }
}

// ---------------------------------------------------------------------------
// Rejection-aware extractors
// ---------------------------------------------------------------------------
//
// `axum::Json<T>` and `axum::extract::Query<T>` answer a *rejection* on bad
// input — a plain-text body, axum's own format, nothing to do with
// `ServiceError`/`WireError` — before the handler ever runs. That bypassed
// the bridge's one error contract: a client missing a required field on
// `POST /mcp/export` got axum's raw `422 text/plain "Failed to deserialize
// the JSON body into the target type: missing field `destPath`..."` instead
// of the `{ "error": { "code", "message" } }` envelope every other failure
// renders. `JsonBody<T>` and `Qs<T>` are drop-in replacements for `Json<T>`/
// `Query<T>` as *parameter* extractors (never as the response type — success
// bodies still use plain `axum::Json`) that convert the rejection into a
// `ServiceError::invalid_arg`, which flows through the existing
// `IntoResponse for ServiceError` above.
//
// Both rejection types (`JsonRejection`, `QueryRejection`) are always
// converted into `ServiceError::InvalidArg` → HTTP 400 `INVALID_ARGUMENT`,
// regardless of axum's own status for that rejection (`JsonRejection`'s
// `MissingJsonContentType` variant answers `415` from axum directly). This
// is a deliberate normalization, not an oversight: `ServiceError` has no
// 415 variant, every other bridge 4xx for "the caller sent something bad"
// is 400 `INVALID_ARGUMENT`, and an MCP client only needs one code path to
// tell a malformed request apart from every other failure. See
// `json_rejections` in `tests/bridge_http.rs` for the pinned contract
// (including the wrong-content-type case, which is 400 here, not axum's 415).

/// Body extractor — use in place of `axum::Json<T>` for every route parameter
/// that deserializes a request body. A deserialization failure (missing
/// field, malformed JSON, wrong content-type) renders through the bridge's
/// `{ "error": { "code", "message" } }` envelope instead of axum's bare
/// plain-text rejection body.
pub(super) struct JsonBody<T>(pub(super) T);

impl<S, T> FromRequest<S> for JsonBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ServiceError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(JsonBody(value)),
            Err(rejection) => Err(ServiceError::invalid_arg(rejection.body_text())),
        }
    }
}

/// Query-string extractor — use in place of `axum::extract::Query<T>` for
/// every route parameter that deserializes `?a=b&c=d`. A malformed value
/// (e.g. `limit=abc` against a `usize` field) renders through the envelope
/// the same way [`JsonBody`] does, instead of axum's bare plain-text
/// rejection body.
pub(super) struct Qs<T>(pub(super) T);

impl<S, T> FromRequestParts<S> for Qs<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ServiceError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(Qs(value)),
            Err(rejection) => Err(ServiceError::invalid_arg(rejection.body_text())),
        }
    }
}

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

/// The self-reported MCP client name from `X-LogTapper-Client`, defaulting to
/// `"mcp"`.
///
/// Passed to [`BridgeCtx::svc`](crate::mcp_bridge::BridgeCtx::svc) so the
/// activity feed can tell agents apart. **Never trusted for authorization** —
/// it is a label, and a caller can put anything in it. An empty header value is
/// treated as absent so a misconfigured client does not produce blank-named
/// journal entries.
///
/// One copy for the whole bridge: `routes/{lines,search,tracker,artifacts,
/// pipeline,sessions}.rs` each grew their own during Waves 1–2 (four of them
/// returning `&str`, one `String`, two of them without the empty-value guard).
pub(super) fn client_name(headers: &HeaderMap) -> &str {
    headers
        .get("x-logtapper-client")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .unwrap_or("mcp")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse a datetime string into Unix-epoch nanoseconds (UTC) — the same
/// epoch `ParsedLineMeta::timestamp` / `LineMeta::timestamp` are on for
/// logcat/bugreport lines, i.e. the value produced by `parse_timestamp_ns()`
/// in `core/logcat_parser.rs`.
///
/// Logcat-native timestamps omit the year, so — exactly like
/// `parse_timestamp_ns()` — the current UTC year is inferred from system
/// time and combined with the parsed month/day via the same era-based civil
/// calendar algorithm. This function cannot call the private
/// `parse_timestamp_ns()` directly (different module), so it instead shares
/// the underlying math via `core::days_from_civil()` /
/// `core::infer_current_year()` — the same helpers `parse_timestamp_ns()`
/// and `bugreport_parser` use.
///
/// Accepts formats:
/// - "MM-DD HH:MM:SS.mmm"  (logcat native — recommended)
/// - "YYYY-MM-DDThh:mm:ss[.fff]" or "YYYY-MM-DD hh:mm:ss[.fff]"
///   (ISO 8601 — year is IGNORED; only month-day is used, matching the
///   inferred-current-year behavior of logcat-native timestamps)
///
/// Returns None if the string cannot be parsed.
pub(super) fn parse_iso_to_unix_nanos(s: &str) -> Option<i64> {
    let s = s.trim();
    let s_normalized = s.replace('T', " ");
    let parts: Vec<&str> = s_normalized.splitn(2, ' ').collect();
    if parts.len() != 2 { return None; }

    let date_part = parts[0];
    let time_part = parts[1];

    // Extract month and day (ignore year if present)
    let date_segments: Vec<&str> = date_part.split('-').collect();
    let (month, day) = if date_segments.len() == 3 {
        // YYYY-MM-DD — ignore year
        let m = date_segments[1].parse::<i64>().ok()?;
        let d = date_segments[2].parse::<i64>().ok()?;
        (m, d)
    } else if date_segments.len() == 2 {
        // MM-DD
        let m = date_segments[0].parse::<i64>().ok()?;
        let d = date_segments[1].parse::<i64>().ok()?;
        (m, d)
    } else {
        return None;
    };

    // Parse time: "HH:MM:SS[.mmm]"
    let t: Vec<&str> = time_part.splitn(4, [':', '.']).collect();
    let h: i64 = t.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let m: i64 = t.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let sec: i64 = t.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let ms: i64 = t.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);

    // Infer the current UTC year exactly like `parse_timestamp_ns()` in
    // `core/logcat_parser.rs`, so the bound lands on the same epoch as
    // `meta.timestamp` for logcat/bugreport lines.
    let year = crate::core::infer_current_year();

    // Days from the Unix epoch to the given civil date (era-based algorithm),
    // shared with `parse_timestamp_ns()` in `core/logcat_parser.rs`.
    let epoch_days = crate::core::days_from_civil(year, month, day);

    const NS_PER_DAY: i64 = 86_400_000_000_000;
    const NS_PER_HOUR: i64 = 3_600_000_000_000;
    const NS_PER_MIN: i64 = 60_000_000_000;
    const NS_PER_SEC: i64 = 1_000_000_000;
    const NS_PER_MS: i64 = 1_000_000;

    Some(
        epoch_days * NS_PER_DAY
            + h * NS_PER_HOUR
            + m * NS_PER_MIN
            + sec * NS_PER_SEC
            + ms * NS_PER_MS,
    )
}

/// Truncate large map vars: for any Value::Object with >20 keys where values
/// are numeric, sort by value desc, keep top 20, add _truncated and _totalKeys.
pub(super) fn truncate_var_maps(vars: &HashMap<String, Value>) -> serde_json::Map<String, Value> {
    vars.iter()
        .filter_map(|(k, v)| {
            match v {
                Value::Array(a) if a.is_empty() => None,
                Value::Object(o) if o.is_empty() => None,
                Value::Object(o) if o.len() > 20 => {
                    // Check if values are numeric
                    let all_numeric = o.values().all(serde_json::Value::is_number);
                    if all_numeric {
                        let total_keys = o.len();
                        let mut entries: Vec<(&String, &Value)> = o.iter().collect();
                        entries.sort_by(|a, b| {
                            let va = a.1.as_f64().unwrap_or(0.0);
                            let vb = b.1.as_f64().unwrap_or(0.0);
                            vb.partial_cmp(&va).unwrap_or(std::cmp::Ordering::Equal)
                        });
                        let mut truncated = serde_json::Map::new();
                        for (ek, ev) in entries.into_iter().take(20) {
                            truncated.insert(ek.clone(), ev.clone());
                        }
                        truncated.insert("_truncated".to_string(), Value::Bool(true));
                        truncated.insert("_totalKeys".to_string(), Value::Number(total_keys.into()));
                        Some((k.clone(), Value::Object(truncated)))
                    } else {
                        Some((k.clone(), v.clone()))
                    }
                }
                _ => Some((k.clone(), v.clone())),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processors::marketplace::resolve_processor_id_checked;
    // The scan-window math these tests exercise lives in `services::lines`;
    // this module no longer re-exports it (WP-2).
    use crate::services::lines::{
        MCP_SCAN_CHUNK_SIZE, MCP_SCAN_LINE_CAP, capped_range_end, scan_chunk_bounds,
        scan_window_capped,
    };
    use axum::body::to_bytes;

    // NOTE: the `resolve_should_anonymize` / `anonymize_for_session` /
    // `anonymize_line_texts` / `anonymize_scan_line` tests moved to
    // `services::policy` along with the functions themselves. The gate is
    // still exercised — just from the module that now owns it.

    // ── IntoResponse for ServiceError ───────────────────────────────────────

    async fn rendered(e: ServiceError) -> (StatusCode, Value) {
        let res = e.into_response();
        let status = res.status();
        let bytes = to_bytes(res.into_body(), usize::MAX).await.expect("collect body");
        (status, serde_json::from_slice(&bytes).expect("JSON body"))
    }

    #[tokio::test]
    async fn every_variant_renders_its_real_status_and_the_nested_envelope() {
        let cases = [
            (ServiceError::session_not_found("s1"), 404, "NOT_FOUND"),
            (ServiceError::invalid_arg("bad"), 400, "INVALID_ARGUMENT"),
            (ServiceError::not_allowed("path is not allowed"), 403, "NOT_ALLOWED"),
            (ServiceError::Conflict("busy".into()), 409, "CONFLICT"),
            (ServiceError::Cancelled, 499, "CANCELLED"),
            (ServiceError::LockPoisoned("sessions"), 500, "LOCK_POISONED"),
            (ServiceError::Internal("boom".into()), 500, "INTERNAL"),
        ];
        for (err, status, code) in cases {
            let message = err.message();
            let (got_status, body) = rendered(err).await;
            assert_eq!(got_status.as_u16(), status, "{code}");
            assert_eq!(body["error"]["code"], code);
            assert_eq!(body["error"]["message"], message);
            // The pre-WP-13 shape — a bare top-level `error` string at HTTP
            // 200 — must be gone, or a client that only checks `body.error`
            // would read an object where it expected text.
            assert!(body["error"].is_object(), "{code}: error must be an object");
        }
    }

    #[tokio::test]
    async fn a_poisoned_lock_is_a_500_lock_poisoned_not_a_panic() {
        // The release-note behaviour change: pre-WP-13 the bridge split its
        // locks into "fail the request" and "recover via into_inner" families.
        // Now every one of them is `services::lock_svc`, which fails closed.
        let state = std::sync::Arc::new(crate::commands::AppState::new());
        let poisoner = std::sync::Arc::clone(&state);
        let joined = std::thread::spawn(move || {
            let _guard = poisoner.sessions.lock().expect("lock not yet poisoned");
            panic!("simulated writer panic while holding sessions");
        })
        .join();
        assert!(joined.is_err(), "poisoning thread should have panicked");
        assert!(state.sessions.is_poisoned());

        // `AnalysisSession` is not `Debug`, so the guard cannot go through
        // `expect_err` — match the error out by hand instead.
        let err = match crate::services::lock_svc(&state.sessions, "sessions") {
            Ok(_) => panic!("a poisoned lock must fail closed"),
            Err(e) => e,
        };
        let (status, body) = rendered(err).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"]["code"], "LOCK_POISONED");
        assert_eq!(body["error"]["message"], "sessions lock poisoned");
    }

    #[tokio::test]
    async fn denied_and_nonexistent_open_paths_render_byte_identically() {
        // `policy::authorize_open` collapses both into the same error value, so
        // the rendering cannot leak the difference. Pinned here because the
        // anti-probing contract now depends on `IntoResponse` being a pure
        // function of the error rather than on each handler arranging it.
        let denied = ServiceError::not_allowed("path is not allowed");
        let missing = ServiceError::not_allowed("path is not allowed");
        assert_eq!(rendered(denied).await, rendered(missing).await);
    }

    // ── client_name ─────────────────────────────────────────────────────────

    fn headers_from(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (k, v) in pairs {
            headers.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        headers
    }

    #[test]
    fn client_name_defaults_to_mcp_when_header_absent() {
        assert_eq!(client_name(&HeaderMap::new()), "mcp");
    }

    #[test]
    fn client_name_reads_the_header_when_present() {
        assert_eq!(
            client_name(&headers_from(&[("x-logtapper-client", "claude-code")])),
            "claude-code"
        );
    }

    #[test]
    fn client_name_ignores_case_of_the_header_name() {
        // HTTP header names are case-insensitive; axum's HeaderMap normalizes
        // this, but pin it here since a header-name typo would silently fall
        // back to "mcp" instead of failing loudly.
        assert_eq!(
            client_name(&headers_from(&[("X-LogTapper-Client", "claude-desktop")])),
            "claude-desktop"
        );
    }

    #[test]
    fn client_name_treats_an_empty_header_value_as_absent() {
        assert_eq!(client_name(&headers_from(&[("x-logtapper-client", "")])), "mcp");
    }

    // ── max_line_chars ──────────────────────────────────────────────────────
    // Wide dumpsys status lines exceed the 500-char default and lose their
    // trailing fields. Callers can widen the cap per request; `truncate_str`
    // itself (and its wider-cap test) live in `services::policy`.

    #[test]
    fn max_line_chars_clamp_matches_handler_bounds() {
        // Mirrors `params.max_line_chars.unwrap_or(500).clamp(1, 8000)`.
        let clamp = |v: usize| v.clamp(1, 8000);
        assert_eq!(clamp(0), 1);
        assert_eq!(clamp(500), 500);
        assert_eq!(clamp(50_000), 8000);
    }

    // ── scan_chunk_bounds / scan_window_capped / capped_range_end ───────────
    // Pure chunking + cap math backing h_query / h_search / h_search_with_context.
    // These handlers used to scan a whole (sometimes unbounded) range under a
    // single `sessions` lock acquisition, freezing every other lock holder for
    // the duration. The fix scans in `MCP_SCAN_CHUNK_SIZE`-line windows,
    // dropping and re-acquiring the lock between each, and bounds the total
    // scan at `MCP_SCAN_LINE_CAP`. This section tests the pure math only —
    // the chunk/cap boundaries — not the handlers' async lock-acquisition
    // loops, which need a live AppState/Tauri context to exercise.

    #[test]
    fn scan_chunk_bounds_splits_evenly() {
        assert_eq!(
            scan_chunk_bounds(0, 30, 10),
            vec![(0, 10), (10, 20), (20, 30)]
        );
    }

    #[test]
    fn scan_chunk_bounds_handles_remainder() {
        assert_eq!(
            scan_chunk_bounds(0, 25, 10),
            vec![(0, 10), (10, 20), (20, 25)]
        );
    }

    #[test]
    fn scan_chunk_bounds_single_chunk_when_smaller_than_chunk_size() {
        assert_eq!(scan_chunk_bounds(5, 8, 10), vec![(5, 8)]);
    }

    #[test]
    fn scan_chunk_bounds_empty_range_yields_no_chunks() {
        assert_eq!(scan_chunk_bounds(10, 10, 10), Vec::<(usize, usize)>::new());
        assert_eq!(scan_chunk_bounds(20, 10, 10), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn scan_chunk_bounds_zero_chunk_size_yields_no_chunks() {
        // Defensive: a zero chunk size must not infinite-loop.
        assert_eq!(scan_chunk_bounds(0, 100, 0), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn scan_chunk_bounds_nonzero_start_offset() {
        assert_eq!(
            scan_chunk_bounds(100_000, 100_025, 10),
            vec![(100_000, 100_010), (100_010, 100_020), (100_020, 100_025)]
        );
    }

    #[test]
    fn scan_window_capped_true_when_range_exceeds_cap() {
        assert!(scan_window_capped(0, 20_000_000, MCP_SCAN_LINE_CAP));
    }

    #[test]
    fn scan_window_capped_false_when_range_fits_under_cap() {
        assert!(!scan_window_capped(0, 100, MCP_SCAN_LINE_CAP));
        // Exactly at the cap is not "over" the cap.
        assert!(!scan_window_capped(0, MCP_SCAN_LINE_CAP, MCP_SCAN_LINE_CAP));
    }

    #[test]
    fn scan_window_capped_respects_nonzero_start() {
        // 20M-line bugreport, paging from line 19M — the remaining window is
        // only 1M, still over a 500k cap.
        assert!(scan_window_capped(19_000_000, 20_000_000, 500_000));
        assert!(!scan_window_capped(19_900_000, 20_000_000, 500_000));
    }

    #[test]
    fn capped_range_end_clamps_to_cap_when_over() {
        assert_eq!(capped_range_end(0, 20_000_000, 500_000), 500_000);
        assert_eq!(capped_range_end(1_000, 20_000_000, 500_000), 501_000);
    }

    #[test]
    fn capped_range_end_passes_through_when_under_cap() {
        assert_eq!(capped_range_end(0, 100, 500_000), 100);
        assert_eq!(capped_range_end(50, 100, 500_000), 100);
    }

    #[test]
    fn capped_range_end_exact_at_cap_is_unchanged() {
        assert_eq!(capped_range_end(0, 500_000, 500_000), 500_000);
    }

    #[test]
    fn cap_and_chunk_bounds_agree_on_scanned_line_count() {
        // The two helpers are used together: cap the window, then chunk it.
        // Their combined output must scan exactly `min(range, cap)` lines,
        // with no gaps or overlaps between consecutive chunks.
        let range_start = 3;
        let requested_end = 1_000_003; // 1,000,000 lines requested
        let cap = 500_000;
        let end = capped_range_end(range_start, requested_end, cap);
        assert_eq!(end - range_start, cap);

        let chunks = scan_chunk_bounds(range_start, end, MCP_SCAN_CHUNK_SIZE);
        assert!(!chunks.is_empty());
        // Contiguous, no gaps/overlaps, and covers exactly [range_start, end).
        assert_eq!(chunks.first().unwrap().0, range_start);
        assert_eq!(chunks.last().unwrap().1, end);
        for pair in chunks.windows(2) {
            assert_eq!(pair[0].1, pair[1].0, "chunks must be contiguous");
        }
        let total_scanned: usize = chunks.iter().map(|(s, e)| e - s).sum();
        assert_eq!(total_scanned, cap);
    }

    // ── parse_iso_to_unix_nanos ──────────────────────────────────────────
    // Regression test for the ~30-year (946,684,800s) time-filter bug: the
    // bound this function produces must be on the SAME epoch as
    // `meta.timestamp`, which `parse_timestamp_ns()` in
    // `core/logcat_parser.rs` fills with true Unix-epoch nanoseconds (not
    // nanoseconds-since-2000-01-01). Before the fix this function added a
    // BASE_NS of 946_684_800_000_000_000, making bounds ~30 years later
    // than the timestamps they were compared against.
    #[test]
    fn parse_iso_to_unix_nanos_matches_logcat_parser_epoch() {
        // Both `parse_iso_to_unix_nanos()` and `parse_timestamp_ns()` (in
        // core/logcat_parser.rs) infer the current UTC year from system
        // time — the ISO input's own year is ignored (unchanged, pre-fix
        // behavior). So the expected value must be computed the same way,
        // using the same era-based civil-calendar algorithm, rather than
        // hardcoded to a specific year.
        fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
            let y = if m <= 2 { y - 1 } else { y };
            let era = y.div_euclid(400);
            let yoe = y.rem_euclid(400);
            let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
            let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
            era * 146097 + doe - 719468
        }
        const NS_PER_DAY: i64 = 86_400_000_000_000;
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let inferred_year = 1970 + now_secs / 31_557_600;
        let expected_unix_ns = days_from_civil(inferred_year, 7, 31) * NS_PER_DAY;

        let got = parse_iso_to_unix_nanos("2026-07-31T00:00:00Z")
            .expect("valid ISO 8601 instant should parse");

        // Sanity: the old (buggy) implementation computed
        // BASE_NS(2000-01-01 as Unix nanos) + yday * NS_PER_DAY, entirely
        // independent of the actual/inferred year. Reproduce that formula
        // exactly (July 31 is day-of-year 211, 0-based) and confirm the
        // fixed function no longer produces it — the two must differ by
        // ~the gap between year 2000 and the inferred current year.
        const OLD_BASE_NS: i64 = 946_684_800_000_000_000; // 2000-01-01 as Unix nanos
        const OLD_JUL_31_YDAY: i64 = 211;
        let old_buggy_value = OLD_BASE_NS + OLD_JUL_31_YDAY * NS_PER_DAY;
        assert_ne!(
            got, old_buggy_value,
            "bound must not regress to the old 2000-epoch-based value"
        );

        assert_eq!(
            got, expected_unix_ns,
            "parse_iso_to_unix_nanos must land on the same Unix epoch as \
             meta.timestamp (i.e. what parse_timestamp_ns() in \
             core/logcat_parser.rs produces)"
        );
    }

    // ── resolve_processor_id_checked at the MCP bridge call sites ───────────
    // `h_processor_detail`, `h_state_at_line`, `h_processor_defs_single`, and
    // `h_run_pipeline` all used to resolve bare processor ids via the plain
    // `resolve_processor_id`, which silently tie-broke when a bare id (e.g.
    // "wifi-state") matched more than one installed qualified id — the same
    // ambiguity `run_pipeline` was already fixed to reject via
    // `resolve_processor_id_checked` (see processors/marketplace.rs). These
    // four call sites now route through the checked variant too and turn an
    // `Err` into a `ServiceError::InvalidArg` (HTTP 400) instead of resolving
    // unpredictably.
    //
    // `resolve_processor_id_checked`'s own ambiguous/unambiguous contract is
    // already covered by unit tests in processors/marketplace.rs. What these
    // tests cover is the seam actually reachable from this file: that calling
    // it against a `state.processors`-shaped store (keyed exactly as
    // `AppState::processors` is) reproduces the `Ok`/`Err` split each call
    // site now matches on, using the identical `&procs, &id` call shape used
    // at all four sites.

    #[test]
    fn resolve_processor_id_checked_errors_on_ambiguous_bare_id_like_bridge_call_sites() {
        // Mirrors state.processors: keyed by qualified id, value type doesn't
        // matter to resolution (the real store holds AnyProcessor).
        let mut procs: HashMap<String, ()> = HashMap::new();
        procs.insert("wifi-state@official".to_string(), ());
        procs.insert("wifi-state@my-team".to_string(), ());

        let result = resolve_processor_id_checked(&procs, "wifi-state");
        assert!(
            result.is_err(),
            "ambiguous bare id must surface as Err for the bridge handlers to map into a ServiceError, not resolve silently"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.contains("wifi-state@official") && msg.contains("wifi-state@my-team"),
            "error should name every candidate so the MCP client can disambiguate: {msg}"
        );
    }

    #[test]
    fn resolve_processor_id_checked_resolves_unambiguous_bare_id_like_bridge_call_sites() {
        let mut procs: HashMap<String, ()> = HashMap::new();
        procs.insert("wifi-state@official".to_string(), ());
        procs.insert("other-proc@official".to_string(), ());

        // Unambiguous bare id resolves — the "found" path each handler
        // still falls through to on `Ok(Some(..))`.
        assert_eq!(
            resolve_processor_id_checked(&procs, "wifi-state"),
            Ok(Some("wifi-state@official".to_string()))
        );

        // Not-found stays `Ok(None)` — handlers preserve today's not-found
        // behavior (h_processor_detail/h_state_at_line fall back to the
        // original bare id via unwrap_or_else; h_processor_defs_single
        // returns its existing "processor not found" error).
        assert_eq!(resolve_processor_id_checked(&procs, "no-such-proc"), Ok(None));

        // Exact qualified id still resolves even with duplicates present.
        assert_eq!(
            resolve_processor_id_checked(&procs, "wifi-state@official"),
            Ok(Some("wifi-state@official".to_string()))
        );
    }
}
