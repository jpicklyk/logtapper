use serde::{Deserialize, Serialize};
use std::path::Path;

/// Metadata for a processor pack — deserialized from a `*.pack.yaml` file.
/// The `id` field is derived from the filename, not stored in YAML.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackMeta {
    #[serde(skip)]
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default)]
    pub deprecated: bool,
    /// Processor IDs that belong to this pack.
    pub processors: Vec<String>,
}

/// IPC-serializable summary of a pack (returned by list_packs and related commands).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub tags: Vec<String>,
    pub category: Option<String>,
    pub license: Option<String>,
    pub repository: Option<String>,
    pub deprecated: bool,
    pub processor_ids: Vec<String>,
}

impl From<&PackMeta> for PackSummary {
    fn from(p: &PackMeta) -> Self {
        PackSummary {
            id: p.id.clone(),
            name: p.name.clone(),
            version: p.version.clone(),
            description: p.description.clone(),
            tags: p.tags.clone(),
            category: p.category.clone(),
            license: p.license.clone(),
            repository: p.repository.clone(),
            deprecated: p.deprecated,
            processor_ids: p.processors.clone(),
        }
    }
}

/// Derive a pack ID from its filename by stripping the `.pack.yaml` extension.
pub fn pack_id_from_path(path: &Path) -> Option<String> {
    let filename = path.file_name()?.to_str()?;
    filename.strip_suffix(".pack.yaml").map(ToString::to_string)
}

/// Read all `*.pack.yaml` files from `dir` and return parsed `PackMeta` entries.
/// Files that fail to parse are skipped with a warning to stderr.
pub fn load_packs_from_dir(dir: &Path) -> Vec<PackMeta> {
    let mut packs = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return packs };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = pack_id_from_path(&path) else { continue };
        let Ok(yaml) = std::fs::read_to_string(&path) else {
            eprintln!("Failed to read pack file: {:?}", path.file_name());
            continue;
        };
        match parse_pack_yaml(&yaml) {
            Ok(mut meta) => {
                meta.id = id;
                packs.push(meta);
            }
            Err(e) => eprintln!("Skipping pack {:?}: {e}", path.file_name()),
        }
    }
    packs
}

/// Parse a pack YAML string into `PackMeta` (id is left empty — callers must set it).
pub fn parse_pack_yaml(yaml: &str) -> Result<PackMeta, String> {
    // Strip UTF-8 BOM if present (common Windows file artifact)
    let yaml = yaml.trim_start_matches('\u{FEFF}');
    serde_yaml::from_str(yaml).map_err(|e| format!("Pack YAML parse error: {e}"))
}

/// Validate a `PackMeta`.  Returns `Ok(())` if valid, or an error string.
pub fn validate_pack(pack: &PackMeta) -> Result<(), String> {
    if pack.name.trim().is_empty() {
        return Err("Pack must have a non-empty 'name' field".to_string());
    }
    if pack.processors.is_empty() {
        return Err("Pack must list at least one processor ID in 'processors'".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_YAML: &str = r#"
name: Test Pack
version: "1.0.0"
author: Tester
description: A test pack
tags: [android, wifi]
processors:
  - wifi_state
  - network_connectivity
"#;

    #[test]
    fn parse_valid_pack() {
        let mut meta = parse_pack_yaml(VALID_YAML).expect("should parse");
        meta.id = "test_pack".to_string();
        assert_eq!(meta.name, "Test Pack");
        assert_eq!(meta.processors.len(), 2);
        assert_eq!(meta.id, "test_pack");
    }

    #[test]
    fn validate_rejects_empty_name() {
        let pack = PackMeta {
            id: "x".to_string(),
            name: "  ".to_string(),
            version: "1.0.0".to_string(),
            author: String::new(),
            description: String::new(),
            tags: vec![],
            category: None,
            license: None,
            repository: None,
            deprecated: false,
            processors: vec!["some_proc".to_string()],
        };
        assert!(validate_pack(&pack).is_err());
    }

    #[test]
    fn validate_rejects_empty_processors() {
        let pack = PackMeta {
            id: "x".to_string(),
            name: "My Pack".to_string(),
            version: "1.0.0".to_string(),
            author: String::new(),
            description: String::new(),
            tags: vec![],
            category: None,
            license: None,
            repository: None,
            deprecated: false,
            processors: vec![],
        };
        assert!(validate_pack(&pack).is_err());
    }

    #[test]
    fn validate_accepts_valid_pack() {
        let mut meta = parse_pack_yaml(VALID_YAML).unwrap();
        meta.id = "test_pack".to_string();
        assert!(validate_pack(&meta).is_ok());
    }

    #[test]
    fn pack_id_from_path_strips_extension() {
        let path = std::path::Path::new("/some/dir/android_wifi.pack.yaml");
        assert_eq!(pack_id_from_path(path), Some("android_wifi".to_string()));
    }

    #[test]
    fn pack_id_from_path_rejects_plain_yaml() {
        let path = std::path::Path::new("/some/dir/processor.yaml");
        assert_eq!(pack_id_from_path(path), None);
    }

    #[test]
    fn load_packs_from_dir_reads_pack_yamls() {
        use std::io::Write;
        let dir = std::env::temp_dir().join("logtapper_test_packs");
        let _ = std::fs::create_dir_all(&dir);

        // Write a valid pack file
        let mut f = std::fs::File::create(dir.join("test-pack.pack.yaml")).unwrap();
        write!(f, "{}", VALID_YAML).unwrap();

        // Write a non-pack YAML (should be ignored)
        let mut f2 = std::fs::File::create(dir.join("not-a-pack.yaml")).unwrap();
        write!(f2, "name: Not A Pack").unwrap();

        let packs = load_packs_from_dir(&dir);
        assert_eq!(packs.len(), 1);
        assert_eq!(packs[0].id, "test-pack");
        assert_eq!(packs[0].name, "Test Pack");

        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_all_marketplace_pack_yamls() {
        let pack_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("marketplace/packs");
        if !pack_dir.exists() {
            return; // Skip if not in project root
        }
        let packs = load_packs_from_dir(&pack_dir);
        assert!(packs.len() > 0, "should find pack YAMLs in marketplace/packs/");
        for pack in &packs {
            assert!(!pack.name.is_empty(), "pack '{}' has empty name", pack.id);
            assert!(!pack.processors.is_empty(), "pack '{}' has no processors", pack.id);
        }
    }

    #[test]
    fn summary_from_meta_roundtrip() {
        let mut meta = parse_pack_yaml(VALID_YAML).unwrap();
        meta.id = "test_pack".to_string();
        let summary = PackSummary::from(&meta);
        assert_eq!(summary.id, "test_pack");
        assert_eq!(summary.processor_ids, vec!["wifi_state", "network_connectivity"]);
        assert_eq!(summary.name, "Test Pack");
    }
}
