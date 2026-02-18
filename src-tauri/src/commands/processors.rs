use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;
use crate::processors::registry::{self, RegistryEntry};
use crate::processors::schema::ProcessorDef;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn processor_summary(def: &ProcessorDef) -> ProcessorSummary {
    ProcessorSummary {
        id: def.meta.id.clone(),
        name: def.meta.name.clone(),
        version: def.meta.version.clone(),
        description: def.meta.description.clone(),
        tags: def.meta.tags.clone(),
    }
}

fn persist_processor(app: &AppHandle, id: &str, yaml: &str) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let proc_dir = data_dir.join("processors");
    std::fs::create_dir_all(&proc_dir).map_err(|e| e.to_string())?;
    std::fs::write(proc_dir.join(format!("{}.yaml", id)), yaml)
        .map_err(|e| format!("Failed to persist processor: {e}"))
}

fn delete_processor_file(app: &AppHandle, id: &str) {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let _ = std::fs::remove_file(
            data_dir.join("processors").join(format!("{}.yaml", id))
        );
    }
}

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
        .map(processor_summary)
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
    app: AppHandle,
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

    persist_processor(&app, &def.meta.id, &yaml)?;

    let summary = processor_summary(&def);

    let mut procs = state
        .processors
        .lock()
        .map_err(|_| "Processor store lock poisoned")?;
    procs.insert(def.meta.id.clone(), def);

    Ok(summary)
}

// ---------------------------------------------------------------------------
// load_processor_from_file — install a processor from a file path
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn load_processor_from_file(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
) -> Result<ProcessorSummary, String> {
    let yaml = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read file: {e}"))?;
    let def = ProcessorDef::from_yaml(&yaml)?;
    for stage in &def.pipeline {
        use crate::processors::schema::PipelineStage;
        if let PipelineStage::Script(s) = stage {
            crate::scripting::sandbox::validate_for_install(&s.src)?;
        }
    }
    persist_processor(&app, &def.meta.id, &yaml)?;
    let summary = processor_summary(&def);
    let mut procs = state.processors.lock().map_err(|_| "lock poisoned")?;
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
// get_matched_lines — raw text of every line matched by a processor run
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedLineInfo {
    pub line_num: usize,
    pub raw: String,
}

#[tauri::command]
pub async fn get_matched_lines(
    state: State<'_, AppState>,
    session_id: String,
    processor_id: String,
) -> Result<Vec<MatchedLineInfo>, String> {
    // Grab matched line numbers without holding the lock while we do session I/O.
    let line_nums: Vec<usize> = {
        let pr = state
            .pipeline_results
            .lock()
            .map_err(|_| "Pipeline results lock poisoned")?;
        pr.get(&session_id)
            .and_then(|s| s.get(&processor_id))
            .map(|r| r.matched_line_nums.clone())
            .unwrap_or_default()
    };

    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Session lock poisoned")?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{session_id}' not found"))?;
    let src = session.primary_source().ok_or("No sources in session")?;

    let result = line_nums
        .iter()
        .map(|&n| MatchedLineInfo {
            line_num: n,
            raw: src.raw_line(n).unwrap_or("").trim_end_matches(['\r', '\n']).to_string(),
        })
        .collect();

    Ok(result)
}

// ---------------------------------------------------------------------------
// uninstall_processor
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn uninstall_processor(
    state: State<'_, AppState>,
    app: AppHandle,
    processor_id: String,
) -> Result<(), String> {
    let mut procs = state
        .processors
        .lock()
        .map_err(|_| "Processor store lock poisoned")?;

    if procs.remove(&processor_id).is_none() {
        return Err(format!("Processor '{processor_id}' not found"));
    }
    delete_processor_file(&app, &processor_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// fetch_registry — list available processors from the GitHub registry
// ---------------------------------------------------------------------------

/// DTO returned to the frontend for each registry entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntryDto {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub path: String,
    pub tags: Vec<String>,
    pub sha256: String,
}

impl From<RegistryEntry> for RegistryEntryDto {
    fn from(e: RegistryEntry) -> Self {
        Self {
            id: e.id,
            name: e.name,
            version: e.version,
            description: e.description,
            path: e.path,
            tags: e.tags,
            sha256: e.sha256,
        }
    }
}

#[tauri::command]
pub async fn fetch_registry(
    state: State<'_, AppState>,
    registry_url: Option<String>,
) -> Result<Vec<RegistryEntryDto>, String> {
    let index = registry::fetch_registry(
        &state.http_client,
        registry_url.as_deref(),
    )
    .await?;

    Ok(index.processors.into_iter().map(RegistryEntryDto::from).collect())
}

// ---------------------------------------------------------------------------
// install_from_registry — download + verify + install a registry processor
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn install_from_registry(
    state: State<'_, AppState>,
    app: AppHandle,
    entry: RegistryEntryDto,
) -> Result<ProcessorSummary, String> {
    // Build a RegistryEntry from the DTO so we can pass it to download_processor.
    let reg_entry = RegistryEntry {
        id: entry.id.clone(),
        name: entry.name.clone(),
        version: entry.version.clone(),
        description: entry.description.clone(),
        path: entry.path.clone(),
        tags: entry.tags.clone(),
        sha256: entry.sha256.clone(),
    };

    let yaml = registry::download_processor(&state.http_client, &reg_entry, None).await?;

    // Validate + install
    let def = ProcessorDef::from_yaml(&yaml)?;

    for stage in &def.pipeline {
        use crate::processors::schema::PipelineStage;
        if let PipelineStage::Script(s) = stage {
            crate::scripting::sandbox::validate_for_install(&s.src)?;
        }
    }

    persist_processor(&app, &def.meta.id, &yaml)?;

    let summary = processor_summary(&def);

    let mut procs = state
        .processors
        .lock()
        .map_err(|_| "Processor store lock poisoned")?;
    procs.insert(def.meta.id.clone(), def);

    Ok(summary)
}
