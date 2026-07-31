//! HTTP bridge for the LogTapper MCP server.
//!
//! A TypeScript MCP server process (stdio transport) talks to Claude Code/Desktop.
//! That process queries THIS local HTTP server on `127.0.0.1:40404` to read live
//! AppState data — sessions, sampled log lines, and state-tracker events.
//!
//! Lock discipline: acquire a Mutex, copy/clone the data needed, drop the lock,
//! THEN build the JSON response. Never hold a lock across an `.await`.

use std::borrow::Cow;
use std::collections::HashMap;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::anonymizer::LogAnonymizer;
use crate::commands::AppState;
use crate::processors::{AnyProcessor, ProcessorKind};
use crate::processors::marketplace::{resolve_processor_id, split_qualified_id};
use crate::processors::reporter::engine::RunResult;
use crate::processors::state_tracker::engine::build_defaults;
use crate::processors::state_tracker::types::StateTransition;

pub const PORT: u16 = 40404;

// ---------------------------------------------------------------------------
// Lock-poisoning helpers
// ---------------------------------------------------------------------------
//
// Every AppState Mutex touched in this file falls into one of two families:
//
// - Request-scoped reads of data a panicking writer could leave genuinely
//   torn (`sessions`, `pipeline_results`, `state_tracker_results`,
//   `correlator_results`, `stream_tracker_state`) go through
//   `lock_or_json_err!` / `lock_or_err_response!` below: on poison, fail
//   *this* request with the bridge's existing `{"error": ...}` contract
//   instead of silently serving a possibly-inconsistent snapshot. The next
//   request gets a fresh lock attempt — nothing is bricked. `sessions` is
//   the chokepoint (`get_session_and_source!` / `verify_session_exists!`,
//   below) since it backs every raw-line read in the bridge;
//   `pipeline_results` / `state_tracker_results` / `correlator_results` are
//   the "three-map write sequence" `execute_pipeline` (`commands/pipeline.rs`)
//   writes together as one logical unit per run — a poison mid-sequence
//   means those three are momentarily mutually inconsistent for this
//   session; `stream_tracker_state` is mutated in place by the ADB
//   extract-process-reinsert pattern (see `AppState::stream_epochs` docs) and
//   carries the same risk.
// - Pure gate/registry locks with no cross-field invariants (`processors`,
//   `mcp_open_allowlist`, `mcp_anonymize`, `anonymizer_config`,
//   `mcp_anonymizers`, `bookmarks`, `analyses`, `active_watches`) recover via
//   `PoisonError::into_inner` directly at their call sites — each guards a
//   flat, independently-keyed map or a single wholesale-replaced config
//   value, so a panicking writer cannot leave a torn invariant behind and
//   serving the recovered data is safe. This mirrors the `run_lock`
//   precedent in `commands/pipeline.rs::execute_pipeline`.

/// Acquire `$mutex`, returning a bridge-contract `{"error": ...}` JSON body
/// early on poison instead of unwinding the whole request/thread. Only valid
/// inside a handler whose return type is exactly `Json<Value>` — see
/// [`lock_or_err_response!`] for the two `Response`-returning handlers
/// (`h_open_file`, `h_close_session`).
macro_rules! lock_or_json_err {
    ($mutex:expr, $name:expr) => {
        match $mutex.lock() {
            Ok(guard) => guard,
            Err(_) => return Json(json!({ "error": format!("{} lock poisoned", $name) })),
        }
    };
}

/// Same as [`lock_or_json_err!`], but for handlers returning `Response`,
/// using the bridge's structured `{ error, code }` shape via [`err`].
macro_rules! lock_or_err_response {
    ($mutex:expr, $name:expr) => {
        match $mutex.lock() {
            Ok(guard) => guard,
            Err(_) => return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("{} lock poisoned", $name),
                "LOCK_POISONED",
            ),
        }
    };
}

// ---------------------------------------------------------------------------
// Session lookup macros
// ---------------------------------------------------------------------------

/// Acquire the sessions lock, look up `$session_id`, bind `$sessions` (the lock
/// guard), `$session` (the `&AnalysisSession`), and `$source` (the `&dyn LogSource`).
/// Returns a JSON error response on lookup failure OR on a poisoned lock (see
/// `lock_or_json_err!` above) — this is the chokepoint for every raw-line
/// read in the bridge, so a torn `sessions` map must never be served silently.
macro_rules! get_session_and_source {
    ($state:expr, $session_id:expr => $sessions:ident, $session:ident, $source:ident) => {
        let $sessions = lock_or_json_err!($state.sessions, "sessions");
        let Some($session) = $sessions.get(&$session_id) else {
            return Json(json!({ "error": format!("Session not found: {}", $session_id) }));
        };
        let Some($source) = $session.primary_source() else {
            return Json(json!({ "error": format!("Session has no sources: {}", $session_id) }));
        };
    };
}

/// Verify a session exists (by key) and return a JSON error if not (or if
/// the lock is poisoned — see `lock_or_json_err!` above).
/// Does not bind the session — drops the lock immediately.
macro_rules! verify_session_exists {
    ($state:expr, $session_id:expr) => {{
        let sessions = lock_or_json_err!($state.sessions, "sessions");
        if !sessions.contains_key(&$session_id) {
            return Json(json!({ "error": format!("Session not found: {}", $session_id) }));
        }
    }};
}

// ---------------------------------------------------------------------------
// Processor metadata extraction helpers
// ---------------------------------------------------------------------------

/// Extract the `sections` list from any processor kind.
///
/// Returns a borrowed slice for reporters (already stored) and an owned Vec
/// for state trackers (computed from transition filters). Other kinds get `[]`.
fn extract_sections(p: &AnyProcessor) -> Cow<'_, [String]> {
    match &p.kind {
        ProcessorKind::Reporter(def) => Cow::Borrowed(&def.sections),
        ProcessorKind::StateTracker(def) => {
            let mut sections: Vec<String> = def.transitions.iter()
                .filter_map(|t| t.filter.section.clone())
                .collect();
            sections.sort();
            sections.dedup();
            Cow::Owned(sections)
        }
        _ => Cow::Borrowed(&[]),
    }
}

/// Extract `source_types` from the processor's schema contract.
fn extract_source_types(p: &AnyProcessor) -> &[String] {
    p.schema.as_ref()
        .map_or(&[], |s| s.source_types.as_slice())
}

/// Check whether a qualified (or bare) processor ID matches an optional filter.
/// Returns `true` if no filter is set, or if the filter matches the full or bare ID.
fn processor_id_matches(candidate: &str, filter: Option<&String>) -> bool {
    filter.map_or(true, |fid| {
        fid == candidate || split_qualified_id(candidate).0 == fid.as_str()
    })
}

// ---------------------------------------------------------------------------
// PII anonymization helpers — used by every raw-line handler below
// (h_query, h_search, h_lines_around, h_search_with_context).
// ---------------------------------------------------------------------------

/// Resolve whether MCP bridge responses for `session_id` should be
/// anonymized, given the current per-session flag map (`AppState::mcp_anonymize`).
///
/// **Fails closed**: a session with no explicit entry — one the frontend has
/// never signalled a pipeline-chain state for (e.g. just opened, or the
/// signal hasn't landed yet) — defaults to `true`. Serving raw PII for an
/// unrecognized session is the wrong default; over-anonymizing a session
/// that didn't need it is not.
///
/// Pulled out as a pure function (no locking, no `AppState`) so the decision
/// itself is unit-testable without spinning up Axum or Tauri state.
///
/// Also reused by `commands::export::export_all_sessions` — export must gate
/// on the same per-session state as the bridge rather than inventing a
/// second anonymization decision, or the two could disagree about whether a
/// given session's raw text is safe to hand out.
pub(crate) fn resolve_should_anonymize(flags: &HashMap<String, bool>, session_id: &str) -> bool {
    flags.get(session_id).copied().unwrap_or(true)
}

/// Anonymize `raw` for `session_id` per its resolved per-session flag (see
/// [`resolve_should_anonymize`]). Reuses this session's persistent
/// `LogAnonymizer` — cached in `mcp_anonymizers` — so token numbering stays
/// stable across multiple bridge calls, creating one from the current
/// default `anonymizer_config` on first use. Returns `raw` unchanged when
/// anonymization is disabled (or unset — never happens, since unset fails
/// closed to anonymize) for this session.
///
/// Locks `mcp_anonymize`, then (only when anonymizing) `anonymizer_config`
/// and `mcp_anonymizers`, each acquired and released in turn. Never held
/// across an `.await`; never nested with `sessions` or `pipeline_results`.
/// Enforced at every call site: `h_query`, `h_search`, `h_search_with_context`,
/// and `h_lines_around` all collect RAW text under the `sessions` lock first,
/// drop it, and only then call this function (directly or via
/// [`anonymize_scan_line`] / [`anonymize_line_texts`]) — `sessions` is never
/// held while this function's own locks are acquired.
///
/// Also called from `commands::export::export_all_sessions` (after its
/// `sessions` lock has been dropped, mirroring the `resolve_line_texts` /
/// `anonymize_line_texts` split below) so exported `.lts` archives honor the
/// same per-session anonymization flag as MCP bridge reads, instead of
/// writing raw Tier-1 bytes unconditionally.
pub(crate) fn anonymize_for_session(state: &AppState, session_id: &str, raw: &str) -> String {
    let should_anonymize = {
        let flags = state.mcp_anonymize.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        resolve_should_anonymize(&flags, session_id)
    };
    if !should_anonymize {
        return raw.to_string();
    }
    let config = state.anonymizer_config.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    let mut anon_map = state.mcp_anonymizers.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let anon = anon_map
        .entry(session_id.to_string())
        .or_insert_with(|| LogAnonymizer::from_config(&config));
    anon.anonymize(raw).0
}

// ---------------------------------------------------------------------------
// Chunked scan helpers — shared by h_query / h_search / h_search_with_context
// ---------------------------------------------------------------------------
//
// These three raw-line scan handlers used to acquire `sessions` once and
// hold it for the entire scan — unbounded for h_search / h_search_with_context,
// and up to 100k lines for h_query. A rarely-matching filter/regex over a
// multi-million-line bugreport ties up the global `sessions` lock for the
// whole request, freezing `get_lines`, `flush_batch`, filter creation, and
// the UI for as long as the scan runs.
//
// The fix mirrors `commands::files::search_logs` (`SEARCH_CHUNK_SIZE`): scan
// in bounded windows, dropping and re-acquiring `sessions` between each one
// so other lock holders always get a turn. A hard cap on total lines scanned
// per request (`MCP_SCAN_LINE_CAP`) additionally bounds worst-case request
// latency. When the cap — or a mid-scan session removal — stops the scan
// before the full requested range was covered, handlers set `truncated: true`
// and report `scannedLines` in the JSON response (both purely additive: every
// existing field is unchanged) so callers know results may be incomplete.

/// Lines scanned per lock acquisition. Matches `commands::files::search_logs`'s
/// `SEARCH_CHUNK_SIZE` so both raw-line scan paths behave consistently.
const MCP_SCAN_CHUNK_SIZE: usize = 10_000;

/// Hard cap on total lines scanned across all chunks for a single request.
/// Without this, a rarely-matching regex/filter over a 20M-line bugreport
/// would scan the entire file on every call — chunking alone stops it from
/// starving other lock holders, but the request could still run for a very
/// long time. Callers that need to see past the cap can page with
/// `start_line`/`end_line`.
const MCP_SCAN_LINE_CAP: usize = 500_000;

/// True if `[range_start, range_end)` is wider than `scan_cap` — i.e. the
/// scan window had to be capped down. Pure so the truncation math is unit
/// testable without a live session/lock.
fn scan_window_capped(range_start: usize, range_end: usize, scan_cap: usize) -> bool {
    range_end.saturating_sub(range_start) > scan_cap
}

/// The effective (possibly capped) end of a scan window starting at
/// `range_start`, given the caller-requested `range_end` and `scan_cap`.
/// Equal to `range_end` when the window already fits under the cap.
fn capped_range_end(range_start: usize, range_end: usize, scan_cap: usize) -> usize {
    range_start.saturating_add(scan_cap).min(range_end)
}

/// Split `[start, end)` into consecutive `[chunk_start, chunk_end)` windows
/// of at most `chunk_size` lines each, in ascending order. Pure — used to
/// scan under short-lived `sessions` lock acquisitions (one per window)
/// instead of holding the lock for a single large scan.
fn scan_chunk_bounds(start: usize, end: usize, chunk_size: usize) -> Vec<(usize, usize)> {
    if start >= end || chunk_size == 0 {
        return Vec::new();
    }
    let mut bounds = Vec::new();
    let mut cur = start;
    while cur < end {
        let next = (cur + chunk_size).min(end);
        bounds.push((cur, next));
        cur = next;
    }
    bounds
}

/// Concrete handle type — Wry is the only desktop runtime Tauri ships.
type Handle = AppHandle<Wry>;

// ---------------------------------------------------------------------------
// Entry point (spawned as a tokio task from lib.rs setup)
// ---------------------------------------------------------------------------

/// Middleware: stamp `mcp_last_activity` on every inbound request.
async fn record_activity(
    State(handle): State<Handle>,
    req: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    let state = handle.state::<AppState>();
    if let Ok(mut ts) = state.mcp_last_activity.lock() {
        *ts = Some(std::time::Instant::now());
    }
    next.run(req).await
}

/// Pure decision function: is this request trustworthy as a local, non-browser
/// caller of the MCP bridge? Used by [`require_local`] and unit-tested directly.
///
/// Three independent checks, any failure rejects:
/// - **Host** must be exactly `127.0.0.1:40404` or `localhost:40404`
///   (case-insensitive). A DNS-rebinding attacker's page is served from an
///   attacker-controlled domain that resolves to 127.0.0.1 *after* the
///   browser's same-origin check passes, but the HTTP `Host` header still
///   carries that attacker domain — rejecting anything but the bridge's own
///   host:port defeats the rebind regardless of what IP the request lands on.
/// - **Origin** must be absent. The MCP server's Node `fetch()` never sets
///   Origin (no browser fetch semantics); browsers add it automatically on
///   cross-origin requests (and on many same-origin ones), so any Origin at
///   all is a signal the caller is a browser, not the trusted Node client.
/// - **Referer**, if present, must start with the bridge's own origin. The
///   trusted client never sends Referer; a browser-issued CSRF request
///   typically carries the attacker page's URL here.
fn is_trusted_request(headers: &axum::http::HeaderMap) -> bool {
    const HOST_127: &str = "127.0.0.1:40404";
    const HOST_LOCALHOST: &str = "localhost:40404";
    const REFERER_127: &str = "http://127.0.0.1:40404";
    const REFERER_LOCALHOST: &str = "http://localhost:40404";
    const REFERER_127_SLASH: &str = "http://127.0.0.1:40404/";
    const REFERER_LOCALHOST_SLASH: &str = "http://localhost:40404/";

    // Host: required, must match exactly (case-insensitive).
    let host_ok = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|h| {
            let h = h.to_ascii_lowercase();
            h == HOST_127 || h == HOST_LOCALHOST
        });
    if !host_ok {
        return false;
    }

    // Origin: must be absent entirely.
    if headers.contains_key(axum::http::header::ORIGIN) {
        return false;
    }

    // Referer: if present, must be the bridge's own origin, matched with an
    // exact end-of-string or `/` boundary — NOT a bare prefix. A plain
    // `starts_with(origin)` would accept `http://127.0.0.1:40404.evil.com/x`
    // and `http://127.0.0.1:40404@evil.com/x`, both of which target a
    // different host despite sharing the origin as a string prefix.
    if let Some(referer) = headers.get(axum::http::header::REFERER).and_then(|v| v.to_str().ok()) {
        let referer_ok = referer == REFERER_127
            || referer == REFERER_LOCALHOST
            || referer.starts_with(REFERER_127_SLASH)
            || referer.starts_with(REFERER_LOCALHOST_SLASH);
        if !referer_ok {
            return false;
        }
    }

    true
}

