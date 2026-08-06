use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

use crate::core::analysis::AnalysisArtifact;
use crate::core::bookmark::Bookmark;

pub const LTS_FORMAT_VERSION: u32 = 3;

/// Top-level manifest stored as `manifest.json` inside the `.lts` zip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtsManifest {
    pub format_version: u32,
    pub sessions: Vec<LtsManifestSession>,
    /// Milliseconds since UNIX epoch.
    pub saved_at: i64,
}

/// Per-session metadata recorded in the top-level manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtsManifestSession {
    pub source_filename: String,
    pub source_size: u64,
}

/// Session-level metadata stored as `sessions/{idx}/artifacts/session-meta.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtsSessionMeta {
    pub active_processor_ids: Vec<String>,
    pub disabled_processor_ids: Vec<String>,
}

impl From<super::SessionMeta> for LtsSessionMeta {
    fn from(m: super::SessionMeta) -> Self {
        Self {
            active_processor_ids: m.active_processor_ids,
            disabled_processor_ids: m.disabled_processor_ids,
        }
    }
}

impl From<LtsSessionMeta> for super::SessionMeta {
    fn from(m: LtsSessionMeta) -> Self {
        Self {
            active_processor_ids: m.active_processor_ids,
            disabled_processor_ids: m.disabled_processor_ids,
        }
    }
}

/// One editor tab stored in `editor-tabs.json` inside the `.lts` zip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtsEditorTab {
    pub label: String,
    pub content: String,
    pub view_mode: String,
    pub word_wrap: bool,
    pub file_path: Option<String>,
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

/// In-memory representation of a single session within an `.lts` file.
pub struct LtsSessionData {
    pub source_bytes: Vec<u8>,
    pub source_filename: String,
    pub bookmarks: Vec<Bookmark>,
    pub analyses: Vec<AnalysisArtifact>,
    pub session_meta: LtsSessionMeta,
}

/// In-memory representation of a loaded `.lts` file.
pub struct LtsData {
    pub manifest: LtsManifest,
    pub sessions: Vec<LtsSessionData>,
    pub processor_manifest: LtsProcessorManifest,
    pub processor_yamls: HashMap<String, String>,
    pub editor_tabs: Vec<LtsEditorTab>,
}

