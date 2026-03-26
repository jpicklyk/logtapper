use std::collections::HashMap;
use tauri::State;
use crate::commands::{lock_or_err, AppState};
use crate::processors::state_tracker::schema::TrackerMode;
use crate::processors::state_tracker::types::{StateSnapshot, StateTransition};

// ---------------------------------------------------------------------------
// Helpers — resolve transitions for a tracker from either pipeline results
// (state_tracker_results) or live streaming state (stream_tracker_state).
// Pipeline results take priority when present.
// ---------------------------------------------------------------------------

struct ResolvedTracker {
    transitions: Vec<StateTransition>,
    source_sections: Vec<String>,
}

fn resolve_tracker(
    state: &AppState,
    session_id: &str,
    tracker_id: &str,
) -> Option<ResolvedTracker> {
    // Try pipeline results first.
    {
        let results = state.state_tracker_results.lock().ok()?;
        if let Some(session_map) = results.get(session_id) {
            if let Some(r) = session_map.get(tracker_id) {
                return Some(ResolvedTracker {
                    transitions: r.transitions.clone(),
                    source_sections: r.source_sections.clone(),
                });
            }
        }
    }
    // Fall back to streaming state (no source_sections for streaming).
    {
        let stream = state.stream_tracker_state.lock().ok()?;
        if let Some(session_map) = stream.get(session_id) {
            if let Some(cont) = session_map.get(tracker_id) {
                return Some(ResolvedTracker {
                    transitions: cont.transitions.clone(),
                    source_sections: vec![],
                });
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Get the state snapshot at a specific line number for a given tracker.
#[tauri::command]
pub async fn get_state_at_line(
    state: State<'_, AppState>,
    session_id: String,
    tracker_id: String,
    line_num: usize,
) -> Result<StateSnapshot, String> {
    let resolved = resolve_tracker(&state, &session_id, &tracker_id)
        .ok_or_else(|| format!("No state tracker results for session {session_id} / tracker {tracker_id}"))?;

    let processors = lock_or_err(&state.processors, "processors")?;
    let processor = processors.get(&tracker_id)
        .ok_or_else(|| format!("Processor {tracker_id} not found"))?;
    let tracker_def = processor.as_state_tracker()
        .ok_or_else(|| format!("{tracker_id} is not a StateTracker"))?;

    // Snapshot trackers represent a point-in-time dump — the selected line is irrelevant.
    let effective_line = if tracker_def.mode == TrackerMode::Snapshot {
        usize::MAX
    } else {
        line_num
    };

    let pos = resolved.transitions.partition_point(|t| t.line_num <= effective_line);

    let mut fields: HashMap<String, serde_json::Value> = tracker_def.state.iter()
        .map(|f| (f.name.clone(), f.default.clone()))
        .collect();

    let mut initialized: std::collections::HashSet<String> = Default::default();
    for t in &resolved.transitions[..pos] {
        for (field, change) in &t.changes {
            fields.insert(field.clone(), change.to.clone());
            initialized.insert(field.clone());
        }
    }

    let (line, ts) = if pos > 0 {
        let t = &resolved.transitions[pos - 1];
        (t.line_num, t.timestamp)
    } else {
        (0, 0)
    };

    Ok(StateSnapshot {
        line_num: line,
        timestamp: ts,
        fields,
        initialized_fields: initialized.into_iter().collect(),
        source_sections: resolved.source_sections,
    })
}

/// Get all transitions for a tracker in a session.
#[tauri::command]
pub async fn get_state_transitions(
    state: State<'_, AppState>,
    session_id: String,
    tracker_id: String,
) -> Result<Vec<StateTransition>, String> {
    resolve_tracker(&state, &session_id, &tracker_id)
        .map(|r| r.transitions)
        .ok_or_else(|| format!("No state tracker results for session {session_id} / tracker {tracker_id}"))
}

/// Get all transition line numbers grouped by tracker ID.
/// Only includes trackers where `output.timeline` is true.
#[tauri::command]
pub async fn get_all_transition_lines(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<HashMap<String, Vec<usize>>, String> {
    // Build a set of tracker IDs that have timeline enabled.
    let timeline_enabled: std::collections::HashSet<String> = {
        let processors = lock_or_err(&state.processors, "processors")?;
        processors.iter()
            .filter_map(|(id, proc)| {
                proc.as_state_tracker()
                    .filter(|def| def.output.timeline)
                    .map(|_| id.clone())
            })
            .collect()
    };

    let mut map: HashMap<String, Vec<usize>> = HashMap::new();

    // Collect from pipeline results.
    {
        let results = lock_or_err(&state.state_tracker_results, "state_tracker_results")?;
        if let Some(session_map) = results.get(&session_id) {
            for (tracker_id, result) in session_map {
                if !timeline_enabled.contains(tracker_id) { continue; }
                let lines: Vec<usize> = result.transitions.iter().map(|t| t.line_num).collect();
                map.insert(tracker_id.clone(), lines);
            }
        }
    }

    // Merge in streaming state (adds trackers not already present from pipeline results).
    {
        let stream = lock_or_err(&state.stream_tracker_state, "stream_tracker_state")?;
        if let Some(session_map) = stream.get(&session_id) {
            for (tracker_id, cont) in session_map {
                if !timeline_enabled.contains(tracker_id) { continue; }
                let lines: Vec<usize> = cont.transitions.iter().map(|t| t.line_num).collect();
                map.entry(tracker_id.clone()).or_insert(lines);
            }
        }
    }

    Ok(map)
}
