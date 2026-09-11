//! Regex search endpoints: search, search_with_context.
//!
//! Both are thin adapters over
//! [`services::search::hits`](crate::services::search::hits): they translate
//! query-string parameters into a [`SearchHitsRequest`] and ship the resulting
//! [`SearchHits`](crate::services::wire::SearchHits) as-is.
//!
//! **Wire changes (WP-13).** The two endpoints used to render two different
//! bespoke shapes over one scan — `search` emitted `contextBefore`/
//! `contextAfter` as sibling arrays of `{lineNum, raw}`, `search_with_context`
//! emitted one flat `context` list with an `isMatch` flag. Both now answer
//! `SearchHits`:
//!
//! | was (`search`) | was (`search_with_context`) | now |
//! |---|---|---|
//! | `matches` | `matches` | `hits` |
//! | `matchCount` | `matchCount` | `total` |
//! | — | `returned` | `returned` |
//! | `limit` | `maxResults` | `limit` |
//! | — | `offset` | `offset` |
//! | — | `totalLinesInSession` | `totalLines` |
//! | `matches[].{lineNum,raw}` | `matches[].matchLineNum` + `context[]` | `hits[].line` — a full [`ViewLine`](crate::core::line::ViewLine) |
//! | `contextBefore`/`contextAfter` (omitted when empty) | `context[].isMatch` | `hits[].contextBefore` / `contextAfter` — always present, possibly empty; the match is `hits[].line` |
//! | `captures` (omitted when empty) | — | `hits[].captures` — always present, possibly empty |
//! | `pattern`, `caseInsensitive` | `query`, `caseInsensitive`, `contextLines`, `maxLineChars` | dropped — a caller already knows what it asked for |
//!
//! `scannedLines` and `truncated` keep their names and meanings.
//!
//! **`total` still means two different things across these routes**, because
//! the underlying knob lives in `services::search` (outside this package): the
//! `search` scan stops once the page is full, so `total == returned`, while
//! `search_with_context` scans the whole (possibly capped) range for an exact
//! count. Unifying them is a `services::search` change — see WP-2's notes on
//! the three transitional knobs.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::client_name;
use crate::services::search::{self, SearchHitsRequest};
use crate::services::wire::SearchHits;
use crate::services::{ServiceCtx, ServiceError};

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
) -> Result<Json<SearchHits>, ServiceError> {
    let sctx = ctx.svc(client_name(&headers));
    // `services::search::hits` is synchronous by contract: it takes the
    // `sessions` lock once per scan chunk and must never hold one across an
    // await, so it runs on the blocking pool instead of the request's worker
    // (which is also what the old handler's `yield_now()` between chunks was
    // approximating).
    let hits = tokio::task::spawn_blocking(move || search_hits(&sctx, &session_id, &params))
        .await
        .map_err(|e| ServiceError::Internal(format!("search task failed: {e}")))??;
    Ok(Json(hits))
}

/// The whole of `h_search` minus axum. Separated so tests can call it without a
/// `BridgeCtx`.
fn search_hits(
    ctx: &ServiceCtx,
    session_id: &str,
    params: &SearchParams,
) -> Result<SearchHits, ServiceError> {
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

    search::hits(ctx, &req)
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
) -> Result<Json<SearchHits>, ServiceError> {
    let sctx = ctx.svc(client_name(&headers));
    let hits =
        tokio::task::spawn_blocking(move || search_with_context_hits(&sctx, &session_id, &params))
            .await
            .map_err(|e| ServiceError::Internal(format!("search_with_context task failed: {e}")))??;
    Ok(Json(hits))
}