/// Middleware: reject any request that does not look like it came from the
/// trusted local MCP server process. See [`is_trusted_request`] for the
/// decision logic. Runs BEFORE [`record_activity`] in the layer stack (see
/// `start()`) so rejected requests never stamp `mcp_last_activity`.
async fn require_local(
    State(_handle): State<Handle>,
    req: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    if !is_trusted_request(req.headers()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

pub async fn start(handle: Handle, shutdown_rx: tokio::sync::oneshot::Receiver<()>) {
    // Clone handle for the router state; keep original for the port flag.
    let router = Router::new()
        .route("/mcp/status", get(h_status))
        .route("/mcp/open_file", post(h_open_file))
        .route("/mcp/sessions", get(h_sessions))
        .route("/mcp/sessions/{session_id}/close", post(h_close_session))
        .route("/mcp/sessions/{session_id}/query", get(h_query))
        .route("/mcp/sessions/{session_id}/pipeline", get(h_pipeline))
        .route("/mcp/sessions/{session_id}/events", get(h_events))
        .route("/mcp/sessions/{session_id}/correlations", get(h_correlations))
        .route("/mcp/sessions/{session_id}/processor/{processor_id}", get(h_processor_detail))
        .route("/mcp/sessions/{session_id}/tracker/{tracker_id}/state_at", get(h_state_at_line))
        .route("/mcp/sessions/{session_id}/search", get(h_search))
        .route("/mcp/sessions/{session_id}/metadata", get(h_metadata))
        .route("/mcp/sessions/{session_id}/sections", get(h_sections))
        .route("/mcp/sessions/{session_id}/section_at", get(h_section_at))
        .route("/mcp/sessions/{session_id}/tag-stats", get(h_tag_stats))
        .route("/mcp/sessions/{session_id}/lines_around", get(h_lines_around))
        .route("/mcp/sessions/{session_id}/search_with_context", get(h_search_with_context))
        .route("/mcp/processors", get(h_processor_defs_list))
        .route("/mcp/processors/{processor_id}", get(h_processor_defs_single))
        // Phase 2 — Bookmarks
        .route("/mcp/sessions/{session_id}/bookmarks", get(h_list_bookmarks).post(h_create_bookmark))
        .route("/mcp/sessions/{session_id}/bookmarks/{bookmark_id}", delete(h_delete_bookmark).put(h_update_bookmark))
        // Phase 2 — Analysis artifacts
        .route("/mcp/sessions/{session_id}/analyses", get(h_list_analyses).post(h_publish_analysis))
        .route("/mcp/sessions/{session_id}/analyses/{artifact_id}", get(h_get_analysis).put(h_update_analysis).delete(h_delete_analysis))
        // Phase 3 — Insights
        .route("/mcp/sessions/{session_id}/insights", get(h_insights))
        // Pipeline run trigger (MCP)
        .route("/mcp/sessions/{session_id}/run_pipeline", post(h_run_pipeline))
        // Phase 4 — Watches
        .route("/mcp/sessions/{session_id}/watches", get(h_list_watches).post(h_create_watch))
        .route("/mcp/sessions/{session_id}/watches/{watch_id}", delete(h_cancel_watch))
        .layer(middleware::from_fn_with_state(handle.clone(), record_activity))
        // `require_local` is added AFTER `record_activity`, which in axum/tower
        // layering means it becomes the OUTERMOST layer and therefore runs
        // FIRST on every inbound request (layers wrap inside-out in the order
        // they're added; the last `.layer()` call is the outermost wrapper).
        // That ordering is required here: a rejected (non-local) request must
        // be turned away by `require_local` before `record_activity` ever
        // sees it, so untrusted traffic cannot stamp `mcp_last_activity`.
        .layer(middleware::from_fn_with_state(handle.clone(), require_local))
        .with_state(handle.clone());

    match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(listener) => {
            // Record that the bridge is running so the frontend can show status.
            let state = handle.state::<AppState>();
            if let Ok(mut p) = state.mcp_bridge_port.lock() {
                *p = Some(PORT);
            }
            #[allow(clippy::drop_non_drop)]
            drop(state);
            log::info!("MCP bridge listening on 127.0.0.1:{PORT}");
            let graceful = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                });
            if let Err(e) = graceful.await {
                log::error!("MCP bridge error: {e}");
            }
            // Clear the port flag so the frontend knows the bridge is no longer running.
            let state = handle.state::<AppState>();
            if let Ok(mut p) = state.mcp_bridge_port.lock() {
                *p = None;
            }
            // Clear the shutdown sender so start_mcp_bridge can restart cleanly.
            if let Ok(mut s) = state.mcp_bridge_shutdown.lock() {
                s.take();
            }
            log::info!("MCP bridge stopped");
        }
        Err(e) => {
            log::error!(
                "MCP bridge: cannot bind to 127.0.0.1:{PORT} — {e}. \
                 Is another instance running?"
            );
            // Clear the shutdown sender on bind failure too, so the bridge can be restarted.
            if let Ok(mut s) = handle.state::<AppState>().mcp_bridge_shutdown.lock() {
                s.take();
            };
        }
    }
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
fn parse_iso_to_unix_nanos(s: &str) -> Option<i64> {
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

/// Truncate a string to at most `max_chars` characters, appending "..." if cut.
/// Uses char boundaries to avoid splitting multi-byte UTF-8 sequences.
fn truncate_str(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let end = s.char_indices()
            .nth(max_chars)
            .map_or(s.len(), |(i, _)| i);
        let mut t = s[..end].to_string();
        t.push_str("...");
        t
    }
}

/// Truncate large map vars: for any Value::Object with >20 keys where values
/// are numeric, sort by value desc, keep top 20, add _truncated and _totalKeys.
fn truncate_var_maps(vars: &HashMap<String, Value>) -> serde_json::Map<String, Value> {
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

/// Resolve multiple line numbers to raw, **un-anonymized, un-truncated**
/// text, returning a map of line_num -> text. Must be called while holding
/// the `sessions` lock (it borrows the locked map directly).
///
/// Callers MUST pipe the result through [`anonymize_line_texts`] — dropping
/// the `sessions` lock first — before it reaches a JSON response. This
/// function on its own does not honor the session's `mcp_anonymize` flag;
/// serving its output directly is the Tier-2 raw-line-leak bug this pair of
/// functions fixes (see `anonymize_for_session`'s doc comment for why the
/// gate exists).
fn resolve_line_texts(
    sessions: &HashMap<String, crate::core::session::AnalysisSession>,
    session_id: &str,
    line_nums: &[usize],
) -> HashMap<usize, String> {
    let mut map = HashMap::new();
    if let Some(session) = sessions.get(session_id) {
        if let Some(source) = session.primary_source() {
            for &ln in line_nums {
                if let Some(raw) = source.raw_line(ln) {
                    map.insert(ln, raw.into_owned());
                }
            }
        }
    }
    map
}

/// Anonymize and truncate a map of line_num -> raw text produced by
/// [`resolve_line_texts`], honoring the session's per-session `mcp_anonymize`
/// flag via [`anonymize_for_session`].
///
/// Must be called AFTER the `sessions` lock used by `resolve_line_texts` has
/// been dropped: `anonymize_for_session` acquires `mcp_anonymize` /
/// `anonymizer_config` / `mcp_anonymizers`, and nesting those under
/// `sessions` violates this file's lock-ordering rule (see the module header
/// docs and the "Lock-poisoning helpers" section above).
///
/// Truncation (500 chars, matching `resolve_line_texts`'s historical
/// behavior) is applied AFTER anonymization so a redaction token is never
/// cut mid-token by the length cap.
fn anonymize_line_texts(
    state: &AppState,
    session_id: &str,
    raw: HashMap<usize, String>,
) -> HashMap<usize, String> {
    raw.into_iter()
        .map(|(ln, text)| {
            let anonymized = anonymize_for_session(state, session_id, &text);
            (ln, truncate_str(&anonymized, 500))
        })
        .collect()
}

/// Anonymize + truncate a single raw line's text for MCP scan-result output,
/// honoring the session's per-session `mcp_anonymize` flag via
/// [`anonymize_for_session`]. Truncation is applied AFTER anonymization (same
/// ordering rationale as [`anonymize_line_texts`]) so a redaction token is
/// never cut mid-token by the length cap.
///
/// Shared by `h_search` (matched line + context_before/context_after),
/// `h_search_with_context` (context lines), and `h_lines_around` (each
/// returned line) — all three call this AFTER the `sessions` lock used to
/// collect the raw text has been dropped, mirroring the `resolve_line_texts`
/// / `anonymize_line_texts` split above. Factored out as a pure function (no
/// locking beyond what `anonymize_for_session` itself does) so the
/// transformation is unit-testable without a live Tauri `AppHandle`.
fn anonymize_scan_line(state: &AppState, session_id: &str, raw: &str, max_chars: usize) -> String {
    let clean = anonymize_for_session(state, session_id, raw);
    truncate_str(&clean, max_chars)
}

// ---------------------------------------------------------------------------
// GET /mcp/status
// ---------------------------------------------------------------------------

async fn h_status(State(handle): State<Handle>) -> Json<Value> {
    let state = handle.state::<AppState>();

    let session_ids: Vec<String> = {
        let sessions = lock_or_json_err!(state.sessions, "sessions");
        sessions.keys().cloned().collect()
    };

    let processor_ids: Vec<String> = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        procs.keys().cloned().collect()
    };

    Json(json!({
        "running": true,
        "port": PORT,
        "sessionCount": session_ids.len(),
        "sessionIds": session_ids,
        "installedProcessors": processor_ids.len(),
    }))
}

/// Build a JSON error response with a stable machine-readable `code` for MCP
/// clients. Shared by the write-style handlers (`h_open_file`,
/// `h_close_session`) so every error body has the same `{ error, code }` shape.
fn err(status: StatusCode, message: impl Into<String>, code: &str) -> Response {
    (status, Json(json!({ "error": message.into(), "code": code }))).into_response()
}

// ---------------------------------------------------------------------------
// POST /mcp/open_file   { "path": "C:\\logs\\device.log" }
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct OpenFileBody {
    /// Absolute local path to open. Must resolve inside the configured
    /// `mcp_open_allowlist`, or match an already-open session.
    path: String,
    /// Optional source-type override, replacing content detection for this
    /// session. See [`crate::core::session::SourceType::from_label`] for the
    /// accepted labels.
    #[serde(default, rename = "sourceType")]
    source_type: Option<String>,
}

