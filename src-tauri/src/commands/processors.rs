use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;
use crate::processors::marketplace;
use crate::processors::registry::{self, RegistryEntry};
use crate::processors::{AnyProcessor, ProcessorSummary};

pub(crate) fn persist_processor(app: &AppHandle, id: &str, yaml: &str) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let proc_dir = data_dir.join("processors");
    std::fs::create_dir_all(&proc_dir).map_err(|e| e.to_string())?;
    let filename = marketplace::id_to_filename(id);
    std::fs::write(proc_dir.join(format!("{}.yaml", filename)), yaml)
        .map_err(|e| format!("Failed to persist processor: {e}"))
}

/// Validate, persist, and install a parsed processor into the store.
fn validate_and_install(
    app: &AppHandle,
    state: &AppState,
    yaml: &str,
    processor: AnyProcessor,
) -> Result<ProcessorSummary, String> {
    processor.validate_filter_rules()?;
    if let Some(reporter_def) = processor.as_reporter() {
        for stage in &reporter_def.pipeline {
            use crate::processors::schema::PipelineStage;
            if let PipelineStage::Script(s) = stage {
                crate::scripting::sandbox::validate_for_install(&s.src)?;
            }
        }
    }
    persist_processor(app, &processor.meta.id, yaml)?;
    let summary = ProcessorSummary::from(&processor);
    let mut procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
    procs.insert(processor.meta.id.clone(), processor);
    Ok(summary)
}

fn delete_processor_file(app: &AppHandle, id: &str) {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let filename = marketplace::id_to_filename(id);
        let _ = std::fs::remove_file(
            data_dir.join("processors").join(format!("{}.yaml", filename))
        );
    }
}

#[tauri::command]
pub async fn list_processors(
    state: State<'_, AppState>,
) -> Result<Vec<ProcessorSummary>, String> {
    let procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
    let mut out: Vec<ProcessorSummary> = procs.iter().map(|(key, p)| {
        let mut summary = ProcessorSummary::from(p);
        // Use the map key (qualified ID for marketplace processors) instead of bare meta.id.
        summary.id = key.clone();
        summary
    }).collect();
    out.sort_by(|a, b| b.builtin.cmp(&a.builtin).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub async fn load_processor_yaml(
    state: State<'_, AppState>,
    app: AppHandle,
    yaml: String,
) -> Result<ProcessorSummary, String> {
    let processor = AnyProcessor::from_yaml(&yaml)?;
    validate_and_install(&app, &state, &yaml, processor)
}

#[tauri::command]
pub async fn load_processor_from_file(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
) -> Result<ProcessorSummary, String> {
    let yaml = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read file: {e}"))?;
    let processor = AnyProcessor::from_yaml(&yaml)?;
    validate_and_install(&app, &state, &yaml, processor)
}

#[tauri::command]
pub async fn get_processor_vars(
    state: State<'_, AppState>,
    session_id: String,
    processor_id: String,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let pr = state.pipeline_results.lock().map_err(|_| "Pipeline results lock poisoned")?;
    let session_results = pr.get(&session_id)
        .ok_or_else(|| format!("No pipeline results for session '{session_id}'" ))?;
    let result = session_results.get(&processor_id)
        .ok_or_else(|| format!("No result for processor '{processor_id}'" ))?;
    Ok(result.vars.clone())
}

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
    // 1. Reporter pipeline results
    let line_nums: Vec<usize> = {
        let pr = state.pipeline_results.lock().map_err(|_| "Pipeline results lock poisoned")?;
        if let Some(nums) = pr.get(&session_id)
            .and_then(|s| s.get(&processor_id))
            .map(|r| r.matched_line_nums.clone())
        {
            nums
        } else {
            drop(pr);
            // 2. State tracker transition lines
            let str_lock = state.state_tracker_results.lock().map_err(|_| "State tracker results lock poisoned")?;
            if let Some(nums) = str_lock.get(&session_id)
                .and_then(|s| s.get(&processor_id))
                .map(|r| r.transitions.iter().map(|t| t.line_num).collect::<Vec<_>>())
            {
                nums
            } else {
                drop(str_lock);
                // 3. Correlator event trigger lines
                let cr_lock = state.correlator_results.lock().map_err(|_| "Correlator results lock poisoned")?;
                cr_lock.get(&session_id)
                    .and_then(|s| s.get(&processor_id))
                    .map(|r| r.events.iter().map(|e| e.trigger_line_num).collect::<Vec<_>>())
                    .unwrap_or_default()
            }
        }
    };
    let mut line_nums = line_nums;
    line_nums.sort_unstable();

    let sessions = state.sessions.lock().map_err(|_| "Session lock poisoned")?;
    let session = sessions.get(&session_id)
        .ok_or_else(|| format!("Session '{session_id}' not found"))?;
    let src = session.primary_source().ok_or("No sources in session")?;
    let result = line_nums.iter().map(|&n| MatchedLineInfo {
        line_num: n,
        raw: src.raw_line(n).as_deref().unwrap_or("").trim_end_matches(['\r', '\n']).to_string(),
    }).collect();
    Ok(result)
}

#[tauri::command]
pub async fn uninstall_processor(
    state: State<'_, AppState>,
    app: AppHandle,
    processor_id: String,
) -> Result<(), String> {
    if processor_id.starts_with("__") {
        return Err("Built-in processors cannot be uninstalled".to_string());
    }
    let mut procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
    if procs.remove(&processor_id).is_none() {
        return Err(format!("Processor '{processor_id}' not found"));
    }
    delete_processor_file(&app, &processor_id);
    Ok(())
}

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
            id: e.id, name: e.name, version: e.version, description: e.description,
            path: e.path, tags: e.tags, sha256: e.sha256,
        }
    }
}

#[tauri::command]
pub async fn fetch_registry(
    state: State<'_, AppState>,
    registry_url: Option<String>,
) -> Result<Vec<RegistryEntryDto>, String> {
    let index = registry::fetch_registry(&state.http_client, registry_url.as_deref()).await?;
    Ok(index.processors.into_iter().map(RegistryEntryDto::from).collect())
}

#[tauri::command]
pub async fn install_from_registry(
    state: State<'_, AppState>,
    app: AppHandle,
    entry: RegistryEntryDto,
) -> Result<ProcessorSummary, String> {
    let reg_entry = RegistryEntry {
        id: entry.id.clone(), name: entry.name.clone(), version: entry.version.clone(),
        description: entry.description.clone(), path: entry.path.clone(),
        tags: entry.tags.clone(), sha256: entry.sha256.clone(),
    };
    let yaml = registry::download_processor(&state.http_client, &reg_entry, None).await?;
    let processor = AnyProcessor::from_yaml(&yaml)?;
    validate_and_install(&app, &state, &yaml, processor)
}