/// Write a `.lts` zip file (current format: `LTS_FORMAT_VERSION` = 3) to `dest`.
///
/// # Arguments
/// * `dest` — output path for the zip file
/// * `sessions` — slice of per-session data to embed
/// * `processor_yamls` — `(id, filename, yaml_content)` tuples for each processor to embed
///
/// # Zip layout
/// ```text
/// manifest.json
/// sessions/{idx}/source/{filename}         (Stored, large_file=true)
/// sessions/{idx}/artifacts/bookmarks.json  (Deflated)
/// sessions/{idx}/artifacts/analyses.json   (Deflated)
/// sessions/{idx}/artifacts/session-meta.json (Deflated)
/// processors/{filename}.yaml               (Deflated)
/// processors/processor-manifest.json       (Deflated)
/// ```
pub fn write_lts(
    dest: &Path,
    sessions: &[LtsSessionData],
    processor_yamls: &[(String, String, String)], // (id, filename, yaml_content)
    editor_tabs: &[LtsEditorTab],
) -> Result<(), String> {
    let manifest_sessions: Vec<LtsManifestSession> = sessions
        .iter()
        .map(|s| LtsManifestSession {
            source_filename: s.source_filename.clone(),
            source_size: s.source_bytes.len() as u64,
        })
        .collect();

    let manifest = LtsManifest {
        format_version: LTS_FORMAT_VERSION,
        sessions: manifest_sessions,
        saved_at: super::now_ms(),
    };

    // Written atomically: content lands in a sibling `.lts.tmp` file first and
    // is only renamed over `dest` once fully flushed, so a crash, full disk, or
    // per-session write error mid-stream can never truncate or corrupt the
    // previous good `.lts` file (see `workspace::write_atomic`).
    super::write_atomic(dest, "lts.tmp", |out_file| {
        let mut writer = zip::ZipWriter::new(out_file);

        let deflate_opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let stored_opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .large_file(true);

        // 1. manifest.json (Deflated)
        super::zip_write_json(&mut writer, "manifest.json", deflate_opts, &manifest)?;

        // 2. Per-session entries
        for (idx, session) in sessions.iter().enumerate() {
            let source_entry = format!("sessions/{idx}/source/{}", session.source_filename);
            writer
                .start_file(&source_entry, stored_opts)
                .map_err(|e| format!("Failed to start source entry '{source_entry}': {e}"))?;
            std::io::Write::write_all(&mut writer, &session.source_bytes)
                .map_err(|e| format!("Failed to write source bytes for session {idx}: {e}"))?;

            super::zip_write_json(
                &mut writer,
                &format!("sessions/{idx}/artifacts/bookmarks.json"),
                deflate_opts,
                &session.bookmarks,
            )?;
            super::zip_write_json(
                &mut writer,
                &format!("sessions/{idx}/artifacts/analyses.json"),
                deflate_opts,
                &session.analyses,
            )?;
            super::zip_write_json(
                &mut writer,
                &format!("sessions/{idx}/artifacts/session-meta.json"),
                deflate_opts,
                &session.session_meta,
            )?;
        }

        // 3. processors/<filename>.yaml + build processor manifest (Deflated)
        let mut proc_manifest = LtsProcessorManifest {
            processors: Vec::with_capacity(processor_yamls.len()),
        };

        for (id, filename, yaml_content) in processor_yamls {
            // Defense-in-depth (zip-slip): `filename` is normally
            // `id_to_filename(id)` for an id that already passed
            // `validate_processor_id()`, but this is a public fn and not
            // every caller is guaranteed to have re-checked it — e.g. a
            // re-export of a `.lts`-imported processor threads an id
            // sourced from an untrusted archive manifest
            // (`resolve_lts_processors_raw`'s `entry.id`) through here.
            // `commands::export::export_all_sessions` already applies this
            // same guard before calling `write_lts`; this is belt-and-
            // braces for any other caller of this public function. Refuse
            // to embed a traversal-y / separator-bearing name as a zip
            // entry — skip just this processor rather than aborting the
            // whole write.
            if let Err(e) = crate::processors::marketplace::ensure_filename_safe(filename) {
                log::warn!(
                    "write_lts: skipping processor '{id}' with unsafe archive filename '{filename}': {e}"
                );
                continue;
            }

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

        // 4. processors/processor-manifest.json (Deflated)
        super::zip_write_json(
            &mut writer,
            "processors/processor-manifest.json",
            deflate_opts,
            &proc_manifest,
        )?;

        // 5. editor-tabs.json (Deflated) — omitted when empty
        if !editor_tabs.is_empty() {
            super::zip_write_json(&mut writer, "editor-tabs.json", deflate_opts, &editor_tabs)?;
        }

        writer
            .finish()
            .map_err(|e| format!("Failed to finalise .lts zip: {e}"))
    })
}

/// Read a `.lts` zip file from `path` and return all embedded data.
pub fn read_lts(path: &Path) -> Result<LtsData, String> {
    let file = File::open(path)
        .map_err(|e| format!("Failed to open .lts file '{}': {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid .lts zip '{}': {e}", path.display()))?;

    // 1. manifest.json
    let manifest: LtsManifest = super::zip_read_json(&mut archive, "manifest.json")?;

    // Unlike `ltw_v4.rs`'s `read_ltw` (which requires an exact format match,
    // since older `.ltw` formats live in now-removed `ltw_v1..v3.rs` files),
    // this single `lts.rs` reader has always stayed backward-compatible with
    // older `.lts` manifests by defaulting individual entries that didn't
    // exist yet (`session-meta.json`, `processor-manifest.json`,
    // `editor-tabs.json` are all read as "optional — default if missing"
    // below, regardless of `format_version`). So we don't reject every
    // non-current version like `read_ltw` does — only versions *newer* than
    // this build understands, which this code has no fallback path for.
    if manifest.format_version > LTS_FORMAT_VERSION {
        return Err(format!(
            "Unsupported .lts format version {} (this build supports up to {LTS_FORMAT_VERSION})",
            manifest.format_version
        ));
    }

    // 2. Per-session data
    let mut sessions: Vec<LtsSessionData> = Vec::with_capacity(manifest.sessions.len());
    for (idx, session_meta_entry) in manifest.sessions.iter().enumerate() {
        // source bytes (Stored)
        let source_bytes: Vec<u8> = {
            let source_entry =
                format!("sessions/{idx}/source/{}", session_meta_entry.source_filename);
            let mut entry = archive.by_name(&source_entry).map_err(|e| {
                format!("Source entry '{source_entry}' not found in .lts file: {e}")
            })?;
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("Failed to read source bytes from '{source_entry}': {e}"))?;
            buf
        };

        let bookmarks: Vec<Bookmark> = super::zip_read_json(
            &mut archive,
            &format!("sessions/{idx}/artifacts/bookmarks.json"),
        )?;

        let analyses: Vec<AnalysisArtifact> = super::zip_read_json(
            &mut archive,
            &format!("sessions/{idx}/artifacts/analyses.json"),
        )?;

        // session-meta.json is optional — default if missing
        let session_meta: LtsSessionMeta = {
            let meta_path = format!("sessions/{idx}/artifacts/session-meta.json");
            match archive.by_name(&meta_path) {
                Ok(entry) => serde_json::from_reader(entry)
                    .map_err(|e| format!("Failed to parse {meta_path}: {e}"))?,
                Err(_) => LtsSessionMeta::default(),
            }
        };

        sessions.push(LtsSessionData {
            source_bytes,
            source_filename: session_meta_entry.source_filename.clone(),
            bookmarks,
            analyses,
            session_meta,
        });
    }

    // 3. processors/processor-manifest.json (optional — default if missing)
    let processor_manifest: LtsProcessorManifest =
        match archive.by_name("processors/processor-manifest.json") {
            Ok(entry) => serde_json::from_reader(entry)
                .map_err(|e| format!("Failed to parse processors/processor-manifest.json: {e}"))?,
            Err(_) => LtsProcessorManifest::default(),
        };

    // 4. Read each processor YAML listed in the manifest.
    let mut processor_yamls: HashMap<String, String> =
        HashMap::with_capacity(processor_manifest.processors.len());
    for entry_meta in &processor_manifest.processors {
        // Defense-in-depth (zip-slip): `entry_meta.filename` / `.id` come
        // straight out of an untrusted `.lts` archive's
        // `processor-manifest.json` and are never validated by
        // `validate_processor_id()` — that only runs on bare ids parsed
        // from a processor's own YAML `meta.id`, not on manifest entries.
        // Nothing here currently joins this name onto a real filesystem
        // path — `archive.by_name()` below only looks the name up inside
        // the zip's own in-memory entry table, and `resolve_lts_processors`
        // (`commands/export.rs`) only ever writes these ids into in-memory
        // `AppState`, never to disk — so this is not exploitable today.
        // Still, reject unsafe entries outright rather than caching an
        // id/filename pair that could otherwise round-trip into a *newly
        // written* archive on re-export (see the matching guards in
        // `export_all_sessions` and `write_lts` above).
        if let Err(e) = crate::processors::marketplace::ensure_filename_safe(&entry_meta.filename) {
            log::warn!(
                "read_lts: skipping processor manifest entry with unsafe filename '{}': {e}",
                entry_meta.filename
            );
            continue;
        }
        if let Err(e) = crate::processors::marketplace::ensure_filename_safe(&entry_meta.id) {
            log::warn!(
                "read_lts: skipping processor manifest entry with unsafe id '{}': {e}",
                entry_meta.id
            );
            continue;
        }
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

    // 5. editor-tabs.json (optional — default to empty vec if missing)
    let editor_tabs: Vec<LtsEditorTab> = match archive.by_name("editor-tabs.json") {
        Ok(file) => serde_json::from_reader(file)
            .map_err(|e| format!("editor-tabs.json: {e}"))?,
        Err(_) => vec![],
    };

    Ok(LtsData {
        manifest,
        sessions,
        processor_manifest,
        processor_yamls,
        editor_tabs,
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
            title: "Test Analysis".to_string(),
            created_at: 2000,
            sections: vec![],
            legacy_session_id: None,
        }
    }

    fn make_session(
        filename: &str,
        source_bytes: Vec<u8>,
        bookmarks: Vec<Bookmark>,
        analyses: Vec<AnalysisArtifact>,
        meta: LtsSessionMeta,
    ) -> LtsSessionData {
        LtsSessionData {
            source_bytes,
            source_filename: filename.to_string(),
            bookmarks,
            analyses,
            session_meta: meta,
        }
    }

    // ─── Existing tests (updated for v2) ────────────────────────────────────

    /// Full round-trip: write_lts then read_lts, verify all fields survive (single session).
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

        let sessions = vec![make_session("test.log", source_bytes.clone(), bookmarks, analyses, meta)];
        write_lts(&zip_path, &sessions, &proc_yamls, &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        // Manifest
        assert_eq!(loaded.manifest.format_version, LTS_FORMAT_VERSION);
        assert_eq!(loaded.manifest.sessions.len(), 1);
        assert_eq!(loaded.manifest.sessions[0].source_filename, "test.log");
        assert_eq!(loaded.manifest.sessions[0].source_size, source_bytes.len() as u64);
        assert!(loaded.manifest.saved_at > 0);

        assert_eq!(loaded.sessions.len(), 1);
        let sess = &loaded.sessions[0];

        // Source bytes (Stored — no transformation)
        assert_eq!(sess.source_bytes, source_bytes);

        // Bookmarks
        assert_eq!(sess.bookmarks.len(), 2);
        assert_eq!(sess.bookmarks[0].line_number, 10);
        assert_eq!(sess.bookmarks[1].line_number, 20);

        // Analyses
        assert_eq!(sess.analyses.len(), 1);
        assert_eq!(sess.analyses[0].title, "Test Analysis");

        // Session meta
        assert_eq!(
            sess.session_meta.active_processor_ids,
            vec!["proc-a".to_string()]
        );
        assert_eq!(
            sess.session_meta.disabled_processor_ids,
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

        let sessions = vec![make_session("empty.log", vec![], vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.sessions.len(), 1);
        let sess = &loaded.sessions[0];
        assert!(sess.source_bytes.is_empty());
        assert!(sess.bookmarks.is_empty());
        assert!(sess.analyses.is_empty());
        assert!(sess.session_meta.active_processor_ids.is_empty());
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

        let sessions = vec![make_session("large.log", source_bytes.clone(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.sessions.len(), 1);
        let sess = &loaded.sessions[0];
        assert_eq!(
            sess.source_bytes.len(), original_len,
            "source byte count must survive round-trip"
        );
        assert_eq!(
            sess.source_bytes, source_bytes,
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

        let before_write = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let sessions = vec![make_session("myfile.log", source_bytes.to_vec(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let after_write = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(i64::MAX);

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.manifest.format_version, LTS_FORMAT_VERSION);
        assert_eq!(loaded.manifest.sessions.len(), 1);
        assert_eq!(loaded.manifest.sessions[0].source_filename, "myfile.log");
        assert_eq!(
            loaded.manifest.sessions[0].source_size,
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
                sessions: vec![LtsManifestSession {
                    source_filename: "minimal.log".to_string(),
                    source_size: 5,
                }],
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

            // sessions/0/source/minimal.log
            writer.start_file("sessions/0/source/minimal.log", stored).unwrap();
            std::io::Write::write_all(&mut writer, b"hello").unwrap();

            // sessions/0/artifacts/bookmarks.json
            writer.start_file("sessions/0/artifacts/bookmarks.json", deflate).unwrap();
            serde_json::to_writer(&mut writer, &Vec::<crate::core::bookmark::Bookmark>::new()).unwrap();

            // sessions/0/artifacts/analyses.json
            writer.start_file("sessions/0/artifacts/analyses.json", deflate).unwrap();
            serde_json::to_writer(&mut writer, &Vec::<crate::core::analysis::AnalysisArtifact>::new()).unwrap();

            // Intentionally omit session-meta.json and processor-manifest.json
            writer.finish().unwrap();
        }

        // Must not return an error — missing optional entries must use defaults.
        let loaded = read_lts(&zip_path).expect("read_lts must succeed with missing optional entries");

        assert_eq!(loaded.sessions.len(), 1);
        let sess = &loaded.sessions[0];
        assert!(sess.session_meta.active_processor_ids.is_empty(), "default session meta must have no active processors");
        assert!(sess.session_meta.disabled_processor_ids.is_empty(), "default session meta must have no disabled processors");
        assert!(loaded.processor_manifest.processors.is_empty(), "default processor manifest must be empty");
        assert!(loaded.processor_yamls.is_empty(), "no processor YAMLs when manifest is missing");
        assert_eq!(sess.source_bytes, b"hello");
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

        let sessions = vec![make_session("test.log", b"data".to_vec(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &proc_yamls, &[]).expect("write_lts");

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

        let sessions = vec![make_session("test.log", b"data".to_vec(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &proc_yamls, &[]).expect("write_lts");

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

    // ─── Zip-slip hardening tests ───────────────────────────────────────────

    /// `write_lts` must silently skip (not abort the whole write, not panic)
    /// a processor entry whose `filename` contains a traversal sequence —
    /// the rest of the archive (including other, safe processors) must
    /// still be written and readable.
    #[test]
    fn write_lts_skips_processor_with_unsafe_filename() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let proc_yamls = vec![
            (
                "good-proc".to_string(),
                "good-proc.yaml".to_string(),
                "id: good-proc\ntype: reporter\n".to_string(),
            ),
            (
                // Simulates an id sourced from an untrusted, re-exported
                // `.lts` manifest entry (see `resolve_lts_processors_raw`'s
                // `entry.id`) that was never re-validated before reaching
                // `id_to_filename()`.
                "evil-proc".to_string(),
                "../../evil.yaml".to_string(),
                "id: evil-proc\ntype: reporter\n".to_string(),
            ),
        ];

        let sessions = vec![make_session("test.log", b"data\n".to_vec(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &proc_yamls, &[]).expect("write_lts must not abort on an unsafe filename");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(
            loaded.processor_manifest.processors.len(), 1,
            "only the safe processor should have been written to the manifest"
        );
        assert_eq!(loaded.processor_manifest.processors[0].id, "good-proc");
        assert_eq!(loaded.processor_yamls.len(), 1);
        assert!(loaded.processor_yamls.contains_key("good-proc"));
        assert!(!loaded.processor_yamls.contains_key("evil-proc"), "unsafe entry must not have been written");
    }

    /// `read_lts` must silently skip (not error, not panic) a
    /// `processor-manifest.json` entry whose `filename` contains a
    /// traversal sequence — as if a `.lts` file were hand-crafted or
    /// tampered with outside `write_lts`'s own (also-hardened) path.
    #[test]
    fn read_lts_skips_manifest_entry_with_unsafe_filename() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        // Hand-build a minimal .lts zip (bypassing write_lts's own guard)
        // with a processor-manifest.json entry naming a traversal-y path.
        {
            let manifest = LtsManifest {
                format_version: LTS_FORMAT_VERSION,
                sessions: vec![],
                saved_at: 12345,
            };
            let proc_manifest = LtsProcessorManifest {
                processors: vec![LtsProcessorEntry {
                    id: "evil".to_string(),
                    filename: "../../evil.yaml".to_string(),
                    sha256: "deadbeef".to_string(),
                }],
            };

            let out_file = File::create(&zip_path).expect("create zip");
            let mut writer = zip::ZipWriter::new(out_file);
            let deflate = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            writer.start_file("manifest.json", deflate).unwrap();
            serde_json::to_writer(&mut writer, &manifest).unwrap();

            writer.start_file("processors/processor-manifest.json", deflate).unwrap();
            serde_json::to_writer(&mut writer, &proc_manifest).unwrap();

            // Deliberately do NOT write a `processors/../../evil.yaml`
            // entry — the point of the read-side guard is that `read_lts`
            // must reject the manifest entry before ever attempting
            // `archive.by_name()` on the unsafe name.
            writer.finish().unwrap();
        }

        let loaded = read_lts(&zip_path).expect("read_lts must not error on an unsafe manifest entry");

        assert!(loaded.sessions.is_empty());
        assert!(
            loaded.processor_yamls.is_empty(),
            "unsafe manifest entry must not have been resolved into processor_yamls"
        );
    }

    /// Same as above, but the `id` field (not `filename`) is the
    /// traversal-y one — both fields are attacker-controlled in an
    /// untrusted manifest and must be checked independently.
    #[test]
    fn read_lts_skips_manifest_entry_with_unsafe_id() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        {
            let manifest = LtsManifest {
                format_version: LTS_FORMAT_VERSION,
                sessions: vec![],
                saved_at: 12345,
            };
            let proc_manifest = LtsProcessorManifest {
                processors: vec![LtsProcessorEntry {
                    id: "../../evil".to_string(),
                    filename: "evil.yaml".to_string(),
                    sha256: "deadbeef".to_string(),
                }],
            };

            let out_file = File::create(&zip_path).expect("create zip");
            let mut writer = zip::ZipWriter::new(out_file);
            let deflate = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            writer.start_file("manifest.json", deflate).unwrap();
            serde_json::to_writer(&mut writer, &manifest).unwrap();

            writer.start_file("processors/processor-manifest.json", deflate).unwrap();
            serde_json::to_writer(&mut writer, &proc_manifest).unwrap();

            // filename is "safe" on its own, but write the entry anyway so
            // this test proves the `id` check alone is sufficient to skip
            // it even when the corresponding zip entry exists.
            writer.start_file("processors/evil.yaml", deflate).unwrap();
            std::io::Write::write_all(&mut writer, b"id: evil\ntype: reporter\n").unwrap();

            writer.finish().unwrap();
        }

        let loaded = read_lts(&zip_path).expect("read_lts must not error on an unsafe manifest id");

        assert!(
            loaded.processor_yamls.is_empty(),
            "manifest entry with an unsafe id must not have been resolved into processor_yamls"
        );
    }

    // ─── New v2 tests ────────────────────────────────────────────────────────

    /// V2: 1 session with bookmarks, analyses, session-meta, processors round-trips.
    #[test]
    fn lts_v2_roundtrip_single_session() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let source_bytes = b"logcat line one\nlogcat line two\n".to_vec();
        let bookmarks = vec![make_bookmark(1), make_bookmark(5)];
        let analyses = vec![make_artifact()];
        let meta = LtsSessionMeta {
            active_processor_ids: vec!["proc-x".to_string()],
            disabled_processor_ids: vec!["proc-y".to_string()],
        };
        let proc_yamls = vec![(
            "proc-x".to_string(),
            "proc-x.yaml".to_string(),
            "id: proc-x\ntype: reporter\n".to_string(),
        )];

        let sessions = vec![make_session("session0.log", source_bytes.clone(), bookmarks, analyses, meta)];
        write_lts(&zip_path, &sessions, &proc_yamls, &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.manifest.format_version, LTS_FORMAT_VERSION);
        assert_eq!(loaded.manifest.sessions.len(), 1);
        assert_eq!(loaded.sessions.len(), 1);

        let sess = &loaded.sessions[0];
        assert_eq!(sess.source_filename, "session0.log");
        assert_eq!(sess.source_bytes, source_bytes);
        assert_eq!(sess.bookmarks.len(), 2);
        assert_eq!(sess.bookmarks[0].line_number, 1);
        assert_eq!(sess.bookmarks[1].line_number, 5);
        assert_eq!(sess.analyses.len(), 1);
        assert_eq!(sess.analyses[0].title, "Test Analysis");
        assert_eq!(sess.session_meta.active_processor_ids, vec!["proc-x".to_string()]);
        assert_eq!(sess.session_meta.disabled_processor_ids, vec!["proc-y".to_string()]);

        assert_eq!(loaded.processor_manifest.processors.len(), 1);
        assert_eq!(loaded.processor_yamls.get("proc-x").map(|s| s.as_str()), Some("id: proc-x\ntype: reporter\n"));
    }

    /// V2: 2 sessions with different sources/bookmarks/analyses/meta.
    #[test]
    fn lts_v2_roundtrip_two_sessions() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let bytes0 = b"session 0 data\n".to_vec();
        let bytes1 = b"session 1 data - different\n".to_vec();

        let sessions = vec![
            make_session(
                "alpha.log",
                bytes0.clone(),
                vec![make_bookmark(10)],
                vec![],
                LtsSessionMeta {
                    active_processor_ids: vec!["pa".to_string()],
                    disabled_processor_ids: vec![],
                },
            ),
            make_session(
                "beta.log",
                bytes1.clone(),
                vec![make_bookmark(20), make_bookmark(30)],
                vec![make_artifact()],
                LtsSessionMeta {
                    active_processor_ids: vec!["pb".to_string()],
                    disabled_processor_ids: vec!["pc".to_string()],
                },
            ),
        ];

        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.sessions.len(), 2);

        let s0 = &loaded.sessions[0];
        assert_eq!(s0.source_filename, "alpha.log");
        assert_eq!(s0.source_bytes, bytes0);
        assert_eq!(s0.bookmarks.len(), 1);
        assert_eq!(s0.bookmarks[0].line_number, 10);
        assert!(s0.analyses.is_empty());
        assert_eq!(s0.session_meta.active_processor_ids, vec!["pa".to_string()]);

        let s1 = &loaded.sessions[1];
        assert_eq!(s1.source_filename, "beta.log");
        assert_eq!(s1.source_bytes, bytes1);
        assert_eq!(s1.bookmarks.len(), 2);
        assert_eq!(s1.bookmarks[0].line_number, 20);
        assert_eq!(s1.bookmarks[1].line_number, 30);
        assert_eq!(s1.analyses.len(), 1);
        assert_eq!(s1.session_meta.active_processor_ids, vec!["pb".to_string()]);
        assert_eq!(s1.session_meta.disabled_processor_ids, vec!["pc".to_string()]);
    }

    /// V2: 3 sessions validates indexing beyond 0/1.
    #[test]
    fn lts_v2_roundtrip_three_sessions() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let sessions = vec![
            make_session("first.log", b"AAA\n".to_vec(), vec![make_bookmark(1)], vec![], LtsSessionMeta::default()),
            make_session("second.log", b"BBB\n".to_vec(), vec![make_bookmark(2)], vec![], LtsSessionMeta::default()),
            make_session("third.log", b"CCC\n".to_vec(), vec![make_bookmark(3)], vec![], LtsSessionMeta::default()),
        ];

        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.sessions.len(), 3);
        assert_eq!(loaded.manifest.sessions.len(), 3);

        assert_eq!(loaded.sessions[0].source_filename, "first.log");
        assert_eq!(loaded.sessions[0].source_bytes, b"AAA\n");
        assert_eq!(loaded.sessions[0].bookmarks[0].line_number, 1);

        assert_eq!(loaded.sessions[1].source_filename, "second.log");
        assert_eq!(loaded.sessions[1].source_bytes, b"BBB\n");
        assert_eq!(loaded.sessions[1].bookmarks[0].line_number, 2);

        assert_eq!(loaded.sessions[2].source_filename, "third.log");
        assert_eq!(loaded.sessions[2].source_bytes, b"CCC\n");
        assert_eq!(loaded.sessions[2].bookmarks[0].line_number, 3);
    }

    /// V2: 2 sessions sharing proc-a, one also has proc-b → exactly 2 YAMLs in zip.
    #[test]
    fn lts_v2_processor_deduplication() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        // Both sessions share proc-a; only session 1 uses proc-b.
        // Caller is responsible for deduplication before calling write_lts.
        // We pass deduplicated proc_yamls directly.
        let proc_yamls = vec![
            ("proc-a".to_string(), "proc-a.yaml".to_string(), "id: proc-a\ntype: reporter\n".to_string()),
            ("proc-b".to_string(), "proc-b.yaml".to_string(), "id: proc-b\ntype: state_tracker\n".to_string()),
        ];

        let sessions = vec![
            make_session("s0.log", b"s0\n".to_vec(), vec![], vec![], LtsSessionMeta {
                active_processor_ids: vec!["proc-a".to_string()],
                disabled_processor_ids: vec![],
            }),
            make_session("s1.log", b"s1\n".to_vec(), vec![], vec![], LtsSessionMeta {
                active_processor_ids: vec!["proc-a".to_string(), "proc-b".to_string()],
                disabled_processor_ids: vec![],
            }),
        ];

        write_lts(&zip_path, &sessions, &proc_yamls, &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        // Exactly 2 YAMLs in zip (no duplicates)
        assert_eq!(loaded.processor_manifest.processors.len(), 2, "expected exactly 2 processor entries");
        assert_eq!(loaded.processor_yamls.len(), 2, "expected exactly 2 YAML entries");

        assert!(loaded.processor_yamls.contains_key("proc-a"), "proc-a must be present");
        assert!(loaded.processor_yamls.contains_key("proc-b"), "proc-b must be present");

        // Session active proc IDs survived
        assert_eq!(loaded.sessions[0].session_meta.active_processor_ids, vec!["proc-a".to_string()]);
        assert_eq!(loaded.sessions[1].session_meta.active_processor_ids, vec!["proc-a".to_string(), "proc-b".to_string()]);
    }

    /// V2: format_version is 2, sessions array has correct filenames and sizes.
    #[test]
    fn lts_v2_manifest_fields() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let bytes0 = b"file zero content\n";
        let bytes1 = b"file one has more content\n";

        let sessions = vec![
            make_session("zero.log", bytes0.to_vec(), vec![], vec![], LtsSessionMeta::default()),
            make_session("one.log", bytes1.to_vec(), vec![], vec![], LtsSessionMeta::default()),
        ];

        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.manifest.format_version, LTS_FORMAT_VERSION, "format_version must equal LTS_FORMAT_VERSION");
        assert_eq!(loaded.manifest.sessions.len(), 2);

        assert_eq!(loaded.manifest.sessions[0].source_filename, "zero.log");
        assert_eq!(loaded.manifest.sessions[0].source_size, bytes0.len() as u64);

        assert_eq!(loaded.manifest.sessions[1].source_filename, "one.log");
        assert_eq!(loaded.manifest.sessions[1].source_size, bytes1.len() as u64);
    }

    /// V2: sessions with 0 bookmarks/analyses round-trip cleanly.
    #[test]
    fn lts_v2_empty_artifacts() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let sessions = vec![
            make_session("a.log", b"data a\n".to_vec(), vec![], vec![], LtsSessionMeta::default()),
            make_session("b.log", b"data b\n".to_vec(), vec![], vec![], LtsSessionMeta::default()),
        ];

        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.sessions.len(), 2);
        for sess in &loaded.sessions {
            assert!(sess.bookmarks.is_empty(), "bookmarks must be empty");
            assert!(sess.analyses.is_empty(), "analyses must be empty");
        }
    }

    /// V2: empty processor_yamls writes and reads back cleanly.
    #[test]
    fn lts_v2_no_processors() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let sessions = vec![make_session("noproc.log", b"content\n".to_vec(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert!(loaded.processor_manifest.processors.is_empty(), "no processors expected in manifest");
        assert!(loaded.processor_yamls.is_empty(), "no YAML entries expected");
    }

    // ─── New v3 editor-tab tests ─────────────────────────────────────────────

    /// Round-trip: two editor tabs (one scratch, one file-backed) survive write+read.
    #[test]
    fn lts_editor_tabs_roundtrip() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let tab_scratch = LtsEditorTab {
            label: "Scratch".to_string(),
            content: "let x = 1;\n".to_string(),
            view_mode: "text".to_string(),
            word_wrap: true,
            file_path: None,
        };
        let tab_file = LtsEditorTab {
            label: "main.rs".to_string(),
            content: "fn main() {}\n".to_string(),
            view_mode: "code".to_string(),
            word_wrap: false,
            file_path: Some("/home/user/project/src/main.rs".to_string()),
        };
        let editor_tabs = vec![tab_scratch, tab_file];

        let sessions = vec![make_session("test.log", b"data\n".to_vec(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &[], &editor_tabs).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.editor_tabs.len(), 2, "both editor tabs must survive round-trip");

        let t0 = &loaded.editor_tabs[0];
        assert_eq!(t0.label, "Scratch");
        assert_eq!(t0.content, "let x = 1;\n");
        assert_eq!(t0.view_mode, "text");
        assert!(t0.word_wrap);
        assert!(t0.file_path.is_none(), "scratch tab must have no file_path");

        let t1 = &loaded.editor_tabs[1];
        assert_eq!(t1.label, "main.rs");
        assert_eq!(t1.content, "fn main() {}\n");
        assert_eq!(t1.view_mode, "code");
        assert!(!t1.word_wrap);
        assert_eq!(t1.file_path.as_deref(), Some("/home/user/project/src/main.rs"));
    }

    /// Compatibility: a .lts file with no editor-tabs.json entry reads back as empty vec.
    #[test]
    fn lts_v2_compat() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        // Write with empty editor_tabs — no editor-tabs.json entry is created.
        let sessions = vec![make_session("compat.log", b"v2data\n".to_vec(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert!(
            loaded.editor_tabs.is_empty(),
            "reading a file with no editor-tabs.json must return empty vec"
        );
    }

    /// V2: large (100 KB) source bytes survive Stored compression byte-for-byte.
    #[test]
    fn lts_v2_source_bytes_preserved() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        // Generate 100 KB of pseudo-random bytes (not compressible)
        let source_bytes: Vec<u8> = (0u32..102_400)
            .map(|i| ((i.wrapping_mul(2_654_435_761) >> 24) & 0xFF) as u8)
            .collect();
        let original = source_bytes.clone();

        let sessions = vec![make_session("big.log", source_bytes, vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.sessions.len(), 1);
        let sess = &loaded.sessions[0];
        assert_eq!(sess.source_bytes.len(), original.len(), "byte count must match");
        assert_eq!(sess.source_bytes, original, "source bytes must be bit-for-bit identical after Stored round-trip");
    }

    // ─── Atomic-write regression tests ─────────────────────────────────────
    //
    // `write_lts` now builds the zip inside `workspace::write_atomic` instead
    // of truncating `dest` directly with `File::create`. Atomicity itself
    // (temp file -> fsync -> rename, dest untouched on any failure) is
    // structurally guaranteed and exhaustively covered by the generic
    // `write_atomic_*` tests in `workspace::mod.rs`
    // (`write_atomic_creates_new_file`, `write_atomic_replaces_existing_file`,
    // `write_atomic_failure_leaves_dest_untouched`). The tests below verify
    // `write_lts` actually routes through that primitive (no leftover temp
    // file, sibling naming) and that a full overwrite of a pre-existing file
    // at `dest` still round-trips correctly.

    /// After a successful `write_lts`, no sibling `.lts.tmp` temp file is left
    /// behind — proves the write goes through `write_atomic`'s
    /// create-temp/fsync/rename sequence rather than writing `dest` in place.
    #[test]
    fn lts_write_leaves_no_leftover_temp_file() {
        let dir = tempfile::tempdir().expect("tmpdir");
        let zip_path = dir.path().join("workspace.lts");
        let tmp_path = zip_path.with_extension("lts.tmp");

        let sessions = vec![make_session("test.log", b"data\n".to_vec(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        assert!(zip_path.exists(), "destination .lts file must exist after a successful write");
        assert!(!tmp_path.exists(), "no leftover .lts.tmp temp file should remain after a successful write");

        // Sanity: the file that landed at dest is a valid, readable .lts archive.
        let loaded = read_lts(&zip_path).expect("read_lts on freshly written file");
        assert_eq!(loaded.sessions.len(), 1);
    }

    /// A successful `write_lts` to a path that already holds a previous
    /// (unrelated, non-zip) file fully replaces its content — proving the
    /// rename-based swap performed by `write_atomic` overwrites the previous
    /// good save rather than corrupting it in place.
    #[test]
    fn lts_write_fully_replaces_previous_file_content() {
        let dir = tempfile::tempdir().expect("tmpdir");
        let zip_path = dir.path().join("workspace.lts");

        // Simulate a previous "good" save sitting at `dest` with unrelated bytes.
        std::fs::write(&zip_path, b"not-a-zip-previous-save").expect("seed previous file");

        let sessions = vec![make_session(
            "after.log",
            b"new content after overwrite\n".to_vec(),
            vec![make_bookmark(1)],
            vec![],
            LtsSessionMeta::default(),
        )];
        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts over existing file");

        let loaded = read_lts(&zip_path).expect("read_lts after overwrite");
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].source_filename, "after.log");
        assert_eq!(loaded.sessions[0].source_bytes, b"new content after overwrite\n");
        assert_eq!(loaded.sessions[0].bookmarks.len(), 1);
    }

    // ─── format_version validation ─────────────────────────────────────────

    /// Rewrite just `manifest.json` inside an already-written `.lts` zip with
    /// a tampered `format_version`, keeping every other entry untouched.
    fn rewrite_manifest_format_version(zip_path: &Path, format_version: u32) {
        // Read back everything so we can rebuild the zip with only the
        // manifest changed.
        let mut manifest: LtsManifest = {
            let file = File::open(zip_path).unwrap();
            let mut archive = zip::ZipArchive::new(file).unwrap();
            super::super::zip_read_json(&mut archive, "manifest.json").unwrap()
        };
        manifest.format_version = format_version;

        // Copy every other entry from the original archive verbatim, then
        // overwrite manifest.json with the tampered version.
        let orig_bytes = std::fs::read(zip_path).unwrap();
        let mut src_archive = zip::ZipArchive::new(std::io::Cursor::new(orig_bytes)).unwrap();

        let out_file = File::create(zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(out_file);
        let deflate = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for i in 0..src_archive.len() {
            let mut entry = src_archive.by_index(i).unwrap();
            let name = entry.name().to_string();
            if name == "manifest.json" {
                continue;
            }
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).unwrap();
            let opts = if entry.compression() == zip::CompressionMethod::Stored {
                SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored)
                    .large_file(true)
            } else {
                deflate
            };
            writer.start_file(&name, opts).unwrap();
            std::io::Write::write_all(&mut writer, &buf).unwrap();
        }

        writer.start_file("manifest.json", deflate).unwrap();
        serde_json::to_writer(&mut writer, &manifest).unwrap();
        writer.finish().unwrap();
    }

    /// A `.lts` file whose `format_version` is newer than this build
    /// understands must be rejected with a clear error rather than silently
    /// misparsed or accepted.
    #[test]
    fn read_lts_rejects_future_format_version() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let sessions = vec![make_session("test.log", b"data\n".to_vec(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        rewrite_manifest_format_version(&zip_path, LTS_FORMAT_VERSION + 1);

        let result = read_lts(&zip_path);
        assert!(result.is_err(), "a newer-than-supported format_version must be rejected");
        let err = result.err().expect("expected an error");
        assert!(
            err.contains("Unsupported .lts format version"),
            "error must explain the version mismatch, got: {err}"
        );
    }

    /// Older `.lts` manifests (format_version below current) must still be
    /// accepted — this reader stays backward-compatible via per-entry
    /// optionality rather than a hard version cutover, unlike `read_ltw`.
    #[test]
    fn read_lts_accepts_older_format_version() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let sessions = vec![make_session("old.log", b"legacy data\n".to_vec(), vec![], vec![], LtsSessionMeta::default())];
        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        assert!(LTS_FORMAT_VERSION > 1, "test assumes there is an older version to downgrade to");
        rewrite_manifest_format_version(&zip_path, LTS_FORMAT_VERSION - 1);

        let loaded = read_lts(&zip_path).expect("an older format_version must still be readable");
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].source_filename, "old.log");
        assert_eq!(loaded.sessions[0].source_bytes, b"legacy data\n");
    }
}
