//! `tracker` service — state-tracker replay.
//!
//! One implementation shared by the desktop command
//! (`commands::state_tracker::get_state_at_line`) and the MCP bridge route
//! (`mcp_bridge::routes::tracker::h_state_at_line`). Before this package they
//! were two independently hand-written copies of the same replay logic, and
//! had drifted: the bridge's copy ignored [`TrackerMode::Snapshot`] (it always
//! replayed up to the literal requested line) and dropped `sourceSections`
//! from its response. Both are fixed here, once, for every caller.

use std::collections::HashMap;

use crate::commands::AppState;
use crate::processors::state_tracker::engine::build_defaults;
use crate::processors::state_tracker::schema::{StateTrackerDef, TrackerMode};
use crate::processors::state_tracker::types::{StateSnapshot, StateTransition};

use super::error::ServiceError;
use super::wire::Page;
use super::{lock_svc, ServiceCtx};

// ---------------------------------------------------------------------------
// Resolution — pipeline results take priority over live streaming state
// ---------------------------------------------------------------------------

/// Transitions for one tracker, resolved from whichever store has them.
struct ResolvedTracker {
    transitions: Vec<StateTransition>,
    /// Only populated for completed pipeline runs — live streaming state
    /// carries no section provenance.
    source_sections: Vec<String>,
}

/// Resolve `tracker_id`'s transitions for `session_id`: completed pipeline
/// results (`AppState::state_tracker_results`) first, falling back to live
/// ADB streaming state (`AppState::stream_tracker_state`). Ported verbatim
/// from `commands::state_tracker::resolve_tracker` / the bridge's inline copy
/// of the same fallback — both callers now share this one resolution order.
fn resolve_tracker(
    state: &AppState,
    session_id: &str,
    tracker_id: &str,
) -> Result<ResolvedTracker, ServiceError> {
    {
        let results = lock_svc(&state.state_tracker_results, "state_tracker_results")?;
        if let Some(r) = results.get(session_id).and_then(|m| m.get(tracker_id)) {
            return Ok(ResolvedTracker {
                transitions: r.transitions.clone(),
                source_sections: r.source_sections.clone(),
            });
        }
    }
    {
        let stream = lock_svc(&state.stream_tracker_state, "stream_tracker_state")?;
        if let Some(cont) = stream.get(session_id).and_then(|m| m.get(tracker_id)) {
            return Ok(ResolvedTracker {
                transitions: cont.transitions.clone(),
                source_sections: Vec::new(),
            });
        }
    }
    Err(ServiceError::NotFound(format!(
        "No state tracker results for session {session_id} / tracker {tracker_id}"
    )))
}

/// Replay `transitions` up to (and including) `effective_line`, folding each
/// transition's field changes onto the tracker's declared defaults. Pure —
/// no locking — so [`state_at`] and any future caller share the exact same
/// math regardless of where the transitions came from.
fn replay(
    transitions: &[StateTransition],
    tracker_def: &StateTrackerDef,
    effective_line: usize,
    source_sections: Vec<String>,
) -> StateSnapshot {
    let pos = transitions.partition_point(|t| t.line_num <= effective_line);

    let mut fields = build_defaults(tracker_def);
    let mut initialized: std::collections::HashSet<String> = Default::default();
    for t in &transitions[..pos] {
        for (field, change) in &t.changes {
            fields.insert(field.clone(), change.to.clone());
            initialized.insert(field.clone());
        }
    }

    let (line_num, timestamp) = if pos > 0 {
        let t = &transitions[pos - 1];
        (t.line_num, t.timestamp)
    } else {
        (0, 0)
    };

    StateSnapshot {
        line_num,
        timestamp,
        fields,
        initialized_fields: initialized.into_iter().collect(),
        source_sections,
    }
}

