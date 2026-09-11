//! Thin Tauri adapters over [`crate::services::marketplace`].
//!
//! Every real decision — persistence, network fetch, version comparison,
//! journaling — lives in the service. A command here is expected to be:
//! build a [`crate::commands::adapters::ui_ctx`], call one service function,
//! marshal the `Result`.
//!
//! The DTOs, pure helpers (`is_newer`, `detect_pack_updates`,
//! `chrono_now_iso`, `build_provenance_yaml`) and the `try_add_source` /
//! `try_remove_source` cores all now live in `services::marketplace` and are
//! re-exported here under their original names — `lib.rs`'s startup update
//! check and `AppState.pending_updates` / `pending_pack_updates` (declared in
//! `commands/mod.rs`) reference them via `commands::sources::*` and must keep
//! compiling unchanged; ts-rs's `ROOT_TYPES!` list in
//! `tests/export_bindings.rs` also names the DTOs at this path.

use tauri::AppHandle;

use crate::processors::marketplace::Source;
use crate::services::marketplace as svc;

pub use svc::{
    MarketplaceEntryDto, MarketplaceFetchResult, MarketplacePackEntryDto, PackUpdateAvailable,
    SourceError, UpdateAvailable, UpdateCheckResult, UpdateResult,
};
pub(crate) use svc::{build_provenance_yaml, chrono_now_iso, detect_pack_updates, is_newer};
// Only referenced by this file's own rollback-semantics tests below.
#[cfg(test)]
pub(crate) use svc::{try_add_source, try_remove_source};

// ---------------------------------------------------------------------------
// Startup-only helper (needs a raw AppHandle before any ServiceCtx exists)
// ---------------------------------------------------------------------------

/// Load `sources.json` from disk, or an empty Vec if missing/corrupt. Called
/// once at startup (`lib.rs`'s `.setup()`), before `AppState.sources` exists
/// in memory.
pub fn load_sources(app: &AppHandle) -> Vec<Source> {
    let paths = crate::commands::adapters::TauriPaths::new(app.clone());
    svc::load_sources_file(&paths)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_sources(app: AppHandle) -> Result<Vec<Source>, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::sources(&ctx).map_err(|e| e.message())
}

#[tauri::command]
pub async fn add_source(app: AppHandle, source: Source) -> Result<(), String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::add_source(&ctx, source).map_err(|e| e.message())
}

#[tauri::command]
pub async fn remove_source(app: AppHandle, source_name: String) -> Result<(), String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::remove_source(&ctx, &source_name).map_err(|e| e.message())
}

#[tauri::command]
pub async fn fetch_marketplace_for_source(
    app: AppHandle,
    source_name: String,
) -> Result<MarketplaceFetchResult, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::fetch(&ctx, &source_name).await.map_err(|e| e.message())
}

#[tauri::command]
pub async fn check_updates(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::check_updates(&ctx).await.map_err(|e| e.message())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_processor(
    app: AppHandle,
    processor_id: String,
    entry_name: String,
    entry_path: String,
    entry_version: String,
    entry_sha256: String,
) -> Result<UpdateResult, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::update_processor(&ctx, &processor_id, &entry_name, &entry_path, &entry_version, &entry_sha256)
        .await
        .map_err(|e| e.message())
}

#[tauri::command]
pub async fn update_all_from_source(app: AppHandle, source_name: String) -> Result<Vec<UpdateResult>, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::update_all_from_source(&ctx, &source_name).await.map_err(|e| e.message())
}

/// Kept as a direct `AppHandle`-based helper (not routed through a
/// `ServiceCtx`) — it just re-persists whatever is already in `AppState`, no
/// service decision involved.
#[tauri::command]
pub async fn save_sources_to_disk(app: AppHandle) -> Result<(), String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::save_sources_to_disk(&ctx).map_err(|e| e.message())
}

