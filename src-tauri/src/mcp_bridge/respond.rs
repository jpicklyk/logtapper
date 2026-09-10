//! Shared response-shaping helpers for the MCP bridge's route handlers.
//!
//! Lock discipline: acquire a Mutex, copy/clone the data needed, drop the lock,
//! THEN build the JSON response. Never hold a lock across an `.await`.

use std::collections::HashMap;

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::core::session::AnalysisSession;

// ---------------------------------------------------------------------------
// Lock-poisoning helpers
// ---------------------------------------------------------------------------
//
// Every AppState Mutex touched in the bridge falls into one of two families:
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
pub(super) use lock_or_json_err;

/// Same as [`lock_or_json_err!`], but for handlers returning `Response`,
/// using the bridge's structured `{ error, code }` shape via [`err`].
macro_rules! lock_or_err_response {
    ($mutex:expr, $name:expr) => {
        match $mutex.lock() {
            Ok(guard) => guard,
            Err(_) => return crate::mcp_bridge::respond::err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("{} lock poisoned", $name),
                "LOCK_POISONED",
            ),
        }
    };
}
pub(super) use lock_or_err_response;

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
        let $sessions = crate::mcp_bridge::respond::lock_or_json_err!($state.sessions, "sessions");
        let Some($session) = $sessions.get(&$session_id) else {
            return Json(json!({ "error": format!("Session not found: {}", $session_id) }));
        };
        let Some($source) = $session.primary_source() else {
            return Json(json!({ "error": format!("Session has no sources: {}", $session_id) }));
        };
    };
}
pub(super) use get_session_and_source;

/// Verify a session exists (by key) and return a JSON error if not (or if
/// the lock is poisoned — see `lock_or_json_err!` above).
/// Does not bind the session — drops the lock immediately.
macro_rules! verify_session_exists {
    ($state:expr, $session_id:expr) => {{
        let sessions = crate::mcp_bridge::respond::lock_or_json_err!($state.sessions, "sessions");
        if !sessions.contains_key(&$session_id) {
            return Json(json!({ "error": format!("Session not found: {}", $session_id) }));
        }
    }};
}
pub(super) use verify_session_exists;

// ---------------------------------------------------------------------------
// PII anonymization helpers — used by every raw-line handler
// (h_query, h_search, h_lines_around, h_search_with_context).
// ---------------------------------------------------------------------------

// These moved to `services::policy` so the service layer owns the
// fail-closed anonymization gate and both transports share one
// implementation: `resolve_should_anonymize`, `anonymize_for_session`,
// `anonymize_line_texts`, `anonymize_scan_line`, `truncate_str`. Their tests
// moved with them. The `resolve_line_texts` / `anonymize_line_texts` split
// described below is unchanged — only the second half now lives elsewhere.

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

// The scan budget and the pure window math moved to `services::lines` — the
// service layer owns the shared limit now that both raw-line reads go through
// it. These re-exports exist only so `routes/search.rs` keeps compiling
// unchanged; WP-2 repoints it and they go away.
pub(super) use crate::services::lines::{
    MCP_SCAN_CHUNK_SIZE, MCP_SCAN_LINE_CAP, capped_range_end, scan_chunk_bounds,
    scan_window_capped,
};

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

// `contains_ignore_case` moved to `services::lines` with the filtered-scan
// path that was its only caller. Its tests moved with it — nothing in this
// module references it any more, so there is no re-export to keep.

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