/// State snapshot for `tracker_id` at `line_num`.
///
/// **Snapshot-mode fix**: a [`TrackerMode::Snapshot`] tracker represents a
/// point-in-time dump (e.g. a single `dumpsys` invocation) where the selected
/// line is irrelevant — the caller always wants the fully-accumulated final
/// state. The desktop command has always special-cased this
/// (`effective_line = usize::MAX`); the MCP bridge's own copy of this replay
/// did not, so querying a Snapshot tracker over MCP silently returned only
/// the state as of the literal requested line — frequently nothing at all, if
/// that line predates every transition — instead of the same full dump the
/// UI showed for the identical tracker. Both callers now go through this one
/// function, so that divergence cannot recur for a third caller.
///
/// Also carries `sourceSections` in the returned [`StateSnapshot`] for every
/// caller — the bridge's old ad hoc JSON response dropped that field.
pub fn state_at(
    ctx: &ServiceCtx,
    session_id: &str,
    tracker_id: &str,
    line_num: usize,
) -> Result<StateSnapshot, ServiceError> {
    let state = ctx.state();
    let resolved = resolve_tracker(state, session_id, tracker_id)?;

    let tracker_def = {
        let processors = lock_svc(&state.processors, "processors")?;
        let processor = processors
            .get(tracker_id)
            .ok_or_else(|| ServiceError::NotFound(format!("Processor {tracker_id} not found")))?;
        processor.as_state_tracker_arc().ok_or_else(|| {
            ServiceError::invalid_arg(format!("{tracker_id} is not a StateTracker"))
        })?
    };

    let effective_line = if tracker_def.mode == TrackerMode::Snapshot {
        usize::MAX
    } else {
        line_num
    };

    Ok(replay(
        &resolved.transitions,
        &tracker_def,
        effective_line,
        resolved.source_sections,
    ))
}

/// Page through `tracker_id`'s raw transitions (chronological, as recorded),
/// windowed by `offset`/`limit`.
///
/// Backs `commands::state_tracker::get_state_transitions`, which returns the
/// full unpaginated list to the desktop UI (`offset` 0, `limit` `usize::MAX`)
/// — the pagination exists so a future MCP route can page a single tracker's
/// transitions without inventing a second implementation.
pub fn transitions(
    ctx: &ServiceCtx,
    session_id: &str,
    tracker_id: &str,
    offset: usize,
    limit: usize,
) -> Result<Page<StateTransition>, ServiceError> {
    let resolved = resolve_tracker(ctx.state(), session_id, tracker_id)?;
    let total = resolved.transitions.len();
    let items: Vec<StateTransition> = resolved
        .transitions
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect();
    Ok(Page::window(items, offset, limit, total))
}

/// All transition line numbers, grouped by tracker id, for trackers whose
/// `output.timeline` flag is set.
///
/// Ported verbatim from `commands::state_tracker::get_all_transition_lines`:
/// pipeline results are collected first, then streaming state fills in any
/// tracker not already present (pipeline results take priority per-tracker,
/// exactly as [`resolve_tracker`] does for a single tracker).
pub fn all_transition_lines(
    ctx: &ServiceCtx,
    session_id: &str,
) -> Result<HashMap<String, Vec<usize>>, ServiceError> {
    let state = ctx.state();

    let timeline_enabled: std::collections::HashSet<String> = {
        let processors = lock_svc(&state.processors, "processors")?;
        processors
            .iter()
            .filter_map(|(id, proc)| {
                proc.as_state_tracker()
                    .filter(|def| def.output.timeline)
                    .map(|_| id.clone())
            })
            .collect()
    };

    let mut map: HashMap<String, Vec<usize>> = HashMap::new();

    {
        let results = lock_svc(&state.state_tracker_results, "state_tracker_results")?;
        if let Some(session_map) = results.get(session_id) {
            for (tracker_id, result) in session_map {
                if !timeline_enabled.contains(tracker_id) {
                    continue;
                }
                map.insert(
                    tracker_id.clone(),
                    result.transitions.iter().map(|t| t.line_num).collect(),
                );
            }
        }
    }

    {
        let stream = lock_svc(&state.stream_tracker_state, "stream_tracker_state")?;
        if let Some(session_map) = stream.get(session_id) {
            for (tracker_id, cont) in session_map {
                if !timeline_enabled.contains(tracker_id) {
                    continue;
                }
                map.entry(tracker_id.clone())
                    .or_insert_with(|| cont.transitions.iter().map(|t| t.line_num).collect());
            }
        }
    }

    Ok(map)
}

