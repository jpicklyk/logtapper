//! Thin Tauri adapters over `services::tracker`. See that module for the
//! shared replay logic (including the Snapshot-mode fix) both this file and
//! `mcp_bridge::routes::tracker` delegate to.

use std::collections::HashMap;

use tauri::AppHandle;

use crate::commands::adapters::ui_ctx;
use crate::processors::state_tracker::types::{StateSnapshot, StateTransition};
use crate::services::tracker;

/// Get the state snapshot at a specific line number for a given tracker.
#[tauri::command]
pub async fn get_state_at_line(
    app: AppHandle,
    session_id: String,
    tracker_id: String,
    line_num: usize,
) -> Result<StateSnapshot, String> {
    let ctx = ui_ctx(&app);
    Ok(tracker::state_at(&ctx, &session_id, &tracker_id, line_num)?)
}

/// Get all transitions for a tracker in a session.
#[tauri::command]
pub async fn get_state_transitions(
    app: AppHandle,
    session_id: String,
    tracker_id: String,
) -> Result<Vec<StateTransition>, String> {
    let ctx = ui_ctx(&app);
    let page = tracker::transitions(&ctx, &session_id, &tracker_id, 0, usize::MAX)?;
    Ok(page.items)
}

/// Get all transition line numbers grouped by tracker ID.
/// Only includes trackers where `output.timeline` is true.
#[tauri::command]
pub async fn get_all_transition_lines(
    app: AppHandle,
    session_id: String,
) -> Result<HashMap<String, Vec<usize>>, String> {
    let ctx = ui_ctx(&app);
    Ok(tracker::all_transition_lines(&ctx, &session_id)?)
}
