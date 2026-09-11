//! Filter service — a chunked historical scan behind a durable handle.
//!
//! The single implementation of filter create/lines/info/cancel/close,
//! replacing what used to live entirely in `commands::filter`: a Tauri
//! command spawned `tauri::async_runtime::spawn` directly and emitted
//! `app.emit("filter-progress", ...)` from inside the scan loop, which made
//! the whole thing unreachable from the MCP bridge. [`create`] now spawns
//! through [`super::Spawner`] and reports through [`ProgressSink`] as
//! [`ProgressEvent::Filter`], so `commands::filter`'s Tauri adapters and
//! `mcp_bridge::routes::filters`'s HTTP handlers drive the exact same scan.
//!
//! ## Snapshot semantics — read this before wiring an agent client
//!
//! [`create`] captures `total_lines` once, from the source's length at that
//! instant, and the background scan only ever walks `[0, total_lines)`. A
//! filter is a point-in-time view over the session, not a live query:
//!
//! - Lines a streaming session receives **after** `create` was called are
//!   invisible to this filter forever — even while it is still "scanning"
//!   earlier history, and even after the scan finishes. There is no re-scan.
//!   An agent that needs coverage of newly-arrived lines must `create` a new
//!   filter (or use [`super::watches`] for a live-matching subscription
//!   instead of a point-in-time scan).
//! - [`cancel`] stops the background scan early; [`close`] additionally
//!   forgets the filter's id and matched-line state. Neither one touches the
//!   underlying session, its raw log data, or any other filter's results —
//!   "closing a filter does not retain its state" describes the filter's own
//!   bookkeeping, not the session it scanned.
//! - [`info`]'s `status` (`"scanning"` | `"complete"` | `"cancelled"`) plus
//!   `linesScanned`/`totalLines` is how a caller with no progress channel
//!   (an HTTP agent) learns the scan finished — poll it instead of assuming
//!   a fixed delay.
//!
//! ## Redaction
//!
//! [`lines`] puts every returned line's `raw` and `message` through
//! [`redact_line`] whenever [`should_anonymize`] says this caller/session
//! pair requires it — never for a `Ui` caller, fail-closed for an `Agent`
//! caller against an unknown session flag. No truncation is applied (`usize::MAX`):
//! `get_filtered_lines` has never truncated line text, unlike `lines_around`
//! or the search endpoints.
//!
//! ## Locking
//!
//! One `AppState` lock per step, never across an `.await`: `sessions` is
//! locked (and dropped) once to read `total_lines` in [`create`], and again,
//! separately, once per [`SCAN_BATCH_SIZE`]-line batch inside the background
//! scan; `active_filters` is locked (and dropped) once per call in every
//! other function. `raw_line`/`meta_at` are used throughout — never direct
//! indexing — so a stream source's eviction offset applies transparently.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use regex::Regex;
use serde::Serialize;
use ts_rs::TS;
use uuid::Uuid;

use crate::core::filter::{
    line_matches_criteria_with_needles, FilterCriteria, FilterSession, FilterStatus,
};
use crate::core::line::{LogLevel, ViewLine};
use crate::core::parser::LogParser;
use crate::core::session::parser_for;

use super::events::{FilterProgressEvent, ProgressEvent, ProgressSink};
use super::policy::{redact_line, should_anonymize};
use super::{lock_svc, ServiceCtx, ServiceError};

/// Reproduced verbatim from `commands::filter`'s pre-service error text —
/// both [`create`] and [`lines`] resolve a session's primary source and fail
/// with this exact message when it has none.
const NO_SOURCE_IN_SESSION: &str = "No source in session";

/// Lines scanned per lock acquisition of `sessions` inside the background
/// scan. Matches the pre-service `BATCH_SIZE` in `commands::filter` — the
/// scan re-acquires the lock this often rather than holding it for the whole
/// run, and yields to the runtime between batches (see [`scan_filter_background`]).
const SCAN_BATCH_SIZE: usize = 10_000;

/// How often (in scanned lines) the background scan reports progress, besides
/// always reporting once at completion. Matches the pre-service constant.
const PROGRESS_INTERVAL: usize = 50_000;

