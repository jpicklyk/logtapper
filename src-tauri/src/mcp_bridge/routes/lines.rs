//! Raw-line sampling endpoints: query, lines_around.
//!
//! Both are thin adapters over
//! [`services::lines::get_lines`](crate::services::lines::get_lines): they
//! translate query-string parameters into a [`LinesRequest`] and ship the
//! resulting [`LinePage`](crate::services::wire::LinePage) as-is.
//!
//! **Wire changes (WP-13).** These routes used to render bespoke JSON with a
//! `{ lineNum, level, tag, raw }` element type. They now answer `LinePage`, the
//! same envelope the viewer's own `get_lines` returns:
//!
//! | was | now |
//! |---|---|
//! | `totalLinesInSession` | `totalLines` |
//! | `sampledCount` / `lineCount` | `count` |
//! | `strategy` (echo of the query string) | `strategy` ([`LineStrategy`], tagged by `kind`) |
//! | `lines[].{lineNum,level,tag,raw}` | `lines[]` — the full [`ViewLine`](crate::core::line::ViewLine) |
//! | `lines[].isCenter` (lines_around) | `lines[].isContext`, inverted |
//! | `centerLine` (lines_around) | `strategy.line` |
//! | `scannedLines` / `truncated` (filtered only) | always present when meaningful |
//! | `stats.{tagCounts,levelCounts}` | `stats` — unchanged keys, now `LineStats` |
//!
//! `strategyNote` survives as free text on the filtered path. `sessionId` is
//! still echoed (it is `LinePage`'s own first field).
//!
//! `GET /mcp/sessions/{id}/tag-stats` was **deleted** in the same package: it
//! had no service, no Tauri command, and no `mcp-server` tool — an orphan that
//! read `AppState` directly through the last `get_session_and_source!`
//! expansion in the bridge. `GET /mcp/sessions/{id}/metadata` already reports
//! `totalLines`, and `.../query?n=…` reports the level and tag histograms over
//! a sample.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{client_name, parse_iso_to_unix_nanos};
use crate::services::lines::{self, LineFilters, LineSelection, LinesRequest};
use crate::services::wire::LinePage;
use crate::services::{ServiceCtx, ServiceError};

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
) -> Result<Json<LinePage>, ServiceError> {
    let sctx = ctx.svc(client_name(&headers));
    // `services::lines::get_lines` is synchronous by contract: it takes the
    // `sessions` lock once per scan chunk and must never hold one across an
    // await, so it runs on the blocking pool instead of the request's worker
    // (which is also what the old handler's `yield_now()` between chunks was
    // approximating).
    let page = tokio::task::spawn_blocking(move || query_page(&sctx, &session_id, &params))
        .await
        .map_err(|e| ServiceError::Internal(format!("query task failed: {e}")))??;
    Ok(Json(page))
}

/// The whole of `h_query` minus axum. Separated so tests can call it without a
/// `BridgeCtx`.
fn query_page(
    ctx: &ServiceCtx,
    session_id: &str,
    params: &QueryParams,
) -> Result<LinePage, ServiceError> {
    let n = params.n.unwrap_or(50).min(200);
    let strategy = params.strategy.as_deref().unwrap_or("recent");

    // Parse time range filters upfront (ISO 8601 → Unix-epoch nanos, same
    // epoch as meta.timestamp for logcat/bugreport lines).
    let time_start_ns = params.time_start.as_deref().and_then(parse_iso_to_unix_nanos);
    let time_end_ns = params.time_end.as_deref().and_then(parse_iso_to_unix_nanos);

    // The strategy string is free-form on the wire and anything unrecognised
    // has always fallen through to uniform sampling. The response no longer
    // echoes the raw string — it carries the resolved `LineStrategy` instead,
    // so a typo is now visible as `{"kind":"uniform"}` rather than silently
    // reflected back.
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

    let req = LinesRequest::range(session_id, 0, n)
        .select(selection)
        .filter(filters)
        // No per-line character cap: `h_query` has never truncated (unlike
        // `lines_around` / the search endpoints), and `n <= 200` bounds the
        // payload without one.
        .for_agent(None);

    // `strategyNote` comes from the service, which words it for whichever path
    // it actually took (sample vs. filtered scan). The route used to overwrite
    // it with its own sentence on the filtered path; there is no reason for two
    // sources of the same explanation.
    lines::get_lines(ctx, req)
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
) -> Result<Json<LinePage>, ServiceError> {
    let sctx = ctx.svc(client_name(&headers));
    let page = tokio::task::spawn_blocking(move || lines_around_page(&sctx, &session_id, &params))
        .await
        .map_err(|e| ServiceError::Internal(format!("lines_around task failed: {e}")))??;
    Ok(Json(page))
}