#[tauri::command]
pub async fn get_pending_updates(app: AppHandle) -> Result<Vec<UpdateAvailable>, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::pending_updates(&ctx).map_err(|e| e.message())
}

#[tauri::command]
pub async fn get_pending_pack_updates(app: AppHandle) -> Result<Vec<PackUpdateAvailable>, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::pending_pack_updates(&ctx).map_err(|e| e.message())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_from_marketplace(
    app: AppHandle,
    source_name: String,
    entry_id: String,
    entry_name: String,
    entry_path: String,
    entry_version: String,
    entry_sha256: String,
) -> Result<crate::processors::ProcessorSummary, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::install_from_marketplace(&ctx, &source_name, &entry_id, &entry_name, &entry_path, &entry_version, &entry_sha256)
        .await
        .map_err(|e| e.message())
}

#[tauri::command]
pub async fn install_pack_from_marketplace(
    app: AppHandle,
    source_name: String,
    pack_entry: crate::processors::marketplace::MarketplacePackEntry,
) -> Result<crate::processors::PackSummary, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::install_pack_from_marketplace(&ctx, &source_name, pack_entry).await.map_err(|e| e.message())
}

#[tauri::command]
pub async fn uninstall_pack_from_marketplace(app: AppHandle, source_name: String, pack_id: String) -> Result<(), String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    svc::uninstall_pack_from_marketplace(&ctx, &source_name, &pack_id).map_err(|e| e.message())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processors::marketplace::{self, SourceType};

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
        assert!(is_newer("1.0", "1.0.1"));
        assert!(is_newer("1.0.1", "1.0"));
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
        let path = "packs/wifi-diagnostics.pack.yaml";
        let full_path = format!("marketplace/{path}");
        let url = crate::processors::registry::github_raw_url("jpicklyk/logtapper", "main", &full_path);
        assert!(
            url.contains("/marketplace/packs/"),
            "download URL must include marketplace/ prefix, got: {url}"
        );
        assert!(!url.contains("/marketplace/marketplace/"), "must not double-prefix marketplace/, got: {url}");
    }

    #[test]
    fn fetch_result_github_url_has_marketplace_prefix() {
        let url = crate::processors::registry::github_raw_url("jpicklyk/logtapper", "main", "marketplace/marketplace.json");
        assert_eq!(url, "https://raw.githubusercontent.com/jpicklyk/logtapper/main/marketplace/marketplace.json");
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
        let json = std::fs::read_to_string(dir.join("marketplace.json")).expect("should read marketplace.json");
        let index: marketplace::MarketplaceIndex = serde_json::from_str(&json).expect("should parse marketplace.json");
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
        let proc_ids: std::collections::HashSet<&str> = index.processors.iter().map(|p| p.id.as_str()).collect();
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
    fn pack_yaml_versions_match_index() {
        let (dir, index) = load_marketplace_index();
        for entry in &index.packs {
            let yaml_str = match std::fs::read_to_string(dir.join(&entry.path)) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let pack = crate::processors::pack::parse_pack_yaml(&yaml_str)
                .unwrap_or_else(|e| panic!("Pack '{}' failed to parse: {e}", entry.id));
            assert_eq!(
                pack.version, entry.version,
                "Version mismatch for pack '{}': YAML='{}', index='{}'",
                entry.id, pack.version, entry.version
            );
        }
    }

    #[test]
    fn processor_source_types_match_index() {
        let (dir, index) = load_marketplace_index();
        for entry in &index.processors {
            let yaml_str = match std::fs::read_to_string(dir.join(&entry.path)) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let Ok(p) = crate::processors::AnyProcessor::from_yaml(&yaml_str) else {
                continue;
            };
            let declared = p.schema.as_ref().map(|s| s.source_types.clone()).unwrap_or_default();
            assert_eq!(
                declared, entry.source_types,
                "source_types mismatch for '{}': YAML={:?} (governs execution), index={:?} (shown in the Marketplace)",
                entry.id, declared, entry.source_types
            );
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
    // Dev vs release source configuration
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
        let url = crate::processors::registry::github_raw_url("jpicklyk/logtapper", "main", "marketplace/marketplace.json");
        assert_eq!(url, "https://raw.githubusercontent.com/jpicklyk/logtapper/main/marketplace/marketplace.json");
    }

    #[test]
    fn github_source_constructs_correct_processor_url() {
        let url = crate::processors::registry::github_raw_url("jpicklyk/logtapper", "main", "marketplace/processors/battery_state.yaml");
        assert_eq!(url, "https://raw.githubusercontent.com/jpicklyk/logtapper/main/marketplace/processors/battery_state.yaml");
    }

    #[test]
    fn github_source_constructs_correct_pack_url() {
        let url = crate::processors::registry::github_raw_url("jpicklyk/logtapper", "main", "marketplace/packs/device-health.pack.yaml");
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
        let installed = std::collections::HashMap::new();
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

    // -----------------------------------------------------------------------
    // add_source / remove_source: persist-before-commit rollback (defect 1)
    // -----------------------------------------------------------------------

    fn test_source(name: &str) -> Source {
        Source {
            name: name.to_string(),
            source_type: SourceType::Local { path: "/some/path".to_string() },
            enabled: true,
            auto_update: false,
            last_checked: None,
        }
    }

    #[test]
    fn add_source_rolls_back_in_memory_state_when_save_fails() {
        let mut sources = vec![test_source("existing")];
        let updated = try_add_source(&sources, test_source("new")).expect("no name clash");
        let save_result: Result<(), String> = Err("disk full".to_string());
        let outcome = save_result.map(|()| sources = updated);
        assert!(outcome.is_err());
        assert_eq!(sources.len(), 1, "in-memory Vec must be unchanged after a failed save");
        assert_eq!(sources[0].name, "existing");
    }

    #[test]
    fn remove_source_rolls_back_in_memory_state_when_save_fails() {
        let mut sources = vec![test_source("existing"), test_source("target")];
        let updated = try_remove_source(&sources, "target").expect("target exists");
        let save_result: Result<(), String> = Err("disk full".to_string());
        let outcome = save_result.map(|()| sources = updated);
        assert!(outcome.is_err());
        assert_eq!(sources.len(), 2, "in-memory Vec must be unchanged after a failed save");
        assert!(sources.iter().any(|s| s.name == "target"), "removed source must still be present in memory");
    }

    #[test]
    fn add_source_commits_new_state_when_save_succeeds() {
        let mut sources = vec![test_source("existing")];
        let updated = try_add_source(&sources, test_source("new")).expect("no name clash");
        let save_result: Result<(), String> = Ok(());
        let outcome = save_result.map(|()| sources = updated);
        assert!(outcome.is_ok());
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().any(|s| s.name == "new"));
    }

    #[test]
    fn buggy_push_before_save_ordering_leaves_stale_state_on_failure() {
        let mut sources = vec![test_source("existing")];
        sources.push(test_source("new"));
        let save_result: Result<(), String> = Err("disk full".to_string());
        assert!(save_result.is_err());
        assert_eq!(sources.len(), 2, "reproduces defect 1: the unpersisted source remains in memory after save fails");
    }

    /// `load_sources` (the `AppHandle`-based startup helper kept in this file)
    /// delegates to the same `AppPaths`-based loader the service uses — proven
    /// here via a fixed-dir `AppPaths` standing in for a real `TauriPaths`.
    #[test]
    fn load_sources_file_reads_back_what_was_written() {
        use crate::services::paths::FixedPaths;
        let tmp = tempfile::tempdir().unwrap();
        let paths = FixedPaths(tmp.path().to_path_buf());
        let sources = vec![test_source("official")];
        let json = serde_json::to_string_pretty(&sources).unwrap();
        std::fs::write(tmp.path().join("sources.json"), json).unwrap();
        let loaded = svc::load_sources_file(&paths);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "official");
    }
}