/// The whole of `h_search_with_context` minus axum. Separated so tests can call
/// it without a `BridgeCtx`.
fn search_with_context_hits(
    ctx: &ServiceCtx,
    session_id: &str,
    params: &SearchWithContextParams,
) -> Result<SearchHits, ServiceError> {
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
        // produce an exact `total` rather than stopping once `max_results` is
        // reached. That full-scan-for-counting design is tracked separately
        // (item c5d058b3) and is unchanged here.
        count_all_matches: true,
        count_unreadable_as_scanned: false,
        redact_match_line_first: false,
    };

    search::hits(ctx, &req)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::{fixture_session, fixture_session_with_pii, test_ctx};

    // NOTE: the golden tests that diffed these two renderers against frozen
    // copies of their pre-service handler bodies are deleted with WP-13, for
    // the same reason as `routes/lines.rs`'s: the shapes they pinned are
    // exactly what this package replaces. `SearchHits`'s own key set is pinned
    // in `services::wire`, and the scan semantics in `services::search`.

    fn ctx_with(session_id: &str, lines: usize) -> (ServiceCtx, tempfile::TempDir) {
        test_ctx()
            .agent("a")
            .with_session_object(fixture_session(session_id, lines))
            .agent_raw_access(true)
            .build()
    }

    #[test]
    fn search_returns_hits_with_context_as_sibling_arrays() {
        let (ctx, _tmp) = ctx_with("s1", 50);
        let params = SearchParams {
            pattern: "line 1".to_string(),
            limit: Some(3),
            context: Some(2),
            ..Default::default()
        };

        let hits = search_hits(&ctx, "s1", &params).expect("hits");

        assert_eq!(hits.session_id, "s1");
        assert_eq!(hits.limit, 3);
        assert_eq!(hits.offset, 0);
        assert_eq!(hits.returned, hits.hits.len());
        // `search` stops once the page is full, so the count it reports is the
        // page's own size (see the module docs).
        assert_eq!(hits.total, hits.returned);
        assert_eq!(hits.total_lines, 50);
        let first = &hits.hits[0];
        assert!(!first.line.is_context, "the match itself is never context");
        assert!(
            first.context_before.iter().all(|l| l.is_context),
            "context lines are marked as such"
        );
    }

    #[test]
    fn search_with_context_counts_past_the_page() {
        let (ctx, _tmp) = ctx_with("s1", 50);
        let params = SearchWithContextParams {
            query: "line".to_string(),
            max_results: Some(2),
            context_lines: Some(1),
            ..Default::default()
        };

        let hits = search_with_context_hits(&ctx, "s1", &params).expect("hits");

        assert_eq!(hits.returned, 2);
        assert_eq!(hits.limit, 2);
        assert!(
            hits.total > hits.returned,
            "this endpoint scans the whole range for an exact count: {} vs {}",
            hits.total,
            hits.returned
        );
    }

    #[test]
    fn an_uncompilable_pattern_is_a_400_invalid_argument() {
        let (ctx, _tmp) = ctx_with("s1", 5);
        let params = SearchParams {
            pattern: "(unclosed".to_string(),
            ..Default::default()
        };

        let err = search_hits(&ctx, "s1", &params).expect_err("bad regex must error");
        assert_eq!(err.http_status(), 400);
        assert_eq!(err.code(), search::INVALID_REGEX);
    }

    #[test]
    fn an_unknown_session_is_a_404_not_found() {
        let (ctx, _tmp) = ctx_with("s1", 5);
        let params = SearchParams { pattern: "x".to_string(), ..Default::default() };

        let err = search_hits(&ctx, "nope", &params).expect_err("unknown session must error");
        assert_eq!(err.http_status(), 404);
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn both_endpoints_redact_with_no_configuration_at_all() {
        // The default state: agents are anonymized until the user opts out.
        let (ctx, _tmp) = test_ctx()
            .agent("claude-code")
            .with_session_object(fixture_session_with_pii("p1", 5))
            .build();

        let a = search_hits(
            &ctx,
            "p1",
            &SearchParams { pattern: "user".to_string(), ..Default::default() },
        )
        .expect("search");
        for hit in &a.hits {
            assert!(!hit.line.raw.contains("@example.com"), "search must redact by default");
        }

        let b = search_with_context_hits(
            &ctx,
            "p1",
            &SearchWithContextParams { query: "user".to_string(), ..Default::default() },
        )
        .expect("search_with_context");
        for hit in &b.hits {
            assert!(
                !hit.line.raw.contains("@example.com"),
                "search_with_context must redact by default"
            );
        }
    }
}
