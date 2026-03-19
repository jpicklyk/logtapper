pub mod lts;

use std::fs::File;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::core::analysis::AnalysisArtifact;
use crate::core::bookmark::Bookmark;

pub const WORKSPACE_FORMAT_VERSION: u32 = 1;

/// Manifest stored as `manifest.json` inside the `.ltw` zip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceManifest {
    pub format_version: u32,
    pub source_file_path: String,
    /// Milliseconds since UNIX epoch.
    pub saved_at: i64,
}

/// Session-level metadata stored as `session-meta.json` inside the `.ltw` zip.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub active_processor_ids: Vec<String>,
    pub disabled_processor_ids: Vec<String>,
}

/// In-memory representation of a loaded `.ltw` workspace.
pub struct WorkspaceData {
    pub manifest: WorkspaceManifest,
    pub bookmarks: Vec<Bookmark>,
    pub analyses: Vec<AnalysisArtifact>,
    pub session_meta: SessionMeta,
}

/// Save a workspace to the given zip path.
///
/// Writes four entries: `manifest.json`, `bookmarks.json`, `analyses.json`,
/// and `session-meta.json` using Deflate compression.
pub fn save_workspace(
    zip_path: &Path,
    file_path: &str,
    bookmarks: &[Bookmark],
    analyses: &[AnalysisArtifact],
    meta: &SessionMeta,
) -> Result<(), String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let manifest = WorkspaceManifest {
        format_version: WORKSPACE_FORMAT_VERSION,
        source_file_path: file_path.to_string(),
        saved_at: now_ms,
    };

    let out_file = File::create(zip_path)
        .map_err(|e| format!("Failed to create workspace file '{}': {e}", zip_path.display()))?;
    let mut writer = zip::ZipWriter::new(out_file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // manifest.json
    writer
        .start_file("manifest.json", opts)
        .map_err(|e| format!("Failed to start manifest.json entry: {e}"))?;
    serde_json::to_writer(&mut writer, &manifest)
        .map_err(|e| format!("Failed to write manifest.json: {e}"))?;

    // bookmarks.json
    writer
        .start_file("bookmarks.json", opts)
        .map_err(|e| format!("Failed to start bookmarks.json entry: {e}"))?;
    serde_json::to_writer(&mut writer, bookmarks)
        .map_err(|e| format!("Failed to write bookmarks.json: {e}"))?;

    // analyses.json
    writer
        .start_file("analyses.json", opts)
        .map_err(|e| format!("Failed to start analyses.json entry: {e}"))?;
    serde_json::to_writer(&mut writer, analyses)
        .map_err(|e| format!("Failed to write analyses.json: {e}"))?;

    // session-meta.json
    writer
        .start_file("session-meta.json", opts)
        .map_err(|e| format!("Failed to start session-meta.json entry: {e}"))?;
    serde_json::to_writer(&mut writer, meta)
        .map_err(|e| format!("Failed to write session-meta.json: {e}"))?;

    writer
        .finish()
        .map_err(|e| format!("Failed to finalise workspace zip: {e}"))?;

    Ok(())
}

/// Load a workspace from a `.ltw` zip file.
pub fn load_workspace(zip_path: &Path) -> Result<WorkspaceData, String> {
    let file = File::open(zip_path)
        .map_err(|e| format!("Failed to open workspace '{}': {e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid workspace zip '{}': {e}", zip_path.display()))?;

    let manifest: WorkspaceManifest = {
        let entry = archive
            .by_name("manifest.json")
            .map_err(|e| format!("manifest.json not found in workspace: {e}"))?;
        serde_json::from_reader(entry)
            .map_err(|e| format!("Failed to parse manifest.json: {e}"))?
    };

    let bookmarks: Vec<Bookmark> = {
        let entry = archive
            .by_name("bookmarks.json")
            .map_err(|e| format!("bookmarks.json not found in workspace: {e}"))?;
        serde_json::from_reader(entry)
            .map_err(|e| format!("Failed to parse bookmarks.json: {e}"))?
    };

    let analyses: Vec<AnalysisArtifact> = {
        let entry = archive
            .by_name("analyses.json")
            .map_err(|e| format!("analyses.json not found in workspace: {e}"))?;
        serde_json::from_reader(entry)
            .map_err(|e| format!("Failed to parse analyses.json: {e}"))?
    };

    let session_meta: SessionMeta = {
        let entry = archive
            .by_name("session-meta.json")
            .map_err(|e| format!("session-meta.json not found in workspace: {e}"))?;
        serde_json::from_reader(entry)
            .map_err(|e| format!("Failed to parse session-meta.json: {e}"))?
    };

    Ok(WorkspaceData {
        manifest,
        bookmarks,
        analyses,
        session_meta,
    })
}

/// Derive a stable `.ltw` filename from a source file path.
///
/// Takes the SHA-256 of the UTF-8 bytes of `file_path` and returns the first
/// 8 bytes encoded as lowercase hex followed by `.ltw`.
pub fn path_to_workspace_name(file_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(file_path.as_bytes());
    let result = hasher.finalize();
    format!("{}.ltw", hex::encode(&result[..8]))
}

/// Return (and create if needed) the application workspace storage directory.
pub fn workspace_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let dir = data_dir.join("workspaces");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create workspaces dir: {e}"))?;
    Ok(dir)
}