/// A page of [`lines`] is capped at this many lines regardless of the
/// caller-requested `count` — matches the pre-service cap in
/// `commands::filter::get_filtered_lines`.
const MAX_LINES_PAGE: usize = 1_000;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilterCreateResult {
    pub filter_id: String,
    pub session_id: String,
    /// Total lines in the source (will be scanned progressively).
    pub total_lines: usize,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilteredLinesResult {
    pub filter_id: String,
    pub total_matches: usize,
    pub lines: Vec<ViewLine>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilterInfo {
    pub filter_id: String,
    pub session_id: String,
    pub total_matches: usize,
    pub lines_scanned: usize,
    pub total_lines: usize,
    pub status: String,
}

fn status_str(status: FilterStatus) -> &'static str {
    match status {
        FilterStatus::Scanning => "scanning",
        FilterStatus::Complete => "complete",
        FilterStatus::Cancelled => "cancelled",
    }
}

// ---------------------------------------------------------------------------
// create — register a filter and spawn its background scan
// ---------------------------------------------------------------------------

/// Validate `criteria`, register a [`FilterSession`] against `session_id`,
/// spawn its background scan through `ctx`'s [`super::Spawner`], and return
/// immediately with the snapshot [`FilterCreateResult`] — the scan continues
/// after this call returns, reporting through `progress` as
/// [`ProgressEvent::Filter`] and updating the state `info`/`lines`/`cancel`/
/// `close` all read.
///
/// The regex is compiled and validated **before** the session is even
/// resolved — reproducing `commands::filter::create_filter`'s order, where
/// an invalid pattern is reported as such rather than silently scanning to
/// zero matches (`line_matches_criteria` treats an uncompiled regex as a
/// non-match).
pub fn create(
    ctx: &ServiceCtx,
    session_id: String,
    criteria: FilterCriteria,
    progress: Arc<dyn ProgressSink>,
) -> Result<FilterCreateResult, ServiceError> {
    let compiled_regex = criteria.compile_regex().map_err(ServiceError::invalid_arg)?;

    let total_lines = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| ServiceError::session_not_found(&session_id))?;
        let source = session
            .primary_source()
            .ok_or_else(|| ServiceError::invalid_arg(NO_SOURCE_IN_SESSION))?;
        source.total_lines()
    };

    let filter_id = format!("filter-{}", Uuid::new_v4());
    let filter = Arc::new(FilterSession::new(
        filter_id.clone(),
        session_id.clone(),
        criteria,
        total_lines,
    ));

    {
        let mut filters = lock_svc(&ctx.state().active_filters, "active_filters")?;
        filters.insert(filter_id.clone(), Arc::clone(&filter));
    }

    ctx.journal(
        "filter.create",
        Some(&session_id),
        format!("filter {filter_id} ({total_lines} lines)"),
    );

    let bg_ctx = ctx.clone();
    ctx.spawner().spawn(Box::pin(async move {
        scan_filter_background(bg_ctx, filter, compiled_regex, progress).await;
    }));

    Ok(FilterCreateResult {
        filter_id,
        session_id,
        total_lines,
    })
}

/// Whether `criteria` actually filters on `pid` — i.e. whether
/// `line_matches_criteria`/`line_matches_criteria_with_needles` will ever
/// consult the `pid` argument. Mirrors the exact condition those functions
/// use (`Some(pids) if !pids.is_empty()`) so the scan loop can skip parsing
/// each line for its pid when the filter doesn't need it.
fn criteria_needs_pid(criteria: &FilterCriteria) -> bool {
    criteria.pids.as_ref().is_some_and(|p| !p.is_empty())
}

