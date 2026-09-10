//! State-tracker, correlator, and section endpoints: events, correlations,
//! state_at, sections, section_at.
//!
//! Every handler here is a thin adapter: resolve any bridge-only convenience
//! (bare→qualified processor id resolution), build a `ServiceCtx` via
//! `ctx.svc(client)`, call the shared `services::{tracker,correlator,sections}`
//! function, then render the JSON shape this route has always returned.
//! `services::insights` is the only other WP-3 service — its route lives in
//! `routes/insights.rs`.
//!
//! **Deliberate wire-text changes** (documented here rather than silently
//! introduced): errors surfaced by the shared services use `ServiceError`'s
//! message text, which in a few cases differs from what this file used to
//! spell out ad hoc — e.g. a missing tracker's error was `"no tracker results
//! for session {s} / tracker {t}"` (lowercase) here vs.
//! `"No state tracker results for session {s} / tracker {t}"` (capitalized,
//! matching the desktop command) via `services::tracker::state_at`. Missing
//! session/no-source errors on `h_sections`/`h_section_at` similarly now read
//! `"Session '{id}' not found"` instead of `"Session not found: {id}"`. Both
//! transports now say the same thing, which is the point of this package —
//! see `services::tracker`/`services::sections` for the authoritative text.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::processors::marketplace::resolve_processor_id_checked;

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::section_json;
use crate::services::{correlator, sections, tracker};

/// Self-reported MCP client name from the `X-LogTapper-Client` header,
/// defaulting to `"mcp"` — passed to `BridgeCtx::svc` so the activity feed
/// (once these routes start mutating anything) can tell agents apart.
/// `pub(super)` so `routes::insights` shares it rather than duplicating the
/// lookup.
pub(super) fn client_name(headers: &HeaderMap) -> &str {
    headers
        .get("x-logtapper-client")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("mcp")
}

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
    Query(params): Query<EventParams>,
) -> Json<Value> {
    let limit = params.limit.unwrap_or(50).min(200);
    let svc = ctx.svc(client_name(&headers));

    let events = match tracker::recent_events(&svc, &session_id, limit) {
        Ok(events) => events,
        Err(e) => return Json(json!({ "error": e.message() })),
    };

    let events_json: Vec<Value> = events
        .iter()
        .map(|e| {
            json!({
                "trackerId": e.tracker_id,
                "transitionName": e.transition.transition_name,
                "lineNum": e.transition.line_num,
                "timestamp": e.transition.timestamp,
                "changes": e.transition.changes,
            })
        })
        .collect();

    let count = events_json.len();
    Json(json!({
        "sessionId": session_id,
        "events": events_json,
        "count": count,
    }))
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
    Query(params): Query<CorrelationParams>,
) -> Json<Value> {
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);
    let svc = ctx.svc(client_name(&headers));

    let groups = match correlator::events(&svc, &session_id, params.correlator_id.as_deref(), offset, limit) {
        Ok(g) => g,
        Err(e) => return Json(json!({ "error": e.message() })),
    };

    let correlators: Vec<Value> = groups
        .iter()
        .map(|g| {
            let events: Vec<Value> = g
                .page
                .items
                .iter()
                .map(|evt| {
                    json!({
                        "triggerLineNum": evt.trigger_line_num,
                        "triggerTimestamp": evt.trigger_timestamp,
                        "triggerSourceId": evt.trigger_source_id,
                        "triggerFields": evt.trigger_fields,
                        "message": evt.message,
                        "matchedSourceIds": evt.matched_sources.keys().collect::<Vec<_>>(),
                    })
                })
                .collect();
            json!({
                "correlatorId": g.correlator_id,
                "totalEvents": g.page.total,
                "eventCount": events.len(),
                "events": events,
                "offset": offset,
                "limit": limit,
            })
        })
        .collect();

    Json(json!({
        "sessionId": session_id,
        "correlators": correlators,
    }))
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
    Query(params): Query<StateAtParams>,
) -> Json<Value> {
    let line_num = params.line;

    // Resolve bare ID → qualified ID (e.g. "wifi-state" → "wifi-state@official").
    // Bridge-only convenience — the desktop UI always passes an already-qualified
    // id, so this stays here rather than in `services::tracker::state_at`.
    let resolved_id = {
        let procs = ctx.state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match resolve_processor_id_checked(&procs, &tracker_id) {
            Ok(r) => r.unwrap_or_else(|| tracker_id.clone()),
            Err(e) => return Json(json!({ "error": e, "sessionId": session_id, "trackerId": tracker_id })),
        }
    };

    let svc = ctx.svc(client_name(&headers));

    match tracker::state_at(&svc, &session_id, &resolved_id, line_num) {
        Ok(snap) => Json(json!({
            "trackerId": resolved_id,
            "sessionId": session_id,
            "lineNum": snap.line_num,
            "timestamp": snap.timestamp,
            "fields": snap.fields,
            "initializedFields": snap.initialized_fields,
            "sourceSections": snap.source_sections,
        })),
        Err(e) => Json(json!({ "error": e.message() })),
    }
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
    Query(params): Query<SectionAtParams>,
) -> Json<Value> {
    let svc = ctx.svc(client_name(&headers));

    let result = match sections::at(&svc, &session_id, params.line) {
        Ok(r) => r,
        Err(e) => return Json(json!({ "error": e.message() })),
    };

    let containing: Vec<Value> = result.containing.iter().map(section_json).collect();

    let mut out = json!({
        "sessionId": session_id,
        "line": params.line,
        // The name a processor's `filter.section` must use to match this line.
        // Null means no rule can target it by section.
        "matchesFilterSection": result.matches_filter_section.map_or(Value::Null, |s| json!(s)),
        "containingSections": containing,
        "totalLinesInSession": result.total_lines_in_session,
    });
    if let Some(n) = result.note {
        out["note"] = json!(n);
    }
    Json(out)
}

pub(crate) async fn h_sections(
    State(ctx): State<BridgeCtx>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(params): Query<SectionsParams>,
) -> Json<Value> {
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);
    let svc = ctx.svc(client_name(&headers));

    let page = match sections::list(&svc, &session_id, params.query.as_deref(), offset, limit) {
        Ok(p) => p,
        Err(e) => return Json(json!({ "error": e.message() })),
    };

    let sections_json: Vec<Value> = page.items.iter().map(section_json).collect();

    Json(json!({
        "sessionId": session_id,
        "total": page.total,
        "returned": sections_json.len(),
        "offset": page.offset,
        "limit": page.limit,
        "sections": sections_json,
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_from(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (k, v) in pairs {
            headers.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        headers
    }

    #[test]
    fn client_name_defaults_to_mcp_when_header_absent() {
        assert_eq!(client_name(&headers_from(&[])), "mcp");
    }

    #[test]
    fn client_name_reads_the_header_when_present() {
        let headers = headers_from(&[("x-logtapper-client", "claude-code")]);
        assert_eq!(client_name(&headers), "claude-code");
    }

    #[test]
    fn client_name_ignores_case_of_the_header_name() {
        // HTTP header names are case-insensitive; axum's HeaderMap normalizes
        // this, but pin it here since a header-name typo would silently fall
        // back to "mcp" instead of failing loudly.
        let headers = headers_from(&[("X-LogTapper-Client", "claude-desktop")]);
        assert_eq!(client_name(&headers), "claude-desktop");
    }
}
