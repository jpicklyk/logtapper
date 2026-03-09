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
fn github_raw_url(repo: &str, git_ref: &str, path: &str) -> String {
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
            let url = github_raw_url(repo, git_ref, "marketplace.json");
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
            let url = github_raw_url(repo, git_ref, &entry.path);
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
