pub mod app_state;
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

/// Sanitize a workspace name for use as a filesystem-safe `.ltw` filename.
///
/// Rules:
/// - Replace characters not in `[a-zA-Z0-9_. -]` with `-`
/// - Collapse consecutive `-` into one
/// - Trim leading/trailing `-` and whitespace
/// - Limit to 64 characters
/// - Empty result falls back to `"Untitled"`
pub fn sanitize_workspace_name(name: &str) -> String {
    // Replace disallowed characters with '-'
    let replaced: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == ' ' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();

    // Collapse consecutive '-' into one
    let mut collapsed = String::with_capacity(replaced.len());
    let mut last_was_dash = false;
    for c in replaced.chars() {
        if c == '-' {
            if !last_was_dash {
                collapsed.push(c);
            }
            last_was_dash = true;
        } else {
            collapsed.push(c);
            last_was_dash = false;
        }
    }

    // Trim leading/trailing '-' and whitespace
    let trimmed = collapsed.trim_matches(|c| c == '-' || c == ' ');

    // Limit to 64 characters (on char boundary)
    let limited = if trimmed.len() <= 64 {
        trimmed.to_string()
    } else {
        // Truncate at char boundary
        trimmed
            .char_indices()
            .take_while(|(i, _)| *i < 64)
            .map(|(_, c)| c)
            .collect::<String>()
    };

    if limited.is_empty() {
        "Untitled".to_string()
    } else {
        limited
    }
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

    // ─── sanitize_workspace_name tests ───────────────────────────────────────

    #[test]
    fn sanitize_normal_name() {
        assert_eq!(sanitize_workspace_name("My Workspace"), "My Workspace");
    }

    #[test]
    fn sanitize_special_chars() {
        assert_eq!(sanitize_workspace_name("debug/crash:2024"), "debug-crash-2024");
    }

    #[test]
    fn sanitize_unicode_falls_back() {
        // Unicode chars are replaced with '-', then collapsed/trimmed
        let result = sanitize_workspace_name("日本語テスト");
        // All non-ASCII chars become '-', consecutive collapse, then trimmed → "Untitled"
        assert_eq!(result, "Untitled");
    }

    #[test]
    fn sanitize_empty_string() {
        assert_eq!(sanitize_workspace_name(""), "Untitled");
    }

    #[test]
    fn sanitize_whitespace_only() {
        assert_eq!(sanitize_workspace_name("   "), "Untitled");
    }

    #[test]
    fn sanitize_long_name_truncated_to_64() {
        let long_name = "a".repeat(100);
        let result = sanitize_workspace_name(&long_name);
        assert_eq!(result.len(), 64);
        assert!(result.chars().all(|c| c == 'a'));
    }

    #[test]
    fn sanitize_leading_trailing_dashes() {
        assert_eq!(sanitize_workspace_name("---name---"), "name");
    }

    #[test]
    fn sanitize_consecutive_special_chars() {
        assert_eq!(sanitize_workspace_name("a///b"), "a-b");
    }

    #[test]
    fn sanitize_allowed_chars_preserved() {
        assert_eq!(sanitize_workspace_name("My_Log.2024 Analysis"), "My_Log.2024 Analysis");
    }

    #[test]
    fn sanitize_mixed_unicode_and_ascii() {
        // "hello日本world" → "hello-world" (unicode collapsed to single dash)
        assert_eq!(sanitize_workspace_name("hello日本world"), "hello-world");
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
