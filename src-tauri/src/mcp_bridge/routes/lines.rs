//! Raw-line sampling endpoints: query, lines_around, tag-stats.

use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{
    MCP_SCAN_CHUNK_SIZE, MCP_SCAN_LINE_CAP, capped_range_end, contains_ignore_case,
    get_session_and_source, lock_or_json_err, parse_iso_to_unix_nanos, scan_window_capped,
};
use crate::services::policy::anonymize_for_session;
use crate::services::policy::anonymize_scan_line;

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/query
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
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
) -> Json<Value> {
    let state = &*ctx.state;
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
                    // Message filter (case-insensitive) — avoids allocating
                    // a lowercased copy of `raw` per scanned line.
                    if let Some(ref needle) = msg_needle {
                        if !contains_ignore_case(&raw, needle.as_str()) { continue; }
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
    //
    // Deliberately NOT truncated (unlike h_search/h_search_with_context/
    // h_lines_around, which all cap `raw` via `anonymize_scan_line`/
    // `truncate_str`). h_query has no `max_line_chars` param and its doc
    // ("Returns the raw line text plus level and tag metadata") makes no
    // truncation caveat, unlike h_search_with_context's tool doc which
    // spells the cap out explicitly. `n` is also capped at 200 (vs.
    // max_results on the search endpoints), keeping worst-case payload size
    // bounded without needing a per-line cap. Adding truncation here would
    // silently change this endpoint's response shape for existing callers.
    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    let mut level_counts: HashMap<&str, usize> = HashMap::new();

    let lines: Vec<Value> = snaps
        .into_iter()
        .map(|snap| {
            *tag_counts.entry(snap.tag.clone()).or_insert(0) += 1;
            *level_counts.entry(snap.level).or_insert(0) += 1;
            let raw = anonymize_for_session(state, &session_id, &snap.raw);
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

#[derive(Deserialize)]
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
) -> Json<Value> {
    let state = &*ctx.state;
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
                "raw": anonymize_scan_line(state, &session_id, &s.raw, 500),
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
