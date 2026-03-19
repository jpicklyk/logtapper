use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::core::analysis::AnalysisArtifact;
use crate::core::bookmark::Bookmark;

pub const LTS_FORMAT_VERSION: u32 = 1;

/// Manifest stored as `manifest.json` inside the `.lts` zip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtsManifest {
    pub format_version: u32,
    pub source_filename: String,
    pub source_size: u64,
    /// Milliseconds since UNIX epoch.
    pub saved_at: i64,
}

/// Session-level metadata stored as `artifacts/session-meta.json` inside the `.lts` zip.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtsSessionMeta {
    pub active_processor_ids: Vec<String>,
    pub disabled_processor_ids: Vec<String>,
}

/// One entry in the processor manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtsProcessorEntry {
    pub id: String,
    pub filename: String,
    pub sha256: String,
}

/// Processor manifest stored as `processors/processor-manifest.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtsProcessorManifest {
    pub processors: Vec<LtsProcessorEntry>,
}

/// In-memory representation of a loaded `.lts` file.
pub struct LtsData {
    pub manifest: LtsManifest,
    pub source_bytes: Vec<u8>,
    pub source_filename: String,
    pub bookmarks: Vec<Bookmark>,
    pub analyses: Vec<AnalysisArtifact>,
    pub session_meta: LtsSessionMeta,
    pub processor_manifest: LtsProcessorManifest,
    pub processor_yamls: HashMap<String, String>,
}

/// Write a `.lts` zip file to `dest`.
///
/// # Arguments
/// * `dest` — output path for the zip file
/// * `source_filename` — original filename of the log source (no path, just the name)
/// * `source_bytes` — raw bytes of the log source; stored uncompressed (`Stored`)
/// * `bookmarks` — session bookmarks
/// * `analyses` — session analysis artifacts
/// * `meta` — session-level metadata (active/disabled processor IDs)
/// * `processor_yamls` — `(id, filename, yaml_content)` tuples for each processor to embed
pub fn write_lts(
    dest: &Path,
    source_filename: &str,
    source_bytes: &[u8],
    bookmarks: &[Bookmark],
    analyses: &[AnalysisArtifact],
    meta: &LtsSessionMeta,
    processor_yamls: &[(String, String, String)],
) -> Result<(), String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let manifest = LtsManifest {
        format_version: LTS_FORMAT_VERSION,
        source_filename: source_filename.to_string(),
        source_size: source_bytes.len() as u64,
        saved_at: now_ms,
    };

    let out_file = File::create(dest)
        .map_err(|e| format!("Failed to create .lts file '{}': {e}", dest.display()))?;
    let mut writer = zip::ZipWriter::new(out_file);

    let deflate_opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let stored_opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    // 1. manifest.json (Deflated)
    writer
        .start_file("manifest.json", deflate_opts)
        .map_err(|e| format!("Failed to start manifest.json entry: {e}"))?;
    serde_json::to_writer(&mut writer, &manifest)
        .map_err(|e| format!("Failed to write manifest.json: {e}"))?;

    // 2. source/<source_filename> (Stored — no compression for large files)
    let source_entry = format!("source/{source_filename}");
    writer
        .start_file(&source_entry, stored_opts)
        .map_err(|e| format!("Failed to start source entry '{source_entry}': {e}"))?;
    std::io::Write::write_all(&mut writer, source_bytes)
        .map_err(|e| format!("Failed to write source bytes: {e}"))?;

    // 3. artifacts/bookmarks.json (Deflated)
    writer
        .start_file("artifacts/bookmarks.json", deflate_opts)
        .map_err(|e| format!("Failed to start artifacts/bookmarks.json entry: {e}"))?;
    serde_json::to_writer(&mut writer, bookmarks)
        .map_err(|e| format!("Failed to write artifacts/bookmarks.json: {e}"))?;

    // 4. artifacts/analyses.json (Deflated)
    writer
        .start_file("artifacts/analyses.json", deflate_opts)
        .map_err(|e| format!("Failed to start artifacts/analyses.json entry: {e}"))?;
    serde_json::to_writer(&mut writer, analyses)
        .map_err(|e| format!("Failed to write artifacts/analyses.json: {e}"))?;

    // 5. artifacts/session-meta.json (Deflated)
    writer
        .start_file("artifacts/session-meta.json", deflate_opts)
        .map_err(|e| format!("Failed to start artifacts/session-meta.json entry: {e}"))?;
    serde_json::to_writer(&mut writer, meta)
        .map_err(|e| format!("Failed to write artifacts/session-meta.json: {e}"))?;

    // 6. processors/<filename>.yaml + build processor manifest (Deflated)
    let mut proc_manifest = LtsProcessorManifest {
        processors: Vec::with_capacity(processor_yamls.len()),
    };

    for (id, filename, yaml_content) in processor_yamls {
        // Compute SHA-256 of the YAML content.
        let mut hasher = Sha256::new();
        hasher.update(yaml_content.as_bytes());
        let hash = hex::encode(hasher.finalize());

        proc_manifest.processors.push(LtsProcessorEntry {
            id: id.clone(),
            filename: filename.clone(),
            sha256: hash,
        });

        let yaml_entry = format!("processors/{filename}");
        writer
            .start_file(&yaml_entry, deflate_opts)
            .map_err(|e| format!("Failed to start processor entry '{yaml_entry}': {e}"))?;
        std::io::Write::write_all(&mut writer, yaml_content.as_bytes())
            .map_err(|e| format!("Failed to write processor YAML '{yaml_entry}': {e}"))?;
    }

    // 7. processors/processor-manifest.json (Deflated)
    writer
        .start_file("processors/processor-manifest.json", deflate_opts)
        .map_err(|e| {
            format!("Failed to start processors/processor-manifest.json entry: {e}")
        })?;
    serde_json::to_writer(&mut writer, &proc_manifest)
        .map_err(|e| format!("Failed to write processors/processor-manifest.json: {e}"))?;

    writer
        .finish()
        .map_err(|e| format!("Failed to finalise .lts zip: {e}"))?;

    Ok(())
}