/// Return the full path to the `.ltw` file for the given source file path.
pub fn workspace_path_for(app: &tauri::AppHandle, file_path: &str) -> Result<PathBuf, String> {
    Ok(workspace_dir(app)?.join(path_to_workspace_name(file_path)))
}

/// Delete the oldest `.ltw` files in `dir` so that at most `keep` files remain.
///
/// All errors are silently ignored — this is a non-fatal housekeeping operation.
pub fn evict_old_workspaces(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().is_some_and(|ext| ext == "ltw") {
                let mtime = e.metadata().ok()?.modified().ok()?;
                Some((mtime, path))
            } else {
                None
            }
        })
        .collect();

    // Sort newest first.
    files.sort_by(|a, b| b.0.cmp(&a.0));

    // Remove files beyond the keep limit.
    for (_, path) in files.iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
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

    /// Full round-trip: save then load a workspace and verify all fields.
    #[test]
    fn workspace_roundtrip() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        // Drop the file handle so the zip writer can create/truncate it.
        drop(tmp);

        let bookmarks = vec![make_bookmark(10), make_bookmark(20)];
        let analyses = vec![make_artifact()];
        let meta = SessionMeta {
            active_processor_ids: vec!["proc-a".to_string()],
            disabled_processor_ids: vec!["proc-b".to_string()],
        };

        save_workspace(&zip_path, "/logs/test.log", &bookmarks, &analyses, &meta)
            .expect("save_workspace");

        let loaded = load_workspace(&zip_path).expect("load_workspace");

        assert_eq!(loaded.manifest.format_version, WORKSPACE_FORMAT_VERSION);
        assert_eq!(loaded.manifest.source_file_path, "/logs/test.log");
        assert!(loaded.manifest.saved_at > 0);

        assert_eq!(loaded.bookmarks.len(), 2);
        assert_eq!(loaded.bookmarks[0].line_number, 10);
        assert_eq!(loaded.bookmarks[1].line_number, 20);

        assert_eq!(loaded.analyses.len(), 1);
        assert_eq!(loaded.analyses[0].title, "Test Analysis");

        assert_eq!(
            loaded.session_meta.active_processor_ids,
            vec!["proc-a".to_string()]
        );
        assert_eq!(
            loaded.session_meta.disabled_processor_ids,
            vec!["proc-b".to_string()]
        );
    }

    /// Empty collections round-trip cleanly.
    #[test]
    fn workspace_roundtrip_empty() {
        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let meta = SessionMeta::default();
        save_workspace(&zip_path, "/logs/empty.log", &[], &[], &meta)
            .expect("save_workspace");

        let loaded = load_workspace(&zip_path).expect("load_workspace");
        assert!(loaded.bookmarks.is_empty());
        assert!(loaded.analyses.is_empty());
        assert!(loaded.session_meta.active_processor_ids.is_empty());
    }

    /// `path_to_workspace_name` must return a consistent value for the same input.
    #[test]
    fn workspace_name_is_deterministic() {
        let name1 = path_to_workspace_name("/data/logs/device.log");
        let name2 = path_to_workspace_name("/data/logs/device.log");
        assert_eq!(name1, name2);
        assert!(name1.ends_with(".ltw"));
        // 8 bytes = 16 hex chars + ".ltw" = 20 chars total
        assert_eq!(name1.len(), 20);
    }

    /// Different paths must produce different names.
    #[test]
    fn workspace_name_differs_for_different_paths() {
        let a = path_to_workspace_name("/logs/file_a.log");
        let b = path_to_workspace_name("/logs/file_b.log");
        assert_ne!(a, b);
    }

    /// `evict_old_workspaces` deletes the oldest files when over the keep limit.
    #[test]
    fn evict_keeps_newest() {
        let tmp_dir = tempfile::tempdir().expect("tmpdir");
        let dir = tmp_dir.path();

        // Create 5 files with distinct modification times using different content sizes
        // to ensure they are distinct on the filesystem.
        let names: Vec<String> = (0..5).map(|i| format!("file{i}.ltw")).collect();
        for (i, name) in names.iter().enumerate() {
            let path = dir.join(name);
            std::fs::write(&path, vec![b'x'; i + 1]).expect("write");
            // Small sleep to ensure distinct mtime on coarse-grained filesystems.
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        evict_old_workspaces(dir, 3);

        let remaining: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        assert_eq!(remaining.len(), 3, "expected 3 files, got {remaining:?}");

        // The 3 newest files (file2, file3, file4) must survive.
        for name in &["file2.ltw", "file3.ltw", "file4.ltw"] {
            assert!(
                remaining.contains(&(*name).to_string()),
                "{name} should have survived eviction; remaining: {remaining:?}"
            );
        }
    }

    /// `evict_old_workspaces` is a no-op when the count is within the limit.
    #[test]
    fn evict_noop_when_under_limit() {
        let tmp_dir = tempfile::tempdir().expect("tmpdir");
        let dir = tmp_dir.path();

        for i in 0..2 {
            std::fs::write(dir.join(format!("f{i}.ltw")), b"data").expect("write");
        }

        evict_old_workspaces(dir, 5);

        let count = std::fs::read_dir(dir).unwrap().count();
        assert_eq!(count, 2);
    }
}
