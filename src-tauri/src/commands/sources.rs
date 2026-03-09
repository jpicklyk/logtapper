use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;
use crate::processors::marketplace::{self, MarketplaceEntry, Source};
use crate::processors::registry;
use crate::processors::{AnyProcessor, ProcessorSummary};

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

// ---------------------------------------------------------------------------
// Update types
// ---------------------------------------------------------------------------

/// A processor that has a newer version available in the marketplace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAvailable {
    /// Qualified processor ID (id@source).
    pub processor_id: String,
    pub processor_name: String,
    pub source_name: String,
    pub installed_version: String,
    pub available_version: String,
    /// Marketplace entry for performing the update.
    pub entry: MarketplaceEntryDto,
}

/// Result of a check_updates call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub updates: Vec<UpdateAvailable>,
    /// Sources that failed to fetch (name -> error message).
    pub errors: Vec<SourceError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceError {
    pub source_name: String,
    pub error: String,
}

/// Result of applying a single update.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub processor_id: String,
    pub old_version: String,
    pub new_version: String,
    pub success: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Version comparison helper
// ---------------------------------------------------------------------------

/// Compare installed version against marketplace version using SemVer.
/// Returns true if `available` is newer than `installed`.
pub(crate) fn is_newer(installed: &str, available: &str) -> bool {
    match (semver::Version::parse(installed), semver::Version::parse(available)) {
        (Ok(inst), Ok(avail)) => avail > inst,
        // If either fails to parse as semver, fall back to string inequality
        _ => installed != available,
    }
}

// ---------------------------------------------------------------------------
// Update commands
// ---------------------------------------------------------------------------

/// Check all enabled sources for processor updates.
/// Compares installed processor versions against marketplace entries.
#[tauri::command]
pub async fn check_updates(
    state: State<'_, AppState>,
) -> Result<UpdateCheckResult, String> {
    // Snapshot sources and installed processors (release locks before network I/O).
    let sources: Vec<Source> = {
        let s = state.sources.lock().map_err(|_| "Sources lock poisoned")?;
        s.iter().filter(|s| s.enabled).cloned().collect()
    };
    // HashMap<qualified_id, (bare_id, installed_version)> for O(1) lookups per marketplace entry.
    let installed: HashMap<String, (String, String)> = {
        let procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
        procs.iter()
            .filter_map(|(qid, proc)| {
                proc.source.as_ref().map(|_src| {
                    (qid.clone(), (proc.meta.id.clone(), proc.meta.version.clone()))
                })
            })
            .collect()
    };

    let mut updates = Vec::new();
    let mut errors = Vec::new();

    for source in &sources {
        let index = match registry::fetch_marketplace(&state.http_client, source).await {
            Ok(idx) => idx,
            Err(e) => {
                errors.push(SourceError {
                    source_name: source.name.clone(),
                    error: e,
                });
                continue;
            }
        };

        for market_entry in &index.processors {
            let qid = marketplace::qualified_id(&market_entry.id, &source.name);

            // O(1) lookup instead of linear scan.
            if let Some((_bare_id, inst_ver)) = installed.get(&qid) {
                if is_newer(inst_ver, &market_entry.version) {
                    updates.push(UpdateAvailable {
                        processor_id: qid.clone(),
                        processor_name: market_entry.name.clone(),
                        source_name: source.name.clone(),
                        installed_version: inst_ver.clone(),
                        available_version: market_entry.version.clone(),
                        entry: MarketplaceEntryDto::from(market_entry.clone()),
                    });
                }
            }
        }

        // Update last_checked timestamp for this source.
        if let Ok(mut srcs) = state.sources.lock() {
            if let Some(s) = srcs.iter_mut().find(|s| s.name == source.name) {
                s.last_checked = Some(chrono_now_iso());
            }
        }
    }

    Ok(UpdateCheckResult { updates, errors })
}