/// Open a log file as a session on behalf of an MCP client, gated by the
/// `mcp_open_allowlist` allowlist.
///
/// Reuses [`crate::commands::files::open_file_inner`] — the SAME writer the Tauri
/// UI uses — so the stored `file_path`, the derived session id, the emitted
/// events, and the background indexer are all identical to a UI-driven open. The
/// file is opened with its CANONICAL path so the stored id is stable regardless
/// of the spelling the client sent (reopening the same file is therefore
/// idempotent — same session id, one registry entry).
///
/// Error contract (see [`crate::commands::bridge_access::OpenAccessError`]):
/// - `NotAllowed` → HTTP 403 `{ "error": "path is not allowed", "code": "NOT_ALLOWED" }`.
///   Deliberately identical whether the path is outside the allowlist OR does not
///   exist — a client must not be able to probe the filesystem for files it isn't
///   allowed to open. Do not branch the message or status on which case it is.
/// - `InvalidPath(msg)` → HTTP 400 `{ "error": msg, "code": "INVALID_PATH" }` for
///   malformed input (relative / UNC / verbatim / device / ADS paths), rejected
///   before any filesystem access.
async fn h_open_file(
    State(handle): State<Handle>,
    Json(body): Json<OpenFileBody>,
) -> Response {
    use crate::commands::bridge_access::{OpenAccessError, canonical_compare_form, validate_open_path};

    let state = handle.state::<AppState>();

    // Allowlist: lock, clone both fields, drop.
    let (allowed, allow_all): (Vec<String>, bool) = {
        let cfg = state.mcp_open_allowlist.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        (cfg.allowed_dirs.clone(), cfg.allow_all)
    };

    // Canonical paths of already-open file-backed sessions (auto-permit reopen).
    // Skip streams (file_path=None) and any path that no longer canonicalizes.
    // The sessions lock is released at the end of this block — it is NEVER held
    // across the open call below.
    let open_paths: Vec<String> = {
        let sessions = lock_or_err_response!(state.sessions, "sessions");
        sessions
            .values()
            .filter_map(|s| s.file_path.as_deref())
            .filter_map(|p| canonical_compare_form(std::path::Path::new(p)))
            .collect()
    };

    match validate_open_path(&allowed, &open_paths, &body.path, allow_all) {
        Err(OpenAccessError::NotAllowed) => {
            err(StatusCode::FORBIDDEN, "path is not allowed", "NOT_ALLOWED")
        }
        Err(OpenAccessError::InvalidPath(msg)) => {
            err(StatusCode::BAD_REQUEST, msg, "INVALID_PATH")
        }
        Ok(canonical) => {
            // Validate the override before opening. An unknown label is a client
            // error, not something to silently ignore — falling back to detection
            // would defeat the whole point of supplying it.
            let source_type_override = match body.source_type.as_deref() {
                None => None,
                Some(label) => match crate::core::session::SourceType::from_label(label) {
                    Some(t) => Some(t),
                    None => {
                        return err(
                            StatusCode::BAD_REQUEST,
                            format!(
                                "unknown sourceType '{label}'; expected one of: {}",
                                crate::core::session::SourceType::labels().join(", ")
                            ),
                            "INVALID_SOURCE_TYPE",
                        );
                    }
                },
            };
            let canonical_str = canonical.to_string_lossy().to_string();
            match crate::commands::files::open_file_inner(
                &state,
                &handle,
                &canonical_str,
                source_type_override,
            ) {
                Ok(results) => match results.first() {
                    Some(first) => {
                        // Notify the frontend so it creates a logviewer tab for this
                        // already-loaded session — the symmetric half of `session-closed`.
                        // Emitted HERE, from the handler, NOT from `open_file_inner`: the
                        // UI-initiated open path already builds its own tab and must stay
                        // behavior-unchanged; a bridge-initiated open is otherwise invisible
                        // to the frontend unless the bridge tells it. The payload is the full
                        // LoadResult (camelCase) so the frontend can reuse its normal
                        // post-load tab logic against an already-loaded session. Reopening the
                        // same file re-fires this with the SAME (deterministic) sessionId — the
                        // frontend listener is idempotent and will not spawn a duplicate tab.
                        let _ = handle.emit("session-opened", first);
                        Json(json!({
                            "sessionId": first.session_id,
                            "sourceType": first.source_type,
                            "totalLines": first.total_lines,
                            "isIndexing": first.is_indexing,
                        }))
                        .into_response()
                    }
                    None => err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "open produced no session",
                        "OPEN_FAILED",
                    ),
                },
                Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e, "OPEN_FAILED"),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/close
// ---------------------------------------------------------------------------

/// Close a session on behalf of an MCP client. ALWAYS closes (never refuses
/// because the session is displayed): purges every session-keyed map and drops
/// the file's memory map via [`crate::commands::files::close_session_inner`] — the
/// SAME cleanup the Tauri UI close path runs — then notifies the frontend so any
/// pane/tab bound to the session is closed.
///
/// The `session-closed` Tauri event is emitted HERE, not from `close_session_inner`.
/// The UI close path is user-initiated (the user already sees their own tab go
/// away) and must stay behavior-unchanged; a bridge-initiated close, by contrast,
/// is invisible to the frontend unless the bridge tells it. Emitting only on this
/// path keeps the two paths cleanly separated.
///
/// Error contract:
/// - Unknown session id → HTTP 404 `{ "error": "session not found", "code": "NOT_FOUND" }`.
///   The existence check runs under a short-lived `sessions` lock that is dropped
///   before `close_session_inner` re-acquires it (no lock held across the close).
async fn h_close_session(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
) -> Response {
    let state = handle.state::<AppState>();

    // Existence check under a short-lived lock; drop it before closing.
    {
        let sessions = lock_or_err_response!(state.sessions, "sessions");
        if !sessions.contains_key(&session_id) {
            return err(StatusCode::NOT_FOUND, "session not found", "NOT_FOUND");
        }
    }

    if let Err(e) = crate::commands::files::close_session_inner(&state, Some(&handle), &session_id) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e, "CLOSE_FAILED");
    }

    // Notify the frontend so it closes any pane/tab bound to this session.
    let _ = handle.emit("session-closed", json!({ "sessionId": session_id }));

    Json(json!({ "closed": true, "sessionId": session_id })).into_response()
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions
// ---------------------------------------------------------------------------

async fn h_sessions(State(handle): State<Handle>) -> Json<Value> {
    let state = handle.state::<AppState>();

    // Collect session info without holding the lock into the JSON builder.
    let sessions_info: Vec<Value> = {
        let sessions = lock_or_json_err!(state.sessions, "sessions");
        sessions
            .values()
            .map(|session| {
                let sources: Vec<Value> = if let Some(src) = session.primary_source() {
                    vec![json!({
                        "id": src.id(),
                        "name": src.name(),
                        "sourceType": src.source_type().to_string(),
                        "totalLines": src.total_lines(),
                    })]
                } else {
                    vec![]
                };
                json!({
                    "id": session.id,
                    "sources": sources,
                })
            })
            .collect()
    };

    // Processor IDs that have pipeline results for any session.
    let processors_with_results: Vec<String> = {
        let results = lock_or_json_err!(state.pipeline_results, "pipeline_results");
        let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for session_map in results.values() {
            ids.extend(session_map.keys().cloned());
        }
        ids.into_iter().collect()
    };

    // Installed processors (id + name + type).
    let installed: Vec<Value> = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        procs
            .values()
            .map(|p| {
                json!({
                    "id": p.meta.id,
                    "name": p.meta.name,
                    "processorType": p.processor_type(),
                })
            })
            .collect()
    };

    Json(json!({
        "sessions": sessions_info,
        "processorsWithResults": processors_with_results,
        "installedProcessors": installed,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/query
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct QueryParams {
    /// Number of lines to return (default 50, max 200).
    n: Option<usize>,
    /// Sampling strategy: "uniform" | "recent" | "around" (default "recent").
    strategy: Option<String>,
    /// Center line number for the "around" strategy.
    around_line: Option<usize>,
    /// Minimum log level filter: V D I W E F (first char compared).
    level: Option<String>,
    /// Exact tag filter.
    tag: Option<String>,
    /// Substring filter applied to the raw line.
    message: Option<String>,
    /// Restrict results to lines >= start_line (0-based, inclusive).
    start_line: Option<usize>,
    /// Restrict results to lines < end_line (0-based, exclusive).
    end_line: Option<usize>,
    /// Filter to lines with timestamp >= this value (ISO 8601, e.g. "2024-01-15T10:30:00").
    time_start: Option<String>,
    /// Filter to lines with timestamp <= this value (ISO 8601, e.g. "2024-01-15T11:00:00").
    time_end: Option<String>,
}

async fn h_query(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<QueryParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let n = params.n.unwrap_or(50).min(200);
    let strategy = params.strategy.as_deref().unwrap_or("recent");

    // Parse time range filters upfront (ISO 8601 → Unix-epoch nanos, same
    // epoch as meta.timestamp for logcat/bugreport lines)
    let time_start_ns = params.time_start.as_deref().and_then(parse_iso_to_unix_nanos);
    let time_end_ns = params.time_end.as_deref().and_then(parse_iso_to_unix_nanos);

    // Snapshot the lines we need without holding the lock into async territory.
    struct LineSnap {
        line_num: usize,
        level: &'static str,   // e.g. "Info", "Error"
        tag: String,
        raw: String,
    }

    let (snaps, total_lines): (Vec<LineSnap>, usize) = {
        get_session_and_source!(state, session_id => sessions, session, source);

        let total = source.total_lines();

        // Clamp sample range to [start_line, end_line)
        let range_start = params.start_line.unwrap_or(0).min(total);
        let range_end = params.end_line.unwrap_or(total).min(total);
        let clamped_total = range_end.saturating_sub(range_start);

        let indices = if params.start_line.is_some() || params.end_line.is_some() {
            // Apply range clamping to sample_indices
            sample_indices(clamped_total, n, strategy, params.around_line.map(|a| a.saturating_sub(range_start)))
                .into_iter()
                .map(|i| i + range_start)
                .collect()
        } else {
            sample_indices(total, n, strategy, params.around_line)
        };

        let snaps = indices
            .into_iter()
            .filter_map(|i| {
                let raw = source.raw_line(i)?.into_owned();
                let meta = source.meta_at(i)?;
                Some(LineSnap {
                    line_num: i,
                    level: meta.level.as_str(),
                    tag: session.resolve_tag(meta.tag_id).to_string(),
                    raw,
                })
            })
            .collect();

        (snaps, total)
    };

    // If any filter is active, scanning a fixed sample produces poor results for
    // rare events in large logs.  Instead, scan lines (up to MCP_SCAN_LINE_CAP)
    // and collect up to `n` matches.  The "strategy" still controls scan
    // direction:
    //   recent   → scan newest→oldest (stop after n matches)
    //   around   → scan outward from around_line (stop after n matches)
    //   uniform  → scan in order, then space the matches evenly
    let has_filter = params.tag.is_some() || params.message.is_some()
        || params.level.is_some() || time_start_ns.is_some() || time_end_ns.is_some();

    let mut query_lines_scanned: usize = 0;
    let mut query_truncated = false;

    let snaps = if has_filter {
        // Clamp scan range to [start_line, end_line) — pure arithmetic
        // against the `total_lines` snapshot captured above, no lock needed.
        let range_start = params.start_line.unwrap_or(0).min(total_lines);
        let range_end = params.end_line.unwrap_or(total_lines).min(total_lines);
        let cap_applied = scan_window_capped(range_start, range_end, MCP_SCAN_LINE_CAP);

        // Build the scan order based on strategy (clamped to range AND to
        // MCP_SCAN_LINE_CAP — without the cap, "uniform" in particular would
        // materialize one usize per line for the whole session).
        let scan_indices: Vec<usize> = match strategy {
            "recent" => {
                let start = range_start.max(range_end.saturating_sub(MCP_SCAN_LINE_CAP));
                (start..range_end).rev().collect()
            }
            "around" => {
                let center = params.around_line.unwrap_or_else(|| range_end.saturating_sub(1))
                    .clamp(range_start, range_end.saturating_sub(1));
                let half = MCP_SCAN_LINE_CAP / 2;
                let start = center.saturating_sub(half).max(range_start);
                let end = (center + half).min(range_end);
                // Interleave outward from center: center, center-1, center+1, …
                (start..=center).rev().zip(((center + 1)..end).map(Some).chain(std::iter::repeat(None)))
                    .flat_map(|(b, a)| std::iter::once(b).chain(a))
                    .collect()
            }
            _ => {
                // uniform: scan lines in order (capped) so rare events aren't missed
                let end = capped_range_end(range_start, range_end, MCP_SCAN_LINE_CAP);
                (range_start..end).collect()
            }
        };

        let msg_needle = params.message.as_ref().map(|m| m.to_lowercase());
        let mut matched: Vec<LineSnap> = Vec::new();
        let mut session_lost = false;

        // Scan the (already-capped) index list in fixed-size batches,
        // dropping and re-acquiring `sessions` between batches (see the
        // "Chunked scan helpers" section above). Indices may be
        // non-contiguous — the "around" strategy interleaves forward and
        // backward — so we chunk the materialized Vec rather than a range.
        'chunks: for idx_chunk in scan_indices.chunks(MCP_SCAN_CHUNK_SIZE) {
            if matched.len() >= n { break; }

            {
                let sessions = lock_or_json_err!(state.sessions, "sessions");
                let Some(session) = sessions.get(&session_id) else {
                    session_lost = true;
                    break 'chunks;
                };
                let Some(source) = session.primary_source() else {
                    session_lost = true;
                    break 'chunks;
                };

                for &i in idx_chunk {
                    if matched.len() >= n { break; }
                    query_lines_scanned += 1;
                    let Some(raw) = source.raw_line(i) else { continue };
                    let Some(meta) = source.meta_at(i) else { continue };
                    let level_str = meta.level.as_str();
                    // Tag filter
                    if let Some(ref tf) = params.tag {
                        if session.resolve_tag(meta.tag_id) != tf { continue; }
                    }
                    // Message filter (case-insensitive)
                    if let Some(ref needle) = msg_needle {
                        if !raw.to_lowercase().contains(needle.as_str()) { continue; }
                    }
                    // Level filter
                    if let Some(ref lf) = params.level {
                        if !level_at_least(level_str, lf) { continue; }
                    }
                    // Time range filter
                    if let Some(ts) = time_start_ns {
                        if meta.timestamp < ts { continue; }
                    }
                    if let Some(ts) = time_end_ns {
                        if meta.timestamp > ts { continue; }
                    }
                    matched.push(LineSnap { line_num: i, level: level_str, tag: session.resolve_tag(meta.tag_id).to_string(), raw: raw.into_owned() });
                }
            } // sessions lock dropped here, before the yield below

            tokio::task::yield_now().await;
        }
        // For "recent" we scanned newest→oldest; restore chronological order.
        if strategy == "recent" { matched.reverse(); }

        query_truncated = session_lost || (cap_applied && matched.len() < n);
        matched
    } else {
        snaps
    };

    // Build JSON output.
    // ── PII anonymization applied inline ────────────────────────────────────
    // Per-session flag (signalled via set_mcp_anonymize, fails closed for an
    // unknown session) — see `resolve_should_anonymize` / `anonymize_for_session`.
    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    let mut level_counts: HashMap<&str, usize> = HashMap::new();

    let lines: Vec<Value> = snaps
        .into_iter()
        .map(|snap| {
            *tag_counts.entry(snap.tag.clone()).or_insert(0) += 1;
            *level_counts.entry(snap.level).or_insert(0) += 1;
            let raw = anonymize_for_session(&state, &session_id, &snap.raw);
            json!({
                "lineNum": snap.line_num,
                "level": snap.level,
                "tag": snap.tag,
                "raw": raw,
            })
        })
        .collect();

    let count = lines.len();
    let mut result = json!({
        "sessionId": session_id,
        "totalLinesInSession": total_lines,
        "sampledCount": count,
        "strategy": strategy,
        "lines": lines,
        "stats": {
            "tagCounts": tag_counts,
            "levelCounts": level_counts,
        },
    });
    if has_filter {
        result["strategyNote"] = json!(format!(
            "Filters active — switched to full scan mode using '{}' ordering (scan capped at {} lines)",
            strategy, MCP_SCAN_LINE_CAP
        ));
        // Additive fields — see "Chunked scan helpers" module docs. Present
        // only on the filtered/scan path; the plain-sample path above never
        // scans, so there is nothing meaningful to report.
        result["scannedLines"] = json!(query_lines_scanned);
        result["truncated"] = json!(query_truncated);
    }
    Json(result)
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/pipeline
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PipelineParams {
    /// Filter to a single processor by ID.
    processor_id: Option<String>,
}

async fn h_pipeline(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<PipelineParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();

    // --- Phase 1: Clone pipeline results and processor metadata ---
    struct ReporterSnap {
        proc_id: String,
        name: String,
        description: String,
        matched_line_count: usize,
        sample_line_nums: Vec<usize>,
        emission_count: usize,
        recent_emissions: Vec<Value>,
        vars: HashMap<String, Value>,
    }

    struct TrackerSnap {
        tracker_id: String,
        name: String,
        description: String,
        transition_count: usize,
        final_state: Value,
        recent_transitions: Vec<StateTransition>,
    }

    // Collect reporter data (clone out of lock)
    let reporter_snaps: Vec<ReporterSnap> = {
        let results = lock_or_json_err!(state.pipeline_results, "pipeline_results");
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match results.get(&session_id) {
            None => vec![],
            Some(session_map) => session_map
                .iter()
                .filter(|(pid, _)| processor_id_matches(pid, params.processor_id.as_ref()))
                .map(|(proc_id, run_result)| {
                    let proc = procs.get(proc_id);
                    let name = proc.map_or_else(|| proc_id.clone(), |p| p.meta.name.clone());
                    let description = proc.map(|p| p.meta.description.clone()).unwrap_or_default();

                    // Last 10 emissions, serialized
                    let recent_emissions: Vec<Value> = run_result.emissions.iter().rev().take(10)
                        .map(|e| serde_json::to_value(e).unwrap_or(json!(null)))
                        .collect();

                    // First 5 matched line nums for sample
                    let matched_sample: Vec<usize> = run_result.matched_line_nums.iter().take(5).copied().collect();

                    ReporterSnap {
                        proc_id: proc_id.clone(),
                        name,
                        description,
                        matched_line_count: run_result.matched_line_nums.len(),
                        sample_line_nums: matched_sample,
                        emission_count: run_result.emissions.len(),
                        recent_emissions,
                        vars: run_result.vars.clone(),
                    }
                })
                .collect(),
        }
    };

    // Collect tracker data (clone out of lock)
    let tracker_snaps: Vec<TrackerSnap> = {
        let pipeline_res = lock_or_json_err!(state.state_tracker_results, "state_tracker_results");
        let stream_res = lock_or_json_err!(state.stream_tracker_state, "stream_tracker_state");
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

        let from_pipeline = pipeline_res.get(&session_id);
        let from_stream = stream_res.get(&session_id);

        if from_pipeline.is_none() && from_stream.is_none() {
            vec![]
        } else {
            let mut tracker_ids: Vec<String> = from_pipeline
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            if let Some(sm) = from_stream {
                for id in sm.keys() {
                    if !tracker_ids.contains(id) { tracker_ids.push(id.clone()); }
                }
            }
            tracker_ids.into_iter()
                .filter(|tid| processor_id_matches(tid, params.processor_id.as_ref()))
                .map(|tracker_id| {
                    let proc = procs.get(&tracker_id);
                    let name = proc.map_or_else(|| tracker_id.clone(), |p| p.meta.name.clone());
                    let description = proc.map(|p| p.meta.description.clone()).unwrap_or_default();

                    let (transitions, final_state): (&[StateTransition], Value) =
                        if let Some(pr) = from_pipeline.and_then(|m| m.get(&tracker_id)) {
                            (pr.transitions.as_slice(), json!(pr.final_state))
                        } else if let Some(sr) = from_stream.and_then(|m| m.get(&tracker_id)) {
                            (sr.transitions.as_slice(), json!(sr.current_state))
                        } else {
                            (&[], json!({}))
                        };

                    // Last 20 transitions
                    let recent: Vec<StateTransition> = transitions.iter().rev().take(20).cloned().collect();

                    TrackerSnap {
                        tracker_id,
                        name,
                        description,
                        transition_count: transitions.len(),
                        final_state,
                        recent_transitions: recent,
                    }
                }).collect()
        }
    };

    // --- Phase 2: Resolve line text from sessions (separate lock), then
    // anonymize per the session's `mcp_anonymize` flag AFTER the `sessions`
    // lock is dropped (see `anonymize_line_texts` doc comment). ---
    let line_text_map: HashMap<usize, String> = {
        // Collect all line nums we need to resolve
        let mut needed: Vec<usize> = Vec::new();
        for snap in &reporter_snaps {
            needed.extend(&snap.sample_line_nums);
        }
        for snap in &tracker_snaps {
            for t in &snap.recent_transitions {
                needed.push(t.line_num);
            }
        }
        needed.sort_unstable();
        needed.dedup();

        let raw = {
            let sessions = lock_or_json_err!(state.sessions, "sessions");
            resolve_line_texts(&sessions, &session_id, &needed)
        };
        anonymize_line_texts(&state, &session_id, raw)
    };

    // --- Phase 3: Build JSON ---
    let reporter_results: Vec<Value> = reporter_snaps.into_iter().map(|snap| {
        let sample_lines: Vec<Value> = snap.sample_line_nums.iter().map(|&ln| {
            json!({
                "lineNum": ln,
                "rawLine": line_text_map.get(&ln).cloned().unwrap_or_default(),
            })
        }).collect();

        let vars = truncate_var_maps(&snap.vars);

        json!({
            "processorId": snap.proc_id,
            "processorType": "reporter",
            "name": snap.name,
            "description": snap.description,
            "matchedLines": snap.matched_line_count,
            "emissionCount": snap.emission_count,
            "recentEmissions": snap.recent_emissions,
            "sampleMatchedLines": sample_lines,
            "vars": vars,
        })
    }).collect();

    let tracker_results: Vec<Value> = tracker_snaps.into_iter().map(|snap| {
        let transitions: Vec<Value> = snap.recent_transitions.iter().map(|t| {
            json!({
                "lineNum": t.line_num,
                "transitionName": t.transition_name,
                "changes": t.changes,
                "rawLine": line_text_map.get(&t.line_num).cloned().unwrap_or_default(),
            })
        }).collect();

        json!({
            "processorId": snap.tracker_id,
            "processorType": "state_tracker",
            "name": snap.name,
            "description": snap.description,
            "transitionCount": snap.transition_count,
            "finalState": snap.final_state,
            "recentTransitions": transitions,
        })
    }).collect();

    let has_any = !reporter_results.is_empty() || !tracker_results.is_empty();
    Json(json!({
        "sessionId": session_id,
        "hasResults": has_any,
        "reporters": reporter_results,
        "stateTrackers": tracker_results,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/processor/{processor_id}
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ProcessorDetailParams {
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

async fn h_processor_detail(
    State(handle): State<Handle>,
    Path((session_id, processor_id)): Path<(String, String)>,
    Query(params): Query<ProcessorDetailParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let include_emissions = params.include_emissions.unwrap_or(false);
    let emission_limit = params.emission_limit.unwrap_or(50).min(200);
    let emission_offset = params.emission_offset.unwrap_or(0);
    let include_line_text = params.include_line_text.unwrap_or(false);

    // Resolve bare → qualified ID and check processor type in a single lock.
    let (resolved_id, processor_type) = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let resolved = resolve_processor_id(&procs, &processor_id)
            .unwrap_or_else(|| processor_id.clone());
        let ptype = procs.get(&resolved).map(|p| p.processor_type().to_string());
        (resolved, ptype)
    };

    match processor_type.as_deref() {
        Some("reporter") | None => {
            // Try reporter results (None processor_type means it might still have results)
            let result_data: Option<(RunResult, String, String)> = {
                let results = lock_or_json_err!(state.pipeline_results, "pipeline_results");
                let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                results.get(&session_id)
                    .and_then(|m| m.get(&resolved_id))
                    .map(|rr| {
                        let proc = procs.get(&resolved_id);
                        let name = proc.map_or_else(|| resolved_id.clone(), |p| p.meta.name.clone());
                        let desc = proc.map(|p| p.meta.description.clone()).unwrap_or_default();
                        (RunResult {
                            emissions: rr.emissions.clone(),
                            vars: rr.vars.clone(),
                            matched_line_nums: rr.matched_line_nums.clone(),
                            script_errors: rr.script_errors,
                            first_script_error: rr.first_script_error.clone(),
                        }, name, desc)
                    })
            };

            let Some((rr, name, description)) = result_data else {
                return Json(json!({ "error": "no results for this processor/session", "processorId": processor_id, "sessionId": session_id }));
            };

            // Collect line nums to resolve
            let mut needed_lines: Vec<usize> = Vec::new();
            if include_line_text {
                // First 100 matched lines
                needed_lines.extend(rr.matched_line_nums.iter().take(100));
                if include_emissions {
                    for e in rr.emissions.iter().skip(emission_offset).take(emission_limit) {
                        needed_lines.push(e.line_num);
                    }
                }
            }
            needed_lines.sort_unstable();
            needed_lines.dedup();

            let line_texts: HashMap<usize, String> = if include_line_text {
                let raw = {
                    let sessions = lock_or_json_err!(state.sessions, "sessions");
                    resolve_line_texts(&sessions, &session_id, &needed_lines)
                };
                anonymize_line_texts(&state, &session_id, raw)
            } else {
                HashMap::new()
            };

            // Build emissions
            let emissions_json: Value = if include_emissions {
                let page: Vec<Value> = rr.emissions.iter()
                    .skip(emission_offset)
                    .take(emission_limit)
                    .map(|e| {
                        let mut v = serde_json::to_value(e).unwrap_or(json!(null));
                        if include_line_text {
                            if let Some(text) = line_texts.get(&e.line_num) {
                                v.as_object_mut().map(|o| o.insert("rawLine".to_string(), json!(text)));
                            }
                        }
                        v
                    })
                    .collect();
                json!(page)
            } else {
                json!(null)
            };

            // Matched lines (first 100)
            let matched_lines: Vec<Value> = rr.matched_line_nums.iter().take(100).map(|&ln| {
                let mut entry = json!({ "lineNum": ln });
                if include_line_text {
                    if let Some(text) = line_texts.get(&ln) {
                        entry.as_object_mut().map(|o| o.insert("rawLine".to_string(), json!(text)));
                    }
                }
                entry
            }).collect();

            let vars = truncate_var_maps(&rr.vars);

            Json(json!({
                "processorId": processor_id,
                "sessionId": session_id,
                "processorType": "reporter",
                "name": name,
                "description": description,
                "matchedLineCount": rr.matched_line_nums.len(),
                "emissionCount": rr.emissions.len(),
                "vars": vars,
                "matchedLines": matched_lines,
                "emissions": emissions_json,
                "emissionOffset": emission_offset,
                "emissionLimit": emission_limit,
            }))
        }
        Some("state_tracker") => {
            // Resolve tracker data
            let tracker_data: Option<(Vec<StateTransition>, Value, String, String)> = {
                let pipeline_res = lock_or_json_err!(state.state_tracker_results, "state_tracker_results");
                let stream_res = lock_or_json_err!(state.stream_tracker_state, "stream_tracker_state");
                let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

                let proc = procs.get(&resolved_id);
                let name = proc.map_or_else(|| resolved_id.clone(), |p| p.meta.name.clone());
                let desc = proc.map(|p| p.meta.description.clone()).unwrap_or_default();

                let from_pipeline = pipeline_res.get(&session_id).and_then(|m| m.get(&resolved_id));
                let from_stream = stream_res.get(&session_id).and_then(|m| m.get(&resolved_id));

                if let Some(pr) = from_pipeline {
                    Some((pr.transitions.clone(), json!(pr.final_state), name, desc))
                } else {
                    from_stream.map(|sr| (sr.transitions.clone(), json!(sr.current_state), name, desc))
                }
            };

            let Some((transitions, final_state, name, description)) = tracker_data else {
                return Json(json!({ "error": "no tracker results for this processor/session", "processorId": processor_id, "sessionId": session_id }));
            };

            // Paginate transitions
            let page: Vec<StateTransition> = transitions.iter()
                .skip(emission_offset)
                .take(emission_limit)
                .cloned()
                .collect();

            // Resolve line text if requested
            let line_texts: HashMap<usize, String> = if include_line_text {
                let needed: Vec<usize> = page.iter().map(|t| t.line_num).collect();
                let raw = {
                    let sessions = lock_or_json_err!(state.sessions, "sessions");
                    resolve_line_texts(&sessions, &session_id, &needed)
                };
                anonymize_line_texts(&state, &session_id, raw)
            } else {
                HashMap::new()
            };

            let transitions_json: Vec<Value> = page.iter().map(|t| {
                let mut v = json!({
                    "lineNum": t.line_num,
                    "timestamp": t.timestamp,
                    "transitionName": t.transition_name,
                    "changes": t.changes,
                });
                if include_line_text {
                    if let Some(text) = line_texts.get(&t.line_num) {
                        v.as_object_mut().map(|o| o.insert("rawLine".to_string(), json!(text)));
                    }
                }
                v
            }).collect();

            Json(json!({
                "processorId": processor_id,
                "sessionId": session_id,
                "processorType": "state_tracker",
                "name": name,
                "description": description,
                "transitionCount": transitions.len(),
                "finalState": final_state,
                "transitions": transitions_json,
                "offset": emission_offset,
                "limit": emission_limit,
            }))
        }
        Some(other) => {
            Json(json!({ "error": format!("processor type '{other}' detail not supported"), "processorId": processor_id }))
        }
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/events
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct EventParams {
    /// Max transitions to return, most-recent first (default 50, max 200).
    limit: Option<usize>,
}

async fn h_events(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<EventParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let limit = params.limit.unwrap_or(50).min(200);

    let events: Vec<Value> = {
        let pipeline_res = lock_or_json_err!(state.state_tracker_results, "state_tracker_results");
        let stream_res   = lock_or_json_err!(state.stream_tracker_state, "stream_tracker_state");

        // Collect transitions from pipeline results first, then streaming state.
        // Both may coexist; streaming transitions use tracker_id as the key.
        let mut all: Vec<Value> = Vec::new();

        if let Some(session_map) = pipeline_res.get(&session_id) {
            for r in session_map.values() {
                for t in &r.transitions {
                    all.push(json!({
                        "trackerId": r.tracker_id,
                        "transitionName": t.transition_name,
                        "lineNum": t.line_num,
                        "timestamp": t.timestamp,
                        "changes": t.changes,
                    }));
                }
            }
        }

        if let Some(session_map) = stream_res.get(&session_id) {
            for (tracker_id, cont) in session_map {
                for t in &cont.transitions {
                    all.push(json!({
                        "trackerId": tracker_id,
                        "transitionName": t.transition_name,
                        "lineNum": t.line_num,
                        "timestamp": t.timestamp,
                        "changes": t.changes,
                    }));
                }
            }
        }

        all.sort_by(|a, b| b["lineNum"].as_u64().cmp(&a["lineNum"].as_u64()));
        all.into_iter().take(limit).collect()
    };

    let count = events.len();
    Json(json!({
        "sessionId": session_id,
        "events": events,
        "count": count,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/correlations
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CorrelationParams {
    /// Filter to a single correlator by ID.
    correlator_id: Option<String>,
    /// Max events to return (default 50, max 200).
    limit: Option<usize>,
    /// Offset for pagination (default 0).
    offset: Option<usize>,
}

async fn h_correlations(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<CorrelationParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);

    let correlators: Vec<Value> = {
        let cr = lock_or_json_err!(state.correlator_results, "correlator_results");
        match cr.get(&session_id) {
            None => vec![],
            Some(session_map) => session_map
                .iter()
                .filter(|(cid, _)| {
                    params.correlator_id.as_ref().map_or(true, |fid| fid == *cid)
                })
                .map(|(corr_id, result)| {
                    let events: Vec<Value> = result.events.iter()
                        .skip(offset)
                        .take(limit)
                        .map(|evt| {
                            json!({
                                "triggerLineNum": evt.trigger_line_num,
                                "triggerTimestamp": evt.trigger_timestamp,
                                "triggerSourceId": evt.trigger_source_id,
                                "triggerFields": evt.trigger_fields,
                                "message": evt.message,
                                "matchedSourceIds": evt.matched_sources.keys().collect::<Vec<_>>(),
                            })
                        }).collect();
                    json!({
                        "correlatorId": corr_id,
                        "totalEvents": result.events.len(),
                        "eventCount": events.len(),
                        "events": events,
                        "offset": offset,
                        "limit": limit,
                    })
                })
                .collect(),
        }
    };

    Json(json!({
        "sessionId": session_id,
        "correlators": correlators,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/tracker/{tracker_id}/state_at
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct StateAtParams {
    /// Line number to compute state at (required).
    line: usize,
}

async fn h_state_at_line(
    State(handle): State<Handle>,
    Path((session_id, tracker_id)): Path<(String, String)>,
    Query(params): Query<StateAtParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let line_num = params.line;

    // Resolve bare ID → qualified ID (e.g. "wifi-state" → "wifi-state@official")
    let resolved_id = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        resolve_processor_id(&procs, &tracker_id).unwrap_or_else(|| tracker_id.clone())
    };

    // Resolve transitions from pipeline or stream state. Deliberately two
    // plain blocks rather than `.or_else(|| { .. })` — `lock_or_json_err!`
    // expands to an early `return` on poison, which must return from this
    // handler, not from a closure.
    let from_pipeline: Option<Vec<StateTransition>> = {
        let pipeline_res = lock_or_json_err!(state.state_tracker_results, "state_tracker_results");
        pipeline_res.get(&session_id)
            .and_then(|session_map| session_map.get(&resolved_id))
            .map(|r| r.transitions.clone())
    };
    let transitions: Option<Vec<StateTransition>> = if from_pipeline.is_some() {
        from_pipeline
    } else {
        let stream_res = lock_or_json_err!(state.stream_tracker_state, "stream_tracker_state");
        stream_res.get(&session_id)
            .and_then(|m| m.get(&resolved_id))
            .map(|cont| cont.transitions.clone())
    };

    let Some(transitions) = transitions else {
        return Json(json!({
            "error": format!("no tracker results for session {session_id} / tracker {resolved_id}"),
        }));
    };

    // Replay transitions up to line_num against declared defaults
    let defaults: HashMap<String, serde_json::Value> = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match procs.get(&resolved_id).and_then(|p| p.as_state_tracker()) {
            Some(def) => build_defaults(def),
            None => HashMap::new(),
        }
    };

    let pos = transitions.partition_point(|t| t.line_num <= line_num);
    let mut fields = defaults;
    let mut initialized: Vec<String> = Vec::new();

    for t in &transitions[..pos] {
        for (field, change) in &t.changes {
            fields.insert(field.clone(), change.to.clone());
            if !initialized.contains(field) {
                initialized.push(field.clone());
            }
        }
    }

    let (snap_line, snap_ts) = if pos > 0 {
        let t = &transitions[pos - 1];
        (t.line_num, t.timestamp)
    } else {
        (0, 0)
    };

    Json(json!({
        "trackerId": resolved_id,
        "sessionId": session_id,
        "lineNum": snap_line,
        "timestamp": snap_ts,
        "fields": fields,
        "initializedFields": initialized,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/search
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SearchParams {
    /// Regex pattern to search for (required).
    pattern: String,
    /// Max results (default 50, max 200).
    limit: Option<usize>,
    /// Case insensitive search (default false).
    #[serde(default)]
    case_insensitive: Option<bool>,
    /// Context lines before and after each match (default 0, max 5).
    context: Option<usize>,
    /// Restrict search to lines >= start_line (0-based, inclusive).
    start_line: Option<usize>,
    /// Restrict search to lines < end_line (0-based, exclusive).
    end_line: Option<usize>,
}

async fn h_search(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<SearchParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let limit = params.limit.unwrap_or(50).min(200);
    let context = params.context.unwrap_or(0).min(5);
    let case_insensitive = params.case_insensitive.unwrap_or(false);

    // Compile the pattern
    let pattern_str = if case_insensitive {
        format!("(?i){}", params.pattern)
    } else {
        params.pattern.clone()
    };

    let regex = match regex::Regex::new(&pattern_str) {
        Ok(re) => re,
        Err(e) => {
            return Json(json!({
                "error": format!("invalid regex pattern: {e}"),
                "pattern": params.pattern,
            }));
        }
    };

    // Scan lines. Fields hold RAW (un-anonymized) text collected under the
    // `sessions` lock — anonymization happens afterward, once the lock is
    // dropped (see `anonymize_scan_line`), so `sessions` is never held across
    // the anonymizer's own locks.
    struct MatchResult {
        line_num: usize,
        raw: String,
        captures: Vec<String>,
        context_before: Vec<(usize, String)>,
        context_after: Vec<(usize, String)>,
    }

    // Resolve the scan window once — same error contract as before (unknown
    // session / no sources → early JSON error via the macro). Everything
    // after this drops the lock and re-acquires it per chunk (see the
    // "Chunked scan helpers" module docs): a rarely-matching regex must not
    // hold `sessions` for the whole scan.
    let total: usize = {
        get_session_and_source!(state, session_id => sessions, session, source);
        source.total_lines()
    };
    let range_start = params.start_line.unwrap_or(0).min(total);
    let requested_end = params.end_line.unwrap_or(total).min(total);
    let cap_applied = scan_window_capped(range_start, requested_end, MCP_SCAN_LINE_CAP);
    let range_end = capped_range_end(range_start, requested_end, MCP_SCAN_LINE_CAP);

    let mut results: Vec<MatchResult> = Vec::new();
    let mut lines_scanned: usize = 0;
    let mut session_lost = false;

    'chunks: for (chunk_start, chunk_end) in scan_chunk_bounds(range_start, range_end, MCP_SCAN_CHUNK_SIZE) {
        if results.len() >= limit { break; }

        { // `sessions` guard scope — dropped before the yield below.
            let sessions = lock_or_json_err!(state.sessions, "sessions");
            let Some(session) = sessions.get(&session_id) else {
                session_lost = true;
                break 'chunks;
            };
            let Some(source) = session.primary_source() else {
                session_lost = true;
                break 'chunks;
            };
            // Re-validate bounds: `total_lines` on a live stream only ever
            // grows (eviction shifts the retained window, not the count),
            // but clamp defensively rather than assume that invariant here.
            let live_total = source.total_lines();
            let chunk_end = chunk_end.min(live_total);

            for i in chunk_start..chunk_end {
                if results.len() >= limit { break; }
                lines_scanned += 1;
                let Some(raw) = source.raw_line(i) else { continue };

                if let Some(caps) = regex.captures(&raw) {
                    // Collect capture groups (skip group 0 = full match)
                    let captures: Vec<String> = (1..caps.len())
                        .filter_map(|j| caps.get(j).map(|m| m.as_str().to_string()))
                        .collect();

                    // Context lines — RAW text only. Anonymization happens
                    // after the `sessions` lock (held by this block) is
                    // dropped — see the module-level "Chunked scan helpers"
                    // docs and `anonymize_scan_line`.
                    let context_before: Vec<(usize, String)> = if context > 0 {
                        let start = i.saturating_sub(context);
                        (start..i)
                            .filter_map(|j| source.raw_line(j).map(|r| (j, r.into_owned())))
                            .collect()
                    } else {
                        vec![]
                    };

                    let context_after: Vec<(usize, String)> = if context > 0 {
                        let end = (i + 1 + context).min(live_total);
                        ((i + 1)..end)
                            .filter_map(|j| source.raw_line(j).map(|r| (j, r.into_owned())))
                            .collect()
                    } else {
                        vec![]
                    };

                    results.push(MatchResult {
                        line_num: i,
                        raw: raw.into_owned(),
                        captures,
                        context_before,
                        context_after,
                    });
                }
            }
        }

        tokio::task::yield_now().await;
    }

    let truncated = session_lost || (cap_applied && results.len() < limit);

    // Anonymize + truncate here, AFTER the `sessions` lock (used only inside
    // the chunked scan loop above) has been dropped — see `anonymize_scan_line`.
    let total_matches = results.len();
    let results_json: Vec<Value> = results.into_iter().map(|m| {
        let clean_raw = anonymize_scan_line(&state, &session_id, &m.raw, 500);
        let mut entry = json!({
            "lineNum": m.line_num,
            "raw": clean_raw,
        });
        if !m.captures.is_empty() {
            entry.as_object_mut().map(|o| o.insert("captures".to_string(), json!(m.captures)));
        }
        if !m.context_before.is_empty() {
            let before: Vec<Value> = m.context_before.into_iter()
                .map(|(ln, text)| json!({ "lineNum": ln, "raw": anonymize_scan_line(&state, &session_id, &text, 500) }))
                .collect();
            entry.as_object_mut().map(|o| o.insert("contextBefore".to_string(), json!(before)));
        }
        if !m.context_after.is_empty() {
            let after: Vec<Value> = m.context_after.into_iter()
                .map(|(ln, text)| json!({ "lineNum": ln, "raw": anonymize_scan_line(&state, &session_id, &text, 500) }))
                .collect();
            entry.as_object_mut().map(|o| o.insert("contextAfter".to_string(), json!(after)));
        }
        entry
    }).collect();

    Json(json!({
        "sessionId": session_id,
        "pattern": params.pattern,
        "caseInsensitive": case_insensitive,
        "matchCount": total_matches,
        "limit": limit,
        "matches": results_json,
        "scannedLines": lines_scanned,
        "truncated": truncated,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/processors — list all processor definitions
// ---------------------------------------------------------------------------

async fn h_processor_defs_list(State(handle): State<Handle>) -> Json<Value> {
    let state = handle.state::<AppState>();

    let processors: Vec<Value> = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        procs.iter().map(|(qualified_id, p)| {
            json!({
                "id": qualified_id,
                "name": p.meta.name,
                "processorType": p.processor_type(),
                "description": p.meta.description,
                "version": p.meta.version,
                "builtin": p.meta.builtin,
                "tags": p.meta.tags,
                "sections": extract_sections(p),
                "sourceTypes": extract_source_types(p),
            })
        }).collect()
    };

    Json(json!({
        "processorCount": processors.len(),
        "processors": processors,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/processors/{processor_id} — single processor definition detail
// ---------------------------------------------------------------------------

async fn h_processor_defs_single(
    State(handle): State<Handle>,
    Path(processor_id): Path<String>,
) -> Json<Value> {
    let state = handle.state::<AppState>();

    let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let resolved = resolve_processor_id(&procs, &processor_id);
    let Some(p) = resolved.as_ref().and_then(|rid| procs.get(rid)) else {
        return Json(json!({ "error": "processor not found", "processorId": processor_id }));
    };

    let mut result = json!({
        "id": p.meta.id,
        "name": p.meta.name,
        "processorType": p.processor_type(),
        "description": p.meta.description,
        "version": p.meta.version,
        "author": p.meta.author,
        "builtin": p.meta.builtin,
        "tags": p.meta.tags,
        "sections": extract_sections(p),
        "sourceTypes": extract_source_types(p),
    });

    match &p.kind {
        ProcessorKind::Reporter(def) => {
            // Summarize filter rules
            let filters: Vec<Value> = def.pipeline.iter().filter_map(|stage| {
                use crate::processors::reporter::schema::PipelineStage;
                match stage {
                    PipelineStage::Filter(fs) => {
                        let rules: Vec<String> = fs.rules.iter().map(|r| match r {
                            crate::processors::reporter::schema::FilterRule::TagMatch { tags, .. } => format!("tag_match: [{}]", tags.join(", ")),
                            crate::processors::reporter::schema::FilterRule::MessageContains { value } => format!("message_contains: \"{value}\""),
                            crate::processors::reporter::schema::FilterRule::MessageContainsAny { values } => format!("message_contains_any: [{}]", values.join(", ")),
                            crate::processors::reporter::schema::FilterRule::MessageRegex { pattern } => format!("message_regex: \"{pattern}\""),
                            crate::processors::reporter::schema::FilterRule::LevelMin { level } => format!("level_min: {level}"),
                            crate::processors::reporter::schema::FilterRule::TimeRange { from, to, .. } => format!("time_range: {from} - {to}"),
                            crate::processors::reporter::schema::FilterRule::SourceTypeIs { source_type } => format!("source_type_is: {source_type}"),
                            crate::processors::reporter::schema::FilterRule::TagRegex { pattern } => format!("tag_regex: \"{pattern}\""),
                            crate::processors::reporter::schema::FilterRule::SectionIs { section } => format!("section_is: {section}"),
                        }).collect();
                        Some(json!(rules))
                    }
                    _ => None,
                }
            }).collect();

            // Extract patterns
            let extracts: Vec<Value> = def.pipeline.iter().filter_map(|stage| {
                use crate::processors::reporter::schema::PipelineStage;
                match stage {
                    PipelineStage::Extract(es) => {
                        let fields: Vec<Value> = es.fields.iter().map(|f| {
                            json!({
                                "name": f.name,
                                "pattern": f.pattern,
                                "cast": f.cast.as_ref().map(|c| format!("{c:?}").to_lowercase()),
                            })
                        }).collect();
                        Some(json!(fields))
                    }
                    _ => None,
                }
            }).collect();

            // Aggregation types
            let aggregations: Vec<String> = def.pipeline.iter().filter_map(|stage| {
                use crate::processors::reporter::schema::PipelineStage;
                match stage {
                    PipelineStage::Aggregate(agg) => {
                        let types: Vec<String> = agg.groups.iter().map(|g| format!("{:?}", g.agg_type).to_lowercase()).collect();
                        Some(types.join(", "))
                    }
                    _ => None,
                }
            }).collect();

            let has_script = def.pipeline.iter().any(|s| matches!(s, crate::processors::reporter::schema::PipelineStage::Script(_)));

            // Var declarations
            let vars: Vec<Value> = def.vars.iter().map(|v| {
                json!({
                    "name": v.name,
                    "type": format!("{:?}", v.var_type).to_lowercase(),
                    "display": v.display,
                    "label": v.label,
                })
            }).collect();

            let obj = result.as_object_mut().unwrap();
            obj.insert("filters".to_string(), json!(filters));
            obj.insert("extracts".to_string(), json!(extracts));
            obj.insert("aggregations".to_string(), json!(aggregations));
            obj.insert("hasScript".to_string(), json!(has_script));
            obj.insert("vars".to_string(), json!(vars));
        }
        ProcessorKind::StateTracker(def) => {
            let state_fields: Vec<Value> = def.state.iter().map(|f| {
                json!({
                    "name": f.name,
                    "type": format!("{:?}", f.field_type).to_lowercase(),
                    "default": f.default,
                })
            }).collect();

            let transition_names: Vec<String> = def.transitions.iter().map(|t| t.name.clone()).collect();

            let obj = result.as_object_mut().unwrap();
            obj.insert("group".to_string(), json!(def.group));
            obj.insert("stateFields".to_string(), json!(state_fields));
            obj.insert("transitionNames".to_string(), json!(transition_names));
        }
        ProcessorKind::Correlator(def) => {
            let source_ids: Vec<String> = def.sources.iter().map(|s| s.id.clone()).collect();

            let obj = result.as_object_mut().unwrap();
            obj.insert("sourceIds".to_string(), json!(source_ids));
            obj.insert("trigger".to_string(), json!(def.correlate.trigger));
            obj.insert("withinLines".to_string(), json!(def.correlate.within_lines));
            obj.insert("withinMs".to_string(), json!(def.correlate.within_ms));
            obj.insert("guidance".to_string(), json!(def.correlate.guidance));
        }
        ProcessorKind::Transformer(_) => {
            // Minimal info already in base result
        }
    }

    Json(result)
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/metadata
// ---------------------------------------------------------------------------

async fn h_metadata(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let state = handle.state::<AppState>();

    get_session_and_source!(state, session_id => sessions, session, source);

    let total_lines = source.total_lines();
    let first_ts = source.first_timestamp();
    let last_ts = source.last_timestamp();

    let file_size = if let Some(file_src) = session.file_source() {
        file_src.mmap().len() as u64
    } else if let Some(stream_src) = session.stream_source() {
        stream_src.stream_byte_count()
    } else {
        0
    };

    let section_count = source.sections().len();

    Json(json!({
        "sessionId": session_id,
        "sourceName": source.name(),
        "sourceType": source.source_type().to_string(),
        "totalLines": total_lines,
        "fileSize": file_size,
        "isLive": source.is_live(),
        "isIndexing": source.is_indexing(),
        "firstTimestamp": first_ts,
        "lastTimestamp": last_ts,
        "sectionCount": section_count,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/sections
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SectionsParams {
    /// Max sections to return (default 50, max 200).
    limit: Option<usize>,
    /// Number of sections to skip (default 0).
    offset: Option<usize>,
    /// Case-insensitive substring filter on section name.
    query: Option<String>,
}

#[derive(Deserialize)]
struct SectionAtParams {
    /// 0-based line number to resolve.
    line: usize,
}

/// Serialize a section into the `{name, startLine, endLine, parentIndex?}`
/// object shared by `h_sections` and `h_section_at`. `parentIndex` is omitted
/// for top-level sections. Kept in one place so both endpoints stay byte-identical.
fn section_json(s: &crate::core::session::SectionInfo) -> Value {
    let mut obj = json!({
        "name": s.name,
        "startLine": s.start_line,
        "endLine": s.end_line,
    });
    if let Some(pi) = s.parent_index {
        obj["parentIndex"] = json!(pi);
    }
    obj
}

/// GET /mcp/sessions/{session_id}/section_at?line=N
///
/// Resolves which section contains a line. Returns the **innermost** section —
/// the value `filter.section` matches against in processor YAML — plus the
/// enclosing chain from outermost to innermost.
///
/// The chain matters: a dumpsys subsection like `wifi` lives inside
/// `DUMPSYS NORMAL`, and a processor rule naming the parent will never match a
/// line inside the child. Without this endpoint the only way to establish that
/// was to page through `sections` and cross-reference `parentIndex` against
/// line ranges by hand.
async fn h_section_at(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<SectionAtParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();

    get_session_and_source!(state, session_id => sessions, session, source);

    let sections = source.sections();
    let total_lines = source.total_lines();
    let line = params.line;

    let describe = |i: usize| section_json(&sections[i]);

    // Every section whose line range covers this line, outermost first. This is
    // the honest "where am I" answer.
    let containing: Vec<Value> = sections
        .iter()
        .enumerate()
        .filter(|(_, s)| line >= s.start_line && line <= s.end_line)
        .map(|(i, _)| describe(i))
        .collect();

    // What `filter.section` would actually match — which is NOT simply the
    // innermost containing section. Resolution takes the last section *starting*
    // at or before the line and gives up if the line is past that section's end,
    // rather than walking outward. So a line sitting inside a parent but after a
    // subsection ended matches nothing at all.
    let matched = crate::core::line::section_index_for_line(sections, line);

    let note = if sections.is_empty() {
        Some("This source has no parsed sections — not a bugreport/dumpstate, or detected as the wrong source type.")
    } else if matched.is_none() && !containing.is_empty() {
        Some("This line lies inside a section by range, but `filter.section` resolves it to nothing: resolution stops at the last section starting before the line and does not walk outward to an enclosing parent. A processor rule naming any of `containingSections` will NOT match this line.")
    } else if matched.is_none() {
        Some("Line falls outside every section — before the first, or in a gap between them.")
    } else {
        None
    };

    let mut out = json!({
        "sessionId": session_id,
        "line": line,
        // The name a processor's `filter.section` must use to match this line.
        // Null means no rule can target it by section.
        "matchesFilterSection": matched.map_or(Value::Null, |i| json!(sections[i].name)),
        "containingSections": containing,
        "totalLinesInSession": total_lines,
    });
    if let Some(n) = note {
        out["note"] = json!(n);
    }
    Json(out)
}

async fn h_sections(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<SectionsParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();

    get_session_and_source!(state, session_id => sessions, session, source);

    let all_sections = source.sections();
    let query_lower = params.query.as_deref().map(str::to_lowercase);

    // Apply name filter
    let filtered: Vec<&crate::core::session::SectionInfo> = all_sections.iter()
        .filter(|s| match &query_lower {
            Some(q) => s.name.to_lowercase().contains(q),
            None => true,
        })
        .collect();

    let total = filtered.len();
    let offset = params.offset.unwrap_or(0);
    let limit = params.limit.unwrap_or(50).min(200);

    let page: Vec<Value> = filtered.iter()
        .skip(offset)
        .take(limit)
        .map(|&s| section_json(s))
        .collect();

    Json(json!({
        "sessionId": session_id,
        "total": total,
        "returned": page.len(),
        "offset": offset,
        "limit": limit,
        "sections": page,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/tag-stats?top_n=50
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct TagStatsParams {
    /// Number of top tags to return (default 50).
    top_n: Option<usize>,
}

async fn h_tag_stats(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<TagStatsParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let top_n = params.top_n.unwrap_or(50);

    // Aggregate inside the lock (fast iteration, no allocations), then drop.
    let (total_lines, level_dist, tag_counts, tag_table) = {
        get_session_and_source!(state, session_id => sessions, session, source);

        let mut level_dist: HashMap<&'static str, usize> = HashMap::new();
        let mut tag_counts: HashMap<u16, usize> = HashMap::new();
        for m in source.line_meta_slice() {
            *level_dist.entry(m.level.as_str()).or_insert(0) += 1;
            *tag_counts.entry(m.tag_id).or_insert(0) += 1;
        }
        (
            source.total_lines(),
            level_dist,
            tag_counts,
            session.tag_table().to_vec(),
        )
    }; // lock drops here

    // Resolve tag IDs and sort by count descending
    let mut top_tags: Vec<Value> = tag_counts
        .into_iter()
        .map(|(tag_id, count)| {
            let tag = tag_table
                .get(tag_id as usize)
                .map_or("<unknown>", std::string::String::as_str);
            json!({ "tag": tag, "count": count })
        })
        .collect();
    top_tags.sort_by(|a, b| {
        b["count"].as_u64().unwrap_or(0).cmp(&a["count"].as_u64().unwrap_or(0))
    });
    top_tags.truncate(top_n);

    Json(json!({
        "sessionId": session_id,
        "totalLines": total_lines,
        "logLevelDistribution": level_dist,
        "topTags": top_tags,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/lines_around?line=N&before=50&after=20
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct LinesAroundParams {
    /// Center line number (required).
    line: usize,
    /// Number of lines before the center (default 20, max 100).
    before: Option<usize>,
    /// Number of lines after the center (default 20, max 100).
    after: Option<usize>,
}

async fn h_lines_around(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<LinesAroundParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let before = params.before.unwrap_or(20).min(100);
    let after = params.after.unwrap_or(20).min(100);
    let center = params.line;

    // Collect RAW (un-anonymized) lines under the `sessions` lock in a
    // scoped block, so the lock is dropped before anonymization runs below
    // — see the module header's lock-discipline rule and `anonymize_scan_line`.
    struct LineAroundSnap {
        line_num: usize,
        level: &'static str,
        tag: String,
        raw: String,
        is_center: bool,
    }

    let (snaps, total): (Vec<LineAroundSnap>, usize) = {
        get_session_and_source!(state, session_id => sessions, session, source);

        let total = source.total_lines();
        let start = center.saturating_sub(before);
        let end = (center + after + 1).min(total);

        let snaps: Vec<LineAroundSnap> = (start..end)
            .filter_map(|i| {
                let raw = source.raw_line(i)?;
                let meta = source.meta_at(i)?;
                Some(LineAroundSnap {
                    line_num: i,
                    level: meta.level.as_str(),
                    tag: session.resolve_tag(meta.tag_id).to_string(),
                    raw: raw.into_owned(),
                    is_center: i == center,
                })
            })
            .collect();

        (snaps, total)
    };

    // Anonymize + truncate AFTER the `sessions` lock above has been dropped.
    let lines: Vec<Value> = snaps
        .into_iter()
        .map(|s| {
            json!({
                "lineNum": s.line_num,
                "level": s.level,
                "tag": s.tag,
                "raw": anonymize_scan_line(&state, &session_id, &s.raw, 500),
                "isCenter": s.is_center,
            })
        })
        .collect();

    Json(json!({
        "sessionId": session_id,
        "centerLine": center,
        "totalLinesInSession": total,
        "lineCount": lines.len(),
        "lines": lines,
    }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/search_with_context
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SearchWithContextParams {
    /// Search query (regex pattern).
    query: String,
    /// Max matches to return (default 10, max 50).
    max_results: Option<usize>,
    /// Context lines before and after each match (default 3, max 10).
    context_lines: Option<usize>,
    /// Case insensitive (default false).
    #[serde(default)]
    case_insensitive: Option<bool>,
    /// Number of matches to skip before collecting results (default 0).
    offset: Option<usize>,
    /// Restrict search to lines >= start_line (0-based, inclusive).
    start_line: Option<usize>,
    /// Restrict search to lines < end_line (0-based, exclusive).
    end_line: Option<usize>,
    /// Max characters per returned line before truncation (default 500, max 8000).
    /// Wide dumpsys status lines exceed the default and get their trailing
    /// fields cut, which can hide the field a diagnosis depends on.
    max_line_chars: Option<usize>,
}

async fn h_search_with_context(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<SearchWithContextParams>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let max_results = params.max_results.unwrap_or(10).min(50);
    let context_lines = params.context_lines.unwrap_or(3).min(10);
    let case_insensitive = params.case_insensitive.unwrap_or(false);
    let offset = params.offset.unwrap_or(0);
    let max_line_chars = params.max_line_chars.unwrap_or(500).clamp(1, 8000);

    let pattern_str = if case_insensitive {
        format!("(?i){}", params.query)
    } else {
        params.query.clone()
    };

    let regex = match regex::Regex::new(&pattern_str) {
        Ok(re) => re,
        Err(e) => {
            return Json(json!({
                "error": format!("invalid regex: {e}"),
                "query": params.query,
            }));
        }
    };

    // Same error contract as before for a missing session — resolved once,
    // then the lock is dropped; the scan below re-acquires it per chunk (see
    // the "Chunked scan helpers" module docs).
    let total: usize = {
        get_session_and_source!(state, session_id => sessions, session, source);
        source.total_lines()
    };
    let range_start = params.start_line.unwrap_or(0).min(total);
    let requested_end = params.end_line.unwrap_or(total).min(total);
    // NOTE: this handler intentionally keeps scanning the whole (possibly
    // capped) range to produce an exact `matchCount`, rather than stopping
    // once `max_results` is reached — that full-scan-for-counting design is
    // tracked separately (see item c5d058b3) and is unchanged here. What
    // changes is HOW the range is scanned: in bounded chunks, with the
    // `sessions` lock released between them, and now capped at
    // MCP_SCAN_LINE_CAP so a pathological range can't scan unboundedly.
    let cap_applied = scan_window_capped(range_start, requested_end, MCP_SCAN_LINE_CAP);
    let range_end = capped_range_end(range_start, requested_end, MCP_SCAN_LINE_CAP);

    // RAW (un-anonymized) context-line snapshot — anonymization is deferred
    // until after the `sessions` lock (held only inside the chunked scan
    // loop below) is dropped, mirroring `h_search` / `h_lines_around`.
    struct ContextLineSnap {
        line_num: usize,
        level: &'static str,
        tag: String,
        raw: String,
        is_match: bool,
    }
    struct ContextMatchSnap {
        match_line_num: usize,
        context: Vec<ContextLineSnap>,
    }

    let mut results: Vec<ContextMatchSnap> = Vec::new();
    let mut skipped: usize = 0;
    // Counted across the whole (possibly capped) scan range, not just the
    // returned page, so callers can tell how much is left to paginate
    // through. `returned` is how many are in this page.
    let mut total_matches: usize = 0;
    let mut lines_scanned: usize = 0;
    let mut session_lost = false;

    'chunks: for (chunk_start, chunk_end) in scan_chunk_bounds(range_start, range_end, MCP_SCAN_CHUNK_SIZE) {
        { // `sessions` guard scope — dropped before the yield below.
            let sessions = lock_or_json_err!(state.sessions, "sessions");
            let Some(session) = sessions.get(&session_id) else {
                session_lost = true;
                break 'chunks;
            };
            let Some(source) = session.primary_source() else {
                session_lost = true;
                break 'chunks;
            };
            let live_total = source.total_lines();
            let chunk_end = chunk_end.min(live_total);

            for i in chunk_start..chunk_end {
                let Some(raw) = source.raw_line(i) else { continue };
                lines_scanned += 1;

                if regex.is_match(&raw) {
                    total_matches += 1;

                    // Skip the first `offset` matches
                    if skipped < offset {
                        skipped += 1;
                        continue;
                    }
                    if results.len() >= max_results {
                        continue;
                    }
                    // Build context — RAW text only, no anonymization here.
                    let ctx_start = i.saturating_sub(context_lines);
                    let ctx_end = (i + context_lines + 1).min(live_total);

                    let context: Vec<ContextLineSnap> = (ctx_start..ctx_end)
                        .filter_map(|j| {
                            let line_raw = source.raw_line(j)?;
                            let meta = source.meta_at(j)?;
                            Some(ContextLineSnap {
                                line_num: j,
                                level: meta.level.as_str(),
                                tag: session.resolve_tag(meta.tag_id).to_string(),
                                raw: line_raw.into_owned(),
                                is_match: j == i,
                            })
                        })
                        .collect();

                    results.push(ContextMatchSnap {
                        match_line_num: i,
                        context,
                    });
                }
            }
        }

        tokio::task::yield_now().await;
    }

    let truncated = session_lost || cap_applied;

    // Anonymize + truncate here, AFTER the `sessions` lock above has been
    // dropped — see `anonymize_scan_line`.
    let returned = results.len();
    let results_json: Vec<Value> = results.into_iter().map(|m| {
        let context: Vec<Value> = m.context.into_iter().map(|c| {
            json!({
                "lineNum": c.line_num,
                "level": c.level,
                "tag": c.tag,
                "raw": anonymize_scan_line(&state, &session_id, &c.raw, max_line_chars),
                "isMatch": c.is_match,
            })
        }).collect();
        json!({
            "matchLineNum": m.match_line_num,
            "context": context,
        })
    }).collect();

    Json(json!({
        "sessionId": session_id,
        "query": params.query,
        "caseInsensitive": case_insensitive,
        // True count across the whole scan range, independent of max_results
        // and offset. `returned` is how many are in this page.
        "matchCount": total_matches,
        "returned": returned,
        "maxResults": max_results,
        "contextLines": context_lines,
        "offset": offset,
        "maxLineChars": max_line_chars,
        "totalLinesInSession": total,
        "matches": results_json,
        "scannedLines": lines_scanned,
        "truncated": truncated,
    }))
}

// ---------------------------------------------------------------------------
// Bookmark endpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct BookmarkListQuery {
    category: Option<String>,
    tag: Option<String>,
}

async fn h_list_bookmarks(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<BookmarkListQuery>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let bookmarks = state.bookmarks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let list: Vec<_> = bookmarks
        .get(&session_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|bm| {
            if let Some(ref cat) = query.category {
                if bm.category.as_deref() != Some(cat.as_str()) {
                    return false;
                }
            }
            if let Some(ref tag) = query.tag {
                let has_tag = bm
                    .tags
                    .as_ref()
                    .is_some_and(|tags| tags.iter().any(|t| t == tag));
                if !has_tag {
                    return false;
                }
            }
            true
        })
        .collect();
    Json(json!(list))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBookmarkBody {
    line_number: u32,
    #[serde(default)]
    label: String,
    #[serde(default)]
    note: String,
    line_number_end: Option<u32>,
    snippet: Option<Vec<String>>,
    category: Option<String>,
    tags: Option<Vec<String>>,
}

async fn h_create_bookmark(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Json(body): Json<CreateBookmarkBody>,
) -> Json<Value> {
    use crate::core::bookmark::CreatedBy;

    match crate::commands::artifact_mutations::add_bookmark(
        &handle,
        session_id,
        body.line_number,
        body.label,
        body.note,
        CreatedBy::Agent,
        body.line_number_end,
        body.snippet,
        body.category,
        body.tags,
    ) {
        Ok(bookmark) => Json(json!(bookmark)),
        Err(e) => Json(json!({ "error": e })),
    }
}

async fn h_delete_bookmark(
    State(handle): State<Handle>,
    Path((session_id, bookmark_id)): Path<(String, String)>,
) -> Json<Value> {
    match crate::commands::artifact_mutations::remove_bookmark(&handle, session_id, bookmark_id) {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "error": e })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBookmarkBody {
    label: Option<String>,
    note: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
}

async fn h_update_bookmark(
    State(handle): State<Handle>,
    Path((session_id, bookmark_id)): Path<(String, String)>,
    Json(body): Json<UpdateBookmarkBody>,
) -> Json<Value> {
    match crate::commands::artifact_mutations::update_bookmark(
        &handle,
        session_id,
        bookmark_id,
        body.label,
        body.note,
        body.category,
        body.tags,
    ) {
        Ok(updated) => Json(json!(updated)),
        Err(e) => Json(json!({ "error": e })),
    }
}

// ---------------------------------------------------------------------------
// Analysis endpoints
// ---------------------------------------------------------------------------

async fn h_list_analyses(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let analyses = state.analyses.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let list = analyses.get(&session_id).cloned().unwrap_or_default();
    Json(json!(list))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishAnalysisBody {
    title: String,
    sections: Vec<crate::core::analysis::AnalysisSection>,
}

async fn h_publish_analysis(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Json(body): Json<PublishAnalysisBody>,
) -> Json<Value> {
    match crate::commands::artifact_mutations::publish_analysis(
        &handle,
        session_id,
        body.title,
        body.sections,
    ) {
        Ok(artifact) => Json(json!(artifact)),
        Err(e) => Json(json!({ "error": e })),
    }
}

async fn h_get_analysis(
    State(handle): State<Handle>,
    Path((session_id, artifact_id)): Path<(String, String)>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let analyses = state.analyses.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(list) = analyses.get(&session_id) {
        if let Some(art) = list.iter().find(|a| a.id == artifact_id) {
            return Json(json!(art));
        }
    }
    Json(json!({"error": format!("Analysis not found: {artifact_id}")}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAnalysisBody {
    title: Option<String>,
    sections: Option<Vec<crate::core::analysis::AnalysisSection>>,
}

async fn h_update_analysis(
    State(handle): State<Handle>,
    Path((session_id, artifact_id)): Path<(String, String)>,
    Json(body): Json<UpdateAnalysisBody>,
) -> Json<Value> {
    match crate::commands::artifact_mutations::update_analysis(
        &handle,
        session_id,
        artifact_id,
        body.title,
        body.sections,
    ) {
        Ok(updated) => Json(json!(updated)),
        Err(e) => Json(json!({ "error": e })),
    }
}

async fn h_delete_analysis(
    State(handle): State<Handle>,
    Path((session_id, artifact_id)): Path<(String, String)>,
) -> Json<Value> {
    match crate::commands::artifact_mutations::remove_analysis(&handle, session_id, artifact_id) {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "error": e })),
    }
}

// ---------------------------------------------------------------------------
// Watch endpoints
// ---------------------------------------------------------------------------

async fn h_list_watches(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let watches = state.active_watches.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let list = watches.get(&session_id);
    let infos: Vec<Value> = list
        .map(|ws| {
            ws.iter()
                .map(|w| {
                    json!({
                        "watchId": w.watch_id,
                        "sessionId": w.session_id,
                        "totalMatches": w.total_matches(),
                        "active": w.is_active(),
                        "criteria": serde_json::to_value(&w.criteria).unwrap_or(json!(null)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Json(json!(infos))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWatchBody {
    #[serde(flatten)]
    criteria: crate::core::filter::FilterCriteria,
}

async fn h_create_watch(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Json(body): Json<CreateWatchBody>,
) -> Json<Value> {
    use std::sync::Arc;
    use crate::core::watch::{WatchSession, WatchInfo};

    let state = handle.state::<AppState>();

    verify_session_exists!(state, session_id);

    let watch_id = uuid::Uuid::new_v4().to_string();
    let watch = match WatchSession::new(watch_id, session_id.clone(), body.criteria.clone()) {
        Ok(w) => Arc::new(w),
        Err(e) => return Json(json!({ "error": e })),
    };

    let info = WatchInfo {
        watch_id: watch.watch_id.clone(),
        session_id: watch.session_id.clone(),
        total_matches: 0,
        active: true,
        criteria: body.criteria,
    };

    {
        let mut watches = state.active_watches.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        watches
            .entry(session_id)
            .or_default()
            .push(watch);
    }

    Json(json!(info))
}

async fn h_cancel_watch(
    State(handle): State<Handle>,
    Path((session_id, watch_id)): Path<(String, String)>,
) -> Json<Value> {
    let state = handle.state::<AppState>();
    let watches = state.active_watches.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(list) = watches.get(&session_id) {
        if let Some(w) = list.iter().find(|w| w.watch_id == watch_id) {
            w.cancel();
            return Json(json!({"ok": true}));
        }
    }
    Json(json!({"error": format!("Watch not found: {watch_id}")}))
}

// ---------------------------------------------------------------------------
// POST /mcp/sessions/{session_id}/run_pipeline
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunPipelineBody {
    /// Processor IDs to run. If omitted, runs all installed processors.
    processor_ids: Option<Vec<String>>,
}

async fn h_run_pipeline(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Json(body): Json<RunPipelineBody>,
) -> Json<Value> {
    use crate::commands::pipeline::execute_pipeline;

    let state = handle.state::<AppState>();

    verify_session_exists!(state, session_id);

    // Resolve processor IDs — use provided list or all installed processors.
    // Bare IDs (e.g. "wifi-state") are resolved to qualified keys ("wifi-state@official").
    let processor_ids: Vec<String> = match body.processor_ids {
        Some(ids) if !ids.is_empty() => {
            let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            ids.into_iter()
                .map(|id| resolve_processor_id(&procs, &id).unwrap_or(id))
                .collect()
        }
        _ => {
            let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            procs.keys().cloned().collect()
        }
    };

    // Pipeline is CPU-heavy (rayon); run on a blocking thread to avoid starving
    // the Axum async runtime.
    let handle_clone = handle.clone();
    let sid = session_id.clone();
    let pids = processor_ids.clone();

    let result = tokio::task::spawn_blocking(move || {
        let state_ref = handle_clone.state::<AppState>();
        execute_pipeline(&state_ref, &handle_clone, &sid, &pids)
    }).await;

    match result {
        Ok(Ok(ref summaries)) => Json(json!({
            "sessionId": session_id,
            "summaries": summaries,
            "processorCount": summaries.len(),
        })),
        Ok(Err(e)) => Json(json!({ "error": e })),
        Err(e) => Json(json!({ "error": format!("Pipeline task panicked: {e}") })),
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/insights
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct InsightsParams {
    /// Max total signal events to return across all processors (default 20).
    max_signals: Option<usize>,
    /// Comma-separated list of processor IDs to include. If absent, all are included.
    processor_ids: Option<String>,
}

async fn h_insights(
    State(handle): State<Handle>,
    Path(session_id): Path<String>,
    Query(params): Query<InsightsParams>,
) -> Json<Value> {
    use crate::processors::marketplace::{McpSchema, Severity, SignalType};
    use crate::processors::signals::{eval_parsed_condition, render_template};

    let state = handle.state::<AppState>();
    let max_signals = params.max_signals.unwrap_or(20);

    let filter_ids: Option<std::collections::HashSet<String>> = params.processor_ids.map(|s| {
        s.split(',').map(|id| id.trim().to_string()).filter(|s| !s.is_empty()).collect()
    });

    fn severity_rank(s: &Severity) -> u8 {
        match s {
            Severity::Critical => 0,
            Severity::Warning  => 1,
            Severity::Info     => 2,
        }
    }

    /// Evaluated signals and summary for one processor, computed while holding the lock.
    struct ProcSnap {
        id: String,
        name: String,
        total_emissions: usize,
        summary: Option<String>,
        all_signals: Vec<Value>,
        signal_counts: HashMap<String, usize>,
        has_mcp_schema: bool,
    }

    let proc_snaps: Vec<ProcSnap> = {
        // Collect (qualified_id, display_name, schema) — qualified_id is the HashMap key.
        let proc_meta: Vec<(String, String, Option<McpSchema>)> = {
            let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            procs.iter()
                .filter(|(qid, p)| {
                    if let Some(ref ids) = filter_ids {
                        ids.contains(qid.as_str()) || ids.contains(&p.meta.id)
                    } else {
                        true
                    }
                })
                .map(|(qid, p)| (
                    qid.clone(),
                    p.meta.name.clone(),
                    p.schema.as_ref().and_then(|s| s.mcp.clone()),
                ))
                .collect()
        };

        // Evaluate signals in-place while holding pipeline_results lock (pure CPU, no I/O).
        let all_results = lock_or_json_err!(state.pipeline_results, "pipeline_results");
        let session_map = all_results.get(&session_id);

        proc_meta.into_iter().map(|(id, name, schema_mcp)| {
            let rr = session_map.and_then(|m| m.get(&id));
            let total_emissions = rr.map_or(0, |r| r.emissions.len());

            let Some(ref mcp) = schema_mcp else {
                return ProcSnap {
                    id, name, total_emissions,
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
                    mcp_summary.include_vars.iter()
                        .filter_map(|k| rr.vars.get(k).map(|v| (k.clone(), v.clone())))
                        .collect()
                };
                Some(render_template(&mcp_summary.template, &vars_map))
            } else {
                None
            };

            let mut all_signals: Vec<Value> = Vec::new();
            let mut signal_counts: HashMap<String, usize> = HashMap::new();

            if let Some(rr) = rr {
                for sig_def in &mcp.signals {
                    let count_entry = signal_counts.entry(sig_def.name.clone()).or_insert(0);

                    if sig_def.signal_type == SignalType::Aggregate {
                        if eval_parsed_condition(sig_def.parsed_condition.as_ref(), &rr.vars) {
                            *count_entry += 1;
                            let first_line = rr.emissions.first().map(|e| e.line_num);
                            let last_line = rr.emissions.last().map(|e| e.line_num);
                            let requested_fields: HashMap<String, Value> = sig_def.fields.iter()
                                .filter_map(|f| rr.vars.get(f).map(|v| (f.clone(), v.clone())))
                                .collect();
                            let message = sig_def.format.as_deref()
                                .map(|fmt| render_template(fmt, &rr.vars));
                            all_signals.push(json!({
                                "name": sig_def.name,
                                "severity": sig_def.severity,
                                "line": first_line,
                                "last_line": last_line,
                                "timestamp": null,
                                "message": message,
                                "fields": requested_fields,
                            }));
                        }
                    } else {
                        for emission in &rr.emissions {
                            let emission_fields: HashMap<String, Value> =
                                emission.fields.iter().cloned().collect();
                            if eval_parsed_condition(sig_def.parsed_condition.as_ref(), &emission_fields) {
                                *count_entry += 1;
                                let requested_fields: HashMap<String, Value> = sig_def.fields.iter()
                                    .filter_map(|f| emission_fields.get(f).map(|v| (f.clone(), v.clone())))
                                    .collect();
                                let message = sig_def.format.as_deref()
                                    .map(|fmt| render_template(fmt, &emission_fields));
                                all_signals.push(json!({
                                    "name": sig_def.name,
                                    "severity": sig_def.severity,
                                    "line": emission.line_num,
                                    "timestamp": null,
                                    "message": message,
                                    "fields": requested_fields,
                                }));
                            }
                        }
                    }
                }
            }

            all_signals.sort_by(|a, b| {
                let sa = a.get("severity").and_then(|v| serde_json::from_value::<Severity>(v.clone()).ok());
                let sb = b.get("severity").and_then(|v| serde_json::from_value::<Severity>(v.clone()).ok());
                let ra = sa.as_ref().map_or(2, severity_rank);
                let rb = sb.as_ref().map_or(2, severity_rank);
                ra.cmp(&rb)
            });

            ProcSnap { id, name, total_emissions, summary, all_signals, signal_counts, has_mcp_schema: true }
        }).collect()
    };

    let mut processors_out: Vec<Value> = Vec::new();

    for mut snap in proc_snaps {
        if !snap.has_mcp_schema {
            processors_out.push(json!({
                "processor_id": snap.id,
                "processor_name": snap.name,
                "summary": null,
                "signals": [],
                "signal_counts": {},
                "total_emissions": snap.total_emissions,
                "truncated": false,
            }));
            continue;
        }

        let truncated = snap.all_signals.len() > max_signals;
        snap.all_signals.truncate(max_signals);

        processors_out.push(json!({
            "processor_id": snap.id,
            "processor_name": snap.name,
            "summary": snap.summary,
            "signals": snap.all_signals,
            "signal_counts": snap.signal_counts,
            "total_emissions": snap.total_emissions,
            "truncated": truncated,
        }));
    }

    Json(json!({
        "session_id": session_id,
        "processors": processors_out,
    }))
}

// ---------------------------------------------------------------------------
// Sampling helpers
// ---------------------------------------------------------------------------

fn sample_indices(total: usize, n: usize, strategy: &str, around: Option<usize>) -> Vec<usize> {
    if total == 0 {
        return vec![];
    }
    let n = n.min(total);
    match strategy {
        "recent" => {
            let start = total.saturating_sub(n);
            (start..total).collect()
        }
        "around" => {
            let center = around.unwrap_or_else(|| total.saturating_sub(1));
            let half = n / 2;
            let start = center.saturating_sub(half);
            let end = (start + n).min(total);
            (start..end).collect()
        }
        _ => {
            // "uniform" — evenly spaced across the whole log
            if n >= total {
                (0..total).collect()
            } else {
                (0..n).map(|i| (i * total) / n).collect()
            }
        }
    }
}

/// Returns true if `line_level` (e.g. "Info") is >= the minimum `filter`
/// (e.g. "W" or "Warn"). Comparison is by priority: V < D < I < W < E < F.
fn level_at_least(line_level: &str, filter: &str) -> bool {
    fn priority(s: &str) -> u8 {
        match s.to_uppercase().chars().next().unwrap_or('I') {
            'V' => 0,
            'D' => 1,
            'W' => 3,
            'E' => 4,
            'F' => 5,
            _ => 2, // 'I' and unknown
        }
    }
    priority(line_level) >= priority(filter)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── resolve_should_anonymize / anonymize_for_session ────────────────────
    // Per-session MCP anonymization flag: must fail closed on an unknown
    // session, and must not leak one session's raw-vs-anonymized state into
    // another's (the bug this module fixes — see AppState::mcp_anonymize).

    #[test]
    fn resolve_should_anonymize_defaults_true_for_unknown_session() {
        // No entry at all — e.g. a session the frontend has never signalled
        // a pipeline-chain state for. Must fail closed to anonymize.
        let flags: HashMap<String, bool> = HashMap::new();
        assert!(resolve_should_anonymize(&flags, "unknown-session"));
    }

    #[test]
    fn resolve_should_anonymize_true_when_flag_set_true() {
        let mut flags: HashMap<String, bool> = HashMap::new();
        flags.insert("sess-a".to_string(), true);
        assert!(resolve_should_anonymize(&flags, "sess-a"));
    }

    #[test]
    fn resolve_should_anonymize_false_when_flag_set_false() {
        let mut flags: HashMap<String, bool> = HashMap::new();
        flags.insert("sess-a".to_string(), false);
        assert!(!resolve_should_anonymize(&flags, "sess-a"));
    }

    #[test]
    fn resolve_should_anonymize_is_per_session_not_global() {
        // The exact scenario from the bug report: two sessions, only one of
        // which has __pii_anonymizer active. A global bool could not
        // represent this; the per-session map must.
        let mut flags: HashMap<String, bool> = HashMap::new();
        flags.insert("sess-anonymized".to_string(), true);
        flags.insert("sess-raw".to_string(), false);
        assert!(resolve_should_anonymize(&flags, "sess-anonymized"));
        assert!(!resolve_should_anonymize(&flags, "sess-raw"));
    }

    #[test]
    fn anonymize_for_session_serves_raw_when_flag_false() {
        let state = AppState::new();
        state.mcp_anonymize.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert("sess-a".to_string(), false);
        let raw = "contact user@example.com for access";
        let out = anonymize_for_session(&state, "sess-a", raw);
        assert_eq!(out, raw);
    }

    #[test]
    fn anonymize_for_session_redacts_when_flag_true() {
        let state = AppState::new();
        state.mcp_anonymize.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert("sess-a".to_string(), true);
        let raw = "contact user@example.com for access";
        let out = anonymize_for_session(&state, "sess-a", raw);
        assert_ne!(out, raw);
        assert!(!out.contains("user@example.com"));
    }

    #[test]
    fn anonymize_for_session_fails_closed_for_unknown_session() {
        // No `set_mcp_anonymize` call has ever landed for this session —
        // must anonymize by default, not serve raw PII.
        let state = AppState::new();
        let raw = "contact user@example.com for access";
        let out = anonymize_for_session(&state, "never-seen-session", raw);
        assert_ne!(out, raw);
        assert!(!out.contains("user@example.com"));
    }

    // ── anonymize_line_texts (Tier-2 raw-line-leak fix) ──────────────────────
    // `h_pipeline` (reporter sampleMatchedLines / tracker recentTransitions)
    // and `h_processor_detail` (include_line_text=true) both resolve raw text
    // via `resolve_line_texts` and previously injected it straight into the
    // JSON response as `rawLine`, never checking the session's
    // `mcp_anonymize` flag — unlike h_query/h_search/h_lines_around/
    // h_search_with_context, which all route through `anonymize_for_session`.
    // These tests exercise the two-phase fix directly: `resolve_line_texts`
    // stays a pure "fetch under lock" helper, and `anonymize_line_texts` is
    // the new gate callers must pipe its output through afterward.

    #[test]
    fn anonymize_line_texts_redacts_pii_when_flag_true() {
        let state = AppState::new();
        state.mcp_anonymize.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), true);

        let mut raw = HashMap::new();
        raw.insert(10usize, "contact user@example.com for access".to_string());
        raw.insert(20usize, "no pii on this line".to_string());

        let out = anonymize_line_texts(&state, "sess-a", raw);

        // The PII-bearing line must no longer contain the raw email — this
        // is exactly the field `h_pipeline` / `h_processor_detail` inject
        // into `rawLine` in the JSON response.
        assert!(!out[&10].contains("user@example.com"), "raw PII leaked through rawLine: {}", out[&10]);
        assert_eq!(out[&20], "no pii on this line");
    }

    #[test]
    fn anonymize_line_texts_serves_raw_when_flag_false() {
        // Anonymization is opt-in per session — a session that explicitly
        // disabled it must still get its raw text back unchanged.
        let state = AppState::new();
        state.mcp_anonymize.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-raw".to_string(), false);

        let mut raw = HashMap::new();
        raw.insert(5usize, "contact user@example.com for access".to_string());

        let out = anonymize_line_texts(&state, "sess-raw", raw);
        assert_eq!(out[&5], "contact user@example.com for access");
    }

    #[test]
    fn anonymize_line_texts_fails_closed_for_unknown_session() {
        // No `set_mcp_anonymize` signal has landed for this session yet —
        // must anonymize by default (same fail-closed contract as
        // `anonymize_for_session`), not serve raw PII through rawLine.
        let state = AppState::new();
        let mut raw = HashMap::new();
        raw.insert(1usize, "contact user@example.com for access".to_string());

        let out = anonymize_line_texts(&state, "never-seen-session", raw);
        assert!(!out[&1].contains("user@example.com"));
    }

    #[test]
    fn anonymize_line_texts_anonymizes_before_truncating() {
        // Order matters: anonymize the FULL raw text first, then truncate.
        // If it were truncated first, an email straddling the 500-char cut
        // point would be sliced mid-token (e.g. "user@example." with no
        // TLD) — the anonymizer's email pattern would no longer match the
        // mangled fragment, and the "user@" prefix would leak into rawLine
        // unredacted. Doing it in the right order redacts the whole email
        // before the cut ever happens.
        let state = AppState::new();
        state.mcp_anonymize.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), true);

        // Email spans char 490..506 — straddles the 500-char truncation point.
        // The prefix ends in a space so the email sits on a word boundary
        // (EMAIL_RE is `\b`-anchored with a bounded local part; without a
        // boundary a 490-char word prefix would prevent any match at all,
        // which is unrelated to the ordering this test checks).
        let long_line = format!("{} user@example.com", "p".repeat(489));
        let mut raw = HashMap::new();
        raw.insert(1usize, long_line);

        let out = anonymize_line_texts(&state, "sess-a", raw);
        assert!(!out[&1].contains("user@"), "partial/full email leaked through rawLine: {}", out[&1]);
    }

    // ── anonymize_scan_line (h_search / h_search_with_context / h_lines_around) ─
    // These three handlers used to call `anonymize_for_session` (which locks
    // `mcp_anonymize` / `anonymizer_config` / `mcp_anonymizers`) WHILE still
    // holding the `sessions` lock from their chunked scan loop — a lock-order
    // violation of this file's own header rule ("copy/clone the data needed,
    // drop the `sessions` lock, THEN build the JSON response"). The fix moves
    // anonymization to run after `sessions` is dropped, funneled through this
    // shared helper. A live Axum/Tauri `Handle<Wry>` is impractical to
    // construct in this test suite (see `poisoned_sessions_probe`'s doc
    // comment for the same constraint), so — exactly like
    // `anonymize_line_texts` above — these tests exercise the extracted
    // post-lock transformation directly to prove anonymization is still
    // applied (and still ordered before truncation) with the lock dropped.

    #[test]
    fn anonymize_scan_line_redacts_pii_when_flag_true() {
        let state = AppState::new();
        state.mcp_anonymize.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), true);

        let raw = "contact user@example.com for access";
        let out = anonymize_scan_line(&state, "sess-a", raw, 500);
        assert_ne!(out, raw);
        assert!(!out.contains("user@example.com"), "raw PII leaked: {out}");
    }

    #[test]
    fn anonymize_scan_line_serves_raw_when_flag_false() {
        // Anonymization is opt-in per session — matches h_search's contract
        // of honoring the session's mcp_anonymize flag, not a global switch.
        let state = AppState::new();
        state.mcp_anonymize.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-raw".to_string(), false);

        let raw = "contact user@example.com for access";
        let out = anonymize_scan_line(&state, "sess-raw", raw, 500);
        assert_eq!(out, raw);
    }

    #[test]
    fn anonymize_scan_line_fails_closed_for_unknown_session() {
        // No `set_mcp_anonymize` signal has landed for this session — must
        // anonymize by default (same fail-closed contract as
        // `anonymize_for_session` / `anonymize_line_texts`), matching what
        // h_search / h_search_with_context / h_lines_around must do for a
        // session the frontend hasn't signalled a state for yet.
        let state = AppState::new();
        let raw = "contact user@example.com for access";
        let out = anonymize_scan_line(&state, "never-seen-session", raw, 500);
        assert!(!out.contains("user@example.com"), "raw PII leaked for unrecognized session: {out}");
    }

    #[test]
    fn anonymize_scan_line_anonymizes_before_truncating() {
        // Same ordering requirement as `anonymize_line_texts`: h_search's
        // matched line, its contextBefore/contextAfter lines, and
        // h_search_with_context's/h_lines_around's context lines are all
        // truncated at up to 500/max_line_chars characters — if truncation
        // ran first, an email straddling the cut point would be sliced
        // mid-token and leak its unredacted prefix.
        let state = AppState::new();
        state.mcp_anonymize.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), true);

        let long_line = format!("{} user@example.com", "p".repeat(489));
        let out = anonymize_scan_line(&state, "sess-a", &long_line, 500);
        assert!(!out.contains("user@"), "partial/full email leaked: {out}");
    }

    #[test]
    fn anonymize_scan_line_truncates_after_anonymizing_respects_custom_cap() {
        // h_search_with_context accepts a caller-supplied `max_line_chars`
        // (up to 8000) instead of the fixed 500 h_search/h_lines_around use —
        // verify the cap is still honored post-anonymization.
        let state = AppState::new();
        state.mcp_anonymize.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), false); // flag off: raw passes through unchanged

        let long = "x".repeat(600);
        let out = anonymize_scan_line(&state, "sess-a", &long, 500);
        assert!(out.ends_with("..."));
        assert_eq!(out.chars().count(), 503);
    }

    // ── Lock poisoning: `lock_or_json_err!` vs. `into_inner` recovery ───────
    // See the "Lock-poisoning helpers" module docs near the top of this file
    // for the two-family policy. These tests poison a real AppState mutex
    // from another thread (mirroring "some unrelated handler panicked while
    // holding this lock") and assert the two recovery strategies behave as
    // documented instead of propagating the poison as a panic.

    /// Exercises the exact `lock_or_json_err!` expansion a real handler uses
    /// for `sessions` — a standalone `Json<Value>`-returning fn so the
    /// macro's early `return` has a matching function to return from
    /// (handlers themselves need a live Axum/Tauri `AppHandle` this test
    /// suite otherwise avoids constructing).
    fn poisoned_sessions_probe(state: &AppState) -> Json<Value> {
        let sessions = lock_or_json_err!(state.sessions, "sessions");
        Json(json!({ "sessionCount": sessions.len() }))
    }

    #[test]
    fn lock_or_json_err_returns_error_body_on_poison_instead_of_panicking() {
        let state = std::sync::Arc::new(AppState::new());

        // Poison `sessions` from another thread — a panic anywhere while
        // holding the lock (e.g. a bug in a session mutation) must not brick
        // every later bridge request.
        let poisoner = std::sync::Arc::clone(&state);
        let joined = std::thread::spawn(move || {
            let _guard = poisoner.sessions.lock().expect("lock not yet poisoned");
            panic!("simulated writer panic while holding sessions");
        })
        .join();
        assert!(joined.is_err(), "poisoning thread should have panicked");
        assert!(state.sessions.is_poisoned());

        // Must return the bridge's `{"error": ...}` contract, not panic.
        let Json(body) = poisoned_sessions_probe(&state);
        assert_eq!(
            body.get("error").and_then(Value::as_str),
            Some("sessions lock poisoned"),
        );
    }

    #[test]
    fn mcp_anonymize_recovers_via_into_inner_after_poison_instead_of_panicking() {
        let state = std::sync::Arc::new(AppState::new());
        // Seed a flag before poisoning so the recovered guard reflects the
        // same value a caller would see if the poisoning writer's insert had
        // completed — `into_inner` recovery must not lose or corrupt it.
        state.mcp_anonymize.lock().expect("lock not yet poisoned").insert("sess-a".to_string(), false);

        let poisoner = std::sync::Arc::clone(&state);
        let joined = std::thread::spawn(move || {
            let _guard = poisoner.mcp_anonymize.lock().expect("lock not yet poisoned");
            panic!("simulated writer panic while holding mcp_anonymize");
        })
        .join();
        assert!(joined.is_err(), "poisoning thread should have panicked");
        assert!(state.mcp_anonymize.is_poisoned());

        // `anonymize_for_session` locks `mcp_anonymize` via `into_inner`
        // recovery (a pure per-session flag map, no cross-field invariant) —
        // it must recover and see the flag set before the panic, not panic
        // itself.
        let raw = "contact user@example.com for access";
        let out = anonymize_for_session(&state, "sess-a", raw);
        assert_eq!(out, raw, "flag=false must still serve raw text after recovery");
    }

    // ── truncate_str / max_line_chars ────────────────────────────────────────
    // Wide dumpsys status lines exceed the 500-char default and lose their
    // trailing fields. Callers can now widen the cap per request.

    #[test]
    fn truncate_str_leaves_short_lines_untouched() {
        assert_eq!(truncate_str("short", 500), "short");
        // Exactly at the cap must not gain an ellipsis.
        let exact = "x".repeat(500);
        assert_eq!(truncate_str(&exact, 500), exact);
    }

    #[test]
    fn truncate_str_cuts_and_marks_long_lines() {
        let long = "x".repeat(600);
        let out = truncate_str(&long, 500);
        assert!(out.ends_with("..."));
        assert_eq!(out.chars().count(), 503);
    }

    #[test]
    fn truncate_str_respects_a_wider_cap() {
        // A realistic UsbPortStatus line: the fields that decide a diagnosis
        // (canChangeDataRole, lastConnectDurationMillis) sit past char 500.
        let line = format!("{}canChangeDataRole=false, lastConnectDurationMillis=0", "p".repeat(520));
        assert!(!truncate_str(&line, 500).contains("canChangeDataRole"));
        let wide = truncate_str(&line, 8000);
        assert!(wide.contains("canChangeDataRole=false"));
        assert!(wide.contains("lastConnectDurationMillis=0"));
        assert!(!wide.ends_with("..."));
    }

    #[test]
    fn truncate_str_does_not_split_multibyte_chars() {
        // Each 'é' is two bytes; cutting by byte index would panic or corrupt.
        let s = "é".repeat(10);
        let out = truncate_str(&s, 4);
        assert_eq!(out, "éééé...");
        assert_eq!(out.chars().count(), 7);
    }

    #[test]
    fn max_line_chars_clamp_matches_handler_bounds() {
        // Mirrors `params.max_line_chars.unwrap_or(500).clamp(1, 8000)`.
        let clamp = |v: usize| v.clamp(1, 8000);
        assert_eq!(clamp(0), 1);
        assert_eq!(clamp(500), 500);
        assert_eq!(clamp(50_000), 8000);
    }

    // ── level_at_least ───────────────────────────────────────────────────────

    #[test]
    fn level_at_least_orders_by_severity() {
        assert!(level_at_least("E", "W"));
        assert!(level_at_least("W", "W"));
        assert!(!level_at_least("D", "W"));
        // Unknown levels are treated as Info.
        assert!(level_at_least("?", "D"));
        assert!(!level_at_least("?", "W"));
    }

    // ── is_trusted_request ───────────────────────────────────────────────────

    fn headers_from(pairs: &[(&str, &str)]) -> axum::http::HeaderMap {
        let mut headers = axum::http::HeaderMap::new();
        for (k, v) in pairs {
            headers.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        headers
    }

    #[test]
    fn trusted_host_127_no_origin() {
        let headers = headers_from(&[("host", "127.0.0.1:40404")]);
        assert!(is_trusted_request(&headers));
    }

    #[test]
    fn trusted_host_localhost() {
        let headers = headers_from(&[("host", "localhost:40404")]);
        assert!(is_trusted_request(&headers));
    }

    #[test]
    fn trusted_host_localhost_uppercase() {
        let headers = headers_from(&[("host", "LOCALHOST:40404")]);
        assert!(is_trusted_request(&headers));
    }

    #[test]
    fn rejects_dns_rebinding_host() {
        let headers = headers_from(&[("host", "evil.com:40404")]);
        assert!(!is_trusted_request(&headers));
    }

    #[test]
    fn rejects_missing_host() {
        let headers = headers_from(&[]);
        assert!(!is_trusted_request(&headers));
    }

    #[test]
    fn rejects_any_origin_even_with_good_host() {
        let headers = headers_from(&[
            ("host", "127.0.0.1:40404"),
            ("origin", "http://evil.com"),
        ]);
        assert!(!is_trusted_request(&headers));
    }

    #[test]
    fn rejects_foreign_referer_even_with_good_host() {
        let headers = headers_from(&[
            ("host", "127.0.0.1:40404"),
            ("referer", "http://evil.com/x"),
        ]);
        assert!(!is_trusted_request(&headers));
    }

    #[test]
    fn trusted_referer_matching_bridge_origin() {
        let headers = headers_from(&[
            ("host", "127.0.0.1:40404"),
            ("referer", "http://127.0.0.1:40404/x"),
        ]);
        assert!(is_trusted_request(&headers));
    }

    #[test]
    fn trusted_referer_bare_origin_no_path() {
        // Exact origin with no trailing path is a legitimate Referer.
        let headers = headers_from(&[
            ("host", "127.0.0.1:40404"),
            ("referer", "http://127.0.0.1:40404"),
        ]);
        assert!(is_trusted_request(&headers));
    }

    #[test]
    fn rejects_referer_with_suffixed_host_boundary_bypass() {
        // A bare starts_with(origin) check would accept these — the bridge
        // origin is only a string prefix; the real host is different. The
        // boundary-correct check (exact, or origin + '/') must reject them.
        for bad in [
            "http://127.0.0.1:40404.evil.com/x",
            "http://127.0.0.1:40404@evil.com/x",
            "http://localhost:40404.evil.com/x",
        ] {
            let headers = headers_from(&[("host", "127.0.0.1:40404"), ("referer", bad)]);
            assert!(!is_trusted_request(&headers), "referer {bad:?} must be rejected");
        }
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
}