/// The whole of `h_lines_around` minus axum. Separated so tests can call it
/// without a `BridgeCtx`.
fn lines_around_page(
    ctx: &ServiceCtx,
    session_id: &str,
    params: &LinesAroundParams,
) -> Result<LinePage, ServiceError> {
    let before = params.before.unwrap_or(20).min(100);
    let after = params.after.unwrap_or(20).min(100);
    let center = params.line;

    // `Around` clamps at the log's start and end and returns *fewer* lines
    // there — it never shifts the window to keep returning `before + after +
    // 1`, which is what distinguishes it from `h_query`'s "around" sampling.
    // The centre is recoverable from the response's `strategy.line`, and each
    // line's `isContext` says whether it is the centre (inverted).
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

    lines::get_lines(ctx, req)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::lines::level_at_least;
    use crate::services::testing::{fixture_session_with_pii, test_ctx};
    use crate::services::wire::LineStrategy;

    fn qp(n: Option<usize>, strategy: Option<&str>) -> QueryParams {
        QueryParams {
            n,
            strategy: strategy.map(str::to_string),
            ..Default::default()
        }
    }

    // NOTE: the golden tests that diffed these two renderers against frozen
    // copies of their pre-service handler bodies are deleted with WP-13. They
    // existed to prove WP-1's extraction was shape-preserving; the shape they
    // pinned is exactly what this package replaces, so keeping them would be
    // pinning the thing being removed. The `LinePage` contract they gave way to
    // is pinned by `services::wire`'s key-set tests plus the service-level
    // selection tests in `services::lines`.

    // ── The typed shape ────────────────────────────────────────────────────

    #[test]
    fn query_page_reports_the_resolved_strategy_not_the_query_string() {
        let (ctx, _tmp) = test_ctx()
            .agent("a")
            .with_session_object(fixture_session_with_pii("p1", 10))
            .agent_raw_access(true)
            .build();

        let page = query_page(&ctx, "p1", &qp(Some(3), Some("recent"))).expect("page");
        assert_eq!(page.session_id, "p1");
        assert_eq!(page.total_lines, 10);
        assert_eq!(page.count, page.lines.len());
        assert_eq!(page.count, 3);
        assert!(matches!(page.strategy, Some(LineStrategy::Recent)));
        // Unfiltered: nothing was scanned, so there is nothing to report.
        assert!(page.scanned_lines.is_none());
        assert_eq!(page.strategy_note.as_deref(), Some("the newest 3 lines"));
    }

    #[test]
    fn query_page_reports_the_scan_on_the_filtered_path() {
        let (ctx, _tmp) = test_ctx()
            .agent("a")
            .with_session_object(fixture_session_with_pii("p1", 10))
            .agent_raw_access(true)
            .build();

        let filtered = QueryParams {
            message: Some("contact".into()),
            ..qp(Some(3), Some("recent"))
        };
        let page = query_page(&ctx, "p1", &filtered).expect("page");
        assert!(
            page.strategy_note.as_deref().is_some_and(|n| n.contains("Filters active")),
            "a filtered query explains that it scanned: {:?}",
            page.strategy_note
        );
        assert!(page.scanned_lines.is_some());
    }

    #[test]
    fn query_page_is_a_not_found_error_for_an_unknown_session() {
        let (ctx, _tmp) = test_ctx().agent("a").build();
        let err = query_page(&ctx, "nope", &qp(Some(3), None)).expect_err("unknown session");
        assert_eq!(err.http_status(), 404);
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn lines_around_page_carries_the_centre_in_its_strategy_and_marks_context() {
        let (ctx, _tmp) = test_ctx()
            .agent("a")
            .with_session_object(fixture_session_with_pii("p1", 10))
            .agent_raw_access(true)
            .build();

        let page = lines_around_page(
            &ctx,
            "p1",
            &LinesAroundParams { line: 5, before: Some(2), after: Some(2) },
        )
        .expect("page");

        assert!(matches!(page.strategy, Some(LineStrategy::Around { line: 5 })));
        assert_eq!(page.count, 5);
        let centres: Vec<usize> = page
            .lines
            .iter()
            .filter(|l| !l.is_context)
            .map(|l| l.line_num)
            .collect();
        assert_eq!(centres, vec![5], "exactly one line is the centre");
        // This endpoint has never returned histograms.
        assert!(page.stats.is_none());
    }

    // ── Facts the typed shape cannot state on its own ──────────────────────

    #[test]
    fn query_anonymizes_for_an_agent_and_not_for_the_ui() {
        let (agent, _t1) = test_ctx()
            .agent("claude-code")
            .with_session_object(fixture_session_with_pii("p1", 3))
            .build();
        let (ui, _t2) = test_ctx()
            .with_session_object(fixture_session_with_pii("p1", 3))
            .build();

        let params = qp(Some(3), Some("recent"));
        let from_agent = query_page(&agent, "p1", &params).expect("agent page");
        let from_ui = query_page(&ui, "p1", &params).expect("ui page");

        assert!(
            !from_agent.lines[0].raw.contains("@example.com"),
            "the agent path must redact — got {}",
            from_agent.lines[0].raw
        );
        assert!(
            from_ui.lines[0].raw.contains("@example.com"),
            "a Ui caller is never redacted — got {}",
            from_ui.lines[0].raw
        );
    }

    #[test]
    fn query_redacts_with_no_configuration_at_all() {
        // The default state: agents are anonymized until the user opts out.
        let (ctx, _tmp) = test_ctx()
            .agent("claude-code")
            .with_session_object(fixture_session_with_pii("p1", 3))
            .build();
        let page = query_page(&ctx, "p1", &qp(Some(3), Some("recent"))).expect("page");
        for line in &page.lines {
            assert!(
                !line.raw.contains("@example.com"),
                "an agent must be redacted by default"
            );
        }
    }

    #[test]
    fn query_leaves_raw_alone_after_the_user_opted_out() {
        let (ctx, _tmp) = test_ctx()
            .agent("claude-code")
            .with_session_object(fixture_session_with_pii("p1", 3))
            .agent_raw_access(true)
            .build();
        let page = query_page(&ctx, "p1", &qp(Some(3), Some("recent"))).expect("page");
        assert!(
            page.lines[0].raw.contains("@example.com"),
            "an explicit opt-out must not redact"
        );
    }

    #[test]
    fn lines_around_truncates_at_500_chars_after_anonymizing() {
        let long = format!("head {} tail", "x".repeat(1_000));
        let session = crate::services::testing::fixture_session_from("long", vec![long]);
        let (ctx, _tmp) = test_ctx().agent("a").with_session_object(session).build();

        let page = lines_around_page(&ctx, "long", &LinesAroundParams { line: 0, ..Default::default() })
            .expect("page");
        let raw = &page.lines[0].raw;
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
