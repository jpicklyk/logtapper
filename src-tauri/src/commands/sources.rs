use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::{lock_or_err, AppState};
use crate::processors::marketplace::{self, MarketplaceEntry, Source};
use crate::processors::pack::{parse_pack_yaml, validate_pack};
use crate::processors::registry;
use crate::processors::{AnyProcessor, PackMeta, PackSummary, ProcessorSummary};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePackEntryDto {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub path: String,
    pub tags: Vec<String>,
    pub sha256: String,
    pub category: Option<String>,
    pub processor_ids: Vec<String>,
}

impl From<marketplace::MarketplacePackEntry> for MarketplacePackEntryDto {
    fn from(e: marketplace::MarketplacePackEntry) -> Self {
        Self {
            id: e.id,
            name: e.name,
            version: e.version,
            description: e.description,
            path: e.path,
            tags: e.tags,
            sha256: e.sha256,
            category: e.category,
            processor_ids: e.processor_ids,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceFetchResult {
    pub processors: Vec<MarketplaceEntryDto>,
    pub packs: Vec<MarketplacePackEntryDto>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_sources(state: State<'_, AppState>) -> Result<Vec<Source>, String> {
    let sources = lock_or_err(&state.sources, "sources")?;
    Ok(sources.clone())
}

#[tauri::command]
pub async fn add_source(
    state: State<'_, AppState>,
    app: AppHandle,
    source: Source,
) -> Result<(), String> {
    let mut sources = lock_or_err(&state.sources, "sources")?;
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
    let mut sources = lock_or_err(&state.sources, "sources")?;
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
) -> Result<MarketplaceFetchResult, String> {
    let source = {
        let sources = lock_or_err(&state.sources, "sources")?;
        sources
            .iter()
            .find(|s| s.name == source_name)
            .cloned()
            .ok_or_else(|| format!("Source '{source_name}' not found"))?
    };
    // Lock released before await
    let index = registry::fetch_marketplace(&state.http_client, &source).await?;
    Ok(MarketplaceFetchResult {
        processors: index.processors.into_iter().map(MarketplaceEntryDto::from).collect(),
        packs: index.packs.into_iter().map(MarketplacePackEntryDto::from).collect(),
    })
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
        let s = lock_or_err(&state.sources, "sources")?;
        s.iter().filter(|s| s.enabled).cloned().collect()
    };
    // HashMap<qualified_id, (bare_id, installed_version)> for O(1) lookups per marketplace entry.
    let installed: HashMap<String, (String, String)> = {
        let procs = lock_or_err(&state.processors, "processors")?;
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
        let srcs = lock_or_err(&state.sources, "sources")?;
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
        let procs = lock_or_err(&state.processors, "processors")?;
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
        let srcs = lock_or_err(&state.sources, "sources")?;
        srcs.iter()
            .find(|s| s.name == source_name)
            .cloned()
            .ok_or_else(|| format!("Source '{source_name}' not found"))?
    };

    // Fetch marketplace.
    let index = registry::fetch_marketplace(&state.http_client, &source).await?;

    // Snapshot installed processors from this source.
    let installed: Vec<(String, String)> = {
        let procs = lock_or_err(&state.processors, "processors")?;
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
    let sources = lock_or_err(&state.sources, "sources")?;
    save_sources(&app, &sources)
}

/// Get pending updates discovered by the startup check.
/// Returns and clears the pending list (UI consumes once, then uses check_updates for refresh).
#[tauri::command]
pub async fn get_pending_updates(
    state: State<'_, AppState>,
) -> Result<Vec<UpdateAvailable>, String> {
    let mut pending = lock_or_err(&state.pending_updates, "pending_updates")?;
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
        let mut procs = lock_or_err(&state.processors, "processors")?;
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
        let srcs = lock_or_err(&state.sources, "sources")?;
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

// ---------------------------------------------------------------------------
// Pack marketplace commands
// ---------------------------------------------------------------------------

/// Download text (pack manifest YAML or any file) from a source using a relative path.
async fn download_text_from_source(
    client: &reqwest::Client,
    source: &Source,
    path: &str,
) -> Result<String, String> {
    use crate::processors::marketplace::SourceType;
    match &source.source_type {
        SourceType::Github { repo, git_ref } => {
            let full_path = format!("marketplace/{path}");
            let url = registry::github_raw_url(repo, git_ref, &full_path);
            let resp = client
                .get(&url)
                .header("User-Agent", "LogTapper/1.0")
                .send()
                .await
                .map_err(|e| format!("Failed to download '{path}': {e}"))?;
            if !resp.status().is_success() {
                let status = resp.status();
                return Err(format!("Download of '{path}' returned HTTP {status}"));
            }
            resp.text().await.map_err(|e| format!("Failed to read response for '{path}': {e}"))
        }
        SourceType::Local { path: base } => {
            let full = std::path::Path::new(base).join(path);
            std::fs::read_to_string(&full)
                .map_err(|e| format!("Failed to read local file '{}': {e}", full.display()))
        }
    }
}

/// Install a processor pack from a named marketplace source.
///
/// For each processor ID listed in the pack, the corresponding processor entry is located
/// in the marketplace index and installed (skipping any that are already installed).
/// Finally, the pack manifest YAML is fetched and stored.
#[tauri::command]
pub async fn install_pack_from_marketplace(
    state: State<'_, AppState>,
    app: AppHandle,
    source_name: String,
    pack_entry: marketplace::MarketplacePackEntry,
) -> Result<PackSummary, String> {
    // Look up the source (release lock before any network I/O).
    let source = {
        let srcs = lock_or_err(&state.sources, "sources")?;
        srcs.iter()
            .find(|s| s.name == source_name)
            .cloned()
            .ok_or_else(|| format!("Source '{source_name}' not found"))?
    };

    // Fetch the full marketplace index to look up processors by ID.
    let index = registry::fetch_marketplace(&state.http_client, &source).await?;

    // Build a map of processor entries for O(1) lookup.
    let proc_map: std::collections::HashMap<&str, &MarketplaceEntry> = index
        .processors
        .iter()
        .map(|e| (e.id.as_str(), e))
        .collect();

    // Install each processor in the pack (skip already-installed ones).
    for proc_id in &pack_entry.processor_ids {
        let qualified_id = marketplace::qualified_id(proc_id, &source_name);

        // Skip if already installed.
        {
            let procs = lock_or_err(&state.processors, "processors")?;
            if procs.contains_key(&qualified_id) {
                continue;
            }
        }

        let entry = proc_map
            .get(proc_id.as_str())
            .ok_or_else(|| format!("Processor '{proc_id}' not found in marketplace index for source '{source_name}'"))?;

        download_and_install_processor(&state, &app, &source, entry, &qualified_id).await?;
    }

    // Download and install the pack manifest.
    let pack_yaml = download_text_from_source(&state.http_client, &source, &pack_entry.path).await?;
    let mut pack_meta: PackMeta = parse_pack_yaml(&pack_yaml)
        .map_err(|e| format!("Failed to parse pack manifest: {e}"))?;
    pack_meta.id = pack_entry.id.clone();
    validate_pack(&pack_meta)?;

    // Persist the pack manifest.
    super::processors::persist_pack_yaml(&app, &pack_meta.id, &pack_yaml)?;

    let summary = PackSummary::from(&pack_meta);

    // Upsert into in-memory pack store.
    {
        let mut packs = lock_or_err(&state.packs, "packs")?;
        if let Some(existing) = packs.iter_mut().find(|p| p.id == pack_meta.id) {
            *existing = pack_meta;
        } else {
            packs.push(pack_meta);
        }
    }

    Ok(summary)
}

/// Uninstall a processor pack from a named marketplace source.
///
/// Processors belonging to this pack are removed only if they are not referenced by any
/// other installed pack. The pack manifest is removed unconditionally.
#[tauri::command]
pub async fn uninstall_pack_from_marketplace(
    state: State<'_, AppState>,
    app: AppHandle,
    source_name: String,
    pack_id: String,
) -> Result<(), String> {
    // Find the pack and get its processor list.
    let processor_ids: Vec<String> = {
        let packs = lock_or_err(&state.packs, "packs")?;
        packs
            .iter()
            .find(|p| p.id == pack_id)
            .ok_or_else(|| format!("Pack '{pack_id}' not found"))?
            .processors
            .iter()
            .map(|id| marketplace::qualified_id(id, &source_name))
            .collect()
    };

    // Determine which other packs (excluding the one being removed) reference each processor.
    let other_pack_proc_ids: std::collections::HashSet<String> = {
        let packs = lock_or_err(&state.packs, "packs")?;
        packs
            .iter()
            .filter(|p| p.id != pack_id)
            .flat_map(|p| p.processors.iter().map(|id| marketplace::qualified_id(id, &source_name)))
            .collect()
    };

    // Remove processors that are not referenced by any other pack.
    for qid in &processor_ids {
        if other_pack_proc_ids.contains(qid) {
            continue;
        }
        {
            let mut procs = lock_or_err(&state.processors, "processors")?;
            procs.remove(qid);
        }
        super::processors::delete_processor_file_by_id(&app, qid);
    }

    // Remove the pack from in-memory store.
    {
        let mut packs = lock_or_err(&state.packs, "packs")?;
        packs.retain(|p| p.id != pack_id);
    }

    // Delete the pack manifest file.
    super::processors::delete_pack_file_by_id(&app, &pack_id);

    Ok(())
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_newer_basic() {
        assert!(is_newer("1.0.0", "1.0.1"));
        assert!(is_newer("1.0.0", "1.1.0"));
        assert!(is_newer("1.0.0", "2.0.0"));
        assert!(!is_newer("1.0.1", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
    }

    #[test]
    fn is_newer_different_lengths() {
        // Non-semver strings fall back to string inequality (installed != available).
        // Both directions return true when strings differ.
        assert!(is_newer("1.0", "1.0.1"));
        assert!(is_newer("1.0.1", "1.0"));
        // Same non-semver strings → false (equal strings, no newer version)
        assert!(!is_newer("1.0", "1.0"));
    }

    #[test]
    fn marketplace_entry_dto_from_entry() {
        use crate::processors::marketplace::MarketplaceEntry;
        let entry = MarketplaceEntry {
            id: "wifi-state".to_string(),
            name: "WiFi State".to_string(),
            version: "1.4.0".to_string(),
            description: Some("Tracks WiFi state".to_string()),
            path: "processors/wifi_state.yaml".to_string(),
            tags: vec!["network".to_string(), "wifi".to_string()],
            sha256: "abc123".to_string(),
            category: Some("network".to_string()),
            license: Some("MIT".to_string()),
            processor_type: Some("state_tracker".to_string()),
            source_types: vec!["logcat".to_string()],
            deprecated: false,
        };
        let dto = MarketplaceEntryDto::from(entry);
        assert_eq!(dto.id, "wifi-state");
        assert_eq!(dto.category, Some("network".to_string()));
        assert_eq!(dto.processor_type, Some("state_tracker".to_string()));
    }

    #[test]
    fn marketplace_pack_entry_dto_from_entry() {
        use crate::processors::marketplace::MarketplacePackEntry;
        let entry = MarketplacePackEntry {
            id: "wifi-pack".to_string(),
            name: "WiFi Pack".to_string(),
            version: "1.0.0".to_string(),
            description: Some("WiFi diagnostics".to_string()),
            path: "packs/wifi.pack.yaml".to_string(),
            tags: vec!["wifi".to_string()],
            sha256: "".to_string(),
            category: Some("network".to_string()),
            processor_ids: vec!["wifi-state".to_string(), "wlan-disconnect".to_string()],
        };
        let dto = MarketplacePackEntryDto::from(entry);
        assert_eq!(dto.id, "wifi-pack");
        assert_eq!(dto.processor_ids, vec!["wifi-state", "wlan-disconnect"]);
        assert_eq!(dto.category, Some("network".to_string()));
    }

    #[test]
    fn marketplace_fetch_result_serialization() {
        let result = MarketplaceFetchResult {
            processors: vec![],
            packs: vec![],
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"processors\""));
        assert!(json.contains("\"packs\""));
    }

    #[test]
    fn download_text_github_url_has_marketplace_prefix() {
        // Verify the URL construction logic in download_text_from_source.
        // For GitHub sources, the path (e.g. "packs/wifi.pack.yaml") must be
        // prefixed with "marketplace/" to match the repo directory structure.
        let path = "packs/wifi-diagnostics.pack.yaml";
        let full_path = format!("marketplace/{path}");
        let url = registry::github_raw_url("jpicklyk/logtapper", "main", &full_path);
        assert!(
            url.contains("/marketplace/packs/"),
            "download URL must include marketplace/ prefix, got: {url}"
        );
        assert!(!url.contains("/marketplace/marketplace/"),
            "must not double-prefix marketplace/, got: {url}"
        );
    }

    #[test]
    fn fetch_result_github_url_has_marketplace_prefix() {
        // Verify fetch_marketplace_for_source constructs the correct URL.
        // This mirrors the logic at the top of the command.
        let url = registry::github_raw_url("jpicklyk/logtapper", "main", "marketplace/marketplace.json");
        assert_eq!(
            url,
            "https://raw.githubusercontent.com/jpicklyk/logtapper/main/marketplace/marketplace.json"
        );
    }
}
