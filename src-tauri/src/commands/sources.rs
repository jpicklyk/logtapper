use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;
use crate::processors::marketplace::{MarketplaceEntry, Source};
use crate::processors::registry;

// ---------------------------------------------------------------------------
// Source persistence helpers
// ---------------------------------------------------------------------------

fn sources_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("sources.json"))
        .map_err(|e| e.to_string())
}

pub fn load_sources(app: &AppHandle) -> Vec<Source> {
    let Ok(path) = sources_path(app) else {
        return Vec::new();
    };
    let Ok(json) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&json).unwrap_or_default()
}

fn save_sources(app: &AppHandle, sources: &[Source]) -> Result<(), String> {
    let path = sources_path(app)?;
    let json =
        serde_json::to_string_pretty(sources).map_err(|e| format!("Serialize error: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write sources.json: {e}"))
}

// ---------------------------------------------------------------------------
// DTO for frontend (camelCase serialization)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceEntryDto {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub path: String,
    pub tags: Vec<String>,
    pub sha256: String,
    pub category: Option<String>,
    pub license: Option<String>,
    pub processor_type: Option<String>,
    pub source_types: Vec<String>,
    pub deprecated: bool,
}

impl From<MarketplaceEntry> for MarketplaceEntryDto {
    fn from(e: MarketplaceEntry) -> Self {
        Self {
            id: e.id,
            name: e.name,
            version: e.version,
            description: e.description,
            path: e.path,
            tags: e.tags,
            sha256: e.sha256,
            category: e.category,
            license: e.license,
            processor_type: e.processor_type,
            source_types: e.source_types,
            deprecated: e.deprecated,
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_sources(state: State<'_, AppState>) -> Result<Vec<Source>, String> {
    let sources = state.sources.lock().map_err(|_| "Sources lock poisoned")?;
    Ok(sources.clone())
}

#[tauri::command]
pub async fn add_source(
    state: State<'_, AppState>,
    app: AppHandle,
    source: Source,
) -> Result<(), String> {
    let mut sources = state.sources.lock().map_err(|_| "Sources lock poisoned")?;
    if sources.iter().any(|s| s.name == source.name) {
        return Err(format!("A source named '{}' already exists", source.name));
    }
    sources.push(source);
    save_sources(&app, &sources)
}

#[tauri::command]
pub async fn remove_source(
    state: State<'_, AppState>,
    app: AppHandle,
    source_name: String,
) -> Result<(), String> {
    let mut sources = state.sources.lock().map_err(|_| "Sources lock poisoned")?;
    let before = sources.len();
    sources.retain(|s| s.name != source_name);
    if sources.len() == before {
        return Err(format!("Source '{source_name}' not found"));
    }
    save_sources(&app, &sources)
}

#[tauri::command]
pub async fn fetch_marketplace_for_source(
    state: State<'_, AppState>,
    source_name: String,
) -> Result<Vec<MarketplaceEntryDto>, String> {
    let source = {
        let sources = state.sources.lock().map_err(|_| "Sources lock poisoned")?;
        sources
            .iter()
            .find(|s| s.name == source_name)
            .cloned()
            .ok_or_else(|| format!("Source '{source_name}' not found"))?
    };
    // Lock released before await
    let index = registry::fetch_marketplace(&state.http_client, &source).await?;
    Ok(index
        .processors
        .into_iter()
        .map(MarketplaceEntryDto::from)
        .collect())
}