/// The chunked scan itself, moved verbatim (behaviorally) from
/// `commands::filter::scan_filter_background`: same batch size, same
/// progress cadence, same per-batch lock acquisition. The only change is the
/// notification path — `progress.on_progress` instead of a captured
/// `AppHandle::emit` — which is what makes this callable from the MCP bridge,
/// which has no `AppHandle`.
async fn scan_filter_background(
    ctx: ServiceCtx,
    filter: Arc<FilterSession>,
    compiled_regex: Option<Regex>,
    progress: Arc<dyn ProgressSink>,
) {
    let total_lines = filter.total_lines.load(Ordering::Relaxed);
    let mut scanned = 0usize;

    // Text/tag needles are immutable for the whole scan — precompute the
    // lowercased forms once (mirrors `compiled_regex`, compiled once by
    // `create`) instead of letting `line_matches_criteria` re-lowercase them
    // on every scanned line.
    let needles = filter.criteria.precompute_needles();

    // Only parse a line for `pid` when the filter actually filters on pid —
    // otherwise every line pays for a full parse just to read a field that's
    // never checked.
    let needs_pid = criteria_needs_pid(&filter.criteria);

    // Allocate the parser once for the whole scan (the source's type can't
    // change mid-scan) instead of once per line. Lazily created on the first
    // batch that successfully resolves the source, then reused by every
    // subsequent batch.
    let mut parser: Option<Box<dyn LogParser>> = None;

    while scanned < total_lines && !filter.is_cancelled() {
        let batch_end = (scanned + SCAN_BATCH_SIZE).min(total_lines);

        // Acquire lock, scan batch, release lock.
        let batch_matches: Vec<usize> = {
            let Ok(sessions) = lock_svc(&ctx.state().sessions, "sessions") else {
                break;
            };
            let Some(session) = sessions.get(&filter.session_id) else {
                break;
            };
            let Some(source) = session.primary_source() else {
                break;
            };

            if needs_pid && parser.is_none() {
                parser = Some(parser_for(source.source_type()));
            }

            let mut matches = Vec::new();
            for i in scanned..batch_end {
                let Some(raw_cow) = source.raw_line(i) else { continue };
                let raw: &str = &raw_cow;
                let Some(meta) = source.meta_at(i) else { continue };

                let tag = session.resolve_tag(meta.tag_id);
                // pid is only worth parsing for when the filter has a pid
                // criterion; otherwise fall back to 0 (matches the old
                // behavior when parsing failed to produce a pid).
                let pid = if needs_pid {
                    parser
                        .as_deref()
                        .and_then(|p| p.parse_line(raw, source.id(), i))
                        .map_or(0, |lc| lc.pid)
                } else {
                    0
                };

                if line_matches_criteria_with_needles(
                    &filter.criteria,
                    &needles,
                    raw,
                    meta.level,
                    tag,
                    meta.timestamp,
                    pid,
                    compiled_regex.as_ref(),
                ) {
                    matches.push(i);
                }
            }
            matches
        };

        if !batch_matches.is_empty() {
            filter.append_matches(&batch_matches);
        }

        scanned = batch_end;
        filter.lines_scanned.store(scanned, Ordering::Relaxed);

        // Emit progress at intervals or when done.
        if scanned % PROGRESS_INTERVAL < SCAN_BATCH_SIZE || scanned >= total_lines {
            progress.on_progress(&ProgressEvent::Filter(FilterProgressEvent {
                filter_id: filter.filter_id.clone(),
                matched_so_far: filter.matched_count(),
                lines_scanned: scanned,
                total_lines,
                done: scanned >= total_lines,
            }));
        }

        // Yield to other tasks periodically.
        tokio::task::yield_now().await;
    }

    if filter.is_cancelled() {
        filter.set_status(FilterStatus::Cancelled);
    } else {
        filter.set_status(FilterStatus::Complete);
    }

    // Final progress report, always `done: true` regardless of how the loop
    // above exited (natural completion, cancellation, or a vanished session).
    progress.on_progress(&ProgressEvent::Filter(FilterProgressEvent {
        filter_id: filter.filter_id.clone(),
        matched_so_far: filter.matched_count(),
        lines_scanned: scanned,
        total_lines,
        done: true,
    }));
}

// ---------------------------------------------------------------------------
// lines — paginated view of a filter's matches so far
// ---------------------------------------------------------------------------

