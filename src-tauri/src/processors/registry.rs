use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::processors::marketplace::{MarketplaceEntry, MarketplaceIndex, Source, SourceType};

// ---------------------------------------------------------------------------
// Legacy v1 registry types (kept for backward compatibility)
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/logtapper/android-log-processors/main/registry.json";

const PROCESSOR_BASE_URL: &str =
    "https://raw.githubusercontent.com/logtapper/android-log-processors/main/";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryIndex {
    pub version: u32,
    pub processors: Vec<RegistryEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub path: String,
    pub tags: Vec<String>,
    pub sha256: String,
}

// ---------------------------------------------------------------------------
// V1 format detection helper — parses marketplace.json supporting both v1 and v2
// ---------------------------------------------------------------------------

/// Intermediate struct for detecting the registry format version.
#[derive(Debug, Deserialize)]
struct VersionProbe {
    #[serde(default)]
    version: u32,
}

/// Convert a v1 `RegistryEntry` to a `MarketplaceEntry`.
impl From<RegistryEntry> for MarketplaceEntry {
    fn from(e: RegistryEntry) -> Self {
        Self {
            id: e.id,
            name: e.name,
            version: e.version,
            description: e.description,
            path: e.path,
            tags: e.tags,
            sha256: e.sha256,
            category: None,
            license: None,
            processor_type: None,
            source_types: Vec::new(),
            deprecated: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Multi-source marketplace operations
// ---------------------------------------------------------------------------

/// Build the raw content URL for a GitHub source.
pub fn github_raw_url(repo: &str, git_ref: &str, path: &str) -> String {
    format!(
        "https://raw.githubusercontent.com/{repo}/{git_ref}/{path}"
    )
}

/// Fetch the marketplace index from a source.
/// Handles both v1 (RegistryIndex) and v2 (MarketplaceIndex) JSON formats.
pub async fn fetch_marketplace(
    client: &Client,
    source: &Source,
) -> Result<MarketplaceIndex, String> {
    match &source.source_type {
        SourceType::Github { repo, git_ref } => {
            let url = github_raw_url(repo, git_ref, "marketplace/marketplace.json");
            fetch_marketplace_from_url(client, &url).await
        }
        SourceType::Local { path } => {
            let index_path = std::path::Path::new(path).join("marketplace.json");
            let json = std::fs::read_to_string(&index_path)
                .map_err(|e| format!("Failed to read local marketplace at '{}': {e}", index_path.display()))?;
            parse_marketplace_json(&json, &source.name)
        }
    }
}

async fn fetch_marketplace_from_url(
    client: &Client,
    url: &str,
) -> Result<MarketplaceIndex, String> {
    let response = client
        .get(url)
        .header("User-Agent", "LogTapper/1.0")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch marketplace: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("Marketplace fetch returned HTTP {status}"));
    }

    let json = response
        .text()
        .await
        .map_err(|e| format!("Failed to read marketplace response: {e}"))?;

    parse_marketplace_json(&json, "remote")
}

/// Parse a marketplace JSON string, detecting v1 vs v2 format.
pub fn parse_marketplace_json(json: &str, source_name: &str) -> Result<MarketplaceIndex, String> {
    let probe: VersionProbe = serde_json::from_str(json)
        .map_err(|e| format!("Failed to detect marketplace format: {e}"))?;

    if probe.version <= 1 {
        // v1 format — parse as RegistryIndex and convert
        let v1: RegistryIndex = serde_json::from_str(json)
            .map_err(|e| format!("Failed to parse v1 registry JSON: {e}"))?;
        Ok(MarketplaceIndex {
            name: source_name.to_string(),
            version: 1,
            owner: None,
            processors: v1.processors.into_iter().map(MarketplaceEntry::from).collect(),
            packs: Vec::new(),
        })
    } else {
        // v2 format
        serde_json::from_str(json).map_err(|e| format!("Failed to parse marketplace JSON: {e}"))
    }
}

/// Download a processor YAML from a source using the entry's path.
pub async fn download_processor_from_source(
    client: &Client,
    source: &Source,
    entry: &MarketplaceEntry,
) -> Result<String, String> {
    match &source.source_type {
        SourceType::Github { repo, git_ref } => {
            let full_path = format!("marketplace/{}", entry.path);
            let url = github_raw_url(repo, git_ref, &full_path);
            let response = client
                .get(&url)
                .header("User-Agent", "LogTapper/1.0")
                .send()
                .await
                .map_err(|e| format!("Failed to download processor '{}': {e}", entry.id))?;

            if !response.status().is_success() {
                let status = response.status();
                return Err(format!(
                    "Download of '{}' returned HTTP {status}",
                    entry.id
                ));
            }

            let yaml = response
                .text()
                .await
                .map_err(|e| format!("Failed to read processor YAML: {e}"))?;

            verify_sha256(&yaml, &entry.sha256)
                .map_err(|e| format!("Integrity check failed for '{}': {e}", entry.id))?;

            Ok(yaml)
        }
        SourceType::Local { path } => {
            let full_path = std::path::Path::new(path).join(&entry.path);
            let yaml = std::fs::read_to_string(&full_path).map_err(|e| {
                format!(
                    "Failed to read local processor '{}' at '{}': {e}",
                    entry.id,
                    full_path.display()
                )
            })?;

            verify_sha256(&yaml, &entry.sha256)
                .map_err(|e| format!("Integrity check failed for '{}': {e}", entry.id))?;

            Ok(yaml)
        }
    }
}

// ---------------------------------------------------------------------------
// Legacy API (kept for backward compatibility with existing commands)
// ---------------------------------------------------------------------------

/// Fetch the registry index from GitHub (or a custom URL).
/// Kept for backward compatibility — wraps the new multi-source fetch.
pub async fn fetch_registry(
    client: &Client,
    registry_url: Option<&str>,
) -> Result<RegistryIndex, String> {
    let url = registry_url.unwrap_or(DEFAULT_REGISTRY_URL);

    let response = client
        .get(url)
        .header("User-Agent", "LogTapper/1.0")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch registry: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("Registry fetch returned HTTP {status}"));
    }

    let index: RegistryIndex = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse registry JSON: {e}"))?;

    Ok(index)
}

