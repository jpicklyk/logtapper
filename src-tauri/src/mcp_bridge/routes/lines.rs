//! Raw-line sampling endpoints: query, lines_around, tag-stats.
//!
//! `h_query` and `h_lines_around` are thin adapters over
//! [`services::lines::get_lines`](crate::services::lines::get_lines): they
//! translate query-string parameters into a [`LinesRequest`] and render the
//! resulting [`LinePage`](crate::services::wire::LinePage) into the exact JSON
//! these two endpoints have always returned. WP-13 replaces the rendering with
//! `LinePage` itself; until then the shape below is the contract with every
//! shipped MCP client, and the golden tests at the bottom of this file pin it
//! against frozen copies of the pre-service handler bodies.
//!
//! `h_tag_stats` still reads `AppState` directly — it aggregates `line_meta`
//! rather than returning line text, so it is not a lines-service caller.

use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{get_session_and_source, parse_iso_to_unix_nanos};
use crate::services::lines::{self, LineFilters, LineSelection, LinesRequest, NO_SOURCES};
use crate::services::wire::LinePage;
use crate::services::{ServiceCtx, ServiceError};

/// The self-reported client name, for the [`Caller`](crate::services::Caller)
/// identity. Labels the activity feed only — never trusted for authorization,
/// and irrelevant to these two handlers beyond `Caller::Agent` being what
/// makes [`policy::redact_line`](crate::services::policy::redact_line)
/// anonymize at all.
fn client_name(headers: &HeaderMap) -> &str {
    headers
        .get("x-logtapper-client")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .unwrap_or("mcp")
}

/// Render a [`ServiceError`] in this module's historical error spellings.
///
/// The service says `Session 'x' not found`; these two endpoints have always
/// said `Session not found: x`, and `Session has no sources: x` where the
/// service says [`NO_SOURCES`]. Everything else (notably a poisoned `sessions`
/// lock, which renders `"sessions lock poisoned"`) already matches byte for
/// byte. WP-13 deletes this and ships the structured error.
fn error_json(err: &ServiceError, session_id: &str) -> Value {
    let message = match err {
        ServiceError::NotFound(_) => format!("Session not found: {session_id}"),
        ServiceError::InvalidArg { message, .. } if message == NO_SOURCES => {
            format!("Session has no sources: {session_id}")
        }
        other => other.message(),
    };
    json!({ "error": message })
}

