use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

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
    let manifest = LtsManifest {
        format_version: LTS_FORMAT_VERSION,
        source_filename: source_filename.to_string(),
        source_size: source_bytes.len() as u64,
        saved_at: super::now_ms(),
    };

    let out_file = File::create(dest)
        .map_err(|e| format!("Failed to create .lts file '{}': {e}", dest.display()))?;
    let mut writer = zip::ZipWriter::new(out_file);

    let deflate_opts = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let stored_opts = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);

    // 1. manifest.json (Deflated)
    super::zip_write_json(&mut writer, "manifest.json", deflate_opts, &manifest)?;

    // 2. source/<source_filename> (Stored — no compression for large files)
    let source_entry = format!("source/{source_filename}");
    writer
        .start_file(&source_entry, stored_opts)
        .map_err(|e| format!("Failed to start source entry '{source_entry}': {e}"))?;
    std::io::Write::write_all(&mut writer, source_bytes)
        .map_err(|e| format!("Failed to write source bytes: {e}"))?;

    // 3. artifacts/bookmarks.json (Deflated)
    super::zip_write_json(&mut writer, "artifacts/bookmarks.json", deflate_opts, bookmarks)?;

    // 4. artifacts/analyses.json (Deflated)
    super::zip_write_json(&mut writer, "artifacts/analyses.json", deflate_opts, analyses)?;

    // 5. artifacts/session-meta.json (Deflated)
    super::zip_write_json(&mut writer, "artifacts/session-meta.json", deflate_opts, meta)?;

    // 6. processors/<filename>.yaml + build processor manifest (Deflated)
    let mut proc_manifest = LtsProcessorManifest {
        processors: Vec::with_capacity(processor_yamls.len()),
    };

    for (id, filename, yaml_content) in processor_yamls {
        proc_manifest.processors.push(LtsProcessorEntry {
            id: id.clone(),
            filename: filename.clone(),
            sha256: super::sha256_hex(yaml_content),
        });

        let yaml_entry = format!("processors/{filename}");
        writer
            .start_file(&yaml_entry, deflate_opts)
            .map_err(|e| format!("Failed to start processor entry '{yaml_entry}': {e}"))?;
        std::io::Write::write_all(&mut writer, yaml_content.as_bytes())
            .map_err(|e| format!("Failed to write processor YAML '{yaml_entry}': {e}"))?;
    }

    // 7. processors/processor-manifest.json (Deflated)
    super::zip_write_json(&mut writer, "processors/processor-manifest.json", deflate_opts, &proc_manifest)?;

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
    let manifest: LtsManifest = super::zip_read_json(&mut archive, "manifest.json")?;

    // 2. source/<manifest.source_filename>
    let source_bytes: Vec<u8> = {
        let source_entry = format!("source/{}", manifest.source_filename);
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
    let bookmarks: Vec<Bookmark> = super::zip_read_json(&mut archive, "artifacts/bookmarks.json")?;

    // 4. artifacts/analyses.json
    let analyses: Vec<AnalysisArtifact> = super::zip_read_json(&mut archive, "artifacts/analyses.json")?;

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

    /// Source bytes written with Stored compression survive the round-trip byte-for-byte.
    #[test]
    fn lts_large_file_stored_compression() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        // Generate a realistic-size block of source bytes (100 KB of logcat lines).
        let mut source_bytes = Vec::with_capacity(100_000);
        for i in 0..1000usize {
            let line = format!(
                "01-01 {:02}:{:02}:{:02}.000  1000  1001 I TestTag: message {}\n",
                i / 3600,
                (i / 60) % 60,
                i % 60,
                i
            );
            source_bytes.extend_from_slice(line.as_bytes());
        }
        let original_len = source_bytes.len();

        let meta = LtsSessionMeta::default();
        write_lts(&zip_path, "large.log", &source_bytes, &[], &[], &meta, &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(
            loaded.source_bytes.len(), original_len,
            "source byte count must survive round-trip"
        );
        assert_eq!(
            loaded.source_bytes, source_bytes,
            "source bytes must be bit-for-bit identical after Stored round-trip"
        );
    }

    /// Manifest fields are populated correctly after a round-trip.
    #[test]
    fn lts_manifest_fields_correct() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let source_bytes = b"01-01 00:00:00.000  1000  1001 I Tag: line\n";
        let meta = LtsSessionMeta::default();

        let before_write = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        write_lts(&zip_path, "myfile.log", source_bytes, &[], &[], &meta, &[]).expect("write_lts");

        let after_write = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(i64::MAX);

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.manifest.format_version, LTS_FORMAT_VERSION);
        assert_eq!(loaded.manifest.source_filename, "myfile.log");
        assert_eq!(
            loaded.manifest.source_size,
            source_bytes.len() as u64,
            "source_size must equal the actual byte count"
        );
        assert!(
            loaded.manifest.saved_at >= before_write && loaded.manifest.saved_at <= after_write,
            "saved_at {} must be within the write window [{}, {}]",
            loaded.manifest.saved_at, before_write, after_write
        );
    }

    /// read_lts handles a file without session-meta.json and processor-manifest.json gracefully.
    #[test]
    fn lts_missing_optional_entries() {
        // Build a minimal .lts zip that omits session-meta.json and processor-manifest.json.
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        // Write a minimal valid .lts by constructing the zip manually — omit the optional entries.
        {
            use std::fs::File;
            use zip::write::SimpleFileOptions;

            let manifest = LtsManifest {
                format_version: LTS_FORMAT_VERSION,
                source_filename: "minimal.log".to_string(),
                source_size: 5,
                saved_at: 12345,
            };

            let out_file = File::create(&zip_path).expect("create zip");
            let mut writer = zip::ZipWriter::new(out_file);
            let deflate = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            let stored = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .large_file(true);

            // manifest.json
            writer.start_file("manifest.json", deflate).unwrap();
            serde_json::to_writer(&mut writer, &manifest).unwrap();

            // source/minimal.log
            writer.start_file("source/minimal.log", stored).unwrap();
            std::io::Write::write_all(&mut writer, b"hello").unwrap();

            // artifacts/bookmarks.json
            writer.start_file("artifacts/bookmarks.json", deflate).unwrap();
            serde_json::to_writer(&mut writer, &Vec::<crate::core::bookmark::Bookmark>::new()).unwrap();

            // artifacts/analyses.json
            writer.start_file("artifacts/analyses.json", deflate).unwrap();
            serde_json::to_writer(&mut writer, &Vec::<crate::core::analysis::AnalysisArtifact>::new()).unwrap();

            // Intentionally omit session-meta.json and processor-manifest.json
            writer.finish().unwrap();
        }

        // Must not return an error — missing optional entries must use defaults.
        let loaded = read_lts(&zip_path).expect("read_lts must succeed with missing optional entries");

        assert!(loaded.session_meta.active_processor_ids.is_empty(), "default session meta must have no active processors");
        assert!(loaded.session_meta.disabled_processor_ids.is_empty(), "default session meta must have no disabled processors");
        assert!(loaded.processor_manifest.processors.is_empty(), "default processor manifest must be empty");
        assert!(loaded.processor_yamls.is_empty(), "no processor YAMLs when manifest is missing");
        assert_eq!(loaded.source_bytes, b"hello");
    }

    /// Three processors all survive round-trip with correct hashes.
    #[test]
    fn lts_multiple_processors() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let yaml_a = "id: proc-a\ntype: reporter\n";
        let yaml_b = "id: proc-b\ntype: state_tracker\n";
        let yaml_c = "id: proc-c\ntype: transformer\n";

        let proc_yamls = vec![
            ("proc-a".to_string(), "proc-a.yaml".to_string(), yaml_a.to_string()),
            ("proc-b".to_string(), "proc-b.yaml".to_string(), yaml_b.to_string()),
            ("proc-c".to_string(), "proc-c.yaml".to_string(), yaml_c.to_string()),
        ];

        let meta = LtsSessionMeta::default();
        write_lts(&zip_path, "test.log", b"data", &[], &[], &meta, &proc_yamls).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.processor_manifest.processors.len(), 3);
        assert_eq!(loaded.processor_yamls.len(), 3);

        // Verify all three processors have correct YAMLs and correct hashes.
        let expected: &[(&str, &str)] = &[
            ("proc-a", yaml_a),
            ("proc-b", yaml_b),
            ("proc-c", yaml_c),
        ];
        for &(id, expected_yaml) in expected {
            let yaml = loaded.processor_yamls.get(id)
                .unwrap_or_else(|| panic!("processor '{id}' YAML missing from round-trip"));
            assert_eq!(yaml, expected_yaml, "YAML content mismatch for '{id}'");

            let entry = loaded.processor_manifest.processors.iter()
                .find(|e| e.id == id)
                .unwrap_or_else(|| panic!("processor '{id}' missing from manifest"));
            let expected_hash = super::super::sha256_hex(expected_yaml);
            assert_eq!(entry.sha256, expected_hash, "SHA-256 mismatch for processor '{id}'");
        }

        // All three hashes must be distinct.
        let hashes: Vec<&str> = loaded.processor_manifest.processors.iter()
            .map(|e| e.sha256.as_str())
            .collect();
        let unique: std::collections::HashSet<&&str> = hashes.iter().collect();
        assert_eq!(unique.len(), 3, "all three processors must have distinct hashes");
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
            let expected_hash = super::super::sha256_hex(expected_yaml);
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
