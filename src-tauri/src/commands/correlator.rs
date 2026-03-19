use tauri::State;

use crate::commands::{lock_or_err, AppState};
use crate::processors::correlator::engine::CorrelatorResult;

/// Return correlation events and guidance for a specific correlator in a session.
#[tauri::command]
pub async fn get_correlator_events(
    state: State<'_, AppState>,
    session_id: String,
    correlator_id: String,
) -> Result<CorrelatorResult, String> {
    let results = lock_or_err(&state.correlator_results, "correlator_results")?;

    let result = results
        .get(&session_id)
        .and_then(|m| m.get(&correlator_id))
        .cloned()
        .unwrap_or(CorrelatorResult {
            guidance: None,
            events: Vec::new(),
        });

    Ok(result)
}
