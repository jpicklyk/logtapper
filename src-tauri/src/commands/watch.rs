use std::sync::Arc;

use tauri::State;
use uuid::Uuid;

use crate::commands::{lock_or_err, AppState};
use crate::core::filter::FilterCriteria;
use crate::core::watch::{WatchInfo, WatchSession};

/// Create a new watch on a session. The watch evaluates new lines against
/// the given criteria during each flush_batch and emits `watch-match` events
/// when matches are found.
#[tauri::command]
pub fn create_watch(
    state: State<'_, AppState>,
    session_id: String,
    criteria: FilterCriteria,
) -> Result<WatchInfo, String> {
    // Verify session exists
    {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        if !sessions.contains_key(&session_id) {
            return Err(format!("Session not found: {session_id}"));
        }
    }

    let watch_id = Uuid::new_v4().to_string();
    let watch = Arc::new(WatchSession::new(
        watch_id,
        session_id.clone(),
        criteria.clone(),
    ));

    let info = WatchInfo {
        watch_id: watch.watch_id.clone(),
        session_id: watch.session_id.clone(),
        total_matches: 0,
        active: true,
        criteria,
    };

    {
        let mut watches = lock_or_err(&state.active_watches, "active_watches")?;
        watches
            .entry(session_id)
            .or_default()
            .push(watch);
    }

    Ok(info)
}

/// Cancel a specific watch by ID.
#[tauri::command]
pub fn cancel_watch(
    state: State<'_, AppState>,
    session_id: String,
    watch_id: String,
) -> Result<(), String> {
    let watches = lock_or_err(&state.active_watches, "active_watches")?;
    if let Some(list) = watches.get(&session_id) {
        if let Some(w) = list.iter().find(|w| w.watch_id == watch_id) {
            w.cancel();
            return Ok(());
        }
    }
    Err(format!("Watch not found: {watch_id}"))
}

/// List all watches for a session (active and cancelled).
#[tauri::command]
pub fn list_watches(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<WatchInfo>, String> {
    let watches = lock_or_err(&state.active_watches, "active_watches")?;
    let list = watches.get(&session_id);
    Ok(list
        .map(|ws| {
            ws.iter()
                .map(|w| WatchInfo {
                    watch_id: w.watch_id.clone(),
                    session_id: w.session_id.clone(),
                    total_matches: w.total_matches(),
                    active: w.is_active(),
                    criteria: w.criteria.clone(),
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Evaluate all active watches for a session against a batch of new lines.
/// Called from flush_batch. Returns a list of (watch_id, new_match_count, total_matches)
/// for watches that found new matches.
/// Lightweight view into a parsed line for watch evaluation (avoids cloning).
pub struct WatchLineRef<'a> {
    pub raw: &'a str,
    pub tag: &'a str,
    pub level: crate::core::line::LogLevel,
    pub timestamp: i64,
    pub pid: i32,
}

pub fn evaluate_watches(
    state: &AppState,
    session_id: &str,
    lines: &[WatchLineRef<'_>],
) -> Vec<(String, u32, u32)> {
    use crate::core::filter::line_matches_criteria;

    let Ok(watches) = state.active_watches.lock() else {
        return vec![];
    };
    let Some(watch_list) = watches.get(session_id) else {
        return vec![];
    };

    let mut results = Vec::new();

    for watch in watch_list {
        if !watch.is_active() {
            continue;
        }

        let mut new_matches = 0u32;
        for wl in lines {
            if line_matches_criteria(
                &watch.criteria,
                wl.raw,
                wl.level,
                wl.tag,
                wl.timestamp,
                wl.pid,
                watch.compiled_regex.as_ref(),
            ) {
                new_matches += 1;
            }
        }

        if new_matches > 0 {
            let total = watch.add_matches(new_matches);
            results.push((watch.watch_id.clone(), new_matches, total));
        }
    }

    results
}