/// Download a processor YAML and verify its SHA-256 checksum.
/// Kept for backward compatibility.
pub async fn download_processor(
    client: &Client,
    entry: &RegistryEntry,
    base_url: Option<&str>,
) -> Result<String, String> {
    let base = base_url.unwrap_or(PROCESSOR_BASE_URL);
    let url = format!("{base}{}", entry.path);

    let response = client
        .get(&url)
        .header("User-Agent", "LogTapper/1.0")
        .send()
        .await
        .map_err(|e| format!("Failed to download processor '{}': {e}", entry.id))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "Download of '{}' returned HTTP {status}",
            entry.id
        ));
    }

    let yaml = response
        .text()
        .await
        .map_err(|e| format!("Failed to read processor YAML: {e}"))?;

    verify_sha256(&yaml, &entry.sha256)
        .map_err(|e| format!("Integrity check failed for '{}': {e}", entry.id))?;

    Ok(yaml)
}

/// Verify that the SHA-256 of `content` matches `expected_hex`.
pub fn verify_sha256(content: &str, expected_hex: &str) -> Result<(), String> {
    if expected_hex.is_empty() {
        // No checksum provided — allow (useful during development)
        return Ok(());
    }

    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    let actual_hex = hex::encode(digest);

    if actual_hex.eq_ignore_ascii_case(expected_hex) {
        Ok(())
    } else {
        Err(format!(
            "SHA-256 mismatch: expected {expected_hex}, got {actual_hex}"
        ))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_raw_url_format() {
        let url = github_raw_url("jpicklyk/logtapper", "main", "some/file.json");
        assert_eq!(
            url,
            "https://raw.githubusercontent.com/jpicklyk/logtapper/main/some/file.json"
        );
    }

    // ── GitHub marketplace URL must include marketplace/ prefix ──────────

    #[test]
    fn marketplace_index_github_url_has_marketplace_prefix() {
        // Simulates what fetch_marketplace does for a GitHub source.
        // The URL must point to marketplace/marketplace.json, not just marketplace.json.
        let repo = "jpicklyk/logtapper";
        let git_ref = "main";
        let url = github_raw_url(repo, git_ref, "marketplace/marketplace.json");
        assert!(
            url.contains("/marketplace/marketplace.json"),
            "marketplace index URL must include marketplace/ prefix, got: {url}"
        );
        assert_eq!(
            url,
            "https://raw.githubusercontent.com/jpicklyk/logtapper/main/marketplace/marketplace.json"
        );
    }

    #[test]
    fn processor_download_github_url_has_marketplace_prefix() {
        // Simulates what download_processor_from_source does for a GitHub source.
        // entry.path is "processors/wifi_state.yaml" — URL must be marketplace/processors/...
        let repo = "jpicklyk/logtapper";
        let git_ref = "main";
        let entry_path = "processors/wifi_state.yaml";
        let full_path = format!("marketplace/{}", entry_path);
        let url = github_raw_url(repo, git_ref, &full_path);
        assert!(
            url.contains("/marketplace/processors/"),
            "processor download URL must include marketplace/ prefix, got: {url}"
        );
        assert_eq!(
            url,
            "https://raw.githubusercontent.com/jpicklyk/logtapper/main/marketplace/processors/wifi_state.yaml"
        );
    }

    #[test]
    fn pack_download_github_url_has_marketplace_prefix() {
        // Simulates what download_text_from_source does for pack YAML downloads.
        // entry.path is "packs/wifi-diagnostics.pack.yaml" — URL must be marketplace/packs/...
        let repo = "jpicklyk/logtapper";
        let git_ref = "main";
        let entry_path = "packs/wifi-diagnostics.pack.yaml";
        let full_path = format!("marketplace/{}", entry_path);
        let url = github_raw_url(repo, git_ref, &full_path);
        assert!(
            url.contains("/marketplace/packs/"),
            "pack download URL must include marketplace/ prefix, got: {url}"
        );
    }

    // ── Verify actual repo file structure matches expected paths ─────────

    #[test]
    fn marketplace_json_exists_at_expected_path() {
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let path = project_root.join("marketplace/marketplace.json");
        assert!(
            path.exists(),
            "marketplace/marketplace.json must exist at repo root: {}",
            path.display()
        );
    }

    #[test]
    fn all_marketplace_processor_files_exist() {
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let json_path = project_root.join("marketplace/marketplace.json");
        let json = std::fs::read_to_string(&json_path).expect("read marketplace.json");
        let index: MarketplaceIndex = serde_json::from_str(&json).expect("parse marketplace.json");

        for entry in &index.processors {
            // entry.path is relative to the marketplace/ dir (e.g. "processors/wifi_state.yaml")
            let file_path = project_root.join("marketplace").join(&entry.path);
            assert!(
                file_path.exists(),
                "processor '{}' references path '{}' but file does not exist at: {}",
                entry.id,
                entry.path,
                file_path.display()
            );
        }
    }

    #[test]
    fn all_marketplace_pack_files_exist() {
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let json_path = project_root.join("marketplace/marketplace.json");
        let json = std::fs::read_to_string(&json_path).expect("read marketplace.json");
        let index: MarketplaceIndex = serde_json::from_str(&json).expect("parse marketplace.json");

        for pack in &index.packs {
            let file_path = project_root.join("marketplace").join(&pack.path);
            assert!(
                file_path.exists(),
                "pack '{}' references path '{}' but file does not exist at: {}",
                pack.id,
                pack.path,
                file_path.display()
            );
        }
    }

    // ── Dev vs release source configuration ─────────────────────────────

    #[test]
    fn dev_build_marketplace_dir_exists() {
        // In dev builds, the official source points to the project's marketplace/ directory.
        // This test verifies that directory exists relative to CARGO_MANIFEST_DIR.
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let marketplace_dir = project_root.join("marketplace");
        assert!(
            marketplace_dir.is_dir(),
            "marketplace/ directory must exist at project root for dev builds: {}",
            marketplace_dir.display()
        );
    }

    #[test]
    fn release_build_github_source_is_valid() {
        // Verify the hardcoded GitHub repo and ref used in release builds.
        let repo = "jpicklyk/logtapper";
        let git_ref = "main";

        // The URL must be well-formed
        let url = github_raw_url(repo, git_ref, "marketplace/marketplace.json");
        assert!(url.starts_with("https://raw.githubusercontent.com/"));
        assert!(url.contains("jpicklyk/logtapper"));
        assert!(url.ends_with("marketplace/marketplace.json"));
    }

    #[test]
    fn local_source_does_not_double_prefix_marketplace() {
        // Local sources join the base path with the entry path directly.
        // The base path is already the marketplace/ directory, so entry.path
        // ("processors/wifi_state.yaml") should NOT get another marketplace/ prefix.
        let base = if cfg!(windows) { "C:\\some\\path\\to\\marketplace" } else { "/some/path/to/marketplace" };
        let entry_path = "processors/wifi_state.yaml";
        let full = std::path::Path::new(base).join(entry_path);
        let full_str = full.to_string_lossy();
        // Must not double-prefix (using OS-agnostic check)
        assert!(
            !full_str.contains("marketplace/marketplace") && !full_str.contains("marketplace\\marketplace"),
            "local path must not double-prefix marketplace: {}",
            full_str
        );
        // Must end with the processor path
        assert!(
            full_str.ends_with("wifi_state.yaml"),
            "local path must end with processor filename: {}",
            full_str
        );
    }

    #[test]
    fn verify_sha256_accepts_empty() {
        // Empty expected hash skips verification (dev mode)
        assert!(verify_sha256("some content", "").is_ok());
    }

    #[test]
    fn verify_sha256_rejects_mismatch() {
        assert!(verify_sha256("some content", "0000dead").is_err());
    }

    // ── Malformed / edge-case marketplace JSON ──────────────────────────

    #[test]
    fn parse_marketplace_rejects_invalid_json() {
        let result = parse_marketplace_json("not json at all", "test");
        assert!(result.is_err());
    }

    #[test]
    fn parse_marketplace_rejects_empty_json() {
        let result = parse_marketplace_json("{}", "test");
        // Missing required "processors" field
        assert!(result.is_err());
    }

    #[test]
    fn parse_marketplace_handles_empty_processors_array() {
        let json = r#"{"name": "test", "version": 2, "processors": []}"#;
        let index = parse_marketplace_json(json, "test").expect("should parse");
        assert!(index.processors.is_empty());
        assert!(index.packs.is_empty());
    }

    #[test]
    fn parse_marketplace_handles_empty_packs_array() {
        let json = r#"{"name": "test", "version": 2, "processors": [], "packs": []}"#;
        let index = parse_marketplace_json(json, "test").expect("should parse");
        assert!(index.packs.is_empty());
    }

    // ── v1 → v2 format migration ────────────────────────────────────────

    #[test]
    fn parse_marketplace_v1_format_converts_to_v2() {
        let json = r#"{
            "version": 1,
            "processors": [
                {"id": "test-proc", "name": "Test", "version": "1.0.0",
                 "description": "A test", "path": "test.yaml",
                 "tags": ["test"], "sha256": "abc123"}
            ]
        }"#;
        let index = parse_marketplace_json(json, "my-source").expect("should parse v1");
        assert_eq!(index.version, 1);
        assert_eq!(index.processors.len(), 1);
        assert_eq!(index.processors[0].id, "test-proc");
        // v1 has no packs
        assert!(index.packs.is_empty());
        // Source name propagated
        assert_eq!(index.name, "my-source");
    }

    #[test]
    fn parse_marketplace_v0_treated_as_v1() {
        // version: 0 or missing should be treated as v1
        let json = r#"{
            "version": 0,
            "processors": [
                {"id": "x", "name": "X", "version": "1.0.0",
                 "path": "x.yaml", "tags": [], "sha256": ""}
            ]
        }"#;
        let index = parse_marketplace_json(json, "test").expect("should parse as v1");
        assert_eq!(index.processors.len(), 1);
    }

    // ── Duplicate IDs ────────────────────────────────────────────────────

    #[test]
    fn bundled_marketplace_has_no_duplicate_processor_ids() {
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let json = std::fs::read_to_string(project_root.join("marketplace/marketplace.json")).unwrap();
        let index: MarketplaceIndex = serde_json::from_str(&json).unwrap();

        let mut seen = std::collections::HashSet::new();
        for proc in &index.processors {
            assert!(
                seen.insert(&proc.id),
                "duplicate processor ID in marketplace.json: '{}'",
                proc.id
            );
        }
    }

    #[test]
    fn bundled_marketplace_has_no_duplicate_pack_ids() {
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let json = std::fs::read_to_string(project_root.join("marketplace/marketplace.json")).unwrap();
        let index: MarketplaceIndex = serde_json::from_str(&json).unwrap();

        let mut seen = std::collections::HashSet::new();
        for pack in &index.packs {
            assert!(
                seen.insert(&pack.id),
                "duplicate pack ID in marketplace.json: '{}'",
                pack.id
            );
        }
    }

    // ── Path traversal safety ────────────────────────────────────────────

    #[test]
    fn processor_paths_do_not_escape_marketplace_dir() {
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let json = std::fs::read_to_string(project_root.join("marketplace/marketplace.json")).unwrap();
        let index: MarketplaceIndex = serde_json::from_str(&json).unwrap();

        for entry in &index.processors {
            assert!(
                !entry.path.contains(".."),
                "processor '{}' path must not contain '..': '{}'",
                entry.id, entry.path
            );
            assert!(
                !entry.path.starts_with('/') && !entry.path.starts_with('\\'),
                "processor '{}' path must be relative: '{}'",
                entry.id, entry.path
            );
        }
        for pack in &index.packs {
            assert!(
                !pack.path.contains(".."),
                "pack '{}' path must not contain '..': '{}'",
                pack.id, pack.path
            );
            assert!(
                !pack.path.starts_with('/') && !pack.path.starts_with('\\'),
                "pack '{}' path must be relative: '{}'",
                pack.id, pack.path
            );
        }
    }

    // ── Pack forward compatibility ───────────────────────────────────────

    #[test]
    fn pack_yaml_ignores_unknown_fields() {
        use crate::processors::pack::parse_pack_yaml;
        let yaml = r#"
name: Future Pack
version: 2.0.0
description: Has extra fields
processors:
  - some-proc
future_field: this should be ignored
another_new_thing:
  nested: value
"#;
        let result = parse_pack_yaml(yaml);
        assert!(result.is_ok(), "unknown fields should be silently ignored: {:?}", result.err());
        let meta = result.unwrap();
        assert_eq!(meta.name, "Future Pack");
        assert_eq!(meta.processors, vec!["some-proc"]);
    }

    // ── Corrupted YAML on disk ───────────────────────────────────────────

    #[test]
    fn corrupted_pack_yaml_returns_error() {
        use crate::processors::pack::parse_pack_yaml;
        let bad_yaml = "{{{{ not yaml at all ::::";
        assert!(parse_pack_yaml(bad_yaml).is_err());
    }

    #[test]
    fn load_packs_from_dir_skips_corrupt_files() {
        use crate::processors::pack::load_packs_from_dir;
        let dir = std::env::temp_dir().join("logtapper_test_corrupt_packs");
        let _ = std::fs::create_dir_all(&dir);

        // Write a valid pack
        std::fs::write(dir.join("good.pack.yaml"), "name: Good\nversion: 1.0.0\nprocessors:\n  - a\n").unwrap();
        // Write a corrupted pack
        std::fs::write(dir.join("bad.pack.yaml"), "{{{{ not yaml").unwrap();
        // Write a non-pack file (should be ignored)
        std::fs::write(dir.join("readme.txt"), "not a pack").unwrap();

        let packs = load_packs_from_dir(&dir);
        // Should load the good one and skip the bad one
        assert_eq!(packs.len(), 1);
        assert_eq!(packs[0].name, "Good");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── All bundled processor YAMLs actually parse ──────────────────────

    #[test]
    fn all_marketplace_processor_yamls_parse_successfully() {
        use crate::processors::AnyProcessor;
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let json = std::fs::read_to_string(project_root.join("marketplace/marketplace.json")).unwrap();
        let index: MarketplaceIndex = serde_json::from_str(&json).unwrap();

        for entry in &index.processors {
            let yaml_path = project_root.join("marketplace").join(&entry.path);
            let yaml = std::fs::read_to_string(&yaml_path)
                .unwrap_or_else(|e| panic!("read '{}': {e}", yaml_path.display()));
            let result = AnyProcessor::from_yaml(&yaml);
            assert!(
                result.is_ok(),
                "processor '{}' at '{}' failed to parse: {:?}",
                entry.id, entry.path, result.err()
            );
        }
    }
}