/// Update a single processor from its marketplace source.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_processor(
    state: State<'_, AppState>,
    app: AppHandle,
    processor_id: String,
    entry_name: String,
    entry_path: String,
    entry_version: String,
    entry_sha256: String,
) -> Result<UpdateResult, String> {
    let (bare_id, source_name) = match marketplace::split_qualified_id(&processor_id) {
        (id, Some(src)) => (id.to_string(), src.to_string()),
        _ => return Err(format!("Processor '{processor_id}' has no source qualifier — cannot update")),
    };

    // Find the source config.
    let source = {
        let srcs = state.sources.lock().map_err(|_| "Sources lock poisoned")?;
        srcs.iter()
            .find(|s| s.name == source_name)
            .cloned()
            .ok_or_else(|| format!("Source '{source_name}' not found"))?
    };

    // Construct entry from frontend-supplied metadata (avoids re-fetching full index).
    let entry = marketplace::MarketplaceEntry {
        id: bare_id,
        name: entry_name,
        path: entry_path,
        version: entry_version,
        sha256: entry_sha256,
        description: None,
        tags: Vec::new(),
        category: None,
        license: None,
        processor_type: None,
        source_types: Vec::new(),
        deprecated: false,
    };

    // Get current installed version.
    let old_version = {
        let procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
        procs.get(&processor_id).map_or_else(|| "unknown".to_string(), |p| p.meta.version.clone())
    };

    let def = download_and_install_processor(&state, &app, &source, &entry, &processor_id).await?;
    let new_version = def.meta.version;

    Ok(UpdateResult {
        processor_id,
        old_version,
        new_version,
        success: true,
        error: None,
    })
}

/// Update all processors from a given source that have newer versions.
#[tauri::command]
pub async fn update_all_from_source(
    state: State<'_, AppState>,
    app: AppHandle,
    source_name: String,
) -> Result<Vec<UpdateResult>, String> {
    // Find the source config.
    let source = {
        let srcs = state.sources.lock().map_err(|_| "Sources lock poisoned")?;
        srcs.iter()
            .find(|s| s.name == source_name)
            .cloned()
            .ok_or_else(|| format!("Source '{source_name}' not found"))?
    };

    // Fetch marketplace.
    let index = registry::fetch_marketplace(&state.http_client, &source).await?;

    // Snapshot installed processors from this source.
    let installed: Vec<(String, String)> = {
        let procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
        procs.iter()
            .filter_map(|(qid, p)| {
                if p.source.as_deref() == Some(&source_name) {
                    Some((qid.clone(), p.meta.version.clone()))
                } else {
                    None
                }
            })
            .collect()
    };

    let mut results = Vec::new();

    for entry in &index.processors {
        let qid = marketplace::qualified_id(&entry.id, &source_name);

        // Check if installed and needs update.
        let Some((_, inst_ver)) = installed.iter().find(|(q, _)| *q == qid) else {
            continue;
        };

        if !is_newer(inst_ver, &entry.version) {
            continue;
        }

        // Download, parse, persist, and insert.
        match download_and_install_processor(&state, &app, &source, entry, &qid).await {
            Ok(def) => {
                results.push(UpdateResult {
                    processor_id: qid,
                    old_version: inst_ver.clone(),
                    new_version: def.meta.version.clone(),
                    success: true,
                    error: None,
                });
            }
            Err(e) => {
                results.push(UpdateResult {
                    processor_id: qid,
                    old_version: inst_ver.clone(),
                    new_version: entry.version.clone(),
                    success: false,
                    error: Some(e),
                });
            }
        }
    }

    // Update last_checked.
    if let Ok(mut srcs) = state.sources.lock() {
        if let Some(s) = srcs.iter_mut().find(|s| s.name == source_name) {
            s.last_checked = Some(chrono_now_iso());
        }
    }

    Ok(results)
}

/// Save sources to disk (called after modifying last_checked, etc.).
#[tauri::command]
pub async fn save_sources_to_disk(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let sources = state.sources.lock().map_err(|_| "Sources lock poisoned")?;
    save_sources(&app, &sources)
}

