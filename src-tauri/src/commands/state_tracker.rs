use std::collections::HashMap;
use tauri::State;
use crate::commands::{lock_or_err, AppState};
use crate::processors::state_tracker::types::{StateSnapshot, StateTransition};

// ---------------------------------------------------------------------------
// Helpers — resolve transitions for a tracker from either pipeline results
// (state_tracker_results) or live streaming state (stream_tracker_state).
// Pipeline results take priority when present.
// ---------------------------------------------------------------------------

fn resolve_transitions(
    state: &AppState,
    session_id: &str,
    tracker_id: &str,
) -> Option<Vec<StateTransition>> {
    // Try pipeline results first.
    {
        let results = state.state_tracker_results.lock().ok()?;
        if let Some(session_map) = results.get(session_id) {
            if let Some(r) = session_map.get(tracker_id) {
                return Some(r.transitions.clone());
            }
        }
    }
    // Fall back to streaming state.
    {
        let stream = state.stream_tracker_state.lock().ok()?;
        if let Some(session_map) = stream.get(session_id) {
            if let Some(cont) = session_map.get(tracker_id) {
                return Some(cont.transitions.clone());
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
    let transitions = resolve_transitions(&state, &session_id, &tracker_id)
        .ok_or_else(|| format!("No state tracker results for session {session_id} / tracker {tracker_id}"))?;

    let pos = transitions.partition_point(|t| t.line_num <= line_num);

    // Replay transitions up to pos against the tracker's declared defaults.
    let processors = lock_or_err(&state.processors, "processors")?;
    let processor = processors.get(&tracker_id)
        .ok_or_else(|| format!("Processor {tracker_id} not found"))?;
    let tracker_def = processor.as_state_tracker()
        .ok_or_else(|| format!("{tracker_id} is not a StateTracker"))?;

    let mut fields: HashMap<String, serde_json::Value> = tracker_def.state.iter()
        .map(|f| (f.name.clone(), f.default.clone()))
        .collect();

    let mut initialized: std::collections::HashSet<String> = Default::default();
    for t in &transitions[..pos] {
        for (field, change) in &t.changes {
            fields.insert(field.clone(), change.to.clone());
            initialized.insert(field.clone());
        }
    }

    let (line, ts) = if pos > 0 {
        let t = &transitions[pos - 1];
        (t.line_num, t.timestamp)
    } else {
        (0, 0)
    };

    Ok(StateSnapshot {
        line_num: line,
        timestamp: ts,
        fields,
        initialized_fields: initialized.into_iter().collect(),
    })
}

/// Get all transitions for a tracker in a session.
#[tauri::command]
pub async fn get_state_transitions(
    state: State<'_, AppState>,
    session_id: String,
    tracker_id: String,
) -> Result<Vec<StateTransition>, String> {
    resolve_transitions(&state, &session_id, &tracker_id)
        .ok_or_else(|| format!("No state tracker results for session {session_id} / tracker {tracker_id}"))
}

/// Get all transition line numbers grouped by tracker ID.
#[tauri::command]
pub async fn get_all_transition_lines(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<HashMap<String, Vec<usize>>, String> {
    let mut map: HashMap<String, Vec<usize>> = HashMap::new();

    // Collect from pipeline results.
    {
        let results = lock_or_err(&state.state_tracker_results, "state_tracker_results")?;
        if let Some(session_map) = results.get(&session_id) {
            for (tracker_id, result) in session_map {
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
                let lines: Vec<usize> = cont.transitions.iter().map(|t| t.line_num).collect();
                map.entry(tracker_id.clone()).or_insert(lines);
            }
        }
    }

    Ok(map)
}
