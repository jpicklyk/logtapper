//! Marketplace sources, fetch, update-checking, and marketplace-driven
//! install/uninstall of processors and packs.
//!
//! `commands/sources.rs` is a thin Tauri adapter over this file; every real
//! decision (persistence, network fetch, version comparison, journal calls)
//! lives here. Source persistence goes through [`super::AppPaths`], network
//! access through `ctx.state().http_client` — never a raw `AppHandle` or a
//! bare `reqwest::Client` constructed ad hoc.
//!
//! **Agent mutation gate**: an agent adding or removing a marketplace source
//! is a supply-chain surface — a source is where every future processor
//! install's code comes from. [`add_source`] / [`remove_source`] are
//! `Forbidden` for [`crate::services::Caller::Agent`] via
//! [`super::policy::deny_agent_gate_mutation`], the same gate that protects
//! the open-file allowlist and anonymizer config. Installing *from* an
//! already-configured source (`install_from_marketplace`,
//! `install_pack_from_marketplace`, `update_*`) is not gated the same way —
//! an agent driving an install a human already authorized by adding the
//! source is normal tool use, not privilege escalation.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::processors::marketplace::{self, MarketplaceEntry, MarketplacePackEntry, Source, SourceType};
use crate::processors::registry;
use crate::processors::{AnyProcessor, PackMeta, PackSummary, ProcessorSummary};

use super::paths::AppPaths;
use super::policy;
use super::{lock_svc, ServiceCtx, ServiceError};

// ---------------------------------------------------------------------------
// DTOs (moved from commands/sources.rs — camelCase wire shapes for the
// frontend; unchanged field-for-field). `commands::sources` re-exports every
// one of these under its old path so existing callers
// (`AppState.pending_updates`/`pending_pack_updates`, the ts-rs
// `ROOT_TYPES!` list) keep compiling unchanged.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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

impl From<MarketplaceEntryDto> for MarketplaceEntry {
    fn from(e: MarketplaceEntryDto) -> Self {
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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

impl From<MarketplacePackEntry> for MarketplacePackEntryDto {
    fn from(e: MarketplacePackEntry) -> Self {
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceFetchResult {
    pub processors: Vec<MarketplaceEntryDto>,
    pub packs: Vec<MarketplacePackEntryDto>,
}

#[derive(Debug, Clone, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PackUpdateAvailable {
    pub pack_id: String,
    pub pack_name: String,
    pub source_name: String,
    pub installed_version: String,
    pub available_version: String,
    /// New processor IDs present in marketplace version but absent from installed pack.
    pub new_processor_ids: Vec<String>,
    /// The full marketplace pack entry, for driving `install_pack_from_marketplace`.
    pub entry: MarketplacePackEntryDto,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceError {
    pub source_name: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub updates: Vec<UpdateAvailable>,
    pub pack_updates: Vec<PackUpdateAvailable>,
    /// Sources that failed to fetch.
    pub errors: Vec<SourceError>,
}

/// Payload of the `updates-available` Tauri event, emitted once by the
/// startup marketplace check (`services::marketplace::startup_check`) when it found
/// anything to report: updates it left pending for the user, and processors
/// it already applied silently for `auto_update` sources. The UI turns the
/// pending half into the "Update all" prompt; the auto-applied half is
/// informational (the catalog refresh rides on `catalog-update`).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesAvailableEvent {
    pub updates: Vec<UpdateAvailable>,
    pub pack_updates: Vec<PackUpdateAvailable>,
    /// Qualified ids of processors auto-updated during this check.
    pub auto_applied: Vec<String>,
}

pub const UPDATES_AVAILABLE_EVENT: &str = "updates-available";

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub processor_id: String,
    pub old_version: String,
    pub new_version: String,
    pub success: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Pure helpers (moved from commands/sources.rs — no AppHandle, no locking)
// ---------------------------------------------------------------------------

/// Compare installed version against marketplace version using SemVer.
/// Returns true if `available` is newer than `installed`.
pub(crate) fn is_newer(installed: &str, available: &str) -> bool {
    match (semver::Version::parse(installed), semver::Version::parse(available)) {
        (Ok(inst), Ok(avail)) => avail > inst,
        _ => installed != available,
    }
}

/// Compare installed packs against marketplace packs. Returns detected updates.
pub(crate) fn detect_pack_updates(
    installed_packs: &HashMap<String, (String, Vec<String>)>,
    marketplace_packs: &[MarketplacePackEntry],
    source_name: &str,
) -> Vec<PackUpdateAvailable> {
    let mut results = Vec::new();
    for market_pack in marketplace_packs {
        if let Some((inst_ver, inst_procs)) = installed_packs.get(&market_pack.id) {
            let version_bumped = is_newer(inst_ver, &market_pack.version);
            let inst_set: std::collections::HashSet<&str> = inst_procs.iter().map(String::as_str).collect();
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

/// Simple ISO-ish timestamp (no chrono dependency — seconds since epoch).
pub(crate) fn chrono_now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}Z", dur.as_secs())
}

/// Build the provenance YAML suffix appended to downloaded processor YAMLs.
///
/// `installed_by` is `"ui"` / `"agent:<client>"` for a fresh caller-driven
/// install ([`super::processors::caller_provenance`]), or the previously
/// recorded value (or `None`) when this is an automatic version bump that
/// nobody explicitly triggered — see [`startup_check`].
pub(crate) fn build_provenance_yaml(source_name: &str, version: &str, sha256: &str, installed_by: Option<&str>) -> String {
    let now = chrono_now_iso();
    let mut yaml = format!("\n_source: {source_name}\n_installed_version: {version}\n_installed_at: {now}\n_sha256: {sha256}\n");
    if let Some(v) = installed_by {
        yaml.push_str(&super::processors::installed_by_line(v));
        yaml.push('\n');
    }
    yaml
}

/// Pure core of [`add_source`]: computes the post-add source list without
/// mutating `current`. Returns an error if a source with the same name
/// already exists. Callers only commit the returned Vec after it has been
/// durably persisted.
pub(crate) fn try_add_source(current: &[Source], source: Source) -> Result<Vec<Source>, ServiceError> {
    if current.iter().any(|s| s.name == source.name) {
        return Err(ServiceError::Conflict(format!(
            "A source named '{}' already exists",
            source.name
        )));
    }
    let mut updated = current.to_vec();
    updated.push(source);
    Ok(updated)
}

/// Pure core of [`remove_source`]: computes the post-removal source list
/// without mutating `current`.
pub(crate) fn try_remove_source(current: &[Source], source_name: &str) -> Result<Vec<Source>, ServiceError> {
    let mut updated = current.to_vec();
    let before = updated.len();
    updated.retain(|s| s.name != source_name);
    if updated.len() == before {
        return Err(ServiceError::NotFound(format!("Source '{source_name}' not found")));
    }
    Ok(updated)
}

// ---------------------------------------------------------------------------
// Source persistence (paths-based)
// ---------------------------------------------------------------------------

fn sources_path(paths: &dyn AppPaths) -> Result<PathBuf, ServiceError> {
    Ok(paths.app_data_dir()?.join("sources.json"))
}

/// Name of the built-in marketplace source every install is seeded with.
pub(crate) const OFFICIAL_SOURCE_NAME: &str = "official";
/// GitHub repo / ref the official source points at in release builds
/// (debug builds point it at the local checkout instead).
#[cfg(not(debug_assertions))]
pub(crate) const OFFICIAL_GITHUB_REPO: &str = "jpicklyk/logtapper";
#[cfg(not(debug_assertions))]
pub(crate) const OFFICIAL_GITHUB_REF: &str = "main";

/// The official source as a fresh install gets it — the one definition shared
/// by first-run seeding (`lib.rs`), the tolerant loader's recovery, and
/// [`restore_default_sources`]. Dev builds point at the checkout's
/// `marketplace/` directory (`crate::resolve_dev_marketplace_path`), release
/// builds at GitHub.
pub(crate) fn default_official_source() -> Source {
    #[cfg(debug_assertions)]
    let source_type = SourceType::Local {
        path: crate::resolve_dev_marketplace_path(),
    };
    #[cfg(not(debug_assertions))]
    let source_type = SourceType::Github {
        repo: OFFICIAL_GITHUB_REPO.to_string(),
        git_ref: OFFICIAL_GITHUB_REF.to_string(),
    };
    Source {
        name: OFFICIAL_SOURCE_NAME.to_string(),
        source_type,
        enabled: true,
        auto_update: false,
        last_checked: None,
    }
}

/// Outcome of [`parse_sources_tolerant`].
#[derive(Debug, Default)]
pub(crate) struct ParsedSources {
    pub sources: Vec<Source>,
    /// Entries dropped: unreadable by this build, or a duplicate name.
    pub skipped: usize,
    /// The file was not a JSON array at all.
    pub unreadable: bool,
}

/// Parse `sources.json` one entry at a time, so a single entry this build
/// can't read (a future `type` variant, a field an older build doesn't know
/// after a downgrade, a hand edit) costs that entry, not every source.
///
/// Recovery of the official source: when the whole file is unreadable, or the
/// entry that failed is named `official`, the default official source is put
/// in its place — the file shows the user had it, and a deliberate removal
/// writes a valid file without it, so this never overrides that choice.
pub(crate) fn parse_sources_tolerant(json: &str) -> ParsedSources {
    let values: Vec<serde_json::Value> = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[marketplace] sources.json is unreadable ({e}); restoring the default source");
            return ParsedSources {
                sources: vec![default_official_source()],
                skipped: 0,
                unreadable: true,
            };
        }
    };
    let mut out = ParsedSources::default();
    for value in values {
        let name = value.get("name").and_then(|n| n.as_str()).map(str::to_string);
        let source = match serde_json::from_value::<Source>(value) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[marketplace] skipping unreadable sources.json entry {name:?}: {e}");
                out.skipped += 1;
                if name.as_deref() == Some(OFFICIAL_SOURCE_NAME) {
                    default_official_source()
                } else {
                    continue;
                }
            }
        };
        if out.sources.iter().any(|s| s.name == source.name) {
            log::warn!("[marketplace] skipping duplicate sources.json entry '{}'", source.name);
            out.skipped += 1;
            continue;
        }
        out.sources.push(source);
    }
    out
}