/// A page of `[offset, offset + count)` matched lines, rendered as
/// [`ViewLine`]s, plus the filter's total match count and lifecycle
/// `status`. Safe to call while the background scan is still running — it
/// reads whatever has been matched so far.
///
/// `count` is capped at [`MAX_LINES_PAGE`] regardless of what the caller
/// asks for, matching `commands::filter::get_filtered_lines`'s pre-service
/// `count.min(1000)`.
pub fn lines(
    ctx: &ServiceCtx,
    filter_id: &str,
    offset: usize,
    count: usize,
) -> Result<FilteredLinesResult, ServiceError> {
    let filter = {
        let filters = lock_svc(&ctx.state().active_filters, "active_filters")?;
        filters
            .get(filter_id)
            .cloned()
            .ok_or_else(|| ServiceError::NotFound(format!("Filter '{filter_id}' not found")))?
    };

    let total_matches = filter.matched_count();
    let page_line_nums = filter.get_page(offset, count.min(MAX_LINES_PAGE));
    let status = filter.status();
    let session_id = filter.session_id.clone();

    let anonymizing = should_anonymize(ctx, &session_id);

    let mut view_lines: Vec<ViewLine> = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| ServiceError::session_not_found(&session_id))?;
        let source = session
            .primary_source()
            .ok_or_else(|| ServiceError::invalid_arg(NO_SOURCE_IN_SESSION))?;

        let parser = parser_for(source.source_type());
        let mut out = Vec::with_capacity(page_line_nums.len());

        for (idx, &ln) in page_line_nums.iter().enumerate() {
            let vi = offset + idx;
            let raw = source.raw_line(ln).as_deref().unwrap_or("").to_string();
            let meta = source.meta_at(ln);

            let view_line = if let Some(lc) = parser.parse_line(&raw, source.id(), ln) {
                ViewLine {
                    line_num: ln,
                    virtual_index: vi,
                    raw: lc.raw.to_string(),
                    level: lc.level,
                    tag: lc.tag.to_string(),
                    message: lc.message.to_string(),
                    timestamp: lc.timestamp,
                    pid: lc.pid,
                    tid: lc.tid,
                    source_id: lc.source_id.to_string(),
                    highlights: vec![],
                    matched_by: vec![],
                    is_context: false,
                }
            } else {
                ViewLine {
                    line_num: ln,
                    virtual_index: vi,
                    raw: raw.clone(),
                    level: meta.map_or(LogLevel::Info, |m| m.level),
                    tag: meta
                        .map_or_else(String::new, |m| session.resolve_tag(m.tag_id).to_string()),
                    message: raw,
                    timestamp: meta.map_or(0, |m| m.timestamp),
                    pid: 0,
                    tid: 0,
                    source_id: source.id().to_string(),
                    highlights: vec![],
                    matched_by: vec![],
                    is_context: false,
                }
            };
            out.push(view_line);
        }
        out
    };

    // Redact only when this caller/session pair requires it — never for `Ui`,
    // fail-closed for an unrecognized session under `Agent`. `redact_line`'s
    // own truncation is disabled (`usize::MAX`): this endpoint has never
    // truncated line text.
    if anonymizing {
        for line in &mut view_lines {
            line.raw = redact_line(ctx, &session_id, &line.raw, usize::MAX);
            line.message = redact_line(ctx, &session_id, &line.message, usize::MAX);
        }
    }

    Ok(FilteredLinesResult {
        filter_id: filter_id.to_string(),
        total_matches,
        lines: view_lines,
        status: status_str(status).to_string(),
    })
}

// ---------------------------------------------------------------------------
// info — lifecycle + progress snapshot
// ---------------------------------------------------------------------------

/// Snapshot of a filter's progress and lifecycle. The only way a caller with
/// no progress channel (an HTTP agent) learns a scan has finished — poll
/// `status` instead of assuming a fixed delay.
pub fn info(ctx: &ServiceCtx, filter_id: &str) -> Result<FilterInfo, ServiceError> {
    let filters = lock_svc(&ctx.state().active_filters, "active_filters")?;
    let filter = filters
        .get(filter_id)
        .ok_or_else(|| ServiceError::NotFound(format!("Filter '{filter_id}' not found")))?;

    Ok(FilterInfo {
        filter_id: filter.filter_id.clone(),
        session_id: filter.session_id.clone(),
        total_matches: filter.matched_count(),
        lines_scanned: filter.lines_scanned.load(Ordering::Relaxed),
        total_lines: filter.total_lines.load(Ordering::Relaxed),
        status: status_str(filter.status()).to_string(),
    })
}

