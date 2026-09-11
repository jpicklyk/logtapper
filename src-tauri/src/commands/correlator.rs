//! Thin Tauri adapter over `services::correlator`. See that module for the
//! shared correlation-event access logic `mcp_bridge::routes::tracker`'s
//! `h_correlations` also delegates to.

use tauri::AppHandle;

use crate::commands::adapters::ui_ctx;
use crate::processors::correlator::engine::CorrelatorResult;
use crate::services::correlator;

/// Return correlation events and guidance for a specific correlator in a session.
#[tauri::command]
pub async fn get_correlator_events(
    app: AppHandle,
    session_id: String,
    correlator_id: String,
) -> Result<CorrelatorResult, String> {
    let ctx = ui_ctx(&app);
    Ok(correlator::full_result(&ctx, &session_id, &correlator_id)?)
}
