//! State-tracker, correlator, and section endpoints: events, correlations,
//! state_at, sections, section_at.
//!
//! Every handler is a thin adapter: resolve any bridge-only convenience
//! (bare→qualified processor id resolution), build a `ServiceCtx` via
//! `ctx.svc(client)`, call the shared `services::{tracker,correlator,sections}`
//! function, map its result into the typed `services::wire` shape.
//! `services::insights` is the only other WP-3 service — its route lives in
//! `routes/insights.rs`.
//!
//! **Wire changes (WP-13).** These five routes used to hand-render bespoke
//! JSON; they now answer with typed envelopes:
//!
//! - `events` → `Page<TrackerEventEntry>` (`events`/`count` → `items`/`total`).
//! - `correlations` → [`SessionCorrelations`], each correlator's events as a
//!   `Page<CorrelationSummary>` (`events` → `items`, `totalEvents` → `total`,
//!   `eventCount` dropped — it was `items.len()`).
//! - `state_at` → [`StateSnapshot`] itself, the same type the desktop command
//!   returns. `trackerId`/`sessionId` are gone from the body: both are in the
//!   request path, and duplicating them made this the only tracker response
//!   that was not simply the domain type.
//! - `sections` → `Page<SectionInfo>` (`sections` → `items`, `returned`
//!   dropped).
//! - `section_at` → [`SectionLocation`].
//!
//! Error messages come from `ServiceError` and are therefore identical to the
//! desktop command's for the same failure (e.g. `No state tracker results for
//! session {s} / tracker {t}`, `Session '{id}' not found`) — see
//! `services::tracker` / `services::sections` for the authoritative text.

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::Deserialize;

use crate::core::session::SectionInfo;
use crate::processors::marketplace::resolve_processor_id_checked;
use crate::processors::state_tracker::types::StateSnapshot;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::{Qs, client_name};
use crate::services::wire::{
    CorrelationSummary, CorrelatorEvents, Page, SectionLocation, SessionCorrelations,
    TrackerEventEntry,
};
use crate::services::{ServiceError, correlator, lock_svc, sections, tracker};

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/events
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct EventParams {
    /// Max transitions to return, most-recent first (default 50, max 200).
    limit: Option<usize>,
}

pub(crate) async fn h_events(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Qs(params): Qs<EventParams>,
) -> Result<Json<Page<TrackerEventEntry>>, ServiceError> {
    let limit = params.limit.unwrap_or(50).min(200);
    let svc = ctx.svc(client_name(&headers));

    let items: Vec<TrackerEventEntry> = tracker::recent_events(&svc, &session_id, limit)?
        .into_iter()
        .map(|e| TrackerEventEntry {
            tracker_id: e.tracker_id,
            transition_name: e.transition.transition_name,
            line_num: e.transition.line_num,
            timestamp: e.transition.timestamp,
            changes: e.transition.changes,
        })
        .collect();

    // `recent_events` caps at `limit` and does not report how many it walked
    // past, so `total` is the page's own length — it is not a pagination
    // cursor, and there is no `offset` to advance. A caller that wants more
    // raises `limit`.
    let total = items.len();
    Ok(Json(Page::window(items, 0, limit, total)))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/correlations
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct CorrelationParams {
    /// Filter to a single correlator by ID.
    correlator_id: Option<String>,
    /// Max events to return (default 50, max 200).
    limit: Option<usize>,
    /// Offset for pagination (default 0).
    offset: Option<usize>,
}

pub(crate) async fn h_correlations(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Qs(params): Qs<CorrelationParams>,
) -> Result<Json<SessionCorrelations>, ServiceError> {
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);
    let svc = ctx.svc(client_name(&headers));

    let groups = correlator::events(
        &svc,
        &session_id,
        params.correlator_id.as_deref(),
        offset,
        limit,
    )?;

    let correlators: Vec<CorrelatorEvents> = groups
        .into_iter()
        .map(|g| {
            let total = g.page.total;
            let items: Vec<CorrelationSummary> = g
                .page
                .items
                .into_iter()
                .map(|evt| CorrelationSummary {
                    trigger_line_num: evt.trigger_line_num,
                    trigger_timestamp: evt.trigger_timestamp,
                    trigger_source_id: evt.trigger_source_id,
                    trigger_fields: evt.trigger_fields,
                    message: evt.message,
                    // Ids only — the per-source match records carry raw line
                    // text, which this endpoint has never exposed and which
                    // `services::correlator` does not redact. See
                    // `CorrelationSummary`'s docs.
                    matched_source_ids: evt.matched_sources.into_keys().collect(),
                })
                .collect();
            CorrelatorEvents {
                correlator_id: g.correlator_id,
                guidance: g.guidance,
                events: Page::window(items, offset, limit, total),
            }
        })
        .collect();

    Ok(Json(SessionCorrelations { session_id, correlators }))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/tracker/{tracker_id}/state_at
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct StateAtParams {
    /// Line number to compute state at (required).
    line: usize,
}

pub(crate) async fn h_state_at_line(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path((session_id, tracker_id)): Path<(String, String)>,
    Qs(params): Qs<StateAtParams>,
) -> Result<Json<StateSnapshot>, ServiceError> {
    let line_num = params.line;

    // Resolve bare ID → qualified ID (e.g. "wifi-state" → "wifi-state@official").
    // Bridge-only convenience — the desktop UI always passes an already-qualified
    // id, so this stays here rather than in `services::tracker::state_at`.
    let resolved_id = {
        let procs = lock_svc(&ctx.state.processors, "processors")?;
        resolve_processor_id_checked(&procs, &tracker_id)
            .map_err(ServiceError::invalid_arg)?
            .unwrap_or_else(|| tracker_id.clone())
    };

    let svc = ctx.svc(client_name(&headers));
    Ok(Json(tracker::state_at(&svc, &session_id, &resolved_id, line_num)?))
}

// ---------------------------------------------------------------------------
// GET /mcp/sessions/{session_id}/sections
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct SectionsParams {
    /// Max sections to return (default 50, max 200).
    limit: Option<usize>,
    /// Number of sections to skip (default 0).
    offset: Option<usize>,
    /// Case-insensitive substring filter on section name.
    query: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct SectionAtParams {
    /// 0-based line number to resolve.
    line: usize,
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
pub(crate) async fn h_section_at(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Qs(params): Qs<SectionAtParams>,
) -> Result<Json<SectionLocation>, ServiceError> {
    let svc = ctx.svc(client_name(&headers));
    let result = sections::at(&svc, &session_id, params.line)?;

    Ok(Json(SectionLocation {
        session_id,
        line: params.line,
        matches_filter_section: result.matches_filter_section,
        containing_sections: result.containing,
        total_lines_in_session: result.total_lines_in_session,
        note: result.note.map(str::to_string),
    }))
}

pub(crate) async fn h_sections(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Qs(params): Qs<SectionsParams>,
) -> Result<Json<Page<SectionInfo>>, ServiceError> {
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);
    let svc = ctx.svc(client_name(&headers));

    Ok(Json(sections::list(
        &svc,
        &session_id,
        params.query.as_deref(),
        offset,
        limit,
    )?))
}