/// What went wrong loading `sources.json` at startup, for the Sources tab's
/// notice. Parked in `AppState::sources_load_notice` by `lib.rs`'s setup and
/// cleared only by `dismiss_sources_load_notice`; absent when the file
/// loaded cleanly (or did not exist).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourcesLoadNotice {
    /// Entries dropped: unreadable by this build, or a duplicate name.
    #[ts(type = "number")]
    pub skipped: usize,
    /// The file could not be read as a list at all; only the default source
    /// was restored.
    pub unreadable: bool,
    /// Where the original file was copied; empty if that copy failed.
    pub backup_path: Option<String>,
}

/// [`load_sources_file`]'s result: the sources to use, and a notice when
/// anything had to be dropped or recovered.
#[derive(Debug, Default)]
pub(crate) struct LoadedSources {
    pub sources: Vec<Source>,
    pub notice: Option<SourcesLoadNotice>,
}

/// Load `sources.json` tolerantly (see [`parse_sources_tolerant`]); empty
/// if it does not exist. Whenever anything had to be dropped or recovered,
/// the original file is first copied to `sources.json.bak`, so the next save
/// (which writes only what was readable) can't destroy it, and a
/// [`SourcesLoadNotice`] is returned for the UI.
pub(crate) fn load_sources_file(paths: &dyn AppPaths) -> LoadedSources {
    let Ok(path) = sources_path(paths) else {
        return LoadedSources::default();
    };
    if !path.exists() {
        return LoadedSources::default();
    }
    let parsed = match std::fs::read_to_string(&path) {
        Ok(json) => parse_sources_tolerant(&json),
        Err(e) => {
            log::warn!("[marketplace] could not read sources.json ({e}); restoring the default source");
            ParsedSources {
                sources: vec![default_official_source()],
                skipped: 0,
                unreadable: true,
            }
        }
    };
    if !parsed.unreadable && parsed.skipped == 0 {
        return LoadedSources {
            sources: parsed.sources,
            notice: None,
        };
    }
    let backup = path.with_extension("json.bak");
    let backup_path = match std::fs::copy(&path, &backup) {
        Ok(_) => {
            log::warn!("[marketplace] original sources.json kept at {}", backup.display());
            Some(backup.to_string_lossy().to_string())
        }
        Err(e) => {
            log::warn!("[marketplace] could not back up sources.json: {e}");
            None
        }
    };
    LoadedSources {
        sources: parsed.sources,
        notice: Some(SourcesLoadNotice {
            skipped: parsed.skipped,
            unreadable: parsed.unreadable,
            backup_path,
        }),
    }
}

/// Pure core of [`restore_default_sources`]: `current` with the official
/// source reset to `official` (in place, keeping its position) or added
/// first if missing. Every other source is untouched.
pub(crate) fn with_default_official(current: &[Source], official: Source) -> Vec<Source> {
    let mut updated = current.to_vec();
    match updated.iter_mut().find(|s| s.name == official.name) {
        Some(existing) => *existing = official,
        None => updated.insert(0, official),
    }
    updated
}

fn save_sources_file(paths: &dyn AppPaths, sources: &[Source]) -> Result<(), ServiceError> {
    let path = sources_path(paths)?;
    let json = serde_json::to_string_pretty(sources)
        .map_err(|e| ServiceError::Internal(format!("Serialize error: {e}")))?;
    std::fs::write(&path, json).map_err(|e| ServiceError::Internal(format!("Failed to write sources.json: {e}")))
}

fn lookup_source(ctx: &ServiceCtx, source_name: &str) -> Result<Source, ServiceError> {
    let sources = lock_svc(&ctx.state().sources, "sources")?;
    sources
        .iter()
        .find(|s| s.name == source_name)
        .cloned()
        .ok_or_else(|| ServiceError::NotFound(format!("Source '{source_name}' not found")))
}

// ---------------------------------------------------------------------------
// Sources CRUD
// ---------------------------------------------------------------------------

pub fn sources(ctx: &ServiceCtx) -> Result<Vec<Source>, ServiceError> {
    let sources = lock_svc(&ctx.state().sources, "sources")?;
    Ok(sources.clone())
}

/// Add a marketplace source. **Agent-forbidden** — see the module doc.
pub fn add_source(ctx: &ServiceCtx, source: Source) -> Result<(), ServiceError> {
    policy::deny_agent_gate_mutation(ctx, "marketplace sources")?;
    let mut sources = lock_svc(&ctx.state().sources, "sources")?;
    // Compute the new state and persist it *before* committing to memory — if
    // save fails, in-memory state must still reflect exactly what's on disk.
    let updated = try_add_source(&sources, source.clone())?;
    save_sources_file(ctx.paths(), &updated)?;
    *sources = updated;
    drop(sources);
    ctx.journal("source.add", None, format!("added marketplace source '{}'", source.name));
    Ok(())
}

/// Remove a marketplace source. **Agent-forbidden** — see the module doc.
pub fn remove_source(ctx: &ServiceCtx, source_name: &str) -> Result<(), ServiceError> {
    policy::deny_agent_gate_mutation(ctx, "marketplace sources")?;
    let mut sources = lock_svc(&ctx.state().sources, "sources")?;
    let updated = try_remove_source(&sources, source_name)?;
    save_sources_file(ctx.paths(), &updated)?;
    *sources = updated;
    drop(sources);
    ctx.journal("source.remove", None, format!("removed marketplace source '{source_name}'"));
    Ok(())
}

/// Restore the built-in official source to its default definition — re-add
/// it if it was removed, reset it if it was changed — leaving every other
/// source as it is. The user-facing repair for a `sources.json` damaged by a
/// schema change. **Agent-forbidden** — see the module doc.
pub fn restore_default_sources(ctx: &ServiceCtx) -> Result<(), ServiceError> {
    policy::deny_agent_gate_mutation(ctx, "marketplace sources")?;
    let mut sources = lock_svc(&ctx.state().sources, "sources")?;
    let updated = with_default_official(&sources, default_official_source());
    save_sources_file(ctx.paths(), &updated)?;
    *sources = updated;
    drop(sources);
    ctx.journal(
        "source.restore",
        None,
        format!("restored the default marketplace source '{OFFICIAL_SOURCE_NAME}'"),
    );
    Ok(())
}

/// The startup [`SourcesLoadNotice`], if `sources.json` needed repair. Not
/// consumed by reading — it stays until the user dismisses it, so reopening
/// the tab still shows it.
pub fn sources_load_notice(ctx: &ServiceCtx) -> Result<Option<SourcesLoadNotice>, ServiceError> {
    Ok(lock_svc(&ctx.state().sources_load_notice, "sources_load_notice")?.clone())
}

/// Clear the startup [`SourcesLoadNotice`] (the user acknowledged it). UI
/// state only — the sources themselves are untouched, so not journaled.
pub fn dismiss_sources_load_notice(ctx: &ServiceCtx) -> Result<(), ServiceError> {
    *lock_svc(&ctx.state().sources_load_notice, "sources_load_notice")? = None;
    Ok(())
}

