use std::collections::HashMap;
use tauri::State;
use crate::commands::AppState;
use crate::processors::state_tracker::types::{StateSnapshot, StateTransition};

/// Get the state snapshot at a specific line number for a given tracker.
#[tauri::command]
pub async fn get_state_at_line(
    state: State<'_, AppState>,
    session_id: String,
    tracker_id: String,
    line_num: usize,
) -> Result<StateSnapshot, String> {
    // Binary search for state at line_num using stored transitions
    let pos = {
        let results = state.state_tracker_results.lock()
            .map_err(|_| "State tracker results lock poisoned")?;
        let session_results = results.get(&session_id)
            .ok_or_else(|| format!("No state tracker results for session {session_id}"))?;
        let tracker_result = session_results.get(&tracker_id)
            .ok_or_else(|| format!("No results for tracker {tracker_id}"))?;
        tracker_result.transitions.partition_point(|t| t.line_num <= line_num)
    };

    // Get defaults from the tracker def and replay transitions up to pos
    let (fields, fields_init, line, ts) = {
        let processors = state.processors.lock()
            .map_err(|_| "Processor lock poisoned")?;
        let processor = processors.get(&tracker_id)
            .ok_or_else(|| format!("Processor {tracker_id} not found"))?;
        let tracker_def = processor.as_state_tracker()
            .ok_or_else(|| format!("{tracker_id} is not a StateTracker"))?;

        let mut fields: HashMap<String, serde_json::Value> = tracker_def.state.iter()
            .map(|f| (f.name.clone(), f.default.clone()))
            .collect();

        let results = state.state_tracker_results.lock()
            .map_err(|_| "State tracker results lock poisoned")?;
        let session_results = results.get(&session_id)
            .ok_or_else(|| format!("No state tracker results for session {session_id}"))?;
        let tracker_result = session_results.get(&tracker_id)
            .ok_or_else(|| format!("No results for tracker {tracker_id}"))?;

        let mut initialized: std::collections::HashSet<String> = Default::default();
        for t in &tracker_result.transitions[..pos] {
            for (field, change) in &t.changes {
                fields.insert(field.clone(), change.to.clone());
                initialized.insert(field.clone());
            }
        }

        let (line, ts) = if pos > 0 {
            let t = &tracker_result.transitions[pos - 1];
            (t.line_num, t.timestamp)
        } else {
            (0, 0)
        };

        (fields, initialized.into_iter().collect::<Vec<_>>(), line, ts)
    };

    Ok(StateSnapshot { line_num: line, timestamp: ts, fields, initialized_fields: fields_init })
}

/// Get all transitions for a tracker in a session.
#[tauri::command]
pub async fn get_state_transitions(
    state: State<'_, AppState>,
    session_id: String,
    tracker_id: String,
) -> Result<Vec<StateTransition>, String> {
    let results = state.state_tracker_results.lock()
        .map_err(|_| "State tracker results lock poisoned")?;
    let session_results = results.get(&session_id)
        .ok_or_else(|| format!("No state tracker results for session {session_id}"))?;
    let tracker_result = session_results.get(&tracker_id)
        .ok_or_else(|| format!("No results for tracker {tracker_id}"))?;
    Ok(tracker_result.transitions.clone())
}

/// Get all transition line numbers grouped by tracker ID.
#[tauri::command]
pub async fn get_all_transition_lines(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<HashMap<String, Vec<usize>>, String> {
    let results = state.state_tracker_results.lock()
        .map_err(|_| "State tracker results lock poisoned")?;
    let session_results = results.get(&session_id)
        .ok_or_else(|| format!("No state tracker results for session {session_id}"))?;

    let map: HashMap<String, Vec<usize>> = session_results.iter()
        .map(|(tracker_id, result)| {
            let lines: Vec<usize> = result.transitions.iter().map(|t| t.line_num).collect();
            (tracker_id.clone(), lines)
        })
        .collect();

    Ok(map)
}