/// The `{ lineNum, level, tag, raw }` element both endpoints emit.
fn line_json(line: &crate::core::line::ViewLine) -> Value {
    json!({
        "lineNum": line.line_num,
        "level": line.level.as_str(),
        "tag": line.tag,
        "raw": line.raw,
    })
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/query
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub(crate) struct QueryParams {
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

pub(crate) async fn h_query(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<QueryParams>,
    headers: HeaderMap,
) -> Json<Value> {
    let sctx = ctx.svc(client_name(&headers));
    // `services::lines::get_lines` is synchronous by contract: it takes the
    // `sessions` lock once per scan chunk and must never hold one across an
    // await, so it runs on the blocking pool instead of the request's worker
    // (which is also what the old handler's `yield_now()` between chunks was
    // approximating).
    let rendered =
        tokio::task::spawn_blocking(move || query_json(&sctx, &session_id, &params)).await;
    Json(rendered.unwrap_or_else(|e| json!({ "error": format!("query task failed: {e}") })))
}

/// The whole of `h_query` minus axum. Separated so the golden test can call it.
fn query_json(ctx: &ServiceCtx, session_id: &str, params: &QueryParams) -> Value {
    let n = params.n.unwrap_or(50).min(200);
    let strategy = params.strategy.as_deref().unwrap_or("recent");

    // Parse time range filters upfront (ISO 8601 → Unix-epoch nanos, same
    // epoch as meta.timestamp for logcat/bugreport lines).
    let time_start_ns = params.time_start.as_deref().and_then(parse_iso_to_unix_nanos);
    let time_end_ns = params.time_end.as_deref().and_then(parse_iso_to_unix_nanos);

    // The strategy string is free-form on the wire and anything unrecognised
    // has always fallen through to uniform sampling — preserved here, and
    // echoed back verbatim in the response's `strategy` field.
    let selection = match strategy {
        "recent" => LineSelection::Recent { count: n },
        "around" => LineSelection::Centered {
            line: params.around_line,
            count: n,
        },
        _ => LineSelection::Uniform { count: n },
    };

    let filters = LineFilters {
        start_line: params.start_line,
        end_line: params.end_line,
        min_level: params.level.clone(),
        tag: params.tag.clone(),
        text: params.message.clone(),
        time_start_ns,
        time_end_ns,
    };
    // Whether the service will scan rather than sample — this endpoint reports
    // it through three extra fields, so the adapter needs to know too.
    let has_filter = filters.is_active();

    let req = LinesRequest::range(session_id, 0, n)
        .select(selection)
        .filter(filters)
        // No per-line character cap: `h_query` has never truncated (unlike
        // `lines_around` / the search endpoints), and `n <= 200` bounds the
        // payload without one. Adding a cap here would silently change the
        // response for existing callers.
        .for_agent(None);

    let page: LinePage = match lines::get_lines(ctx, req) {
        Ok(page) => page,
        Err(e) => return error_json(&e, session_id),
    };

    let lines: Vec<Value> = page.lines.iter().map(line_json).collect();
    let stats = page.stats.unwrap_or_default();

    let mut result = json!({
        "sessionId": session_id,
        "totalLinesInSession": page.total_lines,
        "sampledCount": lines.len(),
        "strategy": strategy,
        "lines": lines,
        "stats": {
            "tagCounts": stats.tag_counts,
            "levelCounts": stats.level_counts,
        },
    });
    if has_filter {
        result["strategyNote"] = json!(format!(
            "Filters active — switched to full scan mode using '{}' ordering (scan capped at {} lines)",
            strategy,
            lines::MCP_SCAN_LINE_CAP
        ));
        // Additive fields, present only on the filtered/scan path: the plain
        // sample never scans, so there is nothing meaningful to report.
        result["scannedLines"] = json!(page.scanned_lines.unwrap_or(0));
        result["truncated"] = json!(page.truncated);
    }
    result
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/tag-stats?top_n=50
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct TagStatsParams {
    /// Number of top tags to return (default 50).
    top_n: Option<usize>,
}

pub(crate) async fn h_tag_stats(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<TagStatsParams>,
) -> Json<Value> {
    let state = &*ctx.state;
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

#[derive(Deserialize, Default)]
pub(crate) struct LinesAroundParams {
    /// Center line number (required).
    line: usize,
    /// Number of lines before the center (default 20, max 100).
    before: Option<usize>,
    /// Number of lines after the center (default 20, max 100).
    after: Option<usize>,
}

pub(crate) async fn h_lines_around(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Query(params): Query<LinesAroundParams>,
    headers: HeaderMap,
) -> Json<Value> {
    let sctx = ctx.svc(client_name(&headers));
    let rendered =
        tokio::task::spawn_blocking(move || lines_around_json(&sctx, &session_id, &params)).await;
    Json(rendered.unwrap_or_else(|e| json!({ "error": format!("lines_around task failed: {e}") })))
}

/// The whole of `h_lines_around` minus axum. Separated so the golden test can
/// call it.
fn lines_around_json(ctx: &ServiceCtx, session_id: &str, params: &LinesAroundParams) -> Value {
    let before = params.before.unwrap_or(20).min(100);
    let after = params.after.unwrap_or(20).min(100);
    let center = params.line;

    // `Around` clamps at the log's start and end and returns *fewer* lines
    // there — it never shifts the window to keep returning `before + after +
    // 1`, which is what distinguishes it from `h_query`'s "around" sampling.
    let mut req = LinesRequest::range(session_id, 0, 0)
        .select(LineSelection::Around {
            line: center,
            before,
            after,
        })
        // 500 chars per line, anonymized first so a redaction token is never
        // cut mid-token by the cap.
        .for_agent(Some(500));
    // This endpoint has never returned histograms.
    req.with_stats = false;

    let page = match lines::get_lines(ctx, req) {
        Ok(page) => page,
        Err(e) => return error_json(&e, session_id),
    };

    let lines: Vec<Value> = page
        .lines
        .iter()
        .map(|line| {
            let mut v = line_json(line);
            // The service marks every line but the centre as context; this
            // endpoint spells the same fact the other way round.
            v["isCenter"] = json!(!line.is_context);
            v
        })
        .collect();

    json!({
        "sessionId": session_id,
        "centerLine": center,
        "totalLinesInSession": page.total_lines,
        "lineCount": lines.len(),
        "lines": lines,
    })
}


// ---------------------------------------------------------------------------
// Golden tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::AppState;
    use crate::core::session::AnalysisSession;
    use crate::services::lines::{
        MCP_SCAN_CHUNK_SIZE, MCP_SCAN_LINE_CAP, capped_range_end, contains_ignore_case,
        level_at_least, scan_window_capped,
    };
    use crate::services::policy::{anonymize_for_session, anonymize_scan_line};
    use crate::services::testing::{fixture_session, fixture_session_with_pii, test_ctx};

    // ── The golden reference ────────────────────────────────────────────────
    //
    // `ref_query` and `ref_lines_around` below are the pre-service bodies of
    // `h_query` and `h_lines_around`, copied verbatim from commit 6d1e19b and
    // frozen. They read `AppState` directly, exactly as the handlers did.
    //
    // Pinning against a frozen implementation rather than a checked-in JSON
    // blob is deliberate: a literal snapshot only pins the handful of inputs
    // someone thought to capture, whereas this runs both implementations over
    // the same case table and diffs the whole response — including the fields
    // nobody remembered to look at. The cost is that the reference must never
    // be "fixed": if a case fails, the new code is wrong, not this copy.

    /// Frozen copy of the pre-service `sample_indices` helper.
    fn ref_sample_indices(
        total: usize,
        n: usize,
        strategy: &str,
        around: Option<usize>,
    ) -> Vec<usize> {
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
                if n >= total {
                    (0..total).collect()
                } else {
                    (0..n).map(|i| (i * total) / n).collect()
                }
            }
        }
    }

    /// Frozen copy of the pre-service `h_query` body.
    fn ref_query(state: &AppState, session_id: &str, params: &QueryParams) -> Value {
        let session_id = session_id.to_string();
        let n = params.n.unwrap_or(50).min(200);
        let strategy = params.strategy.as_deref().unwrap_or("recent");
        let time_start_ns = params.time_start.as_deref().and_then(parse_iso_to_unix_nanos);
        let time_end_ns = params.time_end.as_deref().and_then(parse_iso_to_unix_nanos);

        struct LineSnap {
            line_num: usize,
            level: &'static str,
            tag: String,
            raw: String,
        }

        let (snaps, total_lines): (Vec<LineSnap>, usize) = {
            let Ok(sessions) = state.sessions.lock() else {
                return json!({ "error": "sessions lock poisoned" });
            };
            let Some(session) = sessions.get(&session_id) else {
                return json!({ "error": format!("Session not found: {}", session_id) });
            };
            let Some(source) = session.primary_source() else {
                return json!({ "error": format!("Session has no sources: {}", session_id) });
            };
            let total = source.total_lines();
            let range_start = params.start_line.unwrap_or(0).min(total);
            let range_end = params.end_line.unwrap_or(total).min(total);
            let clamped_total = range_end.saturating_sub(range_start);
            let indices: Vec<usize> = if params.start_line.is_some() || params.end_line.is_some() {
                ref_sample_indices(
                    clamped_total,
                    n,
                    strategy,
                    params.around_line.map(|a| a.saturating_sub(range_start)),
                )
                .into_iter()
                .map(|i| i + range_start)
                .collect()
            } else {
                ref_sample_indices(total, n, strategy, params.around_line)
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

        let has_filter = params.tag.is_some()
            || params.message.is_some()
            || params.level.is_some()
            || time_start_ns.is_some()
            || time_end_ns.is_some();

        let mut query_lines_scanned: usize = 0;
        let mut query_truncated = false;

        let snaps = if has_filter {
            let range_start = params.start_line.unwrap_or(0).min(total_lines);
            let range_end = params.end_line.unwrap_or(total_lines).min(total_lines);
            let cap_applied = scan_window_capped(range_start, range_end, MCP_SCAN_LINE_CAP);
            let scan_indices: Vec<usize> = match strategy {
                "recent" => {
                    let start = range_start.max(range_end.saturating_sub(MCP_SCAN_LINE_CAP));
                    (start..range_end).rev().collect()
                }
                "around" => {
                    let center = params
                        .around_line
                        .unwrap_or_else(|| range_end.saturating_sub(1))
                        .clamp(range_start, range_end.saturating_sub(1));
                    let half = MCP_SCAN_LINE_CAP / 2;
                    let start = center.saturating_sub(half).max(range_start);
                    let end = (center + half).min(range_end);
                    (start..=center)
                        .rev()
                        .zip(((center + 1)..end).map(Some).chain(std::iter::repeat(None)))
                        .flat_map(|(b, a)| std::iter::once(b).chain(a))
                        .collect()
                }
                _ => {
                    let end = capped_range_end(range_start, range_end, MCP_SCAN_LINE_CAP);
                    (range_start..end).collect()
                }
            };

            let msg_needle = params.message.as_ref().map(|m| m.to_lowercase());
            let mut matched: Vec<LineSnap> = Vec::new();
            let mut session_lost = false;

            'chunks: for idx_chunk in scan_indices.chunks(MCP_SCAN_CHUNK_SIZE) {
                if matched.len() >= n {
                    break;
                }
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
                for &i in idx_chunk {
                    if matched.len() >= n {
                        break;
                    }
                    query_lines_scanned += 1;
                    let Some(raw) = source.raw_line(i) else { continue };
                    let Some(meta) = source.meta_at(i) else { continue };
                    let level_str = meta.level.as_str();
                    if let Some(ref tf) = params.tag {
                        if session.resolve_tag(meta.tag_id) != tf {
                            continue;
                        }
                    }
                    if let Some(ref needle) = msg_needle {
                        if !contains_ignore_case(&raw, needle.as_str()) {
                            continue;
                        }
                    }
                    if let Some(ref lf) = params.level {
                        if !level_at_least(level_str, lf) {
                            continue;
                        }
                    }
                    if let Some(ts) = time_start_ns {
                        if meta.timestamp < ts {
                            continue;
                        }
                    }
                    if let Some(ts) = time_end_ns {
                        if meta.timestamp > ts {
                            continue;
                        }
                    }
                    matched.push(LineSnap {
                        line_num: i,
                        level: level_str,
                        tag: session.resolve_tag(meta.tag_id).to_string(),
                        raw: raw.into_owned(),
                    });
                }
            }
            if strategy == "recent" {
                matched.reverse();
            }
            query_truncated = session_lost || (cap_applied && matched.len() < n);
            matched
        } else {
            snaps
        };

        let mut tag_counts: HashMap<String, usize> = HashMap::new();
        let mut level_counts: HashMap<&str, usize> = HashMap::new();
        let lines: Vec<Value> = snaps
            .into_iter()
            .map(|snap| {
                *tag_counts.entry(snap.tag.clone()).or_insert(0) += 1;
                *level_counts.entry(snap.level).or_insert(0) += 1;
                let raw = anonymize_for_session(state, &session_id, &snap.raw);
                json!({ "lineNum": snap.line_num, "level": snap.level, "tag": snap.tag, "raw": raw })
            })
            .collect();

        let count = lines.len();
        let mut result = json!({
            "sessionId": session_id,
            "totalLinesInSession": total_lines,
            "sampledCount": count,
            "strategy": strategy,
            "lines": lines,
            "stats": { "tagCounts": tag_counts, "levelCounts": level_counts },
        });
        if has_filter {
            result["strategyNote"] = json!(format!(
                "Filters active — switched to full scan mode using '{}' ordering (scan capped at {} lines)",
                strategy, MCP_SCAN_LINE_CAP
            ));
            result["scannedLines"] = json!(query_lines_scanned);
            result["truncated"] = json!(query_truncated);
        }
        result
    }

    /// Frozen copy of the pre-service `h_lines_around` body.
    fn ref_lines_around(state: &AppState, session_id: &str, params: &LinesAroundParams) -> Value {
        let session_id = session_id.to_string();
        let before = params.before.unwrap_or(20).min(100);
        let after = params.after.unwrap_or(20).min(100);
        let center = params.line;

        struct LineAroundSnap {
            line_num: usize,
            level: &'static str,
            tag: String,
            raw: String,
            is_center: bool,
        }

        let (snaps, total): (Vec<LineAroundSnap>, usize) = {
            let Ok(sessions) = state.sessions.lock() else {
                return json!({ "error": "sessions lock poisoned" });
            };
            let Some(session) = sessions.get(&session_id) else {
                return json!({ "error": format!("Session not found: {}", session_id) });
            };
            let Some(source) = session.primary_source() else {
                return json!({ "error": format!("Session has no sources: {}", session_id) });
            };
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

        let lines: Vec<Value> = snaps
            .into_iter()
            .map(|s| {
                json!({
                    "lineNum": s.line_num,
                    "level": s.level,
                    "tag": s.tag,
                    "raw": anonymize_scan_line(state, &session_id, &s.raw, 500),
                    "isCenter": s.is_center,
                })
            })
            .collect();

        json!({
            "sessionId": session_id,
            "centerLine": center,
            "totalLinesInSession": total,
            "lineCount": lines.len(),
            "lines": lines,
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

    fn qp(n: Option<usize>, strategy: Option<&str>) -> QueryParams {
        QueryParams {
            n,
            strategy: strategy.map(str::to_string),
            ..Default::default()
        }
    }

    // ── h_query parity ──────────────────────────────────────────────────────

    #[test]
    fn query_json_matches_the_frozen_handler_across_strategies_and_filters() {
        let (ref_ctx, new_ctx, _tmp) = arena();

        let cases: Vec<(&str, &str, QueryParams)> = vec![
            ("default (recent, n=50)", "s1", QueryParams::default()),
            ("uniform n=10", "s1", qp(Some(10), Some("uniform"))),
            (
                "uniform n=7 (non-divisor)",
                "s1",
                qp(Some(7), Some("uniform")),
            ),
            ("recent n over total", "s1", qp(Some(500), Some("recent"))),
            (
                "unrecognised strategy falls back to uniform",
                "s1",
                qp(Some(3), Some("bogus")),
            ),
            (
                "around, centre mid-log",
                "s1",
                QueryParams {
                    around_line: Some(100),
                    ..qp(Some(8), Some("around"))
                },
            ),
            (
                "around, centre near start",
                "s1",
                QueryParams {
                    around_line: Some(2),
                    ..qp(Some(8), Some("around"))
                },
            ),
            (
                "around, centre past EOF",
                "s1",
                QueryParams {
                    around_line: Some(5_000),
                    ..qp(Some(8), Some("around"))
                },
            ),
            ("around, no centre given", "s1", qp(Some(6), Some("around"))),
            (
                "range-clamped uniform",
                "s1",
                QueryParams {
                    start_line: Some(10),
                    end_line: Some(20),
                    ..qp(Some(4), Some("uniform"))
                },
            ),
            (
                "range-clamped around",
                "s1",
                QueryParams {
                    start_line: Some(10),
                    end_line: Some(20),
                    around_line: Some(15),
                    ..qp(Some(4), Some("around"))
                },
            ),
            (
                "range-clamped recent",
                "s1",
                QueryParams {
                    start_line: Some(10),
                    end_line: Some(20),
                    ..qp(Some(4), Some("recent"))
                },
            ),
            (
                "message filter, recent order",
                "s1",
                QueryParams {
                    message: Some("line 1".into()),
                    ..qp(Some(5), Some("recent"))
                },
            ),
            (
                "message filter, uniform order",
                "s1",
                QueryParams {
                    message: Some("line 1".into()),
                    ..qp(Some(5), Some("uniform"))
                },
            ),
            (
                "message filter, around order",
                "s1",
                QueryParams {
                    message: Some("line".into()),
                    around_line: Some(100),
                    ..qp(Some(4), Some("around"))
                },
            ),
            (
                "message filter matching nothing",
                "s1",
                QueryParams {
                    message: Some("no-such-text".into()),
                    ..qp(Some(5), Some("recent"))
                },
            ),
            (
                "message filter is case-insensitive",
                "s1",
                QueryParams {
                    message: Some("LINE 4".into()),
                    ..qp(Some(5), Some("recent"))
                },
            ),
            (
                "level filter above every line",
                "s1",
                QueryParams {
                    level: Some("W".into()),
                    ..qp(Some(5), None)
                },
            ),
            (
                "level filter at the line level",
                "s1",
                QueryParams {
                    level: Some("I".into()),
                    ..qp(Some(5), None)
                },
            ),
            (
                "tag filter, empty tag matches",
                "s1",
                QueryParams {
                    tag: Some(String::new()),
                    ..qp(Some(3), None)
                },
            ),
            (
                "tag filter, no match",
                "s1",
                QueryParams {
                    tag: Some("Nope".into()),
                    ..qp(Some(3), None)
                },
            ),
            (
                "filter plus range clamp",
                "s1",
                QueryParams {
                    message: Some("line".into()),
                    start_line: Some(5),
                    end_line: Some(50),
                    ..qp(Some(5), Some("uniform"))
                },
            ),
            (
                "time filter, lower bound only",
                "s1",
                QueryParams {
                    time_start: Some("2001-09-09T01:46:41".into()),
                    ..qp(Some(4), Some("recent"))
                },
            ),
            (
                "time filter, unparseable bound is ignored",
                "s1",
                QueryParams {
                    time_start: Some("not-a-time".into()),
                    ..qp(Some(4), Some("recent"))
                },
            ),
            ("empty session", "empty", qp(Some(5), None)),
            (
                "empty session, filtered",
                "empty",
                QueryParams {
                    message: Some("x".into()),
                    ..qp(Some(5), None)
                },
            ),
            ("unknown session", "nope", qp(Some(5), None)),
            ("PII session, unfiltered", "p1", qp(Some(3), Some("recent"))),
            (
                "PII session, filtered",
                "p1",
                QueryParams {
                    message: Some("contact".into()),
                    ..qp(Some(3), Some("recent"))
                },
            ),
        ];

        for (name, session_id, params) in cases {
            let expected = ref_query(ref_ctx.state(), session_id, &params);
            let actual = query_json(&new_ctx, session_id, &params);
            assert_eq!(actual, expected, "h_query JSON changed for case: {name}");
        }
    }

    // ── h_lines_around parity ───────────────────────────────────────────────

    #[test]
    fn lines_around_json_matches_the_frozen_handler() {
        let (ref_ctx, new_ctx, _tmp) = arena();

        let cases: Vec<(&str, &str, LinesAroundParams)> = vec![
            (
                "defaults",
                "s1",
                LinesAroundParams {
                    line: 5,
                    ..Default::default()
                },
            ),
            (
                "line 0 — clamps at the start, never widens",
                "s1",
                LinesAroundParams {
                    line: 0,
                    ..Default::default()
                },
            ),
            (
                "line 0 with an explicit before",
                "s1",
                LinesAroundParams {
                    line: 0,
                    before: Some(50),
                    after: Some(3),
                },
            ),
            (
                "near EOF",
                "s1",
                LinesAroundParams {
                    line: 195,
                    before: Some(10),
                    after: Some(100),
                },
            ),
            (
                "past EOF",
                "s1",
                LinesAroundParams {
                    line: 5_000,
                    before: Some(10),
                    after: Some(10),
                },
            ),
            (
                "before/after over the max are clamped to 100",
                "s1",
                LinesAroundParams {
                    line: 120,
                    before: Some(9_999),
                    after: Some(9_999),
                },
            ),
            (
                "zero window returns just the centre",
                "s1",
                LinesAroundParams {
                    line: 7,
                    before: Some(0),
                    after: Some(0),
                },
            ),
            (
                "empty session",
                "empty",
                LinesAroundParams {
                    line: 0,
                    ..Default::default()
                },
            ),
            (
                "unknown session",
                "nope",
                LinesAroundParams {
                    line: 1,
                    ..Default::default()
                },
            ),
            (
                "PII session is anonymized",
                "p1",
                LinesAroundParams {
                    line: 2,
                    before: Some(2),
                    after: Some(2),
                },
            ),
        ];

        for (name, session_id, params) in cases {
            let expected = ref_lines_around(ref_ctx.state(), session_id, &params);
            let actual = lines_around_json(&new_ctx, session_id, &params);
            assert_eq!(
                actual, expected,
                "h_lines_around JSON changed for case: {name}"
            );
        }
    }

    // ── Facts the parity table cannot state on its own ──────────────────────

    #[test]
    fn query_json_anonymizes_for_an_agent_and_not_for_the_ui() {
        let (agent, _t1) = test_ctx()
            .agent("claude-code")
            .with_session_object(fixture_session_with_pii("p1", 3))
            .build();
        let (ui, _t2) = test_ctx()
            .with_session_object(fixture_session_with_pii("p1", 3))
            .build();

        let params = qp(Some(3), Some("recent"));
        let from_agent = query_json(&agent, "p1", &params);
        let from_ui = query_json(&ui, "p1", &params);

        let agent_raw = from_agent["lines"][0]["raw"].as_str().unwrap();
        let ui_raw = from_ui["lines"][0]["raw"].as_str().unwrap();
        assert!(
            !agent_raw.contains("@example.com"),
            "the agent path must redact — got {agent_raw}"
        );
        assert!(
            ui_raw.contains("@example.com"),
            "a Ui caller is never redacted — got {ui_raw}"
        );
    }

    #[test]
    fn query_json_redacts_when_the_anonymize_flag_is_absent() {
        // Fail-closed: no `set_mcp_anonymize` call for this session at all.
        let (ctx, _tmp) = test_ctx()
            .agent("claude-code")
            .with_session_object(fixture_session_with_pii("p1", 3))
            .build();
        let out = query_json(&ctx, "p1", &qp(Some(3), Some("recent")));
        for line in out["lines"].as_array().unwrap() {
            assert!(
                !line["raw"].as_str().unwrap().contains("@example.com"),
                "an unset flag must fail closed"
            );
        }
    }

    #[test]
    fn query_json_leaves_raw_alone_when_anonymization_is_switched_off() {
        let (ctx, _tmp) = test_ctx()
            .agent("claude-code")
            .with_session_object(fixture_session_with_pii("p1", 3))
            .mcp_anonymize("p1", false)
            .build();
        let out = query_json(&ctx, "p1", &qp(Some(3), Some("recent")));
        assert!(
            out["lines"][0]["raw"]
                .as_str()
                .unwrap()
                .contains("@example.com"),
            "an explicit opt-out must not redact"
        );
    }

    #[test]
    fn lines_around_truncates_at_500_chars_after_anonymizing() {
        let long = format!("head {} tail", "x".repeat(1_000));
        let session = crate::services::testing::fixture_session_from("long", vec![long]);
        let (ctx, _tmp) = test_ctx().agent("a").with_session_object(session).build();

        let out = lines_around_json(
            &ctx,
            "long",
            &LinesAroundParams {
                line: 0,
                ..Default::default()
            },
        );
        let raw = out["lines"][0]["raw"].as_str().unwrap();
        assert!(raw.ends_with("..."), "over-long lines are cut and marked");
        assert_eq!(raw.chars().count(), 503, "500 chars plus the ellipsis");
    }

    // ── level_at_least — moved to services::lines, still pinned here ────────

    #[test]
    fn level_at_least_orders_by_severity() {
        assert!(level_at_least("E", "W"));
        assert!(level_at_least("W", "W"));
        assert!(!level_at_least("D", "W"));
        // Unknown levels are treated as Info.
        assert!(level_at_least("?", "D"));
        assert!(!level_at_least("?", "W"));
    }
}
