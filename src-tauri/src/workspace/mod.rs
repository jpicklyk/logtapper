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

use crate::core::analysis::AnalysisArtifact;
use crate::core::bookmark::Bookmark;

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
    let manifest = WorkspaceManifest {
        format_version: WORKSPACE_FORMAT_VERSION,
        source_file_path: file_path.to_string(),
        saved_at: now_ms(),
    };

    let out_file = File::create(zip_path)
        .map_err(|e| format!("Failed to create workspace file '{}': {e}", zip_path.display()))?;
    let mut writer = zip::ZipWriter::new(out_file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip_write_json(&mut writer, "manifest.json", opts, &manifest)?;
    zip_write_json(&mut writer, "bookmarks.json", opts, bookmarks)?;
    zip_write_json(&mut writer, "analyses.json", opts, analyses)?;
    zip_write_json(&mut writer, "session-meta.json", opts, meta)?;

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

    let manifest: WorkspaceManifest = zip_read_json(&mut archive, "manifest.json")?;
    let bookmarks: Vec<Bookmark> = zip_read_json(&mut archive, "bookmarks.json")?;
    let analyses: Vec<AnalysisArtifact> = zip_read_json(&mut archive, "analyses.json")?;
    let session_meta: SessionMeta = zip_read_json(&mut archive, "session-meta.json")?;

    Ok(WorkspaceData {
        manifest,
        bookmarks,
        analyses,
        session_meta,
    })
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

    // ─── path_to_workspace_name tests ────────────────────────────────────────

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

    /// Round-trip with realistic bookmark data (line ranges, snippets, tags) and multi-section analysis.
    #[test]
    fn workspace_roundtrip_with_bookmarks_and_analyses() {
        use crate::core::analysis::{AnalysisSection, Severity, SourceReference};

        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        // Bookmark with all optional fields populated.
        let bm = Bookmark {
            id: "bm-rich".to_string(),
            session_id: "sess-1".to_string(),
            line_number: 100,
            line_number_end: Some(120),
            snippet: Some(vec!["line A".to_string(), "line B".to_string()]),
            category: Some("crash".to_string()),
            tags: Some(vec!["important".to_string(), "regression".to_string()]),
            label: "Rich bookmark".to_string(),
            note: "Detailed note here".to_string(),
            created_by: CreatedBy::User,
            created_at: 99999,
        };

        // Analysis with two sections and source references.
        let artifact = AnalysisArtifact {
            id: "art-rich".to_string(),
            session_id: "sess-1".to_string(),
            title: "Multi-section analysis".to_string(),
            created_at: 88888,
            sections: vec![
                AnalysisSection {
                    heading: "Root cause".to_string(),
                    body: "The service crashed because of a null pointer.".to_string(),
                    references: vec![
                        SourceReference {
                            line_number: 42,
                            end_line: Some(45),
                            label: "Crash site".to_string(),
                            highlight_type: crate::core::analysis::HighlightType::Anchor,
                        },
                    ],
                    severity: Some(Severity::Critical),
                },
                AnalysisSection {
                    heading: "Context".to_string(),
                    body: "The service had been running for 3 hours.".to_string(),
                    references: vec![],
                    severity: Some(Severity::Info),
                },
            ],
        };

        let meta = SessionMeta {
            active_processor_ids: vec!["proc-x".to_string()],
            disabled_processor_ids: vec![],
        };

        save_workspace(&zip_path, "/device/logs/crash.log", &[bm], &[artifact], &meta)
            .expect("save_workspace");

        let loaded = load_workspace(&zip_path).expect("load_workspace");

        // Bookmark fields survive.
        assert_eq!(loaded.bookmarks.len(), 1);
        let lb = &loaded.bookmarks[0];
        assert_eq!(lb.id, "bm-rich");
        assert_eq!(lb.line_number, 100);
        assert_eq!(lb.line_number_end, Some(120));
        assert_eq!(lb.snippet.as_deref(), Some(vec!["line A".to_string(), "line B".to_string()].as_slice()));
        assert_eq!(lb.category.as_deref(), Some("crash"));
        assert_eq!(lb.tags.as_deref(), Some(vec!["important".to_string(), "regression".to_string()].as_slice()));
        assert_eq!(lb.note, "Detailed note here");

        // Analysis sections survive.
        assert_eq!(loaded.analyses.len(), 1);
        let la = &loaded.analyses[0];
        assert_eq!(la.title, "Multi-section analysis");
        assert_eq!(la.sections.len(), 2);
        assert_eq!(la.sections[0].heading, "Root cause");
        assert_eq!(la.sections[0].references.len(), 1);
        assert_eq!(la.sections[0].references[0].line_number, 42);
        assert_eq!(la.sections[0].references[0].end_line, Some(45));
        assert_eq!(la.sections[1].heading, "Context");
        assert!(la.sections[1].references.is_empty());
    }

    /// `path_to_workspace_name` with different path separators produces different names
    /// (since it hashes the raw bytes of the string — different strings → different hashes).
    #[test]
    fn workspace_name_windows_vs_unix_paths() {
        let unix_path = "/data/logs/device.log";
        let windows_path = "C:\\data\\logs\\device.log";
        let name_unix = path_to_workspace_name(unix_path);
        let name_windows = path_to_workspace_name(windows_path);
        // Different path strings must produce different names.
        assert_ne!(
            name_unix, name_windows,
            "different path separator styles must hash to different names"
        );
        // Both must still have valid .ltw format.
        assert!(name_unix.ends_with(".ltw"));
        assert!(name_windows.ends_with(".ltw"));
        assert_eq!(name_unix.len(), 20);
        assert_eq!(name_windows.len(), 20);
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
