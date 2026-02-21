use tauri::State;

use crate::commands::AppState;
use crate::processors::correlator::engine::CorrelatorResult;

/// Return correlation events and guidance for a specific correlator in a session.
#[tauri::command]
pub async fn get_correlator_events(
    state: State<'_, AppState>,
    session_id: String,
    correlator_id: String,
) -> Result<CorrelatorResult, String> {
    let results = state
        .correlator_results
        .lock()
        .map_err(|_| "Correlator results lock poisoned")?;

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
