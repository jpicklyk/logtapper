use tauri::State;

use crate::charts::builder::{build_charts, ChartData};
use crate::commands::AppState;

// ---------------------------------------------------------------------------
// get_chart_data
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_chart_data(
    state: State<'_, AppState>,
    session_id: String,
    processor_id: String,
) -> Result<Vec<ChartData>, String> {
    // Get the processor definition
    let def = {
        let procs = state
            .processors
            .lock()
            .map_err(|_| "Processor store lock poisoned")?;
        procs
            .get(&processor_id)
            .cloned()
            .ok_or_else(|| format!("Processor '{}' not found", processor_id))?
    };

    // Get the pipeline run result
    let (emissions, vars) = {
        let pr = state
            .pipeline_results
            .lock()
            .map_err(|_| "Pipeline results lock poisoned")?;
        let session_results = pr
            .get(&session_id)
            .ok_or_else(|| format!("No pipeline results for session '{session_id}'"))?;
        let result = session_results
            .get(&processor_id)
            .ok_or_else(|| format!("No result for processor '{processor_id}'"))?;
        (result.emissions.clone(), result.vars.clone())
    };

    // Charts are only supported for Reporter-type processors.
    let reporter = match def.as_reporter() {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    let charts = build_charts(reporter, &emissions, &vars);
    Ok(charts)
}