// ---------------------------------------------------------------------------
// Aggregate transitions across every tracker in a session (h_events)
// ---------------------------------------------------------------------------

/// One transition tagged with which tracker produced it.
pub struct TrackerEvent {
    pub tracker_id: String,
    pub transition: StateTransition,
}

/// Every transition across every tracker in `session_id` (pipeline results,
/// then live streaming state — both may coexist), most-recent line first,
/// capped at `limit`.
///
/// Ported verbatim from `mcp_bridge::routes::tracker::h_events`'s inline
/// aggregation — the sole consumer, but pulled out of the route so it stops
/// reading `AppState` directly.
pub fn recent_events(
    ctx: &ServiceCtx,
    session_id: &str,
    limit: usize,
) -> Result<Vec<TrackerEvent>, ServiceError> {
    let state = ctx.state();
    let mut all: Vec<TrackerEvent> = Vec::new();

    {
        let pipeline_res = lock_svc(&state.state_tracker_results, "state_tracker_results")?;
        if let Some(session_map) = pipeline_res.get(session_id) {
            for r in session_map.values() {
                for t in &r.transitions {
                    all.push(TrackerEvent {
                        tracker_id: r.tracker_id.clone(),
                        transition: t.clone(),
                    });
                }
            }
        }
    }

    {
        let stream_res = lock_svc(&state.stream_tracker_state, "stream_tracker_state")?;
        if let Some(session_map) = stream_res.get(session_id) {
            for (tracker_id, cont) in session_map {
                for t in &cont.transitions {
                    all.push(TrackerEvent {
                        tracker_id: tracker_id.clone(),
                        transition: t.clone(),
                    });
                }
            }
        }
    }

    all.sort_by(|a, b| b.transition.line_num.cmp(&a.transition.line_num));
    all.truncate(limit);
    Ok(all)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processors::state_tracker::schema::{StateFieldDecl, StateFieldType, StateTrackerOutput};
    use crate::processors::state_tracker::types::{ContinuousTrackerState, FieldChange, StateTrackerResult};
    use crate::processors::{AnyProcessor, ProcessorKind, ProcessorMeta};
    use crate::services::testing::test_ctx;
    use serde_json::json;
    use std::sync::Arc;

    fn tracker_def(mode: TrackerMode, timeline: bool) -> StateTrackerDef {
        StateTrackerDef {
            group: String::new(),
            sections: vec![],
            mode,
            state: vec![
                StateFieldDecl {
                    name: "enabled".to_string(),
                    field_type: StateFieldType::Bool,
                    default: json!(false),
                },
                StateFieldDecl {
                    name: "ssid".to_string(),
                    field_type: StateFieldType::String,
                    default: json!(""),
                },
            ],
            transitions: vec![],
            output: StateTrackerOutput {
                timeline,
                annotate: false,
            },
        }
    }

    fn install_tracker(ctx: &ServiceCtx, id: &str, mode: TrackerMode, timeline: bool) {
        let processor = AnyProcessor {
            meta: ProcessorMeta {
                id: id.to_string(),
                name: id.to_string(),
                version: "1.0.0".to_string(),
                author: String::new(),
                description: String::new(),
                tags: vec![],
                builtin: false,
                license: None,
                category: None,
                repository: None,
                deprecated: false,
            },
            kind: ProcessorKind::StateTracker(Arc::new(tracker_def(mode, timeline))),
            schema: None,
            source: None,
        };
        ctx.state()
            .processors
            .lock()
            .unwrap()
            .insert(id.to_string(), processor);
    }

    fn transition(line_num: usize, field: &str, to: serde_json::Value) -> StateTransition {
        let mut changes = HashMap::new();
        changes.insert(
            field.to_string(),
            FieldChange {
                from: json!(null),
                to,
            },
        );
        StateTransition {
            line_num,
            timestamp: line_num as i64 * 1000,
            transition_name: format!("t{line_num}"),
            changes,
        }
    }

    fn seed_pipeline_result(ctx: &ServiceCtx, session_id: &str, tracker_id: &str, transitions: Vec<StateTransition>, sections: Vec<String>, mode: TrackerMode) {
        let result = StateTrackerResult {
            tracker_id: tracker_id.to_string(),
            transitions,
            final_state: HashMap::new(),
            source_sections: sections,
            mode,
        };
        ctx.state()
            .state_tracker_results
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .insert(tracker_id.to_string(), result);
    }

    // ── state_at — TimeSeries replay ────────────────────────────────────────

    #[test]
    fn state_at_replays_time_series_transitions_up_to_the_line() {
        let (ctx, _tmp) = test_ctx().build();
        install_tracker(&ctx, "wifi-state", TrackerMode::TimeSeries, false);
        seed_pipeline_result(
            &ctx,
            "s1",
            "wifi-state",
            vec![
                transition(10, "enabled", json!(true)),
                transition(50, "ssid", json!("HomeWifi")),
                transition(90, "enabled", json!(false)),
            ],
            vec![],
            TrackerMode::TimeSeries,
        );

        let snap = state_at(&ctx, "s1", "wifi-state", 60).expect("state_at");
        assert_eq!(snap.line_num, 50);
        assert_eq!(snap.fields["enabled"], json!(true));
        assert_eq!(snap.fields["ssid"], json!("HomeWifi"));
        assert!(snap.initialized_fields.contains(&"enabled".to_string()));
        assert!(snap.source_sections.is_empty());
    }

    #[test]
    fn state_at_before_any_transition_returns_declared_defaults() {
        let (ctx, _tmp) = test_ctx().build();
        install_tracker(&ctx, "wifi-state", TrackerMode::TimeSeries, false);
        seed_pipeline_result(
            &ctx,
            "s1",
            "wifi-state",
            vec![transition(100, "enabled", json!(true))],
            vec![],
            TrackerMode::TimeSeries,
        );

        let snap = state_at(&ctx, "s1", "wifi-state", 5).expect("state_at");
        assert_eq!(snap.line_num, 0);
        assert_eq!(snap.timestamp, 0);
        assert_eq!(snap.fields["enabled"], json!(false));
        assert!(snap.initialized_fields.is_empty());
    }

    // ── state_at — the Snapshot-mode regression this package fixes ─────────

    #[test]
    fn state_at_snapshot_mode_ignores_the_requested_line_and_returns_the_full_dump() {
        // Exact scenario from the task: a Snapshot tracker seeded with
        // transitions at lines 900-1000; requesting line 10 must still return
        // the full accumulated state, not "nothing observed yet" — the bug
        // the bridge's old bespoke replay had.
        let (ctx, _tmp) = test_ctx().build();
        install_tracker(&ctx, "battery-dump", TrackerMode::Snapshot, false);
        seed_pipeline_result(
            &ctx,
            "s1",
            "battery-dump",
            vec![
                transition(900, "enabled", json!(true)),
                transition(950, "ssid", json!("FinalValue")),
                transition(1000, "enabled", json!(false)),
            ],
            vec!["BATTERY STATS".to_string()],
            TrackerMode::Snapshot,
        );

        let snap = state_at(&ctx, "s1", "battery-dump", 10).expect("state_at");
        assert_eq!(snap.line_num, 1000, "must land on the LAST transition, not line 10");
        assert_eq!(snap.fields["enabled"], json!(false));
        assert_eq!(snap.fields["ssid"], json!("FinalValue"));
        assert_eq!(snap.source_sections, vec!["BATTERY STATS".to_string()]);
    }

    #[test]
    fn state_at_time_series_mode_does_honor_the_requested_line() {
        // Control case: a TimeSeries tracker with the SAME transition data
        // must behave differently at line 10 than at line 1000 — proving the
        // Snapshot fix is mode-gated, not a blanket "always return the end".
        let (ctx, _tmp) = test_ctx().build();
        install_tracker(&ctx, "wifi-state", TrackerMode::TimeSeries, false);
        seed_pipeline_result(
            &ctx,
            "s1",
            "wifi-state",
            vec![transition(900, "enabled", json!(true))],
            vec![],
            TrackerMode::TimeSeries,
        );

        let snap = state_at(&ctx, "s1", "wifi-state", 10).expect("state_at");
        assert_eq!(snap.line_num, 0, "line 10 predates the only transition");
        assert_eq!(snap.fields["enabled"], json!(false));
    }

    #[test]
    fn state_at_carries_source_sections_through() {
        let (ctx, _tmp) = test_ctx().build();
        install_tracker(&ctx, "wifi-state", TrackerMode::TimeSeries, false);
        seed_pipeline_result(
            &ctx,
            "s1",
            "wifi-state",
            vec![transition(5, "enabled", json!(true))],
            vec!["DUMPSYS NORMAL".to_string(), "wifi".to_string()],
            TrackerMode::TimeSeries,
        );

        let snap = state_at(&ctx, "s1", "wifi-state", 10).expect("state_at");
        assert_eq!(
            snap.source_sections,
            vec!["DUMPSYS NORMAL".to_string(), "wifi".to_string()]
        );
    }

    #[test]
    fn state_at_falls_back_to_streaming_state_when_no_pipeline_results() {
        let (ctx, _tmp) = test_ctx().build();
        install_tracker(&ctx, "wifi-state", TrackerMode::TimeSeries, false);
        let cont = ContinuousTrackerState {
            current_state: HashMap::new(),
            transitions: vec![transition(3, "enabled", json!(true))],
            last_processed_line: 3,
        };
        ctx.state()
            .stream_tracker_state
            .lock()
            .unwrap()
            .entry("s1".to_string())
            .or_default()
            .insert("wifi-state".to_string(), cont);

        let snap = state_at(&ctx, "s1", "wifi-state", 10).expect("state_at");
        assert_eq!(snap.fields["enabled"], json!(true));
        assert!(snap.source_sections.is_empty(), "streaming state carries no section provenance");
    }

    #[test]
    fn state_at_errors_when_no_results_exist_for_the_tracker() {
        let (ctx, _tmp) = test_ctx().build();
        install_tracker(&ctx, "wifi-state", TrackerMode::TimeSeries, false);
        let err = state_at(&ctx, "s1", "wifi-state", 10).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn state_at_errors_when_the_processor_is_not_a_state_tracker() {
        let (ctx, _tmp) = test_ctx().build();
        seed_pipeline_result(&ctx, "s1", "not-a-tracker", vec![], vec![], TrackerMode::TimeSeries);
        // No processor installed at all under this id.
        let err = state_at(&ctx, "s1", "not-a-tracker", 10).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    // ── transitions() ────────────────────────────────────────────────────

    #[test]
    fn transitions_pages_the_raw_list() {
        let (ctx, _tmp) = test_ctx().build();
        seed_pipeline_result(
            &ctx,
            "s1",
            "wifi-state",
            vec![transition(1, "a", json!(1)), transition(2, "a", json!(2)), transition(3, "a", json!(3))],
            vec![],
            TrackerMode::TimeSeries,
        );

        let page = transitions(&ctx, "s1", "wifi-state", 1, 1).expect("transitions");
        assert_eq!(page.total, 3);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].line_num, 2);
    }

    #[test]
    fn transitions_full_page_returns_everything_unpaginated() {
        let (ctx, _tmp) = test_ctx().build();
        seed_pipeline_result(
            &ctx,
            "s1",
            "wifi-state",
            vec![transition(1, "a", json!(1)), transition(2, "a", json!(2))],
            vec![],
            TrackerMode::TimeSeries,
        );
        let page = transitions(&ctx, "s1", "wifi-state", 0, usize::MAX).expect("transitions");
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.total, 2);
    }

    // ── all_transition_lines() ───────────────────────────────────────────

    #[test]
    fn all_transition_lines_only_includes_timeline_enabled_trackers() {
        let (ctx, _tmp) = test_ctx().build();
        install_tracker(&ctx, "timeline-on", TrackerMode::TimeSeries, true);
        install_tracker(&ctx, "timeline-off", TrackerMode::TimeSeries, false);
        seed_pipeline_result(&ctx, "s1", "timeline-on", vec![transition(5, "a", json!(1))], vec![], TrackerMode::TimeSeries);
        seed_pipeline_result(&ctx, "s1", "timeline-off", vec![transition(6, "a", json!(1))], vec![], TrackerMode::TimeSeries);

        let map = all_transition_lines(&ctx, "s1").expect("all_transition_lines");
        assert_eq!(map.get("timeline-on"), Some(&vec![5]));
        assert!(!map.contains_key("timeline-off"));
    }

    #[test]
    fn all_transition_lines_merges_streaming_without_overriding_pipeline() {
        let (ctx, _tmp) = test_ctx().build();
        install_tracker(&ctx, "a", TrackerMode::TimeSeries, true);
        install_tracker(&ctx, "b", TrackerMode::TimeSeries, true);
        seed_pipeline_result(&ctx, "s1", "a", vec![transition(1, "x", json!(1))], vec![], TrackerMode::TimeSeries);
        let cont = ContinuousTrackerState {
            current_state: HashMap::new(),
            transitions: vec![transition(99, "x", json!(1))],
            last_processed_line: 99,
        };
        ctx.state()
            .stream_tracker_state
            .lock()
            .unwrap()
            .entry("s1".to_string())
            .or_default()
            .insert("b".to_string(), cont);

        let map = all_transition_lines(&ctx, "s1").expect("all_transition_lines");
        assert_eq!(map.get("a"), Some(&vec![1]));
        assert_eq!(map.get("b"), Some(&vec![99]));
    }

    // ── recent_events() ──────────────────────────────────────────────────

    #[test]
    fn recent_events_aggregates_across_trackers_most_recent_line_first() {
        let (ctx, _tmp) = test_ctx().build();
        seed_pipeline_result(&ctx, "s1", "a", vec![transition(10, "x", json!(1))], vec![], TrackerMode::TimeSeries);
        seed_pipeline_result(&ctx, "s1", "b", vec![transition(50, "x", json!(1))], vec![], TrackerMode::TimeSeries);

        let events = recent_events(&ctx, "s1", 50).expect("recent_events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].transition.line_num, 50);
        assert_eq!(events[0].tracker_id, "b");
        assert_eq!(events[1].transition.line_num, 10);
    }

    #[test]
    fn recent_events_respects_the_limit() {
        let (ctx, _tmp) = test_ctx().build();
        seed_pipeline_result(
            &ctx,
            "s1",
            "a",
            vec![transition(1, "x", json!(1)), transition(2, "x", json!(1)), transition(3, "x", json!(1))],
            vec![],
            TrackerMode::TimeSeries,
        );
        let events = recent_events(&ctx, "s1", 2).expect("recent_events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].transition.line_num, 3);
        assert_eq!(events[1].transition.line_num, 2);
    }

    #[test]
    fn recent_events_empty_session_returns_empty_list() {
        let (ctx, _tmp) = test_ctx().build();
        let events = recent_events(&ctx, "no-such-session", 50).expect("recent_events");
        assert!(events.is_empty());
    }
}
