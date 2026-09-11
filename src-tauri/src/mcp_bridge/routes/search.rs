//! Regex search endpoints: search, search_with_context.
//!
//! Both are thin adapters over [`services::search::hits`](crate::services::search::hits):
//! they translate query-string parameters into a [`SearchHitsRequest`] and
//! render the resulting [`SearchHits`](crate::services::wire::SearchHits) into
//! the exact JSON each endpoint has always returned. The two shapes differ —
//! `search` emits `contextBefore`/`contextAfter` as sibling arrays with
//! capture groups, `search_with_context` emits one flat `context` list in
//! reading order with an `isMatch` flag — and that difference is now purely a
//! rendering decision here rather than two separate scans.
//!
//! WP-13 replaces the rendering with `SearchHits` itself and ships
//! [`ServiceError`] instead of `{ "error": … }` at HTTP 200; until then the
//! shapes below are the contract with every shipped MCP client, and the golden
//! tests at the bottom of this file pin them against frozen copies of the
//! pre-service handler bodies.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::core::line::ViewLine;
use crate::mcp_bridge::BridgeCtx;
use crate::services::lines::NO_SOURCES;
use crate::services::search::{self, INVALID_REGEX, SearchHitsRequest};
use crate::services::wire::SearchHits;
use crate::services::{ServiceCtx, ServiceError};

/// The self-reported client name, for the [`Caller`](crate::services::Caller)
/// identity. Labels the activity feed only — never trusted for authorization,
/// and irrelevant to these two handlers beyond `Caller::Agent` being what
/// makes [`policy::redact_line`](crate::services::policy::redact_line)
/// anonymize at all.
///
/// Duplicated from `routes/lines.rs` deliberately: `respond.rs` is moves-only
/// under this package's ownership, and a two-line extractor is not worth a new
/// shared module. The package that needs a third copy should hoist it.
fn client_name(headers: &HeaderMap) -> &str {
    headers
        .get("x-logtapper-client")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .unwrap_or("mcp")
}

