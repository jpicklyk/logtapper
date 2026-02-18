use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Registry index types (mirrors the GitHub JSON)
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
// Registry operations
// ---------------------------------------------------------------------------

/// Fetch the registry index from GitHub (or a custom URL).
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
fn verify_sha256(content: &str, expected_hex: &str) -> Result<(), String> {
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
