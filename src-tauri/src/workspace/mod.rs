pub mod app_state;
pub mod autosave;
pub mod lts;
pub mod ltw_v4;

use std::fs::File;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use zip::write::SimpleFileOptions;

/// Current time as milliseconds since UNIX epoch.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Compute SHA-256 hex digest of a string.
pub(crate) fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

/// Write a JSON-serializable value as a zip entry.
pub(crate) fn zip_write_json<T: serde::Serialize + ?Sized>(
    writer: &mut zip::ZipWriter<File>,
    path: &str,
    opts: SimpleFileOptions,
    value: &T,
) -> Result<(), String> {
    writer
        .start_file(path, opts)
        .map_err(|e| format!("Failed to start {path} entry: {e}"))?;
    serde_json::to_writer(writer, value)
        .map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Read and deserialize a JSON entry from a zip archive.
pub(crate) fn zip_read_json<T: DeserializeOwned>(
    archive: &mut zip::ZipArchive<File>,
    path: &str,
) -> Result<T, String> {
    let entry = archive
        .by_name(path)
        .map_err(|e| format!("{path} not found in archive: {e}"))?;
    serde_json::from_reader(entry)
        .map_err(|e| format!("Failed to parse {path}: {e}"))
}

/// Session-level metadata stored as `session-meta.json` inside the `.ltw` zip.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub active_processor_ids: Vec<String>,
    pub disabled_processor_ids: Vec<String>,
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

/// Delete the oldest `.ltw` files in `dir` so that at most `keep` files remain.
///
/// All errors are silently ignored — this is a non-fatal housekeeping operation.
pub fn evict_old_workspaces(dir: &Path, keep: usize) {
    // Cheap pre-count: statting + sorting every file runs on every flush, but the
    // common case is being under the keep limit. Count `.ltw` entries by
    // extension only — no `metadata()` calls — and bail before the expensive pass.
    let ltw_count = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "ltw"))
            .count(),
        Err(_) => return,
    };
    if ltw_count <= keep {
        return;
    }

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

    /// `evict_old_workspaces` only counts .ltw files, not other files in the directory.
    #[test]
    fn evict_ignores_non_ltw_files() {
        let tmp_dir = tempfile::tempdir().expect("tmpdir");
        let dir = tmp_dir.path();

        // Create 3 .ltw files.
        for i in 0..3 {
            std::fs::write(dir.join(format!("f{i}.ltw")), vec![b'x'; i + 1]).expect("write ltw");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // Create 2 non-.ltw files.
        std::fs::write(dir.join("readme.txt"), b"text file").expect("write txt");
        std::fs::write(dir.join("other.log"), b"log file").expect("write log");

        // Evict keeping only 2 .ltw files.
        evict_old_workspaces(dir, 2);

        let remaining: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        // Non-.ltw files must be untouched.
        assert!(remaining.contains(&"readme.txt".to_string()), "readme.txt must not be evicted");
        assert!(remaining.contains(&"other.log".to_string()), "other.log must not be evicted");

        // Exactly 2 .ltw files must remain.
        let ltw_count = remaining.iter().filter(|n| n.ends_with(".ltw")).count();
        assert_eq!(ltw_count, 2, "exactly 2 .ltw files must remain after eviction; got: {remaining:?}");

        // Total file count = 2 ltw + 2 non-ltw = 4.
        assert_eq!(remaining.len(), 4, "total file count must be 4; got: {remaining:?}");
    }
}