pub fn save_sources_to_disk(ctx: &ServiceCtx) -> Result<(), ServiceError> {
    let sources = lock_svc(&ctx.state().sources, "sources")?;
    save_sources_file(ctx.paths(), &sources)
}

/// Return and clear the pending-updates list discovered by [`startup_check`].
pub fn pending_updates(ctx: &ServiceCtx) -> Result<Vec<UpdateAvailable>, ServiceError> {
    let mut pending = lock_svc(&ctx.state().pending_updates, "pending_updates")?;
    Ok(std::mem::take(&mut *pending))
}

/// Return and clear the pending pack-updates list discovered by [`startup_check`].
pub fn pending_pack_updates(ctx: &ServiceCtx) -> Result<Vec<PackUpdateAvailable>, ServiceError> {
    let mut pending = lock_svc(&ctx.state().pending_pack_updates, "pending_pack_updates")?;
    Ok(std::mem::take(&mut *pending))
}

// ---------------------------------------------------------------------------
// Fetch + update-checking
// ---------------------------------------------------------------------------

/// Fetch a source's marketplace index.
pub async fn fetch(ctx: &ServiceCtx, source_name: &str) -> Result<MarketplaceFetchResult, ServiceError> {
    let source = lookup_source(ctx, source_name)?;
    let index = registry::fetch_marketplace(&ctx.state().http_client, &source)
        .await
        .map_err(ServiceError::Internal)?;
    Ok(MarketplaceFetchResult {
        processors: index.processors.into_iter().map(MarketplaceEntryDto::from).collect(),
        packs: index.packs.into_iter().map(MarketplacePackEntryDto::from).collect(),
    })
}

