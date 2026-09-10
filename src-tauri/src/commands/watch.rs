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
    state: State<'_, std::sync::Arc<AppState>>,
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
    // Rejects an invalid regex before the watch is registered — otherwise it
    // would sit active against every batch and never match.
    let watch = Arc::new(WatchSession::new(
        watch_id,
        session_id.clone(),
        criteria.clone(),
    )?);

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
    state: State<'_, std::sync::Arc<AppState>>,
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
    state: State<'_, std::sync::Arc<AppState>>,
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
    use crate::core::filter::line_matches_criteria_with_needles;

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
            if line_matches_criteria_with_needles(
                &watch.criteria,
                &watch.needles,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::filter::FilterCriteria;
    use crate::core::line::LogLevel;
    use std::sync::Arc;

    // ── evaluate_watches / needle precomputation ────────────────────────────
    // `evaluate_watches` used to call the plain `line_matches_criteria`, which
    // re-lowercases `text_search`/`tags` for every line in the batch. It now
    // reuses `WatchSession::needles`, precomputed once in `WatchSession::new`
    // (mirroring `compiled_regex`), via `line_matches_criteria_with_needles`.
    // This test proves the switch didn't change *which* lines match: a
    // case-insensitive text needle and a case-insensitive tag needle must
    // still match lines whose casing differs from the criteria.

    fn register_watch(state: &AppState, session_id: &str, criteria: FilterCriteria) -> String {
        let watch = Arc::new(
            WatchSession::new("w1".to_string(), session_id.to_string(), criteria).unwrap(),
        );
        let watch_id = watch.watch_id.clone();
        state
            .active_watches
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .push(watch);
        watch_id
    }

    #[test]
    fn evaluate_watches_matches_case_insensitive_text_and_tag_via_precomputed_needles() {
        let state = AppState::default();
        let session_id = "s1";
        let criteria = FilterCriteria {
            text_search: Some("ErRoR".to_string()),
            tags: Some(vec!["NetWork".to_string()]),
            ..Default::default()
        };
        let watch_id = register_watch(&state, session_id, criteria);

        let lines = vec![
            // Matches: text differs in case from needle, tag differs in case too.
            WatchLineRef {
                raw: "01-01 12:00:00.000 E/NETWORK: error occurred",
                tag: "NETWORK",
                level: LogLevel::Error,
                timestamp: 1000,
                pid: 100,
            },
            // Does not match: wrong tag.
            WatchLineRef {
                raw: "01-01 12:00:00.000 E/Other: ERROR occurred",
                tag: "Other",
                level: LogLevel::Error,
                timestamp: 1001,
                pid: 100,
            },
            // Does not match: text missing.
            WatchLineRef {
                raw: "01-01 12:00:00.000 I/Network: all good",
                tag: "Network",
                level: LogLevel::Info,
                timestamp: 1002,
                pid: 100,
            },
        ];

        let results = evaluate_watches(&state, session_id, &lines);

        assert_eq!(results.len(), 1, "expected exactly one watch to report matches");
        let (id, new_matches, total_matches) = &results[0];
        assert_eq!(id, &watch_id);
        assert_eq!(*new_matches, 1, "only the first line should match");
        assert_eq!(*total_matches, 1);
    }

    #[test]
    fn evaluate_watches_skips_cancelled_watches() {
        let state = AppState::default();
        let session_id = "s1";
        let criteria = FilterCriteria {
            text_search: Some("error".to_string()),
            ..Default::default()
        };
        register_watch(&state, session_id, criteria);
        {
            let watches = state.active_watches.lock().unwrap();
            for w in watches.get(session_id).unwrap() {
                w.cancel();
            }
        }

        let lines = vec![WatchLineRef {
            raw: "error occurred",
            tag: "Tag",
            level: LogLevel::Error,
            timestamp: 1000,
            pid: 100,
        }];

        let results = evaluate_watches(&state, session_id, &lines);
        assert!(results.is_empty(), "cancelled watches must not be evaluated");
    }
}
