//! `correlator` service — cross-source correlation event access.
//!
//! One implementation shared by `commands::correlator::get_correlator_events`
//! (the desktop UI's single-correlator, unpaginated read) and the MCP bridge's
//! `mcp_bridge::routes::tracker::h_correlations` (which pages, and can span
//! every correlator in a session at once). Before this package each transport
//! read `AppState::correlator_results` directly with its own hand-rolled
//! pagination/grouping.

use crate::processors::correlator::engine::{CorrelationEvent, CorrelatorResult};

use super::error::ServiceError;
use super::wire::Page;
use super::{lock_svc, ServiceCtx};

/// One correlator's paged events, alongside its author-supplied guidance.
///
/// No `PartialEq` — `CorrelationEvent` (from `processors::correlator::engine`)
/// doesn't derive it either, so tests compare individual fields instead.
#[derive(Debug, Clone)]
pub struct CorrelatorGroup {
    pub correlator_id: String,
    pub guidance: Option<String>,
    pub page: Page<CorrelationEvent>,
}

/// Page through correlation events for `session_id`.
///
/// `correlator_id` filters to a single correlator (at most one group comes
/// back); `None` returns every correlator that has results for this session,
/// each independently paged by the same `offset`/`limit` — matching
/// `h_correlations`'s inline per-correlator loop, ported here verbatim.
///
/// A session with no correlator results yet (or that doesn't exist) yields an
/// empty list rather than an error, matching both callers' long-standing
/// behavior of treating "nothing to report" as a normal, empty result.
pub fn events(
    ctx: &ServiceCtx,
    session_id: &str,
    correlator_id: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<Vec<CorrelatorGroup>, ServiceError> {
    let results = lock_svc(&ctx.state().correlator_results, "correlator_results")?;

    let Some(session_map) = results.get(session_id) else {
        return Ok(Vec::new());
    };

    let groups: Vec<CorrelatorGroup> = session_map
        .iter()
        .filter(|(cid, _)| correlator_id.map_or(true, |fid| fid == cid.as_str()))
        .map(|(cid, result)| {
            let total = result.events.len();
            let items: Vec<CorrelationEvent> =
                result.events.iter().skip(offset).take(limit).cloned().collect();
            CorrelatorGroup {
                correlator_id: cid.clone(),
                guidance: result.guidance.clone(),
                page: Page::window(items, offset, limit, total),
            }
        })
        .collect();

    Ok(groups)
}

/// The full (unpaginated) result for one correlator.
///
/// Backs `commands::correlator::get_correlator_events`, which has always
/// returned every event for a single correlator with no pagination and
/// defaulted to an empty result (not an error) when the correlator has no
/// results yet — that default is reproduced here rather than in the adapter,
/// so both transports share one "missing means empty" decision.
pub fn full_result(
    ctx: &ServiceCtx,
    session_id: &str,
    correlator_id: &str,
) -> Result<CorrelatorResult, ServiceError> {
    let groups = events(ctx, session_id, Some(correlator_id), 0, usize::MAX)?;
    Ok(groups.into_iter().next().map_or(
        CorrelatorResult {
            guidance: None,
            events: Vec::new(),
        },
        |g| CorrelatorResult {
            guidance: g.guidance,
            events: g.page.items,
        },
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;
    use std::collections::HashMap;

    fn event(trigger_line_num: usize) -> CorrelationEvent {
        CorrelationEvent {
            trigger_line_num,
            trigger_timestamp: trigger_line_num as i64 * 1000,
            trigger_source_id: "src-a".to_string(),
            trigger_fields: HashMap::new(),
            trigger_raw_line: format!("line {trigger_line_num}"),
            matched_sources: HashMap::new(),
            message: format!("event at {trigger_line_num}"),
        }
    }

    fn seed(ctx: &crate::services::ServiceCtx, session_id: &str, correlator_id: &str, guidance: Option<&str>, events: Vec<CorrelationEvent>) {
        let result = CorrelatorResult {
            guidance: guidance.map(str::to_string),
            events,
        };
        ctx.state()
            .correlator_results
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .insert(correlator_id.to_string(), result);
    }

    #[test]
    fn events_pages_a_single_correlator() {
        let (ctx, _tmp) = test_ctx().build();
        seed(&ctx, "s1", "anr-detect", Some("watch for ANRs"), vec![event(1), event(2), event(3)]);

        let groups = events(&ctx, "s1", Some("anr-detect"), 1, 1).expect("events");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].correlator_id, "anr-detect");
        assert_eq!(groups[0].guidance.as_deref(), Some("watch for ANRs"));
        assert_eq!(groups[0].page.total, 3);
        assert_eq!(groups[0].page.items.len(), 1);
        assert_eq!(groups[0].page.items[0].trigger_line_num, 2);
    }

    #[test]
    fn events_with_no_filter_returns_every_correlator() {
        let (ctx, _tmp) = test_ctx().build();
        seed(&ctx, "s1", "a", None, vec![event(1)]);
        seed(&ctx, "s1", "b", None, vec![event(2), event(3)]);

        let groups = events(&ctx, "s1", None, 0, 50).expect("events");
        assert_eq!(groups.len(), 2);
        let ids: std::collections::HashSet<&str> = groups.iter().map(|g| g.correlator_id.as_str()).collect();
        assert!(ids.contains("a"));
        assert!(ids.contains("b"));
    }

    #[test]
    fn events_missing_session_returns_empty_not_an_error() {
        let (ctx, _tmp) = test_ctx().build();
        let groups = events(&ctx, "no-such-session", None, 0, 50).expect("events");
        assert!(groups.is_empty());
    }

    #[test]
    fn full_result_returns_every_event_unpaginated() {
        let (ctx, _tmp) = test_ctx().build();
        seed(&ctx, "s1", "anr-detect", Some("g"), vec![event(1), event(2), event(3)]);

        let result = full_result(&ctx, "s1", "anr-detect").expect("full_result");
        assert_eq!(result.guidance.as_deref(), Some("g"));
        assert_eq!(result.events.len(), 3);
    }

    #[test]
    fn full_result_defaults_to_empty_when_correlator_has_no_results() {
        let (ctx, _tmp) = test_ctx().build();
        let result = full_result(&ctx, "s1", "no-such-correlator").expect("full_result");
        assert!(result.guidance.is_none());
        assert!(result.events.is_empty());
    }
}
