//! Regex search endpoints: search, search_with_context.

use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{
    MCP_SCAN_CHUNK_SIZE, MCP_SCAN_LINE_CAP, capped_range_end, get_session_and_source,
    lock_or_json_err, scan_chunk_bounds, scan_window_capped,
};
use crate::services::policy::anonymize_scan_line;

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/search
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
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
) -> Json<Value> {
    let state = &*ctx.state;
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
        let clean_raw = anonymize_scan_line(state, &session_id, &m.raw, 500);
        let mut entry = json!({
            "lineNum": m.line_num,
            "raw": clean_raw,
        });
        if !m.captures.is_empty() {
            entry.as_object_mut().map(|o| o.insert("captures".to_string(), json!(m.captures)));
        }
        if !m.context_before.is_empty() {
            let before: Vec<Value> = m.context_before.into_iter()
                .map(|(ln, text)| json!({ "lineNum": ln, "raw": anonymize_scan_line(state, &session_id, &text, 500) }))
                .collect();
            entry.as_object_mut().map(|o| o.insert("contextBefore".to_string(), json!(before)));
        }
        if !m.context_after.is_empty() {
            let after: Vec<Value> = m.context_after.into_iter()
                .map(|(ln, text)| json!({ "lineNum": ln, "raw": anonymize_scan_line(state, &session_id, &text, 500) }))
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
// GET /mcp/sessions/{session_id}/search_with_context
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
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
) -> Json<Value> {
    let state = &*ctx.state;
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
                "raw": anonymize_scan_line(state, &session_id, &c.raw, max_line_chars),
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