/// Check every enabled source for processor and pack updates — the one
/// update-check implementation, shared by the Settings → Packs "Check for
/// updates" button, `GET /mcp/marketplace/updates`, and [`startup_check`].
///
/// Sources are fetched concurrently (each fetch is bounded by the shared
/// `http_client`'s timeout, so N slow sources cost one timeout, not N).
/// Results keep the configured source order. Every source that answered gets
/// its `last_checked` stamped, and `sources.json` is re-persisted
/// (best-effort: a failed write is logged, not surfaced — the check itself
/// succeeded).
///
/// **Never applies anything**, including for `auto_update` sources: this is a
/// read (an agent reaches it through a `GET`), and a read must not install
/// code. Auto-apply is launch-time only — see [`startup_check`]. A manual
/// check therefore lists an `auto_update` source's updates as pending like
/// any other source's, and the user applies them with the usual buttons.
pub async fn check_updates(ctx: &ServiceCtx) -> Result<UpdateCheckResult, ServiceError> {
    let sources: Vec<Source> = {
        let s = lock_svc(&ctx.state().sources, "sources")?;
        s.iter().filter(|s| s.enabled).cloned().collect()
    };
    let installed: HashMap<String, String> = {
        let procs = lock_svc(&ctx.state().processors, "processors")?;
        procs
            .iter()
            .filter_map(|(qid, proc)| proc.source.as_ref().map(|_| (qid.clone(), proc.meta.version.clone())))
            .collect()
    };
    let installed_packs: HashMap<String, (String, Vec<String>)> = {
        let packs = lock_svc(&ctx.state().packs, "packs")?;
        packs
            .iter()
            .map(|p| (p.id.clone(), (p.version.clone(), p.processors.clone())))
            .collect()
    };

    let client = &ctx.state().http_client;
    let fetched = futures_util::future::join_all(
        sources
            .iter()
            .map(|source| async move { (source, registry::fetch_marketplace(client, source).await) }),
    )
    .await;

    let mut updates = Vec::new();
    let mut pack_updates = Vec::new();
    let mut errors = Vec::new();
    let mut checked: Vec<&str> = Vec::new();

    for (source, result) in fetched {
        let index = match result {
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
            if let Some(inst_ver) = installed.get(&qid) {
                if is_newer(inst_ver, &market_entry.version) {
                    updates.push(UpdateAvailable {
                        processor_id: qid,
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
        checked.push(&source.name);
    }

    if !checked.is_empty() {
        let mut srcs = lock_svc(&ctx.state().sources, "sources")?;
        let now = chrono_now_iso();
        for s in srcs.iter_mut().filter(|s| checked.contains(&s.name.as_str())) {
            s.last_checked = Some(now.clone());
        }
        if let Err(e) = save_sources_file(ctx.paths(), &srcs) {
            log::warn!("[marketplace] update check could not persist last_checked: {}", e.message());
        }
    }

    Ok(UpdateCheckResult {
        updates,
        pack_updates,
        errors,
    })
}

/// The launch-time update check (spawned from `lib.rs`'s `setup`, skipped on
/// first run): [`check_updates`], then the one thing a manual check never
/// does — silently apply every processor update offered by a source with
/// `auto_update: true`.
///
/// - An auto-applied update carries forward the processor's existing
///   `installed_by` provenance (nobody triggered this version bump; see
///   [`build_provenance_yaml`]). One that fails to apply is logged and falls
///   back to pending, so the user still sees it.
/// - Pack updates are never auto-applied (a pack update can pull in new
///   processors, which is an install, not a version bump).
/// - What is left pending is parked in `AppState::pending_updates` /
///   `pending_pack_updates` **before** `updates-available` is emitted — the
///   frontend reads that seed at construction and also listens for the
///   event, so either order of "check finishes" vs "window subscribes" works
///   (`src-solid/packs/packsStore.ts`).
/// - Auto-applied ids ride `catalog-update` (action `"update"`) like every
///   other catalog mutation, and are journaled.
/// - `updates-available` is emitted only when there is something to report.
///
/// Per-source fetch failures are logged; the returned event is exactly what
/// was emitted (or would have been, if empty).
pub async fn startup_check(ctx: &ServiceCtx) -> Result<UpdatesAvailableEvent, ServiceError> {
    let check = check_updates(ctx).await?;
    for e in &check.errors {
        log::warn!("[marketplace] startup update check: source '{}' failed: {}", e.source_name, e.error);
    }

    let auto_sources: HashMap<String, Source> = {
        let srcs = lock_svc(&ctx.state().sources, "sources")?;
        srcs.iter()
            .filter(|s| s.enabled && s.auto_update)
            .map(|s| (s.name.clone(), s.clone()))
            .collect()
    };

    let mut pending = Vec::new();
    let mut auto_applied = Vec::new();
    for update in check.updates {
        let Some(source) = auto_sources.get(&update.source_name) else {
            pending.push(update);
            continue;
        };
        match auto_apply(ctx, source, &update).await {
            Ok(()) => {
                log::info!(
                    "[marketplace] auto-updated {} from {} to {}",
                    update.processor_id,
                    update.installed_version,
                    update.available_version
                );
                auto_applied.push(update.processor_id);
            }
            Err(e) => {
                log::warn!("[marketplace] auto-update of {} failed: {}", update.processor_id, e.message());
                pending.push(update);
            }
        }
    }

    *lock_svc(&ctx.state().pending_updates, "pending_updates")? = pending.clone();
    *lock_svc(&ctx.state().pending_pack_updates, "pending_pack_updates")? = check.pack_updates.clone();

    if !auto_applied.is_empty() {
        ctx.journal(
            "processor.install",
            None,
            format!("auto-updated {} processor(s) from auto-update sources", auto_applied.len()),
        );
        super::processors::emit_catalog_update(ctx, "update", auto_applied.clone());
    }

    let event = UpdatesAvailableEvent {
        updates: pending,
        pack_updates: check.pack_updates,
        auto_applied,
    };
    if !event.updates.is_empty() || !event.pack_updates.is_empty() || !event.auto_applied.is_empty() {
        ctx.events()
            .emit_json(UPDATES_AVAILABLE_EVENT, serde_json::to_value(&event).unwrap_or_default());
    }
    Ok(event)
}

/// Apply one update found by [`check_updates`] without attributing it to a
/// caller: the processor keeps whatever `installed_by` it already had.
async fn auto_apply(ctx: &ServiceCtx, source: &Source, update: &UpdateAvailable) -> Result<(), ServiceError> {
    let existing_installed_by = {
        let procs = lock_svc(&ctx.state().processors, "processors")?;
        procs.get(&update.processor_id).and_then(|p| p.installed_by.clone())
    };
    let entry = MarketplaceEntry::from(update.entry.clone());
    install_processor_with_provenance(ctx, source, &entry, &update.processor_id, existing_installed_by).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Install / update from marketplace
// ---------------------------------------------------------------------------

/// Download, verify, persist, and install a single processor from a
/// marketplace source. The shared core of every install/update path below.
async fn download_and_install_processor(
    ctx: &ServiceCtx,
    source: &Source,
    entry: &MarketplaceEntry,
    qualified_id: &str,
) -> Result<AnyProcessor, ServiceError> {
    let installed_by = super::processors::caller_provenance(ctx.caller());
    install_processor_with_provenance(ctx, source, entry, qualified_id, Some(installed_by)).await
}

/// [`download_and_install_processor`] with the `installed_by` provenance
/// supplied explicitly — `None` when an automatic version bump
/// ([`auto_apply`]) carries forward a processor that predates the field.
async fn install_processor_with_provenance(
    ctx: &ServiceCtx,
    source: &Source,
    entry: &MarketplaceEntry,
    qualified_id: &str,
    installed_by: Option<String>,
) -> Result<AnyProcessor, ServiceError> {
    let yaml = registry::download_processor_from_source(&ctx.state().http_client, source, entry)
        .await
        .map_err(ServiceError::Internal)?;
    let final_yaml = format!(
        "{}{}",
        yaml,
        build_provenance_yaml(&source.name, &entry.version, &entry.sha256, installed_by.as_deref())
    );
    let mut def = AnyProcessor::from_yaml(&final_yaml)
        .map_err(|e| ServiceError::invalid_arg(format!("Failed to parse processor YAML: {e}")))?;
    def.source = Some(source.name.clone());
    def.installed_by = installed_by;

    super::processors::persist_processor_file(ctx.paths(), qualified_id, &final_yaml)?;

    let mut procs = lock_svc(&ctx.state().processors, "processors")?;
    procs.insert(qualified_id.to_string(), def.clone());
    Ok(def)
}

/// Download text (pack manifest YAML) from a source using a relative path.
async fn download_text_from_source(ctx: &ServiceCtx, source: &Source, path: &str) -> Result<String, ServiceError> {
    match &source.source_type {
        SourceType::Github { repo, git_ref } => {
            let full_path = format!("marketplace/{path}");
            let url = registry::github_raw_url(repo, git_ref, &full_path);
            let resp = ctx
                .state()
                .http_client
                .get(&url)
                .header("User-Agent", "LogTapper/1.0")
                .send()
                .await
                .map_err(|e| ServiceError::Internal(format!("Failed to download '{path}': {e}")))?;
            if !resp.status().is_success() {
                let status = resp.status();
                return Err(ServiceError::Internal(format!("Download of '{path}' returned HTTP {status}")));
            }
            resp.text()
                .await
                .map_err(|e| ServiceError::Internal(format!("Failed to read response for '{path}': {e}")))
        }
        SourceType::Local { path: base } => {
            let full = std::path::Path::new(base).join(path);
            std::fs::read_to_string(&full)
                .map_err(|e| ServiceError::Internal(format!("Failed to read local file '{}': {e}", full.display())))
        }
    }
}

/// Update a single already-installed processor from its marketplace source.
#[allow(clippy::too_many_arguments)]
pub async fn update_processor(
    ctx: &ServiceCtx,
    processor_id: &str,
    entry_name: &str,
    entry_path: &str,
    entry_version: &str,
    entry_sha256: &str,
) -> Result<UpdateResult, ServiceError> {
    let (bare_id, source_name) = match marketplace::split_qualified_id(processor_id) {
        (id, Some(src)) => (id.to_string(), src.to_string()),
        _ => {
            return Err(ServiceError::invalid_arg(format!(
                "Processor '{processor_id}' has no source qualifier — cannot update"
            )))
        }
    };
    let source = lookup_source(ctx, &source_name)?;
    let entry = MarketplaceEntry {
        id: bare_id,
        name: entry_name.to_string(),
        path: entry_path.to_string(),
        version: entry_version.to_string(),
        sha256: entry_sha256.to_string(),
        description: None,
        tags: Vec::new(),
        category: None,
        license: None,
        processor_type: None,
        source_types: Vec::new(),
        deprecated: false,
    };
    let old_version = {
        let procs = lock_svc(&ctx.state().processors, "processors")?;
        procs
            .get(processor_id)
            .map_or_else(|| "unknown".to_string(), |p| p.meta.version.clone())
    };

    let def = download_and_install_processor(ctx, &source, &entry, processor_id).await?;
    let new_version = def.meta.version;
    ctx.journal(
        "processor.install",
        None,
        format!("updated processor '{processor_id}' {old_version} -> {new_version}"),
    );
    super::processors::emit_catalog_update(ctx, "update", vec![processor_id.to_string()]);

    Ok(UpdateResult {
        processor_id: processor_id.to_string(),
        old_version,
        new_version,
        success: true,
        error: None,
    })
}

/// Update every outdated processor from one source.
pub async fn update_all_from_source(ctx: &ServiceCtx, source_name: &str) -> Result<Vec<UpdateResult>, ServiceError> {
    let source = lookup_source(ctx, source_name)?;
    let index = registry::fetch_marketplace(&ctx.state().http_client, &source)
        .await
        .map_err(ServiceError::Internal)?;

    let installed: Vec<(String, String)> = {
        let procs = lock_svc(&ctx.state().processors, "processors")?;
        procs
            .iter()
            .filter_map(|(qid, p)| {
                if p.source.as_deref() == Some(source_name) {
                    Some((qid.clone(), p.meta.version.clone()))
                } else {
                    None
                }
            })
            .collect()
    };

    let mut results = Vec::new();
    for entry in &index.processors {
        let qid = marketplace::qualified_id(&entry.id, source_name);
        let Some((_, inst_ver)) = installed.iter().find(|(q, _)| *q == qid) else {
            continue;
        };
        if !is_newer(inst_ver, &entry.version) {
            continue;
        }
        match download_and_install_processor(ctx, &source, entry, &qid).await {
            Ok(def) => results.push(UpdateResult {
                processor_id: qid,
                old_version: inst_ver.clone(),
                new_version: def.meta.version.clone(),
                success: true,
                error: None,
            }),
            Err(e) => results.push(UpdateResult {
                processor_id: qid,
                old_version: inst_ver.clone(),
                new_version: entry.version.clone(),
                success: false,
                error: Some(e.message()),
            }),
        }
    }

    if let Ok(mut srcs) = ctx.state().sources.lock() {
        if let Some(s) = srcs.iter_mut().find(|s| s.name == source_name) {
            s.last_checked = Some(chrono_now_iso());
        }
    }

    if !results.is_empty() {
        let applied = results.iter().filter(|r| r.success).count();
        ctx.journal(
            "processor.install",
            None,
            format!("updated {applied}/{} processor(s) from source '{source_name}'", results.len()),
        );
        let updated_ids: Vec<String> = results.iter().filter(|r| r.success).map(|r| r.processor_id.clone()).collect();
        super::processors::emit_catalog_update(ctx, "update", updated_ids);
    }

    Ok(results)
}

/// Install a processor from a named marketplace source.
#[allow(clippy::too_many_arguments)]
pub async fn install_from_marketplace(
    ctx: &ServiceCtx,
    source_name: &str,
    entry_id: &str,
    entry_name: &str,
    entry_path: &str,
    entry_version: &str,
    entry_sha256: &str,
) -> Result<ProcessorSummary, ServiceError> {
    let source = lookup_source(ctx, source_name)?;
    let entry = MarketplaceEntry {
        id: entry_id.to_string(),
        name: entry_name.to_string(),
        path: entry_path.to_string(),
        version: entry_version.to_string(),
        sha256: entry_sha256.to_string(),
        description: None,
        tags: Vec::new(),
        category: None,
        license: None,
        processor_type: None,
        source_types: Vec::new(),
        deprecated: false,
    };
    let qualified_id = marketplace::qualified_id(&entry.id, source_name);
    let def = download_and_install_processor(ctx, &source, &entry, &qualified_id).await?;

    let mut summary = ProcessorSummary::from(&def);
    summary.id = qualified_id.clone();
    ctx.journal(
        "processor.install",
        None,
        format!("installed '{qualified_id}' from marketplace source '{source_name}'"),
    );
    super::processors::emit_catalog_update(ctx, "install", vec![qualified_id]);
    Ok(summary)
}

/// Install a processor pack (and every member processor not already
/// up to date) from a named marketplace source.
pub async fn install_pack_from_marketplace(
    ctx: &ServiceCtx,
    source_name: &str,
    pack_entry: MarketplacePackEntry,
) -> Result<PackSummary, ServiceError> {
    let source = lookup_source(ctx, source_name)?;
    let index = registry::fetch_marketplace(&ctx.state().http_client, &source)
        .await
        .map_err(ServiceError::Internal)?;
    let proc_map: HashMap<&str, &MarketplaceEntry> = index.processors.iter().map(|e| (e.id.as_str(), e)).collect();

    for proc_id in &pack_entry.processor_ids {
        let qualified_id = marketplace::qualified_id(proc_id, source_name);
        let entry = proc_map.get(proc_id.as_str()).ok_or_else(|| {
            ServiceError::invalid_arg(format!(
                "Processor '{proc_id}' not found in marketplace index for source '{source_name}'"
            ))
        })?;

        let already_current = {
            let procs = lock_svc(&ctx.state().processors, "processors")?;
            procs
                .get(&qualified_id)
                .is_some_and(|installed| !is_newer(&installed.meta.version, &entry.version))
        };
        if already_current {
            continue;
        }

        download_and_install_processor(ctx, &source, entry, &qualified_id).await?;
    }

    let pack_yaml = download_text_from_source(ctx, &source, &pack_entry.path).await?;
    let mut pack_meta: PackMeta =
        crate::processors::pack::parse_pack_yaml(&pack_yaml).map_err(ServiceError::invalid_arg)?;
    pack_meta.id = pack_entry.id.clone();
    crate::processors::pack::validate_pack(&pack_meta).map_err(ServiceError::invalid_arg)?;

    // The marketplace index is authoritative for the pack version — reconcile
    // a lagging manifest version so `detect_pack_updates` doesn't re-report
    // the same update forever (see the comment this preserves from the
    // pre-refactor `install_pack_from_marketplace`).
    let pack_yaml = if pack_meta.version == pack_entry.version {
        pack_yaml
    } else {
        pack_meta.version = pack_entry.version.clone();
        serde_yaml::to_string(&pack_meta)
            .map_err(|e| ServiceError::Internal(format!("Failed to re-serialize pack manifest: {e}")))?
    };

    super::processors::persist_pack_file(ctx.paths(), &pack_meta.id, &pack_yaml)?;
    let summary = PackSummary::from(&pack_meta);
    let pack_id = pack_meta.id.clone();
    super::processors::upsert_pack(ctx, pack_meta)?;
    ctx.journal(
        "pack.install",
        None,
        format!("installed pack '{}' from marketplace source '{source_name}'", pack_entry.id),
    );
    let mut catalog_ids: Vec<String> = pack_entry
        .processor_ids
        .iter()
        .map(|id| marketplace::qualified_id(id, source_name))
        .collect();
    catalog_ids.push(pack_id);
    super::processors::emit_catalog_update(ctx, "install", catalog_ids);
    Ok(summary)
}

/// Uninstall a marketplace-installed pack. Unlike [`super::processors::uninstall_pack`],
/// this also removes member processors that no other installed pack references.
///
/// Synchronous — despite living alongside the network-touching functions
/// above, uninstalling never fetches anything.
pub fn uninstall_pack_from_marketplace(
    ctx: &ServiceCtx,
    source_name: &str,
    pack_id: &str,
) -> Result<(), ServiceError> {
    let processor_ids: Vec<String> = {
        let packs = lock_svc(&ctx.state().packs, "packs")?;
        packs
            .iter()
            .find(|p| p.id == pack_id)
            .ok_or_else(|| ServiceError::NotFound(format!("Pack '{pack_id}' not found")))?
            .processors
            .iter()
            .map(|id| marketplace::qualified_id(id, source_name))
            .collect()
    };

    let other_pack_proc_ids: std::collections::HashSet<String> = {
        let packs = lock_svc(&ctx.state().packs, "packs")?;
        packs
            .iter()
            .filter(|p| p.id != pack_id)
            .flat_map(|p| p.processors.iter().map(|id| marketplace::qualified_id(id, source_name)))
            .collect()
    };

    let mut removed_ids = Vec::new();
    for qid in &processor_ids {
        if other_pack_proc_ids.contains(qid) {
            continue;
        }
        {
            let mut procs = lock_svc(&ctx.state().processors, "processors")?;
            procs.remove(qid);
        }
        super::processors::delete_processor_file(ctx.paths(), qid);
        removed_ids.push(qid.clone());
    }

    {
        let mut packs = lock_svc(&ctx.state().packs, "packs")?;
        packs.retain(|p| p.id != pack_id);
    }
    super::processors::delete_pack_file(ctx.paths(), pack_id);
    ctx.journal("pack.uninstall", None, format!("uninstalled pack '{pack_id}' from source '{source_name}'"));
    removed_ids.push(pack_id.to_string());
    super::processors::emit_catalog_update(ctx, "uninstall", removed_ids);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;

    fn test_source(name: &str) -> Source {
        Source {
            name: name.to_string(),
            source_type: SourceType::Local {
                path: "/some/path".to_string(),
            },
            enabled: true,
            auto_update: false,
            last_checked: None,
        }
    }

    #[test]
    fn is_newer_basic() {
        assert!(is_newer("1.0.0", "1.0.1"));
        assert!(!is_newer("1.0.0", "1.0.0"));
    }

    #[test]
    fn sources_lists_configured_sources() {
        let (ctx, _tmp) = test_ctx().build();
        ctx.state().sources.lock().unwrap().push(test_source("official"));
        let out = sources(&ctx).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "official");
    }

    #[test]
    fn add_source_persists_before_committing_and_journals() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        add_source(&ctx, test_source("official")).unwrap();
        assert_eq!(sources(&ctx).unwrap().len(), 1);
        let path = ctx.paths().app_data_dir().unwrap().join("sources.json");
        assert!(path.exists());
        let on_disk = load_sources_file(ctx.paths()).sources;
        assert_eq!(on_disk.len(), 1);
        let events = sink.events_named("activity");
        assert_eq!(events[0].payload["action"], serde_json::json!("source.add"));
    }

    #[test]
    fn add_source_rejects_duplicate_name() {
        let (ctx, _tmp) = test_ctx().build();
        add_source(&ctx, test_source("official")).unwrap();
        let err = add_source(&ctx, test_source("official")).unwrap_err();
        assert_eq!(err.code(), "CONFLICT");
    }

    #[test]
    fn add_source_is_forbidden_for_an_agent_caller() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = add_source(&ctx, test_source("official")).unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert!(sources(&ctx).unwrap().is_empty(), "the agent's write must not have applied");
    }

    #[test]
    fn remove_source_is_forbidden_for_an_agent_caller() {
        let (ui, _tmp) = test_ctx().build();
        add_source(&ui, test_source("official")).unwrap();
        let agent = ui.with_caller(crate::services::Caller::agent("claude-code"));
        let err = remove_source(&agent, "official").unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert_eq!(sources(&ui).unwrap().len(), 1, "the agent's removal must not have applied");
    }

    #[test]
    fn remove_source_removes_and_journals() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        add_source(&ctx, test_source("official")).unwrap();
        sink.clear();
        remove_source(&ctx, "official").unwrap();
        assert!(sources(&ctx).unwrap().is_empty());
        assert_eq!(sink.events_named("activity")[0].payload["action"], serde_json::json!("source.remove"));
    }

    #[test]
    fn remove_source_on_unknown_name_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = remove_source(&ctx, "nope").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn pending_updates_are_returned_and_cleared() {
        let (ctx, _tmp) = test_ctx().build();
        ctx.state().pending_updates.lock().unwrap().push(UpdateAvailable {
            processor_id: "p@s".into(),
            processor_name: "P".into(),
            source_name: "s".into(),
            installed_version: "1.0.0".into(),
            available_version: "1.1.0".into(),
            entry: MarketplaceEntryDto::from(MarketplaceEntry {
                id: "p".into(),
                name: "P".into(),
                version: "1.1.0".into(),
                description: None,
                path: "p.yaml".into(),
                tags: vec![],
                sha256: String::new(),
                category: None,
                license: None,
                processor_type: None,
                source_types: vec![],
                deprecated: false,
            }),
        });
        let first = pending_updates(&ctx).unwrap();
        assert_eq!(first.len(), 1);
        let second = pending_updates(&ctx).unwrap();
        assert!(second.is_empty(), "pending updates must be consumed once");
    }

    #[test]
    fn detect_pack_updates_finds_version_bump() {
        let mut installed = HashMap::new();
        installed.insert("wifi-diag".to_string(), ("1.0.0".to_string(), vec!["wifi-state".to_string()]));
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
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].installed_version, "1.0.0");
    }

    #[test]
    fn try_add_source_and_try_remove_source_do_not_mutate_input() {
        let current = vec![test_source("a")];
        let updated = try_add_source(&current, test_source("b")).unwrap();
        assert_eq!(current.len(), 1, "input slice must be untouched");
        assert_eq!(updated.len(), 2);

        let updated = try_remove_source(&current, "a").unwrap();
        assert_eq!(current.len(), 1, "input slice must be untouched");
        assert!(updated.is_empty());
    }

    // -----------------------------------------------------------------------
    // B2: catalog-update event + installed_by provenance
    // -----------------------------------------------------------------------

    use crate::processors::marketplace::{MarketplaceIndex, Provenance};

    const FIXTURE_PROCESSOR_YAML: &str = "meta:\n  id: wifi-state\n  name: WiFi State\n  version: 1.0.0\n";
    const FIXTURE_PACK_YAML: &str = "name: WiFi Pack\nversion: 1.0.0\nprocessors:\n  - wifi-state\n";

    fn local_source(dir: &std::path::Path) -> Source {
        Source {
            name: "official".to_string(),
            source_type: SourceType::Local {
                path: dir.to_string_lossy().to_string(),
            },
            enabled: true,
            auto_update: false,
            last_checked: None,
        }
    }

    fn fixture_entry(version: &str) -> MarketplaceEntry {
        MarketplaceEntry {
            id: "wifi-state".to_string(),
            name: "WiFi State".to_string(),
            version: version.to_string(),
            description: None,
            path: "wifi-state.yaml".to_string(),
            tags: vec![],
            sha256: String::new(),
            category: None,
            license: None,
            processor_type: None,
            source_types: vec![],
            deprecated: false,
        }
    }

    fn write_index(dir: &std::path::Path, processors: Vec<MarketplaceEntry>) {
        let index = MarketplaceIndex {
            name: "official".to_string(),
            version: 2,
            owner: None,
            processors,
            packs: vec![],
        };
        std::fs::write(dir.join("marketplace.json"), serde_json::to_string(&index).unwrap()).unwrap();
    }

    /// Install an already-current copy of `wifi-state@official`, as the
    /// prior-version fixture for update-path tests.
    fn install_current(ctx: &ServiceCtx) {
        let mut proc = AnyProcessor::from_yaml(FIXTURE_PROCESSOR_YAML).unwrap();
        proc.source = Some("official".to_string());
        ctx.state()
            .processors
            .lock()
            .unwrap()
            .insert("wifi-state@official".to_string(), proc);
    }

    #[test]
    fn add_source_and_remove_source_emit_no_catalog_update() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        add_source(&ctx, test_source("official")).unwrap();
        remove_source(&ctx, "official").unwrap();
        assert!(
            sink.events_named("catalog-update").is_empty(),
            "source add/remove is a human-only gate, not a catalog change"
        );
    }

    #[tokio::test]
    async fn update_processor_emits_catalog_update() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("wifi-state.yaml"), FIXTURE_PROCESSOR_YAML).unwrap();
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        ctx.state().sources.lock().unwrap().push(local_source(dir.path()));
        install_current(&ctx);

        update_processor(&ctx, "wifi-state@official", "WiFi State", "wifi-state.yaml", "2.0.0", "")
            .await
            .unwrap();

        let events = sink.events_named("catalog-update");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["action"], serde_json::json!("update"));
        assert_eq!(events[0].payload["ids"], serde_json::json!(["wifi-state@official"]));
    }

    #[tokio::test]
    async fn update_all_from_source_emits_catalog_update_with_successful_ids_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("wifi-state.yaml"), FIXTURE_PROCESSOR_YAML).unwrap();
        write_index(dir.path(), vec![fixture_entry("2.0.0")]);

        let (ctx, sink, _tmp) = test_ctx().build_recording();
        ctx.state().sources.lock().unwrap().push(local_source(dir.path()));
        install_current(&ctx);

        let results = update_all_from_source(&ctx, "official").await.unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].success);

        let events = sink.events_named("catalog-update");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["action"], serde_json::json!("update"));
        assert_eq!(events[0].payload["ids"], serde_json::json!(["wifi-state@official"]));
    }

    #[tokio::test]
    async fn update_all_from_source_emits_nothing_when_no_processor_is_outdated() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("wifi-state.yaml"), FIXTURE_PROCESSOR_YAML).unwrap();
        // Marketplace offers the same version already installed — nothing to update.
        write_index(dir.path(), vec![fixture_entry("1.0.0")]);

        let (ctx, sink, _tmp) = test_ctx().build_recording();
        ctx.state().sources.lock().unwrap().push(local_source(dir.path()));
        install_current(&ctx);

        let results = update_all_from_source(&ctx, "official").await.unwrap();
        assert!(results.is_empty());
        assert!(sink.events_named("catalog-update").is_empty());
    }

    #[tokio::test]
    async fn install_from_marketplace_emits_catalog_update() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("wifi-state.yaml"), FIXTURE_PROCESSOR_YAML).unwrap();
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        ctx.state().sources.lock().unwrap().push(local_source(dir.path()));

        let summary = install_from_marketplace(&ctx, "official", "wifi-state", "WiFi State", "wifi-state.yaml", "1.0.0", "")
            .await
            .unwrap();
        assert_eq!(summary.id, "wifi-state@official");

        let events = sink.events_named("catalog-update");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["action"], serde_json::json!("install"));
        assert_eq!(events[0].payload["ids"], serde_json::json!(["wifi-state@official"]));
    }

    #[tokio::test]
    async fn install_pack_from_marketplace_emits_catalog_update_with_members_and_pack_id() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("wifi-state.yaml"), FIXTURE_PROCESSOR_YAML).unwrap();
        std::fs::write(dir.path().join("wifi-pack.pack.yaml"), FIXTURE_PACK_YAML).unwrap();
        write_index(dir.path(), vec![fixture_entry("1.0.0")]);

        let (ctx, sink, _tmp) = test_ctx().build_recording();
        ctx.state().sources.lock().unwrap().push(local_source(dir.path()));

        let pack_entry = MarketplacePackEntry {
            id: "wifi-pack".to_string(),
            name: "WiFi Pack".to_string(),
            version: "1.0.0".to_string(),
            description: None,
            path: "wifi-pack.pack.yaml".to_string(),
            tags: vec![],
            sha256: String::new(),
            category: None,
            processor_ids: vec!["wifi-state".to_string()],
        };

        let summary = install_pack_from_marketplace(&ctx, "official", pack_entry).await.unwrap();
        assert_eq!(summary.id, "wifi-pack");

        let events = sink.events_named("catalog-update");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["action"], serde_json::json!("install"));
        assert_eq!(events[0].payload["ids"], serde_json::json!(["wifi-state@official", "wifi-pack"]));
    }

    #[test]
    fn uninstall_pack_from_marketplace_emits_catalog_update_with_removed_and_pack_id() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        install_current(&ctx);
        ctx.state().packs.lock().unwrap().push(PackMeta {
            id: "wifi-pack".to_string(),
            name: "WiFi Pack".to_string(),
            version: "1.0.0".to_string(),
            author: String::new(),
            description: String::new(),
            tags: vec![],
            category: None,
            license: None,
            repository: None,
            deprecated: false,
            processors: vec!["wifi-state".to_string()],
        });

        uninstall_pack_from_marketplace(&ctx, "official", "wifi-pack").unwrap();

        let events = sink.events_named("catalog-update");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["action"], serde_json::json!("uninstall"));
        assert_eq!(events[0].payload["ids"], serde_json::json!(["wifi-state@official", "wifi-pack"]));
    }

    #[tokio::test]
    async fn install_from_marketplace_stamps_agent_installed_by_provenance() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("wifi-state.yaml"), FIXTURE_PROCESSOR_YAML).unwrap();
        let (ctx, tmp) = test_ctx().agent("claude").build();
        ctx.state().sources.lock().unwrap().push(local_source(dir.path()));

        let summary = install_from_marketplace(&ctx, "official", "wifi-state", "WiFi State", "wifi-state.yaml", "1.0.0", "")
            .await
            .unwrap();
        assert_eq!(summary.installed_by.as_deref(), Some("agent:claude"));

        let yaml_path = tmp
            .path()
            .join("processors")
            .join(format!("{}.yaml", marketplace::id_to_filename("wifi-state@official")));
        let persisted = std::fs::read_to_string(&yaml_path).unwrap();
        let prov: Provenance = serde_yaml::from_str(&persisted).unwrap();
        assert_eq!(prov.installed_by.as_deref(), Some("agent:claude"));
    }

    #[tokio::test]
    async fn install_from_marketplace_stamps_ui_installed_by_provenance() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("wifi-state.yaml"), FIXTURE_PROCESSOR_YAML).unwrap();
        let (ctx, _tmp) = test_ctx().build();
        ctx.state().sources.lock().unwrap().push(local_source(dir.path()));

        let summary = install_from_marketplace(&ctx, "official", "wifi-state", "WiFi State", "wifi-state.yaml", "1.0.0", "")
            .await
            .unwrap();
        assert_eq!(summary.installed_by.as_deref(), Some("ui"));
    }

    // -----------------------------------------------------------------------
    // Tolerant sources.json loading + restore_default_sources
    // -----------------------------------------------------------------------

    fn write_sources_json(ctx: &ServiceCtx, json: &str) -> PathBuf {
        let path = ctx.paths().app_data_dir().unwrap().join("sources.json");
        std::fs::write(&path, json).unwrap();
        path
    }

    const GOOD_OFFICIAL: &str = r#"{"name":"official","type":"github","repo":"jpicklyk/logtapper","ref":"main","enabled":true,"autoUpdate":false}"#;
    const GOOD_MINE: &str = r#"{"name":"mine","type":"local","path":"/tmp/m","enabled":true,"autoUpdate":true}"#;
    /// An entry from a hypothetical future build: a source type this one doesn't know.
    const FUTURE_ENTRY: &str = r#"{"name":"future","type":"s3","bucket":"b","enabled":true}"#;

    #[test]
    fn a_valid_sources_file_loads_unchanged_and_is_not_backed_up() {
        let (ctx, _tmp) = test_ctx().build();
        let path = write_sources_json(&ctx, &format!("[{GOOD_OFFICIAL},{GOOD_MINE}]"));
        let loaded = load_sources_file(ctx.paths());
        assert!(loaded.notice.is_none(), "a clean load raises no notice");
        let names: Vec<&str> = loaded.sources.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["official", "mine"]);
        assert!(!path.with_extension("json.bak").exists());
    }

    #[test]
    fn one_unreadable_entry_costs_only_that_entry_and_backs_the_file_up() {
        let (ctx, _tmp) = test_ctx().build();
        let original = format!("[{GOOD_OFFICIAL},{FUTURE_ENTRY},{GOOD_MINE}]");
        let path = write_sources_json(&ctx, &original);

        let loaded = load_sources_file(ctx.paths());

        let names: Vec<&str> = loaded.sources.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["official", "mine"]);
        let backup = path.with_extension("json.bak");
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            original,
            "the original must survive the next save"
        );
        assert_eq!(
            loaded.notice,
            Some(SourcesLoadNotice {
                skipped: 1,
                unreadable: false,
                backup_path: Some(backup.to_string_lossy().to_string()),
            })
        );
    }

    #[test]
    fn an_unreadable_official_entry_is_replaced_by_the_default_in_place() {
        let broken_official = r#"{"name":"official","type":"s3","enabled":true}"#;
        let parsed = parse_sources_tolerant(&format!("[{GOOD_MINE},{broken_official}]"));
        assert_eq!(parsed.skipped, 1);
        let names: Vec<&str> = parsed.sources.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["mine", "official"]);
        assert_eq!(
            serde_json::to_value(&parsed.sources[1]).unwrap(),
            serde_json::to_value(default_official_source()).unwrap()
        );
    }

    #[test]
    fn a_file_that_is_not_a_json_array_recovers_the_default_source_and_is_backed_up() {
        let (ctx, _tmp) = test_ctx().build();
        let path = write_sources_json(&ctx, "{ this is not json");

        let loaded = load_sources_file(ctx.paths());

        assert_eq!(loaded.sources.len(), 1);
        assert_eq!(loaded.sources[0].name, OFFICIAL_SOURCE_NAME);
        assert_eq!(std::fs::read_to_string(path.with_extension("json.bak")).unwrap(), "{ this is not json");
        let notice = loaded.notice.expect("an unreadable file raises a notice");
        assert!(notice.unreadable);
        assert_eq!(notice.skipped, 0);
    }

    #[test]
    fn a_deliberately_emptied_source_list_stays_empty() {
        let (ctx, _tmp) = test_ctx().build();
        write_sources_json(&ctx, "[]");
        assert!(load_sources_file(ctx.paths()).sources.is_empty(), "removing 'official' on purpose must stick");
    }

    #[test]
    fn duplicate_names_keep_the_first_entry() {
        let dup = r#"{"name":"mine","type":"local","path":"/other","enabled":false,"autoUpdate":false}"#;
        let parsed = parse_sources_tolerant(&format!("[{GOOD_MINE},{dup}]"));
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.sources.len(), 1);
        assert!(parsed.sources[0].enabled);
    }

    #[test]
    fn a_missing_sources_file_loads_empty() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(load_sources_file(ctx.paths()).sources.is_empty());
    }

    #[test]
    fn restore_default_sources_re_adds_a_removed_official_and_keeps_custom_sources() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        add_source(&ctx, test_source("mine")).unwrap();
        sink.clear();

        restore_default_sources(&ctx).unwrap();

        let names: Vec<String> = sources(&ctx).unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["official".to_string(), "mine".to_string()]);
        let on_disk: Vec<String> = load_sources_file(ctx.paths()).sources.into_iter().map(|s| s.name).collect();
        assert_eq!(on_disk, names, "restore persists before committing");
        assert_eq!(sink.events_named("activity")[0].payload["action"], serde_json::json!("source.restore"));
    }

    #[test]
    fn restore_default_sources_resets_a_changed_official_in_place() {
        let (ctx, _tmp) = test_ctx().build();
        let mut changed = test_source("official");
        changed.enabled = false;
        changed.auto_update = true;
        add_source(&ctx, test_source("mine")).unwrap();
        add_source(&ctx, changed).unwrap();

        restore_default_sources(&ctx).unwrap();

        let after = sources(&ctx).unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[0].name, "mine");
        assert_eq!(
            serde_json::to_value(&after[1]).unwrap(),
            serde_json::to_value(default_official_source()).unwrap()
        );
    }

    #[test]
    fn the_sources_load_notice_survives_reads_until_dismissed() {
        let (ctx, _tmp) = test_ctx().build();
        assert_eq!(sources_load_notice(&ctx).unwrap(), None);
        let notice = SourcesLoadNotice {
            skipped: 2,
            unreadable: false,
            backup_path: Some("/data/sources.json.bak".to_string()),
        };
        *ctx.state().sources_load_notice.lock().unwrap() = Some(notice.clone());

        assert_eq!(sources_load_notice(&ctx).unwrap(), Some(notice.clone()));
        assert_eq!(sources_load_notice(&ctx).unwrap(), Some(notice), "reading must not consume it");

        dismiss_sources_load_notice(&ctx).unwrap();
        assert_eq!(sources_load_notice(&ctx).unwrap(), None);
    }

    #[test]
    fn the_sources_load_notice_serializes_camel_case_for_the_ui() {
        let v = serde_json::to_value(SourcesLoadNotice {
            skipped: 1,
            unreadable: true,
            backup_path: None,
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "skipped": 1, "unreadable": true, "backupPath": null }));
    }

    #[test]
    fn restore_default_sources_is_forbidden_for_an_agent_caller() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = restore_default_sources(&ctx).unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert!(sources(&ctx).unwrap().is_empty(), "the agent's write must not have applied");
    }

    // -----------------------------------------------------------------------
    // check_updates / startup_check — one implementation, auto-apply only at
    // startup
    // -----------------------------------------------------------------------

    fn processor_yaml(version: &str) -> String {
        format!("meta:\n  id: wifi-state\n  name: WiFi State\n  version: {version}\n")
    }

    fn named_local_source(name: &str, dir: &std::path::Path, auto_update: bool) -> Source {
        Source {
            name: name.to_string(),
            auto_update,
            ..local_source(dir)
        }
    }

    fn fixture_pack_entry(version: &str) -> MarketplacePackEntry {
        MarketplacePackEntry {
            id: "wifi-pack".to_string(),
            name: "WiFi Pack".to_string(),
            version: version.to_string(),
            description: None,
            path: "wifi-pack.pack.yaml".to_string(),
            tags: vec![],
            sha256: String::new(),
            category: None,
            processor_ids: vec!["wifi-state".to_string()],
        }
    }

    /// A local marketplace offering `wifi-state` at `version`, with the
    /// processor file on disk at that same version.
    fn marketplace_offering(version: &str, packs: Vec<MarketplacePackEntry>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("wifi-state.yaml"), processor_yaml(version)).unwrap();
        let index = MarketplaceIndex {
            name: "official".to_string(),
            version: 2,
            owner: None,
            processors: vec![fixture_entry(version)],
            packs,
        };
        std::fs::write(dir.path().join("marketplace.json"), serde_json::to_string(&index).unwrap()).unwrap();
        dir
    }

    fn installed_version(ctx: &ServiceCtx, qid: &str) -> String {
        ctx.state().processors.lock().unwrap()[qid].meta.version.clone()
    }

    #[tokio::test]
    async fn check_updates_reports_but_never_applies_even_for_an_auto_update_source() {
        let market = marketplace_offering("2.0.0", vec![]);
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        ctx.state().sources.lock().unwrap().push(named_local_source("official", market.path(), true));
        install_current(&ctx);

        let result = check_updates(&ctx).await.unwrap();

        assert_eq!(result.updates.len(), 1);
        assert_eq!(result.updates[0].processor_id, "wifi-state@official");
        assert_eq!(result.updates[0].available_version, "2.0.0");
        assert!(result.errors.is_empty());
        assert_eq!(installed_version(&ctx, "wifi-state@official"), "1.0.0", "a manual check must not apply");
        assert!(sink.events_named("catalog-update").is_empty());
        assert!(sink.events_named(UPDATES_AVAILABLE_EVENT).is_empty(), "only the startup check emits");
    }

    #[tokio::test]
    async fn check_updates_stamps_and_persists_last_checked_for_reachable_sources_only() {
        let market = marketplace_offering("1.0.0", vec![]);
        let missing = tempfile::tempdir().unwrap();
        let (ctx, _tmp) = test_ctx().build();
        {
            let mut srcs = ctx.state().sources.lock().unwrap();
            srcs.push(named_local_source("official", market.path(), false));
            srcs.push(named_local_source("broken", &missing.path().join("nope"), false));
        }

        let result = check_updates(&ctx).await.unwrap();
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].source_name, "broken");

        let in_memory = sources(&ctx).unwrap();
        assert!(in_memory[0].last_checked.is_some());
        assert!(in_memory[1].last_checked.is_none(), "a source that failed to fetch was not checked");
        let on_disk = load_sources_file(ctx.paths()).sources;
        assert_eq!(on_disk.len(), 2);
        assert_eq!(on_disk[0].last_checked, in_memory[0].last_checked, "check_updates persists sources.json itself");
    }

    #[tokio::test]
    async fn check_updates_fetches_every_source_and_keeps_configured_order() {
        let a = marketplace_offering("2.0.0", vec![]);
        let b = marketplace_offering("3.0.0", vec![]);
        let (ctx, _tmp) = test_ctx().build();
        {
            let mut srcs = ctx.state().sources.lock().unwrap();
            srcs.push(named_local_source("alpha", a.path(), false));
            srcs.push(named_local_source("beta", b.path(), false));
        }
        for src in ["alpha", "beta"] {
            let mut proc = AnyProcessor::from_yaml(FIXTURE_PROCESSOR_YAML).unwrap();
            proc.source = Some(src.to_string());
            ctx.state().processors.lock().unwrap().insert(format!("wifi-state@{src}"), proc);
        }

        let result = check_updates(&ctx).await.unwrap();
        let got: Vec<(&str, &str)> = result
            .updates
            .iter()
            .map(|u| (u.processor_id.as_str(), u.available_version.as_str()))
            .collect();
        assert_eq!(got, vec![("wifi-state@alpha", "2.0.0"), ("wifi-state@beta", "3.0.0")]);
    }

    #[tokio::test]
    async fn startup_check_auto_applies_for_an_auto_update_source_and_keeps_installed_by() {
        let market = marketplace_offering("2.0.0", vec![]);
        let (ctx, sink, tmp) = test_ctx().build_recording();
        ctx.state().sources.lock().unwrap().push(named_local_source("official", market.path(), true));
        install_current(&ctx);
        ctx.state()
            .processors
            .lock()
            .unwrap()
            .get_mut("wifi-state@official")
            .unwrap()
            .installed_by = Some("agent:claude".to_string());

        let event = startup_check(&ctx).await.unwrap();

        assert_eq!(event.auto_applied, vec!["wifi-state@official".to_string()]);
        assert!(event.updates.is_empty());
        assert_eq!(installed_version(&ctx, "wifi-state@official"), "2.0.0");

        // Provenance is carried forward, not re-attributed to the startup ctx's `Ui` caller.
        let proc_installed_by = ctx.state().processors.lock().unwrap()["wifi-state@official"].installed_by.clone();
        assert_eq!(proc_installed_by.as_deref(), Some("agent:claude"));
        let yaml_path = tmp
            .path()
            .join("processors")
            .join(format!("{}.yaml", marketplace::id_to_filename("wifi-state@official")));
        let prov: Provenance = serde_yaml::from_str(&std::fs::read_to_string(yaml_path).unwrap()).unwrap();
        assert_eq!(prov.installed_by.as_deref(), Some("agent:claude"));
        assert_eq!(prov.installed_version.as_deref(), Some("2.0.0"));

        let catalog = sink.events_named("catalog-update");
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].payload["action"], serde_json::json!("update"));
        assert_eq!(catalog[0].payload["ids"], serde_json::json!(["wifi-state@official"]));
        let available = sink.events_named(UPDATES_AVAILABLE_EVENT);
        assert_eq!(available.len(), 1);
        assert_eq!(available[0].payload["autoApplied"], serde_json::json!(["wifi-state@official"]));
        assert!(pending_updates(&ctx).unwrap().is_empty(), "an applied update is not pending");
    }

    #[tokio::test]
    async fn startup_check_seeds_pending_state_before_emitting_for_a_manual_source() {
        let market = marketplace_offering("2.0.0", vec![fixture_pack_entry("2.0.0")]);
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        ctx.state().sources.lock().unwrap().push(named_local_source("official", market.path(), false));
        install_current(&ctx);
        ctx.state().packs.lock().unwrap().push(PackMeta {
            id: "wifi-pack".to_string(),
            name: "WiFi Pack".to_string(),
            version: "1.0.0".to_string(),
            author: String::new(),
            description: String::new(),
            tags: vec![],
            category: None,
            license: None,
            repository: None,
            deprecated: false,
            processors: vec!["wifi-state".to_string()],
        });

        let event = startup_check(&ctx).await.unwrap();

        assert!(event.auto_applied.is_empty());
        assert_eq!(installed_version(&ctx, "wifi-state@official"), "1.0.0");
        assert!(sink.events_named("catalog-update").is_empty());

        let available = sink.events_named(UPDATES_AVAILABLE_EVENT);
        assert_eq!(available.len(), 1);
        assert_eq!(available[0].payload["updates"][0]["processorId"], serde_json::json!("wifi-state@official"));
        assert_eq!(available[0].payload["packUpdates"][0]["packId"], serde_json::json!("wifi-pack"));

        // The seed the frontend reads at construction (packsStore.ts).
        let seeded = pending_updates(&ctx).unwrap();
        assert_eq!(seeded.len(), 1);
        assert_eq!(seeded[0].processor_id, "wifi-state@official");
        let seeded_packs = pending_pack_updates(&ctx).unwrap();
        assert_eq!(seeded_packs.len(), 1);
        assert_eq!(seeded_packs[0].pack_id, "wifi-pack");
    }

    #[tokio::test]
    async fn startup_check_falls_back_to_pending_when_an_auto_apply_fails() {
        let market = marketplace_offering("2.0.0", vec![]);
        // The index still offers 2.0.0 but the processor file is gone.
        std::fs::remove_file(market.path().join("wifi-state.yaml")).unwrap();
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        ctx.state().sources.lock().unwrap().push(named_local_source("official", market.path(), true));
        install_current(&ctx);

        let event = startup_check(&ctx).await.unwrap();

        assert!(event.auto_applied.is_empty());
        assert_eq!(event.updates.len(), 1, "a failed auto-apply must still reach the user");
        assert_eq!(installed_version(&ctx, "wifi-state@official"), "1.0.0");
        assert!(sink.events_named("catalog-update").is_empty());
        assert_eq!(pending_updates(&ctx).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn startup_check_emits_nothing_when_everything_is_current() {
        let market = marketplace_offering("1.0.0", vec![]);
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        ctx.state().sources.lock().unwrap().push(named_local_source("official", market.path(), true));
        install_current(&ctx);

        let event = startup_check(&ctx).await.unwrap();

        assert!(event.updates.is_empty() && event.pack_updates.is_empty() && event.auto_applied.is_empty());
        assert!(sink.events_named(UPDATES_AVAILABLE_EVENT).is_empty());
        assert!(sink.events_named("catalog-update").is_empty());
        assert!(sources(&ctx).unwrap()[0].last_checked.is_some());
    }
}