// ---------------------------------------------------------------------------
// cancel — stop the background scan early
// ---------------------------------------------------------------------------

/// Stop `filter_id`'s background scan early. The filter (and whatever it
/// matched before cancellation) stays registered — `lines`/`info` keep
/// working against it — only [`close`] removes it. Journals `filter.cancel`:
/// unlike `lines`/`info`, this changes state.
pub fn cancel(ctx: &ServiceCtx, filter_id: &str) -> Result<(), ServiceError> {
    let session_id = {
        let filters = lock_svc(&ctx.state().active_filters, "active_filters")?;
        let filter = filters
            .get(filter_id)
            .ok_or_else(|| ServiceError::NotFound(format!("Filter '{filter_id}' not found")))?;
        filter.cancel();
        filter.session_id.clone()
    };

    ctx.journal("filter.cancel", Some(&session_id), format!("filter {filter_id}"));
    Ok(())
}

// ---------------------------------------------------------------------------
// close — forget the filter
// ---------------------------------------------------------------------------

/// Remove `filter_id` from the registry, cancelling its scan first if still
/// running. A filter is a transient view over the session: closing it
/// discards only this filter's own id and matched-line bookkeeping — it
/// never touches the session's history or any other filter's results.
///
/// Closing an id that is already gone (or was never created) is not an
/// error — matches `commands::filter::close_filter`'s idempotent behavior —
/// so nothing is journaled in that case (there is no session to attribute the
/// entry to, and no state actually changed).
pub fn close(ctx: &ServiceCtx, filter_id: &str) -> Result<(), ServiceError> {
    let removed = {
        let mut filters = lock_svc(&ctx.state().active_filters, "active_filters")?;
        filters.remove(filter_id)
    };

    if let Some(filter) = removed {
        filter.cancel(); // Stop scanning if still running.
        ctx.journal(
            "filter.close",
            Some(&filter.session_id),
            format!("filter {filter_id}"),
        );
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;
    use crate::services::{Caller, NullProgressSink};

    fn criteria(text: &str) -> FilterCriteria {
        FilterCriteria {
            text_search: Some(text.to_string()),
            ..Default::default()
        }
    }

    fn null_progress() -> Arc<dyn ProgressSink> {
        Arc::new(NullProgressSink)
    }

    // ── create ───────────────────────────────────────────────────────────

    #[test]
    fn create_returns_the_snapshot_and_registers_the_filter() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 500).build();

        let result = create(&ctx, "s1".to_string(), criteria("line"), null_progress())
            .expect("create must succeed for an existing session");

        assert_eq!(result.session_id, "s1");
        assert_eq!(result.total_lines, 500);
        assert!(result.filter_id.starts_with("filter-"));

        let filters = ctx.state().active_filters.lock().unwrap();
        assert!(filters.contains_key(&result.filter_id));
    }

    #[test]
    fn create_journals_for_ui_and_agent_callers() {
        let (ui, _tmp) = test_ctx().with_session("s1", 10).build();
        let r1 = create(&ui, "s1".to_string(), criteria("x"), null_progress()).unwrap();
        let activity = ui.state().activity.list(None, None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "filter.create");
        assert_eq!(activity[0].caller, Caller::Ui);
        assert!(activity[0].summary.contains(&r1.filter_id));

        let (agent, _tmp2) = test_ctx().agent("claude-code").with_session("s1", 10).build();
        create(&agent, "s1".to_string(), criteria("x"), null_progress()).unwrap();
        assert_eq!(
            agent.state().activity.list(None, None)[0].caller,
            Caller::agent("claude-code")
        );
    }

    #[test]
    fn create_rejects_unknown_session() {
        let (ctx, _tmp) = test_ctx().build();
        let err = create(&ctx, "missing".to_string(), criteria("x"), null_progress())
            .expect_err("must fail for a session that does not exist");
        assert_eq!(err.message(), "Session 'missing' not found");
    }

    #[test]
    fn create_rejects_invalid_regex_before_touching_state() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 10).build();
        let bad = FilterCriteria {
            regex: Some("[invalid".to_string()),
            ..Default::default()
        };
        let err = create(&ctx, "s1".to_string(), bad, null_progress())
            .expect_err("invalid regex must be rejected");
        assert!(err.message().contains("[invalid"));
        assert!(
            ctx.state().active_filters.lock().unwrap().is_empty(),
            "a rejected filter must never be registered"
        );
        assert!(
            ctx.state().activity.list(None, None).is_empty(),
            "a rejected create must not journal"
        );
    }

    #[test]
    fn create_rejects_a_session_with_no_source() {
        let (ctx, _tmp) = test_ctx().build();
        ctx.state()
            .sessions
            .lock()
            .unwrap()
            .insert("empty".to_string(), crate::core::session::AnalysisSession::new("empty".to_string()));
        let err = create(&ctx, "empty".to_string(), criteria("x"), null_progress())
            .expect_err("a session with no source must be rejected");
        assert_eq!(err.message(), NO_SOURCE_IN_SESSION);
    }

    // ── info / lines on a freshly created (not-yet-scanned) filter ─────────
    //
    // `test_ctx().build()` wires a `NullSpawner` (see `services::testing`), so
    // `create`'s spawned scan never actually runs in these tests — exactly
    // like a filter observed a moment after creation, before its background
    // scan has made progress. The scan loop itself is exercised directly,
    // below, via `scan_filter_background`.

    #[test]
    fn info_reports_zero_progress_immediately_after_create() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 200).build();
        let created = create(&ctx, "s1".to_string(), criteria("x"), null_progress()).unwrap();

        let info = info(&ctx, &created.filter_id).unwrap();
        assert_eq!(info.filter_id, created.filter_id);
        assert_eq!(info.session_id, "s1");
        assert_eq!(info.total_lines, 200);
        assert_eq!(info.lines_scanned, 0);
        assert_eq!(info.total_matches, 0);
        assert_eq!(info.status, "scanning");
    }

    #[test]
    fn info_unknown_filter_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = info(&ctx, "no-such-filter").expect_err("must fail for an unknown filter id");
        assert_eq!(err.message(), "Filter 'no-such-filter' not found");
    }

    #[test]
    fn lines_unknown_filter_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = lines(&ctx, "no-such-filter", 0, 10)
            .expect_err("must fail for an unknown filter id");
        assert_eq!(err.message(), "Filter 'no-such-filter' not found");
    }

    #[test]
    fn lines_page_is_empty_before_the_scan_has_matched_anything() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 50).build();
        let created = create(&ctx, "s1".to_string(), criteria("x"), null_progress()).unwrap();
        let page = lines(&ctx, &created.filter_id, 0, 10).unwrap();
        assert_eq!(page.total_matches, 0);
        assert!(page.lines.is_empty());
        assert_eq!(page.status, "scanning");
    }

    // ── cancel ───────────────────────────────────────────────────────────

    #[test]
    fn cancel_marks_the_filter_cancelled_and_journals() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 50).build();
        let created = create(&ctx, "s1".to_string(), criteria("x"), null_progress()).unwrap();

        cancel(&ctx, &created.filter_id).expect("must find and cancel");

        let info = info(&ctx, &created.filter_id).unwrap();
        assert_eq!(info.status, "cancelled");

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.last().unwrap().action, "filter.cancel");
    }

    #[test]
    fn cancel_unknown_filter_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = cancel(&ctx, "no-such-filter").expect_err("must fail for an unknown filter id");
        assert_eq!(err.message(), "Filter 'no-such-filter' not found");
    }

    // ── close ────────────────────────────────────────────────────────────

    #[test]
    fn close_removes_the_filter_and_journals() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 50).build();
        let created = create(&ctx, "s1".to_string(), criteria("x"), null_progress()).unwrap();

        close(&ctx, &created.filter_id).expect("close must succeed");

        assert!(
            !ctx.state().active_filters.lock().unwrap().contains_key(&created.filter_id),
            "closed filter must be removed from the registry"
        );
        let err = info(&ctx, &created.filter_id).expect_err("a closed filter must be gone");
        assert!(err.message().contains(&created.filter_id));

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.last().unwrap().action, "filter.close");
    }

    #[test]
    fn close_unknown_filter_is_a_silent_no_op() {
        // Matches `commands::filter::close_filter`'s idempotent behavior:
        // closing something already gone (or never created) is not an error.
        let (ctx, _tmp) = test_ctx().build();
        close(&ctx, "no-such-filter").expect("closing an unknown filter id must not error");
        assert!(
            ctx.state().activity.list(None, None).is_empty(),
            "closing a nonexistent filter must not journal"
        );
    }

    // ── shared visibility across callers ────────────────────────────────
    //
    // The whole point of building this on `ServiceCtx`/`AppState` rather than
    // per-transport state: a filter created by one caller identity is fully
    // visible to (and closeable by) another, because both read/write the
    // same `AppState::active_filters` map.

    #[test]
    fn a_filter_created_by_ui_is_visible_to_and_closeable_by_an_agent() {
        let (ui, _tmp) = test_ctx().with_session("s1", 50).build();
        let created = create(&ui, "s1".to_string(), criteria("x"), null_progress()).unwrap();

        // Same underlying AppState, different caller identity.
        let agent = ui.with_caller(Caller::agent("claude-code"));
        let seen = info(&agent, &created.filter_id).expect("agent must see the UI's filter");
        assert_eq!(seen.filter_id, created.filter_id);

        close(&agent, &created.filter_id).expect("agent must be able to close it");

        // Both identities now see it gone — there was only ever one filter.
        assert!(info(&ui, &created.filter_id).is_err());
        assert!(info(&agent, &created.filter_id).is_err());
    }

    // ── criteria_needs_pid ───────────────────────────────────────────────

    #[test]
    fn criteria_needs_pid_false_when_unset() {
        let c = FilterCriteria::default();
        assert!(!criteria_needs_pid(&c));
    }

    #[test]
    fn criteria_needs_pid_false_when_empty_list() {
        let mut c = FilterCriteria::default();
        c.pids = Some(vec![]);
        assert!(!criteria_needs_pid(&c));
    }

    #[test]
    fn criteria_needs_pid_true_when_pids_configured() {
        let mut c = FilterCriteria::default();
        c.pids = Some(vec![1234]);
        assert!(criteria_needs_pid(&c));
    }

    // ── the scan loop itself, exercised directly (bypassing the spawner) ──

    #[tokio::test]
    async fn scan_filter_background_matches_lines_updates_status_and_reports_progress() {
        let (ctx, _tmp) = test_ctx()
            .with_session_object(crate::services::testing::fixture_session_from(
                "s1",
                vec![
                    "keep this one".to_string(),
                    "drop this one".to_string(),
                    "keep another".to_string(),
                ],
            ))
            .build();

        let c = criteria("keep");
        let regex = c.compile_regex().unwrap();
        let total_lines = 3;
        let filter = Arc::new(FilterSession::new(
            "f1".to_string(),
            "s1".to_string(),
            c,
            total_lines,
        ));
        {
            let mut filters = ctx.state().active_filters.lock().unwrap();
            filters.insert("f1".to_string(), Arc::clone(&filter));
        }

        let sink = Arc::new(crate::services::testing::RecordingSink::new());
        scan_filter_background(ctx.clone(), Arc::clone(&filter), regex, sink.clone() as Arc<dyn ProgressSink>).await;

        assert_eq!(filter.status(), FilterStatus::Complete);
        assert_eq!(filter.matched_count(), 2);
        assert_eq!(filter.lines_scanned.load(Ordering::Relaxed), 3);

        let progress = sink.progress_events();
        assert!(!progress.is_empty(), "the scan must report at least one progress event");
        let last = progress.last().unwrap();
        match last {
            ProgressEvent::Filter(p) => {
                assert!(p.done);
                assert_eq!(p.matched_so_far, 2);
                assert_eq!(p.total_lines, 3);
            }
            other => panic!("expected a Filter progress event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn scan_filter_background_stops_early_when_cancelled_before_it_runs() {
        let (ctx, _tmp) = test_ctx()
            .with_session_object(crate::services::testing::fixture_session_from(
                "s1",
                vec!["a".to_string(), "b".to_string()],
            ))
            .build();

        let c = FilterCriteria::default();
        let filter = Arc::new(FilterSession::new("f1".to_string(), "s1".to_string(), c, 2));
        filter.cancel();

        scan_filter_background(ctx, Arc::clone(&filter), None, null_progress()).await;

        assert_eq!(filter.status(), FilterStatus::Cancelled);
        assert_eq!(
            filter.lines_scanned.load(Ordering::Relaxed),
            0,
            "a filter cancelled before the loop ran must not have scanned anything"
        );
    }

    // ── pid filtering correctness (mirrors what the scan loop relies on) ──
    // These pin the two behaviors the loop depends on: a filter WITH a pid
    // criterion still discriminates on the parsed pid, and one WITHOUT one
    // matches irrespective of whatever pid value is passed in (i.e. it's
    // safe to skip parsing and pass 0).

    #[test]
    fn pid_criterion_present_still_filters_by_pid() {
        let mut c = FilterCriteria::default();
        c.text_search = Some("crash".to_string());
        c.pids = Some(vec![1234]);
        assert!(criteria_needs_pid(&c));
        let needles = c.precompute_needles();

        assert!(line_matches_criteria_with_needles(
            &c, &needles, "app crash detected", LogLevel::Error, "", 0, 1234, None
        ));
        assert!(!line_matches_criteria_with_needles(
            &c, &needles, "app crash detected", LogLevel::Error, "", 0, 9999, None
        ));
    }

    #[test]
    fn no_pid_criterion_matches_regardless_of_pid_value() {
        let mut c = FilterCriteria::default();
        c.text_search = Some("crash".to_string());
        assert!(!criteria_needs_pid(&c));
        let needles = c.precompute_needles();

        let with_zero = line_matches_criteria_with_needles(
            &c, &needles, "app crash detected", LogLevel::Error, "", 0, 0, None
        );
        let with_nonzero = line_matches_criteria_with_needles(
            &c, &needles, "app crash detected", LogLevel::Error, "", 0, 4242, None
        );
        assert!(with_zero);
        assert_eq!(with_zero, with_nonzero);
    }

    // ── redaction gating in `lines` ──────────────────────────────────────

    #[tokio::test]
    async fn lines_redacts_for_an_agent_by_default() {
        let (ctx, _tmp) = test_ctx()
            .agent("claude-code")
            .with_pii_session("s1", 3)
            .build();

        let created = create(&ctx, "s1".to_string(), FilterCriteria::default(), null_progress()).unwrap();
        let filter = {
            let filters = ctx.state().active_filters.lock().unwrap();
            Arc::clone(filters.get(&created.filter_id).unwrap())
        };
        // Run the scan synchronously (this test's spawner is a NullSpawner).
        scan_filter_background(ctx.clone(), filter, None, null_progress()).await;

        let page = lines(&ctx, &created.filter_id, 0, 10).unwrap();
        assert_eq!(page.total_matches, 3);
        for line in &page.lines {
            assert!(
                !line.raw.contains('@'),
                "an agent must not see raw PII by default: {}",
                line.raw
            );
        }
    }

    #[test]
    fn lines_never_redacts_for_a_ui_caller() {
        let (ctx, _tmp) = test_ctx().with_pii_session("s1", 2).build();
        let created = create(&ctx, "s1".to_string(), FilterCriteria::default(), null_progress()).unwrap();
        // Force-populate matches directly (no need to run the scan for this
        // assertion — `lines` renders whatever `get_page` returns).
        let filter = {
            let filters = ctx.state().active_filters.lock().unwrap();
            Arc::clone(filters.get(&created.filter_id).unwrap())
        };
        filter.append_matches(&[0, 1]);

        let page = lines(&ctx, &created.filter_id, 0, 10).unwrap();
        assert!(page.lines.iter().any(|l| l.raw.contains('@')), "a Ui caller must see raw PII unchanged");
    }
}
