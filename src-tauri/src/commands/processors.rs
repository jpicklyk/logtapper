use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

use crate::commands::AppState;
use crate::processors::schema::ProcessorDef;

// ---------------------------------------------------------------------------
// list_processors
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessorSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub tags: Vec<String>,
}

#[tauri::command]
pub async fn list_processors(
    state: State<'_, AppState>,
) -> Result<Vec<ProcessorSummary>, String> {
    let procs = state
        .processors
        .lock()
        .map_err(|_| "Processor store lock poisoned")?;

    let mut out: Vec<ProcessorSummary> = procs
        .values()
        .map(|p| ProcessorSummary {
            id: p.meta.id.clone(),
            name: p.meta.name.clone(),
            version: p.meta.version.clone(),
            description: p.meta.description.clone(),
            tags: p.meta.tags.clone(),
        })
        .collect();

    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

// ---------------------------------------------------------------------------
// load_processor_yaml — install a processor from a YAML string
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn load_processor_yaml(
    state: State<'_, AppState>,
    yaml: String,
) -> Result<ProcessorSummary, String> {
    // Validate
    let def = ProcessorDef::from_yaml(&yaml)?;

    // Validate any inline Rhai scripts
    for stage in &def.pipeline {
        use crate::processors::schema::PipelineStage;
        if let PipelineStage::Script(s) = stage {
            crate::scripting::sandbox::validate_for_install(&s.src)?;
        }
    }

    let summary = ProcessorSummary {
        id: def.meta.id.clone(),
        name: def.meta.name.clone(),
        version: def.meta.version.clone(),
        description: def.meta.description.clone(),
        tags: def.meta.tags.clone(),
    };

    let mut procs = state
        .processors
        .lock()
        .map_err(|_| "Processor store lock poisoned")?;
    procs.insert(def.meta.id.clone(), def);

    Ok(summary)
}

// ---------------------------------------------------------------------------
// get_processor_vars — return current variable state from last pipeline run
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_processor_vars(
    state: State<'_, AppState>,
    session_id: String,
    processor_id: String,
) -> Result<HashMap<String, serde_json::Value>, String> {
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

    Ok(result.vars.clone())
}

// ---------------------------------------------------------------------------
// uninstall_processor
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn uninstall_processor(
    state: State<'_, AppState>,
    processor_id: String,
) -> Result<(), String> {
    let mut procs = state
        .processors
        .lock()
        .map_err(|_| "Processor store lock poisoned")?;

    if procs.remove(&processor_id).is_none() {
        return Err(format!("Processor '{processor_id}' not found"));
    }
    Ok(())
}