/// Read a `.lts` zip file from `path` and return all embedded data.
pub fn read_lts(path: &Path) -> Result<LtsData, String> {
    let file = File::open(path)
        .map_err(|e| format!("Failed to open .lts file '{}': {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid .lts zip '{}': {e}", path.display()))?;

    // 1. manifest.json
    let manifest: LtsManifest = {
        let entry = archive
            .by_name("manifest.json")
            .map_err(|e| format!("manifest.json not found in .lts file: {e}"))?;
        serde_json::from_reader(entry)
            .map_err(|e| format!("Failed to parse manifest.json: {e}"))?
    };

    let source_filename = manifest.source_filename.clone();

    // 2. source/<manifest.source_filename>
    let source_bytes: Vec<u8> = {
        let source_entry = format!("source/{source_filename}");
        let mut entry = archive
            .by_name(&source_entry)
            .map_err(|e| format!("Source entry '{source_entry}' not found in .lts file: {e}"))?;
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read source bytes from '{source_entry}': {e}"))?;
        buf
    };

    // 3. artifacts/bookmarks.json
    let bookmarks: Vec<Bookmark> = {
        let entry = archive
            .by_name("artifacts/bookmarks.json")
            .map_err(|e| format!("artifacts/bookmarks.json not found in .lts file: {e}"))?;
        serde_json::from_reader(entry)
            .map_err(|e| format!("Failed to parse artifacts/bookmarks.json: {e}"))?
    };

    // 4. artifacts/analyses.json
    let analyses: Vec<AnalysisArtifact> = {
        let entry = archive
            .by_name("artifacts/analyses.json")
            .map_err(|e| format!("artifacts/analyses.json not found in .lts file: {e}"))?;
        serde_json::from_reader(entry)
            .map_err(|e| format!("Failed to parse artifacts/analyses.json: {e}"))?
    };

    // 5. artifacts/session-meta.json (optional — default if missing)
    let session_meta: LtsSessionMeta = match archive.by_name("artifacts/session-meta.json") {
        Ok(entry) => serde_json::from_reader(entry)
            .map_err(|e| format!("Failed to parse artifacts/session-meta.json: {e}"))?,
        Err(_) => LtsSessionMeta::default(),
    };

    // 6. processors/processor-manifest.json (optional — default if missing)
    let processor_manifest: LtsProcessorManifest =
        match archive.by_name("processors/processor-manifest.json") {
            Ok(entry) => serde_json::from_reader(entry)
                .map_err(|e| format!("Failed to parse processors/processor-manifest.json: {e}"))?,
            Err(_) => LtsProcessorManifest::default(),
        };

    // 7. Read each processor YAML listed in the manifest.
    let mut processor_yamls: HashMap<String, String> =
        HashMap::with_capacity(processor_manifest.processors.len());
    for entry_meta in &processor_manifest.processors {
        let yaml_entry = format!("processors/{}", entry_meta.filename);
        let mut entry = archive
            .by_name(&yaml_entry)
            .map_err(|e| format!("Processor entry '{yaml_entry}' not found in .lts file: {e}"))?;
        let mut buf = String::new();
        entry
            .read_to_string(&mut buf)
            .map_err(|e| format!("Failed to read processor YAML '{yaml_entry}': {e}"))?;
        processor_yamls.insert(entry_meta.id.clone(), buf);
    }

    Ok(LtsData {
        manifest,
        source_bytes,
        source_filename,
        bookmarks,
        analyses,
        session_meta,
        processor_manifest,
        processor_yamls,
    })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::bookmark::CreatedBy;

    fn make_bookmark(line: u32) -> Bookmark {
        Bookmark {
            id: format!("bm-{line}"),
            session_id: "sess-1".to_string(),
            line_number: line,
            line_number_end: None,
            snippet: None,
            category: None,
            tags: None,
            label: format!("Label {line}"),
            note: String::new(),
            created_by: CreatedBy::User,
            created_at: 1000,
        }
    }

    fn make_artifact() -> AnalysisArtifact {
        AnalysisArtifact {
            id: "art-1".to_string(),
            session_id: "sess-1".to_string(),
            title: "Test Analysis".to_string(),
            created_at: 2000,
            sections: vec![],
        }
    }

    /// Full round-trip: write_lts then read_lts, verify all fields survive.
    #[test]
    fn lts_roundtrip() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let source_bytes = b"01-01 00:00:00.000  123  456 I Tag: message\n".to_vec();
        let bookmarks = vec![make_bookmark(10), make_bookmark(20)];
        let analyses = vec![make_artifact()];
        let meta = LtsSessionMeta {
            active_processor_ids: vec!["proc-a".to_string()],
            disabled_processor_ids: vec!["proc-b".to_string()],
        };
        let proc_yamls = vec![(
            "proc-a".to_string(),
            "proc-a.yaml".to_string(),
            "id: proc-a\ntype: reporter\n".to_string(),
        )];

        write_lts(
            &zip_path,
            "test.log",
            &source_bytes,
            &bookmarks,
            &analyses,
            &meta,
            &proc_yamls,
        )
        .expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        // Manifest
        assert_eq!(loaded.manifest.format_version, LTS_FORMAT_VERSION);
        assert_eq!(loaded.manifest.source_filename, "test.log");
        assert_eq!(loaded.manifest.source_size, source_bytes.len() as u64);
        assert!(loaded.manifest.saved_at > 0);

        // Source filename convenience field
        assert_eq!(loaded.source_filename, "test.log");

        // Source bytes (Stored — no transformation)
        assert_eq!(loaded.source_bytes, source_bytes);

        // Bookmarks
        assert_eq!(loaded.bookmarks.len(), 2);
        assert_eq!(loaded.bookmarks[0].line_number, 10);
        assert_eq!(loaded.bookmarks[1].line_number, 20);

        // Analyses
        assert_eq!(loaded.analyses.len(), 1);
        assert_eq!(loaded.analyses[0].title, "Test Analysis");

        // Session meta
        assert_eq!(
            loaded.session_meta.active_processor_ids,
            vec!["proc-a".to_string()]
        );
        assert_eq!(
            loaded.session_meta.disabled_processor_ids,
            vec!["proc-b".to_string()]
        );

        // Processor manifest
        assert_eq!(loaded.processor_manifest.processors.len(), 1);
        assert_eq!(loaded.processor_manifest.processors[0].id, "proc-a");
        assert_eq!(loaded.processor_manifest.processors[0].filename, "proc-a.yaml");

        // Processor YAML content
        let yaml = loaded.processor_yamls.get("proc-a").expect("proc-a yaml");
        assert_eq!(yaml, "id: proc-a\ntype: reporter\n");
    }

    /// Empty artifacts round-trip cleanly.
    #[test]
    fn lts_roundtrip_empty() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let meta = LtsSessionMeta::default();
        write_lts(&zip_path, "empty.log", b"", &[], &[], &meta, &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert!(loaded.source_bytes.is_empty());
        assert!(loaded.bookmarks.is_empty());
        assert!(loaded.analyses.is_empty());
        assert!(loaded.session_meta.active_processor_ids.is_empty());
        assert!(loaded.processor_manifest.processors.is_empty());
        assert!(loaded.processor_yamls.is_empty());
    }

    /// Processor manifest stores correct SHA-256 hashes of YAML content.
    #[test]
    fn lts_processor_hashes() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let yaml_a = "id: proc-a\ntype: reporter\n";
        let yaml_b = "id: proc-b\ntype: state_tracker\n";

        let proc_yamls = vec![
            ("proc-a".to_string(), "proc-a.yaml".to_string(), yaml_a.to_string()),
            ("proc-b".to_string(), "proc-b.yaml".to_string(), yaml_b.to_string()),
        ];

        let meta = LtsSessionMeta::default();
        write_lts(&zip_path, "test.log", b"data", &[], &[], &meta, &proc_yamls)
            .expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.processor_manifest.processors.len(), 2);

        // Verify SHA-256 hashes independently.
        for entry in &loaded.processor_manifest.processors {
            let expected_yaml = if entry.id == "proc-a" { yaml_a } else { yaml_b };
            let mut hasher = Sha256::new();
            hasher.update(expected_yaml.as_bytes());
            let expected_hash = hex::encode(hasher.finalize());
            assert_eq!(
                entry.sha256, expected_hash,
                "SHA-256 mismatch for processor '{}'",
                entry.id
            );
        }

        // Ensure the two processors have different hashes.
        let hash_a = &loaded.processor_manifest.processors[0].sha256;
        let hash_b = &loaded.processor_manifest.processors[1].sha256;
        assert_ne!(hash_a, hash_b, "Different YAMLs must produce different hashes");
    }
}