/// Render a [`ServiceError`] in these endpoints' historical spellings.
///
/// The service says `Session 'x' not found`; both endpoints have always said
/// `Session not found: x`, and `Session has no sources: x` where the service
/// says [`NO_SOURCES`]. A refused pattern is framed by `regex_prefix` and
/// echoed back under `echo_key` — `search` says `invalid regex pattern` and
/// echoes `pattern`, `search_with_context` says `invalid regex` and echoes
/// `query`. Everything else (notably a poisoned `sessions` lock, which renders
/// `"sessions lock poisoned"`) already matches byte for byte.
fn error_json(
    err: &ServiceError,
    session_id: &str,
    regex_prefix: &str,
    echo_key: &str,
    echo_value: &str,
) -> Value {
    match err {
        ServiceError::InvalidArg { code, message } if *code == INVALID_REGEX => json!({
            "error": format!("{regex_prefix}: {message}"),
            echo_key: echo_value,
        }),
        ServiceError::NotFound(_) => json!({ "error": format!("Session not found: {session_id}") }),
        ServiceError::InvalidArg { message, .. } if message == NO_SOURCES => {
            json!({ "error": format!("Session has no sources: {session_id}") })
        }
        other => json!({ "error": other.message() }),
    }
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/search
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub(crate) struct SearchParams {
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

pub(crate) async fn h_search(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<SearchParams>,
    headers: HeaderMap,
) -> Json<Value> {
    let sctx = ctx.svc(client_name(&headers));
    // `services::search::hits` is synchronous by contract: it takes the
    // `sessions` lock once per scan chunk and must never hold one across an
    // await, so it runs on the blocking pool instead of the request's worker
    // (which is also what the old handler's `yield_now()` between chunks was
    // approximating).
    let rendered =
        tokio::task::spawn_blocking(move || search_json(&sctx, &session_id, &params)).await;
    Json(rendered.unwrap_or_else(|e| json!({ "error": format!("search task failed: {e}") })))
}

/// The whole of `h_search` minus axum. Separated so the golden test can call it.
fn search_json(ctx: &ServiceCtx, session_id: &str, params: &SearchParams) -> Value {
    let limit = params.limit.unwrap_or(50).min(200);
    let context = params.context.unwrap_or(0).min(5);
    let case_insensitive = params.case_insensitive.unwrap_or(false);

    let req = SearchHitsRequest {
        session_id: session_id.to_string(),
        pattern: params.pattern.clone(),
        case_insensitive,
        context_before: context,
        context_after: context,
        // This endpoint has never paginated: it returns the first `limit`
        // matches and stops.
        offset: 0,
        limit,
        start_line: params.start_line,
        end_line: params.end_line,
        max_line_chars: 500,
        with_captures: true,
        count_all_matches: false,
        count_unreadable_as_scanned: true,
        redact_match_line_first: true,
    };

    let hits: SearchHits = match search::hits(ctx, &req) {
        Ok(h) => h,
        Err(e) => {
            return error_json(
                &e,
                session_id,
                "invalid regex pattern",
                "pattern",
                &params.pattern,
            );
        }
    };

    // `captures`, `contextBefore` and `contextAfter` are omitted rather than
    // emitted empty — every shipped client reads them with a presence check.
    let matches: Vec<Value> = hits
        .hits
        .iter()
        .map(|hit| {
            let mut entry = json!({
                "lineNum": hit.line.line_num,
                "raw": hit.line.raw,
            });
            let obj = entry
                .as_object_mut()
                .expect("json! object literal is an object");
            if !hit.captures.is_empty() {
                obj.insert("captures".to_string(), json!(hit.captures));
            }
            if !hit.context_before.is_empty() {
                obj.insert(
                    "contextBefore".to_string(),
                    json!(context_entries(&hit.context_before)),
                );
            }
            if !hit.context_after.is_empty() {
                obj.insert(
                    "contextAfter".to_string(),
                    json!(context_entries(&hit.context_after)),
                );
            }
            entry
        })
        .collect();

    json!({
        "sessionId": session_id,
        "pattern": params.pattern,
        "caseInsensitive": case_insensitive,
        "matchCount": hits.returned,
        "limit": limit,
        "matches": matches,
        "scannedLines": hits.scanned_lines,
        "truncated": hits.truncated,
    })
}

/// `search`'s minimal context element: line number and text, nothing else.
fn context_entries(lines: &[ViewLine]) -> Vec<Value> {
    lines
        .iter()
        .map(|l| json!({ "lineNum": l.line_num, "raw": l.raw }))
        .collect()
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/search_with_context
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub(crate) struct SearchWithContextParams {
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

pub(crate) async fn h_search_with_context(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<SearchWithContextParams>,
    headers: HeaderMap,
) -> Json<Value> {
    let sctx = ctx.svc(client_name(&headers));
    let rendered = tokio::task::spawn_blocking(move || {
        search_with_context_json(&sctx, &session_id, &params)
    })
    .await;
    Json(rendered.unwrap_or_else(
        |e| json!({ "error": format!("search_with_context task failed: {e}") }),
    ))
}

/// The whole of `h_search_with_context` minus axum. Separated so the golden
/// test can call it.
fn search_with_context_json(
    ctx: &ServiceCtx,
    session_id: &str,
    params: &SearchWithContextParams,
) -> Value {
    let max_results = params.max_results.unwrap_or(10).min(50);
    let context_lines = params.context_lines.unwrap_or(3).min(10);
    let case_insensitive = params.case_insensitive.unwrap_or(false);
    let offset = params.offset.unwrap_or(0);
    let max_line_chars = params.max_line_chars.unwrap_or(500).clamp(1, 8000);

    let req = SearchHitsRequest {
        session_id: session_id.to_string(),
        pattern: params.query.clone(),
        case_insensitive,
        context_before: context_lines,
        context_after: context_lines,
        offset,
        limit: max_results,
        start_line: params.start_line,
        end_line: params.end_line,
        max_line_chars,
        with_captures: false,
        // This endpoint keeps scanning the whole (possibly capped) range to
        // produce an exact `matchCount` rather than stopping once
        // `max_results` is reached. That full-scan-for-counting design is
        // tracked separately (item c5d058b3) and is unchanged here.
        count_all_matches: true,
        count_unreadable_as_scanned: false,
        redact_match_line_first: false,
    };

    let hits: SearchHits = match search::hits(ctx, &req) {
        Ok(h) => h,
        Err(e) => return error_json(&e, session_id, "invalid regex", "query", &params.query),
    };

    let matches: Vec<Value> = hits
        .hits
        .iter()
        .map(|hit| {
            // One flat list in reading order; `isMatch` is `is_context`
            // inverted, which is how the service carries the same fact.
            let context: Vec<Value> = hit
                .context_before
                .iter()
                .chain(std::iter::once(&hit.line))
                .chain(hit.context_after.iter())
                .map(|l| {
                    json!({
                        "lineNum": l.line_num,
                        "level": l.level.as_str(),
                        "tag": l.tag,
                        "raw": l.raw,
                        "isMatch": !l.is_context,
                    })
                })
                .collect();
            json!({
                "matchLineNum": hit.line.line_num,
                "context": context,
            })
        })
        .collect();

    json!({
        "sessionId": session_id,
        "query": params.query,
        "caseInsensitive": case_insensitive,
        // True count across the whole scan range, independent of max_results
        // and offset. `returned` is how many are in this page.
        "matchCount": hits.total,
        "returned": hits.returned,
        "maxResults": max_results,
        "contextLines": context_lines,
        "offset": offset,
        "maxLineChars": max_line_chars,
        "totalLinesInSession": hits.total_lines,
        "matches": matches,
        "scannedLines": hits.scanned_lines,
        "truncated": hits.truncated,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::AppState;
    use crate::core::session::AnalysisSession;
    use crate::services::lines::{
        MCP_SCAN_CHUNK_SIZE, MCP_SCAN_LINE_CAP, capped_range_end, scan_chunk_bounds,
        scan_window_capped,
    };
    use crate::services::policy::anonymize_scan_line;
    use crate::services::testing::{fixture_session, fixture_session_with_pii, test_ctx};

    // ── The golden reference ────────────────────────────────────────────────
    //
    // `ref_search` and `ref_search_with_context` below are the pre-service
    // bodies of `h_search` and `h_search_with_context`, copied verbatim from
    // commit dc3f4b2 and frozen. They read `AppState` directly, exactly as the
    // handlers did, with the single mechanical change that the `return
    // Json(...)` statements the macros expanded to become plain `return`s of
    // the same `Value` (these are functions, not axum handlers).
    //
    // Pinning against a frozen implementation rather than a checked-in JSON
    // blob is deliberate (same rationale as `routes/lines.rs`): a literal
    // snapshot only pins the handful of inputs someone thought to capture,
    // whereas this runs both implementations over the same case table and
    // diffs the whole response — including the fields nobody remembered to
    // look at. The cost is that the reference must never be "fixed": if a case
    // fails, the new code is wrong, not this copy.

    /// Frozen copy of the pre-service `h_search` body.
    fn ref_search(state: &AppState, session_id: &str, params: &SearchParams) -> Value {
        let session_id = session_id.to_string();
        let limit = params.limit.unwrap_or(50).min(200);
        let context = params.context.unwrap_or(0).min(5);
        let case_insensitive = params.case_insensitive.unwrap_or(false);

        let pattern_str = if case_insensitive {
            format!("(?i){}", params.pattern)
        } else {
            params.pattern.clone()
        };

        let regex = match regex::Regex::new(&pattern_str) {
            Ok(re) => re,
            Err(e) => {
                return json!({
                    "error": format!("invalid regex pattern: {e}"),
                    "pattern": params.pattern,
                });
            }
        };

        struct MatchResult {
            line_num: usize,
            raw: String,
            captures: Vec<String>,
            context_before: Vec<(usize, String)>,
            context_after: Vec<(usize, String)>,
        }

        let total: usize = {
            let Ok(sessions) = state.sessions.lock() else {
                return json!({ "error": "sessions lock poisoned" });
            };
            let Some(session) = sessions.get(&session_id) else {
                return json!({ "error": format!("Session not found: {}", session_id) });
            };
            let Some(source) = session.primary_source() else {
                return json!({ "error": format!("Session has no sources: {}", session_id) });
            };
            source.total_lines()
        };
        let range_start = params.start_line.unwrap_or(0).min(total);
        let requested_end = params.end_line.unwrap_or(total).min(total);
        let cap_applied = scan_window_capped(range_start, requested_end, MCP_SCAN_LINE_CAP);
        let range_end = capped_range_end(range_start, requested_end, MCP_SCAN_LINE_CAP);

        let mut results: Vec<MatchResult> = Vec::new();
        let mut lines_scanned: usize = 0;
        let mut session_lost = false;

        'chunks: for (chunk_start, chunk_end) in
            scan_chunk_bounds(range_start, range_end, MCP_SCAN_CHUNK_SIZE)
        {
            if results.len() >= limit {
                break;
            }

            {
                let Ok(sessions) = state.sessions.lock() else {
                    return json!({ "error": "sessions lock poisoned" });
                };
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
                    if results.len() >= limit {
                        break;
                    }
                    lines_scanned += 1;
                    let Some(raw) = source.raw_line(i) else {
                        continue;
                    };

                    if let Some(caps) = regex.captures(&raw) {
                        let captures: Vec<String> = (1..caps.len())
                            .filter_map(|j| caps.get(j).map(|m| m.as_str().to_string()))
                            .collect();

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
        }

        let truncated = session_lost || (cap_applied && results.len() < limit);

        let total_matches = results.len();
        let results_json: Vec<Value> = results
            .into_iter()
            .map(|m| {
                let clean_raw = anonymize_scan_line(state, &session_id, &m.raw, 500);
                let mut entry = json!({
                    "lineNum": m.line_num,
                    "raw": clean_raw,
                });
                if !m.captures.is_empty() {
                    entry
                        .as_object_mut()
                        .map(|o| o.insert("captures".to_string(), json!(m.captures)));
                }
                if !m.context_before.is_empty() {
                    let before: Vec<Value> = m
                        .context_before
                        .into_iter()
                        .map(|(ln, text)| {
                            json!({ "lineNum": ln, "raw": anonymize_scan_line(state, &session_id, &text, 500) })
                        })
                        .collect();
                    entry
                        .as_object_mut()
                        .map(|o| o.insert("contextBefore".to_string(), json!(before)));
                }
                if !m.context_after.is_empty() {
                    let after: Vec<Value> = m
                        .context_after
                        .into_iter()
                        .map(|(ln, text)| {
                            json!({ "lineNum": ln, "raw": anonymize_scan_line(state, &session_id, &text, 500) })
                        })
                        .collect();
                    entry
                        .as_object_mut()
                        .map(|o| o.insert("contextAfter".to_string(), json!(after)));
                }
                entry
            })
            .collect();

        json!({
            "sessionId": session_id,
            "pattern": params.pattern,
            "caseInsensitive": case_insensitive,
            "matchCount": total_matches,
            "limit": limit,
            "matches": results_json,
            "scannedLines": lines_scanned,
            "truncated": truncated,
        })
    }

    /// Frozen copy of the pre-service `h_search_with_context` body.
    fn ref_search_with_context(
        state: &AppState,
        session_id: &str,
        params: &SearchWithContextParams,
    ) -> Value {
        let session_id = session_id.to_string();
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
                return json!({
                    "error": format!("invalid regex: {e}"),
                    "query": params.query,
                });
            }
        };

        let total: usize = {
            let Ok(sessions) = state.sessions.lock() else {
                return json!({ "error": "sessions lock poisoned" });
            };
            let Some(session) = sessions.get(&session_id) else {
                return json!({ "error": format!("Session not found: {}", session_id) });
            };
            let Some(source) = session.primary_source() else {
                return json!({ "error": format!("Session has no sources: {}", session_id) });
            };
            source.total_lines()
        };
        let range_start = params.start_line.unwrap_or(0).min(total);
        let requested_end = params.end_line.unwrap_or(total).min(total);
        let cap_applied = scan_window_capped(range_start, requested_end, MCP_SCAN_LINE_CAP);
        let range_end = capped_range_end(range_start, requested_end, MCP_SCAN_LINE_CAP);

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
        let mut total_matches: usize = 0;
        let mut lines_scanned: usize = 0;
        let mut session_lost = false;

        'chunks: for (chunk_start, chunk_end) in
            scan_chunk_bounds(range_start, range_end, MCP_SCAN_CHUNK_SIZE)
        {
            {
                let Ok(sessions) = state.sessions.lock() else {
                    return json!({ "error": "sessions lock poisoned" });
                };
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
                    let Some(raw) = source.raw_line(i) else {
                        continue;
                    };
                    lines_scanned += 1;

                    if regex.is_match(&raw) {
                        total_matches += 1;

                        if skipped < offset {
                            skipped += 1;
                            continue;
                        }
                        if results.len() >= max_results {
                            continue;
                        }
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
        }

        let truncated = session_lost || cap_applied;

        let returned = results.len();
        let results_json: Vec<Value> = results
            .into_iter()
            .map(|m| {
                let context: Vec<Value> = m
                    .context
                    .into_iter()
                    .map(|c| {
                        json!({
                            "lineNum": c.line_num,
                            "level": c.level,
                            "tag": c.tag,
                            "raw": anonymize_scan_line(state, &session_id, &c.raw, max_line_chars),
                            "isMatch": c.is_match,
                        })
                    })
                    .collect();
                json!({
                    "matchLineNum": m.match_line_num,
                    "context": context,
                })
            })
            .collect();

        json!({
            "sessionId": session_id,
            "query": params.query,
            "caseInsensitive": case_insensitive,
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
        })
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    fn fixtures() -> Vec<AnalysisSession> {
        vec![
            fixture_session("s1", 200),
            fixture_session_with_pii("p1", 50),
            fixture_session("empty", 0),
        ]
    }

    /// Two independent contexts over identical fixtures: one for the frozen
    /// reference, one for the service. Separate `AppState`s so neither side
    /// sees the other's anonymizer token numbering — an ordering difference
    /// then shows up as a diff instead of being papered over by a shared map.
    fn arena() -> (ServiceCtx, ServiceCtx, Vec<tempfile::TempDir>) {
        let mut a = test_ctx().agent("golden");
        let mut b = test_ctx().agent("golden");
        for session in fixtures() {
            a = a.with_session_object(session);
        }
        for session in fixtures() {
            b = b.with_session_object(session);
        }
        let (ref_ctx, t1) = a.build();
        let (new_ctx, t2) = b.build();
        (ref_ctx, new_ctx, vec![t1, t2])
    }

    fn sp(pattern: &str) -> SearchParams {
        SearchParams {
            pattern: pattern.to_string(),
            ..Default::default()
        }
    }

    fn swc(query: &str) -> SearchWithContextParams {
        SearchWithContextParams {
            query: query.to_string(),
            ..Default::default()
        }
    }

    // ── h_search parity ─────────────────────────────────────────────────────

    #[test]
    fn search_json_matches_the_frozen_handler() {
        let (ref_ctx, new_ctx, _tmp) = arena();

        let cases: Vec<(&str, &str, SearchParams)> = vec![
            ("plain text pattern", "s1", sp("line 1")),
            ("pattern matching nothing", "s1", sp("no-such-text")),
            ("anchored regex", "s1", sp(r"^line 4\d$")),
            (
                "regex with one capture group",
                "s1",
                sp(r"^line (\d+)$"),
            ),
            (
                "regex with two capture groups",
                "s1",
                sp(r"^(line) (1\d)$"),
            ),
            (
                "regex with a non-participating group",
                "s1",
                sp(r"^line (?:(9)|(1\d))$"),
            ),
            (
                "case-insensitive",
                "s1",
                SearchParams {
                    case_insensitive: Some(true),
                    ..sp("LINE 7")
                },
            ),
            (
                "case-sensitive misses",
                "s1",
                sp("LINE 7"),
            ),
            (
                "limit below the match count",
                "s1",
                SearchParams {
                    limit: Some(3),
                    ..sp("line")
                },
            ),
            (
                "limit above the max is clamped",
                "s1",
                SearchParams {
                    limit: Some(9_999),
                    ..sp("line 3")
                },
            ),
            (
                "with context",
                "s1",
                SearchParams {
                    context: Some(2),
                    ..sp(r"^line 50$")
                },
            ),
            (
                "context clamped at the start of the log",
                "s1",
                SearchParams {
                    context: Some(3),
                    ..sp(r"^line 0$")
                },
            ),
            (
                "context clamped at the end of the log",
                "s1",
                SearchParams {
                    context: Some(3),
                    ..sp(r"^line 199$")
                },
            ),
            (
                "context above the max is clamped",
                "s1",
                SearchParams {
                    context: Some(50),
                    ..sp(r"^line 100$")
                },
            ),
            (
                "start_line / end_line window",
                "s1",
                SearchParams {
                    start_line: Some(20),
                    end_line: Some(30),
                    ..sp("line")
                },
            ),
            (
                "window past EOF",
                "s1",
                SearchParams {
                    start_line: Some(500),
                    end_line: Some(900),
                    ..sp("line")
                },
            ),
            (
                "inverted window",
                "s1",
                SearchParams {
                    start_line: Some(90),
                    end_line: Some(10),
                    ..sp("line")
                },
            ),
            ("empty session", "empty", sp("anything")),
            ("unknown session", "nope", sp("line")),
            ("invalid regex", "s1", sp("(unclosed")),
            ("invalid regex on unknown session", "nope", sp("(unclosed")),
            ("PII session", "p1", sp("contact")),
            (
                "PII session with context",
                "p1",
                SearchParams {
                    context: Some(2),
                    limit: Some(3),
                    ..sp(r"^line 2\d")
                },
            ),
        ];

        for (name, session_id, params) in cases {
            let expected = ref_search(ref_ctx.state(), session_id, &params);
            let actual = search_json(&new_ctx, session_id, &params);
            assert_eq!(actual, expected, "h_search JSON changed for case: {name}");
        }
    }

    // ── h_search_with_context parity ────────────────────────────────────────

    #[test]
    fn search_with_context_json_matches_the_frozen_handler() {
        let (ref_ctx, new_ctx, _tmp) = arena();

        let cases: Vec<(&str, &str, SearchWithContextParams)> = vec![
            ("defaults", "s1", swc(r"^line 5\d$")),
            ("query matching nothing", "s1", swc("no-such-text")),
            (
                "zero context lines",
                "s1",
                SearchWithContextParams {
                    context_lines: Some(0),
                    ..swc(r"^line 5$")
                },
            ),
            (
                "context above the max is clamped",
                "s1",
                SearchWithContextParams {
                    context_lines: Some(99),
                    ..swc(r"^line 100$")
                },
            ),
            (
                "context clamped at the start of the log",
                "s1",
                swc(r"^line 0$"),
            ),
            (
                "context clamped at the end of the log",
                "s1",
                swc(r"^line 199$"),
            ),
            (
                "max_results below the match count",
                "s1",
                SearchWithContextParams {
                    max_results: Some(2),
                    ..swc("line")
                },
            ),
            (
                "max_results above the cap is clamped",
                "s1",
                SearchWithContextParams {
                    max_results: Some(9_999),
                    ..swc("line 3")
                },
            ),
            (
                "offset",
                "s1",
                SearchWithContextParams {
                    offset: Some(10),
                    max_results: Some(3),
                    ..swc(r"^line \d+$")
                },
            ),
            (
                "offset past the end",
                "s1",
                SearchWithContextParams {
                    offset: Some(10_000),
                    ..swc(r"^line \d+$")
                },
            ),
            (
                "case-insensitive",
                "s1",
                SearchWithContextParams {
                    case_insensitive: Some(true),
                    ..swc("LINE 7")
                },
            ),
            (
                "max_line_chars truncates",
                "s1",
                SearchWithContextParams {
                    max_line_chars: Some(4),
                    ..swc(r"^line 12$")
                },
            ),
            (
                "max_line_chars clamped to the floor",
                "s1",
                SearchWithContextParams {
                    max_line_chars: Some(0),
                    ..swc(r"^line 12$")
                },
            ),
            (
                "max_line_chars clamped to the ceiling",
                "s1",
                SearchWithContextParams {
                    max_line_chars: Some(999_999),
                    ..swc(r"^line 12$")
                },
            ),
            (
                "start_line / end_line window",
                "s1",
                SearchWithContextParams {
                    start_line: Some(20),
                    end_line: Some(30),
                    ..swc("line")
                },
            ),
            (
                "window past EOF",
                "s1",
                SearchWithContextParams {
                    start_line: Some(500),
                    end_line: Some(900),
                    ..swc("line")
                },
            ),
            (
                "inverted window",
                "s1",
                SearchWithContextParams {
                    start_line: Some(90),
                    end_line: Some(10),
                    ..swc("line")
                },
            ),
            ("empty session", "empty", swc("anything")),
            ("unknown session", "nope", swc("line")),
            ("invalid regex", "s1", swc("(unclosed")),
            ("invalid regex on unknown session", "nope", swc("(unclosed")),
            ("PII session", "p1", swc("contact")),
            (
                "PII session, paged",
                "p1",
                SearchWithContextParams {
                    offset: Some(5),
                    max_results: Some(3),
                    ..swc("contact")
                },
            ),
        ];

        for (name, session_id, params) in cases {
            let expected = ref_search_with_context(ref_ctx.state(), session_id, &params);
            let actual = search_with_context_json(&new_ctx, session_id, &params);
            assert_eq!(
                actual, expected,
                "h_search_with_context JSON changed for case: {name}"
            );
        }
    }

    // ── Redaction gating (not expressible through the frozen reference, which
    //    always anonymizes because both sides run as an agent) ──────────────

    #[test]
    fn an_agent_without_the_anonymize_flag_gets_redacted_search_results() {
        let (ctx, _t) = test_ctx()
            .agent("mcp")
            .with_session_object(fixture_session_with_pii("p1", 20))
            .build();

        let out = search_json(
            &ctx,
            "p1",
            &SearchParams {
                context: Some(2),
                ..sp("contact")
            },
        );
        assert!(
            !out.to_string().contains("@example.com"),
            "PII survived redaction: {out}"
        );

        let out = search_with_context_json(&ctx, "p1", &swc("contact"));
        assert!(
            !out.to_string().contains("@example.com"),
            "PII survived redaction: {out}"
        );
    }

    #[test]
    fn a_ui_caller_gets_raw_text() {
        let (ctx, _t) = test_ctx()
            .caller(crate::services::Caller::Ui)
            .with_session_object(fixture_session_with_pii("p1", 20))
            .build();

        let out = search_json(&ctx, "p1", &sp("contact"));
        assert!(out.to_string().contains("@example.com"));
    }
}
