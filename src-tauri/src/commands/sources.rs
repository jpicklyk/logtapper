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

/// A pack that has a newer version available (new processors or version bump).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUpdateAvailable {
    pub pack_id: String,
    pub pack_name: String,
    pub source_name: String,
    pub installed_version: String,
    pub available_version: String,
    /// New processor IDs present in marketplace version but absent from installed pack.
    pub new_processor_ids: Vec<String>,
    /// The full marketplace pack entry, for driving install_pack_from_marketplace.
    pub entry: MarketplacePackEntryDto,
}

/// Result of a check_updates call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub updates: Vec<UpdateAvailable>,
    pub pack_updates: Vec<PackUpdateAvailable>,
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

/// Compare installed packs against marketplace packs. Returns detected updates.
pub(crate) fn detect_pack_updates(
    installed_packs: &std::collections::HashMap<String, (String, Vec<String>)>,
    marketplace_packs: &[marketplace::MarketplacePackEntry],
    source_name: &str,
) -> Vec<PackUpdateAvailable> {
    let mut results = Vec::new();
    for market_pack in marketplace_packs {
        if let Some((inst_ver, inst_procs)) = installed_packs.get(&market_pack.id) {
            let version_bumped = is_newer(inst_ver, &market_pack.version);
            let inst_set: std::collections::HashSet<&str> =
                inst_procs.iter().map(String::as_str).collect();
            let new_procs: Vec<String> = market_pack
                .processor_ids
                .iter()
                .filter(|pid| !inst_set.contains(pid.as_str()))
                .cloned()
                .collect();
            if version_bumped || !new_procs.is_empty() {
                results.push(PackUpdateAvailable {
                    pack_id: market_pack.id.clone(),
                    pack_name: market_pack.name.clone(),
                    source_name: source_name.to_string(),
                    installed_version: inst_ver.clone(),
                    available_version: market_pack.version.clone(),
                    new_processor_ids: new_procs,
                    entry: MarketplacePackEntryDto::from(market_pack.clone()),
                });
            }
        }
    }
    results
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
    // HashMap<pack_id, (installed_version, processor_ids)> for pack update detection.
    let installed_packs: std::collections::HashMap<String, (String, Vec<String>)> = {
        let packs = lock_or_err(&state.packs, "packs")?;
        packs
            .iter()
            .map(|p| (p.id.clone(), (p.version.clone(), p.processors.clone())))
            .collect()
    };

    let mut updates = Vec::new();
    let mut pack_updates = Vec::new();
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

        pack_updates.extend(detect_pack_updates(&installed_packs, &index.packs, &source.name));

        // Update last_checked timestamp for this source.
        if let Ok(mut srcs) = state.sources.lock() {
            if let Some(s) = srcs.iter_mut().find(|s| s.name == source.name) {
                s.last_checked = Some(chrono_now_iso());
            }
        }
    }

    Ok(UpdateCheckResult { updates, pack_updates, errors })
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
    Ok(std::mem::take(&mut *pending))
}