/// Resolve multiple line numbers to raw, **un-anonymized, un-truncated**
/// text, returning a map of line_num -> text. Must be called while holding
/// the `sessions` lock (it borrows the locked map directly).
///
/// Callers MUST pipe the result through [`crate::services::policy::anonymize_line_texts`] —
/// dropping the `sessions` lock first — before it reaches a JSON response.
/// This function on its own does not honor the session's `mcp_anonymize`
/// flag; serving its output directly is the Tier-2 raw-line-leak bug this
/// pair of functions fixes (see `anonymize_for_session`'s doc comment for
/// why the gate exists).
///
/// WP-4 moved the last in-tree caller (`routes::pipeline`) onto
/// `services::pipeline`, whose `redacted_line_texts` performs the same
/// two-phase resolve-then-redact. Kept — and allowed to be unused — because
/// the remaining raw-line routes are mid-migration and still reach for it; the
/// package that moves the last of them deletes this.
#[allow(dead_code)]
pub(super) fn resolve_line_texts(
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

/// Build a JSON error response with a stable machine-readable `code` for MCP
/// clients. Shared by the write-style handlers (`h_open_file`,
/// `h_close_session`) so every error body has the same `{ error, code }` shape.
pub(super) fn err(status: StatusCode, message: impl Into<String>, code: &str) -> Response {
    (status, Json(json!({ "error": message.into(), "code": code }))).into_response()
}

/// Build one `GET /mcp/sessions` entry for `session`. Pure (no locking) so it
/// is directly unit-testable — see the `h_sessions_session_json` tests below
/// for the `path` / `focused` fields this adds (MCP work item acfbc673).
pub(super) fn session_to_json(session: &AnalysisSession, focused_session_id: Option<&str>) -> Value {
    let sources: Vec<Value> = if let Some(src) = session.primary_source() {
        vec![json!({
            "id": src.id(),
            "name": src.name(),
            "sourceType": src.source_type().to_string(),
            "totalLines": src.total_lines(),
            // Absolute source-file path, when this is a file-backed session
            // (null for ADB streams). Lets an agent tell apart two open
            // sessions that share the same display name (e.g.
            // "dumpstate.txt" loaded from two devices).
            "path": session.file_path,
        })]
    } else {
        vec![]
    };
    json!({
        "id": session.id,
        "sources": sources,
        "focused": focused_session_id == Some(session.id.as_str()),
    })
}

/// Serialize a section into the `{name, startLine, endLine, parentIndex?}`
/// object shared by `h_sections` and `h_section_at`. `parentIndex` is omitted
/// for top-level sections. Kept in one place so both endpoints stay byte-identical.
pub(super) fn section_json(s: &crate::core::session::SectionInfo) -> Value {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::AppState;
    use crate::processors::marketplace::resolve_processor_id_checked;

    // NOTE: the `resolve_should_anonymize` / `anonymize_for_session` /
    // `anonymize_line_texts` / `anonymize_scan_line` tests moved to
    // `services::policy` along with the functions themselves. The gate is
    // still exercised — just from the module that now owns it.

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
        let out = crate::services::policy::anonymize_for_session(&state, "sess-a", raw);
        assert_eq!(out, raw, "flag=false must still serve raw text after recovery");
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
    // `Err` into this file's `Json({"error": ...})` response shape instead of
    // resolving unpredictably.
    //
    // The handlers themselves take `State<BridgeCtx>`, which still carries a
    // live `AppHandle<Wry>` (the `app` field) for the four call sites that have
    // not moved to `ServiceCtx` yet — impractical to construct here, per this
    // suite's established constraint (see `poisoned_sessions_probe` above).
    // `router()` is split out so a later package can drive the whole table with
    // `tower::ServiceExt::oneshot` once that field is gone.
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
            "ambiguous bare id must surface as Err for the bridge handlers to map into a JSON error, not resolve silently"
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

    // ── h_sessions session_to_json — path + focused fields (MCP acfbc673) ───
    // Session disambiguation: `GET /mcp/sessions` must surface each source's
    // absolute file path and whether the session is the one the frontend has
    // focused, so an agent can tell apart two open sessions that share the
    // same display name (e.g. "dumpstate.txt" loaded from two devices).

    /// Write a minimal logcat-shaped temp file and load it into a fresh
    /// session as source "src-0", mirroring `core::session::tests`' own
    /// helper (not reusable across modules — that one is private to
    /// `session.rs`'s test mod).
    fn session_with_source(id: &str, file_path: &str) -> AnalysisSession {
        let mut path = std::env::temp_dir();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("logtapper_mcp_bridge_test_{id}_{unique}.log"));
        std::fs::write(&path, "01-01 00:00:00.000  1000  1000 I Tag: hello\n").unwrap();

        let mut session = AnalysisSession::new(id.to_string());
        session
            .add_source_partial(&path, "src-0".to_string(), 1_000_000)
            .expect("add_source_partial should succeed for a real temp file");
        session.file_path = Some(file_path.to_string());

        let _ = std::fs::remove_file(&path); // source already mmap'd; file no longer needed on disk
        session
    }

    #[test]
    fn session_to_json_includes_source_path() {
        let session = session_with_source("sess-a", "/logs/S23/dumpstate.txt");
        let json = session_to_json(&session, None);
        assert_eq!(json["sources"][0]["path"], "/logs/S23/dumpstate.txt");
    }

    #[test]
    fn session_to_json_marks_focused_session_true() {
        let session = session_with_source("sess-a", "/logs/S23/dumpstate.txt");
        let json = session_to_json(&session, Some("sess-a"));
        assert_eq!(json["focused"], true);
    }

    #[test]
    fn session_to_json_marks_unfocused_session_false() {
        let session = session_with_source("sess-a", "/logs/S23/dumpstate.txt");
        let json = session_to_json(&session, Some("sess-b"));
        assert_eq!(json["focused"], false);
    }

    #[test]
    fn session_to_json_marks_false_when_nothing_focused() {
        let session = session_with_source("sess-a", "/logs/S23/dumpstate.txt");
        let json = session_to_json(&session, None);
        assert_eq!(json["focused"], false);
    }

    #[test]
    fn session_to_json_disambiguates_same_named_sessions_by_path() {
        // The exact reported scenario: two sessions loaded from the same
        // filename ("dumpstate.txt") on two different devices must carry
        // distinguishable `path` values, and only the actually-focused one
        // reports `focused: true`.
        let s23 = session_with_source("sess-s23", "/logs/S23/dumpstate.txt");
        let xcover6 = session_with_source("sess-xcover6", "/logs/XCover6/dumpstate.txt");

        let s23_json = session_to_json(&s23, Some("sess-xcover6"));
        let xcover6_json = session_to_json(&xcover6, Some("sess-xcover6"));

        assert_ne!(s23_json["sources"][0]["path"], xcover6_json["sources"][0]["path"]);
        assert_eq!(s23_json["focused"], false);
        assert_eq!(xcover6_json["focused"], true);
    }

    #[test]
    fn session_to_json_path_is_null_when_session_has_no_file_path() {
        // A source without a set file_path (e.g. a stream-backed session)
        // must serialize `path` as JSON null, not omit the key or panic.
        let mut path = std::env::temp_dir();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("logtapper_mcp_bridge_test_nopath_{unique}.log"));
        std::fs::write(&path, "01-01 00:00:00.000  1000  1000 I Tag: hello\n").unwrap();

        let mut session = AnalysisSession::new("sess-nopath".to_string());
        session.add_source_partial(&path, "src-0".to_string(), 1_000_000).unwrap();
        let _ = std::fs::remove_file(&path);
        // file_path deliberately left as None (the AnalysisSession::new default).

        let json = session_to_json(&session, None);
        assert!(json["sources"][0]["path"].is_null());
    }

    #[test]
    fn session_to_json_sources_empty_when_no_source() {
        let session = AnalysisSession::new("sess-empty".to_string());
        let json = session_to_json(&session, None);
        assert_eq!(json["sources"].as_array().unwrap().len(), 0);
        assert_eq!(json["focused"], false);
    }
}
