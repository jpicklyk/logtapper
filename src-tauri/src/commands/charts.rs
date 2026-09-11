use tauri::AppHandle;

use crate::charts::builder::ChartData;
use crate::commands::adapters::ui_ctx;
use crate::services::timeline::{self, TimelineSeriesData};

// ---------------------------------------------------------------------------
// get_chart_data / get_timeline_data — thin adapters over `services::timeline`
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_chart_data(
    app: AppHandle,
    session_id: String,
    processor_id: String,
) -> Result<Vec<ChartData>, String> {
    let ctx = ui_ctx(&app);
    Ok(timeline::chart_data(&ctx, &session_id, &processor_id)?)
}

#[tauri::command]
pub async fn get_timeline_data(
    app: AppHandle,
    session_id: String,
    processor_ids: Vec<String>,
) -> Result<Vec<TimelineSeriesData>, String> {
    let ctx = ui_ctx(&app);
    Ok(timeline::timeline_data(&ctx, &session_id, &processor_ids)?)
}