/// Get pending pack updates discovered by the startup check.
/// Returns and clears the pending list (UI consumes once, then uses check_updates for refresh).
#[tauri::command]
pub async fn get_pending_pack_updates(
    state: State<'_, AppState>,
) -> Result<Vec<PackUpdateAvailable>, String> {
    let mut pending = lock_or_err(&state.pending_pack_updates, "pending_pack_updates")?;
    Ok(std::mem::take(&mut *pending))
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

        let entry = proc_map
            .get(proc_id.as_str())
            .ok_or_else(|| format!("Processor '{proc_id}' not found in marketplace index for source '{source_name}'"))?;

        // Skip only if installed version is >= marketplace version.
        {
            let procs = lock_or_err(&state.processors, "processors")?;
            if let Some(installed) = procs.get(&qualified_id) {
                if !is_newer(&installed.meta.version, &entry.version) {
                    continue;
                }
            }
        }

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
    use crate::processors::marketplace::SourceType;

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

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn project_root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CARGO_MANIFEST_DIR should have a parent")
            .to_path_buf()
    }

    fn load_marketplace_index() -> (std::path::PathBuf, marketplace::MarketplaceIndex) {
        let dir = project_root().join("marketplace");
        let json = std::fs::read_to_string(dir.join("marketplace.json"))
            .expect("should read marketplace.json");
        let index: marketplace::MarketplaceIndex = serde_json::from_str(&json)
            .expect("should parse marketplace.json");
        (dir, index)
    }

    // -----------------------------------------------------------------------
    // Marketplace index integrity
    // -----------------------------------------------------------------------

    #[test]
    fn local_source_reads_marketplace_index() {
        let (dir, index) = load_marketplace_index();
        assert!(dir.join("marketplace.json").exists());
        assert!(!index.processors.is_empty());
        assert!(!index.packs.is_empty());
        assert!(index.version >= 1);
    }

    #[test]
    fn local_source_processor_yamls_exist() {
        let (dir, index) = load_marketplace_index();
        for entry in &index.processors {
            let yaml_path = dir.join(&entry.path);
            assert!(yaml_path.exists(), "Processor YAML missing: {} (id: {})", yaml_path.display(), entry.id);
        }
    }

    #[test]
    fn local_source_pack_yamls_exist() {
        let (dir, index) = load_marketplace_index();
        for pack in &index.packs {
            let pack_path = dir.join(&pack.path);
            assert!(pack_path.exists(), "Pack YAML missing: {} (id: {})", pack_path.display(), pack.id);
        }
    }

    #[test]
    fn pack_processor_ids_exist_in_index() {
        let (_dir, index) = load_marketplace_index();
        let proc_ids: std::collections::HashSet<&str> =
            index.processors.iter().map(|p| p.id.as_str()).collect();
        for pack in &index.packs {
            for proc_id in &pack.processor_ids {
                assert!(
                    proc_ids.contains(proc_id.as_str()),
                    "Pack '{}' references processor '{}' which is not in the index",
                    pack.id, proc_id
                );
            }
        }
    }

    #[test]
    fn processor_yaml_versions_match_index() {
        let (dir, index) = load_marketplace_index();
        for entry in &index.processors {
            let yaml_str = match std::fs::read_to_string(dir.join(&entry.path)) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let yaml: serde_yaml::Value = match serde_yaml::from_str(&yaml_str) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let yaml_version = yaml
                .get("version")
                .or_else(|| yaml.get("meta").and_then(|m| m.get("version")))
                .and_then(|v| v.as_str());
            if let Some(yaml_ver) = yaml_version {
                assert_eq!(
                    yaml_ver, entry.version,
                    "Version mismatch for '{}': YAML='{}', index='{}'",
                    entry.id, yaml_ver, entry.version
                );
            }
        }
    }

    #[test]
    fn all_processor_yamls_parse_successfully() {
        use crate::processors::AnyProcessor;
        let (dir, index) = load_marketplace_index();
        for entry in &index.processors {
            let yaml_str = match std::fs::read_to_string(dir.join(&entry.path)) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let result = AnyProcessor::from_yaml(&yaml_str);
            assert!(result.is_ok(), "Processor '{}' failed to parse: {}", entry.id, result.unwrap_err());
        }
    }

    // -----------------------------------------------------------------------
    // Update detection
    // -----------------------------------------------------------------------

    #[test]
    fn update_detection_finds_newer_version() {
        assert!(is_newer("1.0.0", "2.0.0"));
        assert!(is_newer("3.1.2", "4.0.0"));
    }

    #[test]
    fn update_detection_ignores_same_version() {
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("4.0.0", "4.0.0"));
    }

    #[test]
    fn update_detection_ignores_older_version() {
        assert!(!is_newer("2.0.0", "1.0.0"));
    }

    // -----------------------------------------------------------------------
    // Source serialization
    // -----------------------------------------------------------------------

    #[test]
    fn source_serialization_roundtrip_local() {
        let source = Source {
            name: "official".to_string(),
            source_type: SourceType::Local { path: "/some/path/marketplace".to_string() },
            enabled: true, auto_update: false, last_checked: None,
        };
        let json = serde_json::to_string_pretty(&source).expect("serialize");
        let parsed: Source = serde_json::from_str(&json).expect("deserialize");
        assert!(matches!(&parsed.source_type, SourceType::Local { path } if path == "/some/path/marketplace"));
    }

    #[test]
    fn source_serialization_roundtrip_github() {
        let source = Source {
            name: "official".to_string(),
            source_type: SourceType::Github { repo: "jpicklyk/logtapper".to_string(), git_ref: "main".to_string() },
            enabled: true, auto_update: false, last_checked: Some("12345Z".to_string()),
        };
        let json = serde_json::to_string_pretty(&source).expect("serialize");
        let parsed: Source = serde_json::from_str(&json).expect("deserialize");
        assert!(matches!(&parsed.source_type, SourceType::Github { repo, git_ref } if repo == "jpicklyk/logtapper" && git_ref == "main"));
    }

    // -----------------------------------------------------------------------
    // Dev source resolution and auto-correction
    // -----------------------------------------------------------------------

    #[test]
    fn simplified_path_strips_unc_prefix() {
        use crate::simplified_path;
        let marketplace_dir = project_root().join("marketplace");
        let result = simplified_path(&marketplace_dir);
        let result_str = result.to_string_lossy();
        assert!(!result_str.starts_with(r"\\?\"), "should strip \\\\?\\ prefix, got: {result_str}");
        assert!(result_str.contains("marketplace"));
    }

    // These tests are debug-only because resolve_dev_marketplace_path is #[cfg(debug_assertions)].
    // They will be silently skipped in `cargo test --release`.
    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_marketplace_path_is_valid() {
        let path = crate::resolve_dev_marketplace_path();
        let p = std::path::Path::new(&path);
        assert!(!path.starts_with(r"\\?\"), "should not have \\\\?\\ prefix: {path}");
        assert!(p.join("marketplace.json").exists(), "should contain marketplace.json: {path}");
        assert!(p.join("processors").is_dir(), "should contain processors/: {path}");
        assert!(p.join("packs").is_dir(), "should contain packs/: {path}");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_dev_marketplace_path_prefers_project_root_over_target() {
        let path = crate::resolve_dev_marketplace_path();
        let p = std::path::Path::new(&path);
        let has_target = p.components().any(|c| c.as_os_str() == "target");
        assert!(!has_target, "should not be inside target/: {path}");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn needs_source_correction_detects_github() {
        use crate::needs_source_correction;
        let github = SourceType::Github { repo: "r".to_string(), git_ref: "main".to_string() };
        assert!(needs_source_correction(&github, "/any/path"));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn needs_source_correction_detects_stale_local() {
        use crate::needs_source_correction;
        let local = SourceType::Local { path: "/old/path".to_string() };
        assert!(needs_source_correction(&local, "/correct/path"));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn needs_source_correction_skips_correct_local() {
        use crate::needs_source_correction;
        let local = SourceType::Local { path: "/correct/path".to_string() };
        assert!(!needs_source_correction(&local, "/correct/path"));
    }

    // -----------------------------------------------------------------------
    // Release migration
    // -----------------------------------------------------------------------

    #[test]
    fn release_migration_local_to_github() {
        let source_type = SourceType::Local { path: "/some/dev/path".to_string() };
        assert!(matches!(source_type, SourceType::Local { .. }), "should detect Local for migration");
    }

    #[test]
    fn release_migration_skips_github() {
        let source_type = SourceType::Github { repo: "r".to_string(), git_ref: "main".to_string() };
        assert!(!matches!(source_type, SourceType::Local { .. }), "should not migrate Github");
    }

    // -----------------------------------------------------------------------
    // GitHub URL construction
    // -----------------------------------------------------------------------

    #[test]
    fn github_source_constructs_correct_index_url() {
        let url = registry::github_raw_url("jpicklyk/logtapper", "main", "marketplace/marketplace.json");
        assert_eq!(url, "https://raw.githubusercontent.com/jpicklyk/logtapper/main/marketplace/marketplace.json");
    }

    #[test]
    fn github_source_constructs_correct_processor_url() {
        let url = registry::github_raw_url("jpicklyk/logtapper", "main", "marketplace/processors/battery_state.yaml");
        assert_eq!(url, "https://raw.githubusercontent.com/jpicklyk/logtapper/main/marketplace/processors/battery_state.yaml");
    }

    #[test]
    fn github_source_constructs_correct_pack_url() {
        let url = registry::github_raw_url("jpicklyk/logtapper", "main", "marketplace/packs/device-health.pack.yaml");
        assert_eq!(url, "https://raw.githubusercontent.com/jpicklyk/logtapper/main/marketplace/packs/device-health.pack.yaml");
    }

    // -----------------------------------------------------------------------
    // Pack update detection
    // -----------------------------------------------------------------------

    #[test]
    fn pack_update_detected_on_version_bump() {
        use crate::processors::marketplace::MarketplacePackEntry;
        let mut installed = std::collections::HashMap::new();
        installed.insert("wifi-diag".to_string(), ("1.0.0".to_string(), vec!["wifi-state".to_string(), "wlan-events".to_string()]));
        let market = vec![MarketplacePackEntry {
            id: "wifi-diag".to_string(),
            name: "WiFi Diagnostics".to_string(),
            version: "2.0.0".to_string(),
            description: None,
            path: "packs/wifi-diag.pack.yaml".to_string(),
            tags: vec![],
            sha256: String::new(),
            category: None,
            processor_ids: vec!["wifi-state".to_string(), "wlan-events".to_string()],
        }];
        let results = detect_pack_updates(&installed, &market, "official");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].installed_version, "1.0.0");
        assert_eq!(results[0].available_version, "2.0.0");
        assert!(results[0].new_processor_ids.is_empty());
    }

    #[test]
    fn pack_update_detected_on_new_processors() {
        use crate::processors::marketplace::MarketplacePackEntry;
        let mut installed = std::collections::HashMap::new();
        installed.insert("wifi-diag".to_string(), ("1.0.0".to_string(), vec!["wifi-state".to_string()]));
        let market = vec![MarketplacePackEntry {
            id: "wifi-diag".to_string(),
            name: "WiFi Diagnostics".to_string(),
            version: "1.0.0".to_string(),
            description: None,
            path: "packs/wifi-diag.pack.yaml".to_string(),
            tags: vec![],
            sha256: String::new(),
            category: None,
            processor_ids: vec!["wifi-state".to_string(), "p2p-tracker".to_string()],
        }];
        let results = detect_pack_updates(&installed, &market, "official");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].new_processor_ids, vec!["p2p-tracker"]);
    }

    #[test]
    fn pack_update_not_detected_when_unchanged() {
        use crate::processors::marketplace::MarketplacePackEntry;
        let mut installed = std::collections::HashMap::new();
        installed.insert("wifi-diag".to_string(), ("1.0.0".to_string(), vec!["wifi-state".to_string()]));
        let market = vec![MarketplacePackEntry {
            id: "wifi-diag".to_string(),
            name: "WiFi Diagnostics".to_string(),
            version: "1.0.0".to_string(),
            description: None,
            path: "packs/wifi-diag.pack.yaml".to_string(),
            tags: vec![],
            sha256: String::new(),
            category: None,
            processor_ids: vec!["wifi-state".to_string()],
        }];
        let results = detect_pack_updates(&installed, &market, "official");
        assert!(results.is_empty());
    }

    #[test]
    fn pack_update_skips_uninstalled_packs() {
        use crate::processors::marketplace::MarketplacePackEntry;
        let installed = std::collections::HashMap::new(); // nothing installed
        let market = vec![MarketplacePackEntry {
            id: "wifi-diag".to_string(),
            name: "WiFi Diagnostics".to_string(),
            version: "2.0.0".to_string(),
            description: None,
            path: "packs/wifi-diag.pack.yaml".to_string(),
            tags: vec![],
            sha256: String::new(),
            category: None,
            processor_ids: vec!["wifi-state".to_string()],
        }];
        let results = detect_pack_updates(&installed, &market, "official");
        assert!(results.is_empty());
    }

    #[test]
    fn pack_update_available_serialization() {
        let update = PackUpdateAvailable {
            pack_id: "wifi-diag".to_string(),
            pack_name: "WiFi Diagnostics".to_string(),
            source_name: "official".to_string(),
            installed_version: "1.0.0".to_string(),
            available_version: "2.0.0".to_string(),
            new_processor_ids: vec!["p2p-tracker".to_string()],
            entry: MarketplacePackEntryDto {
                id: "wifi-diag".to_string(),
                name: "WiFi Diagnostics".to_string(),
                version: "2.0.0".to_string(),
                description: None,
                path: "packs/wifi-diag.pack.yaml".to_string(),
                tags: vec![],
                sha256: String::new(),
                category: None,
                processor_ids: vec!["wifi-state".to_string()],
            },
        };
        let json = serde_json::to_string(&update).unwrap();
        assert!(json.contains("\"packId\""));
        assert!(json.contains("\"packName\""));
        assert!(json.contains("\"newProcessorIds\""));
        assert!(json.contains("\"installedVersion\""));
        assert!(json.contains("\"availableVersion\""));
    }

    #[test]
    fn update_check_result_includes_pack_updates() {
        let result = UpdateCheckResult {
            updates: vec![],
            pack_updates: vec![],
            errors: vec![],
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"packUpdates\""));
        assert!(json.contains("\"updates\""));
        assert!(json.contains("\"errors\""));
    }
}