/// Get pending updates discovered by the startup check.
/// Returns and clears the pending list (UI consumes once, then uses check_updates for refresh).
#[tauri::command]
pub async fn get_pending_updates(
    state: State<'_, AppState>,
) -> Result<Vec<UpdateAvailable>, String> {
    let mut pending = state.pending_updates.lock().map_err(|_| "Pending updates lock poisoned")?;
    let result = pending.clone();
    pending.clear();
    Ok(result)
}

// ---------------------------------------------------------------------------
// Shared install helper
// ---------------------------------------------------------------------------

/// Download, parse, persist, and install a single processor from a marketplace source.
///
/// Performs the full sequence: download YAML → append provenance → parse → set source
/// field → persist to disk → insert into state. Returns the parsed `AnyProcessor` so
/// callers can extract the version or build a summary without re-locking.
async fn download_and_install_processor(
    state: &AppState,
    app: &AppHandle,
    source: &Source,
    entry: &MarketplaceEntry,
    qualified_id: &str,
) -> Result<AnyProcessor, String> {
    // 1. Download and verify SHA256.
    let yaml = registry::download_processor_from_source(&state.http_client, source, entry).await?;

    // 2. Append provenance metadata.
    let final_yaml = format!("{}{}", yaml, build_provenance_yaml(&source.name, &entry.version, &entry.sha256));

    // 3. Parse.
    let mut def = AnyProcessor::from_yaml(&final_yaml)
        .map_err(|e| format!("Failed to parse processor YAML: {e}"))?;

    // 4. Set source field.
    def.source = Some(source.name.clone());

    // 5. Persist to disk.
    super::processors::persist_processor(app, qualified_id, &final_yaml)?;

    // 6. Insert into state.
    {
        let mut procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
        procs.insert(qualified_id.to_string(), def.clone());
    }

    Ok(def)
}

/// Install a processor from a named marketplace source.
/// Downloads the YAML, verifies SHA256, appends provenance, parses, persists, and inserts.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_from_marketplace(
    state: State<'_, AppState>,
    app: AppHandle,
    source_name: String,
    entry_id: String,
    entry_name: String,
    entry_path: String,
    entry_version: String,
    entry_sha256: String,
) -> Result<ProcessorSummary, String> {
    // Look up the source.
    let source = {
        let srcs = state.sources.lock().map_err(|_| "Sources lock poisoned")?;
        srcs.iter()
            .find(|s| s.name == source_name)
            .cloned()
            .ok_or_else(|| format!("Source '{source_name}' not found"))?
    };

    // Construct entry from frontend-supplied metadata (avoids re-fetching full index).
    let entry = marketplace::MarketplaceEntry {
        id: entry_id,
        name: entry_name,
        path: entry_path,
        version: entry_version,
        sha256: entry_sha256,
        // Fields not needed for download/install — defaults are fine.
        description: None,
        tags: Vec::new(),
        category: None,
        license: None,
        processor_type: None,
        source_types: Vec::new(),
        deprecated: false,
    };

    let qualified_id = marketplace::qualified_id(&entry.id, &source_name);

    let def = download_and_install_processor(&state, &app, &source, &entry, &qualified_id).await?;

    // Build summary with the qualified ID (From impl uses bare id).
    let mut summary = ProcessorSummary::from(&def);
    summary.id = qualified_id;

    Ok(summary)
}

/// Simple ISO 8601 timestamp (no chrono dependency — use std).
pub(crate) fn chrono_now_iso() -> String {
    // Use std::time — format as seconds since epoch for simplicity.
    // For a proper ISO timestamp we'd need the `chrono` crate, but this is
    // sufficient for provenance tracking.
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}Z", dur.as_secs())
}

/// Build the provenance YAML suffix appended to downloaded processor YAMLs.
pub(crate) fn build_provenance_yaml(source_name: &str, version: &str, sha256: &str) -> String {
    let now = chrono_now_iso();
    format!(
        "\n_source: {source_name}\n_installed_version: {version}\n_installed_at: {now}\n_sha256: {sha256}\n"
    )
}
