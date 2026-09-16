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

/// Durably write `dest`: content is written to a sibling temp file first,
/// flushed to disk, then moved into place with `std::fs::rename`. `rename`
/// replaces the destination atomically on the same volume (including NTFS on
/// Windows) — so a crash or power loss mid-write can only strand the temp
/// file, never truncate or corrupt the previous good `dest`.
///
/// `write_fn` receives the freshly-created temp file, writes its content, and
/// hands ownership back (e.g. `ZipWriter::finish()` already returns `W`). On
/// any failure the temp file is removed (best-effort) and `dest` is left
/// untouched.
///
/// `tmp_ext` becomes the temp file's extension, e.g. `"ltw.tmp"` for
/// `workspace.ltw` -> `workspace.ltw.tmp`.
pub(crate) fn write_atomic<F>(dest: &Path, tmp_ext: &str, write_fn: F) -> Result<(), String>
where
    F: FnOnce(File) -> Result<File, String>,
{
    let tmp_path = dest.with_extension(tmp_ext);

    let tmp_file = File::create(&tmp_path)
        .map_err(|e| format!("Failed to create temp file '{}': {e}", tmp_path.display()))?;

    let result = write_fn(tmp_file).and_then(|file| {
        file.sync_all()
            .map_err(|e| format!("Failed to flush temp file '{}': {e}", tmp_path.display()))
    });

    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }

    std::fs::rename(&tmp_path, dest).map_err(|e| {
        format!(
            "Failed to move temp file '{}' into place at '{}': {e}",
            tmp_path.display(),
            dest.display()
        )
    })
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

/// True when `stem` (a `.ltw` filename with its extension stripped) matches
/// an id shape the auto-saver has ever produced for its id-keyed
/// `workspaces/{workspace_id}.ltw` file — never a name a person chose when
/// explicitly saving a `.ltw` into this same directory.
///
/// Two shapes count, per a `git log`/`git log -S` search of this
/// repository's history of workspace-id generation (see the
/// `4ffb7495`-tagged bug-fix commit's `root-cause` note for the exact
/// commands run):
///
/// - **The only generator this codebase has ever shipped**: `workspace_id`
///   comes from `crypto.randomUUID()` on the frontend
///   (`src-shared/bridge/workspaceTypes.ts::createEmptyWorkspace`) — a
///   lowercase, hyphenated UUID string, e.g.
///   `3fa85f64-5717-4562-b3fc-2c963f66afa6` (8-4-4-4-12 hex groups).
/// - **A legacy bare-hex id observed in real user app-data directories**
///   (e.g. `375d922faf1d3501.ltw`) that predates this repository's history:
///   exactly 16 lowercase hex characters, no separators. No generator for
///   this shape exists anywhere in `git log --all`, so it is included
///   defensively rather than confirmed — but the risk of treating it as an
///   eviction candidate is one-sided and safe: nobody names a workspace file
///   a bare 16-digit hex string by hand, so this can never falsely protect
///   (or falsely evict) a real user-chosen filename.
///
/// A user-chosen filename like `my-notes.ltw` or `presentation.ltw` matches
/// neither shape and is therefore never an eviction candidate, regardless of
/// age — it also never counts against `keep`.
fn is_autosave_id_stem(stem: &str) -> bool {
    is_uuid_v4_shaped(stem) || is_legacy_hex_id(stem)
}

/// `8-4-4-4-12` lowercase hex groups, exactly what `crypto.randomUUID()` produces.
fn is_uuid_v4_shaped(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, &b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

/// Exactly 16 lowercase hex characters, no separators — the legacy shape.
fn is_legacy_hex_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Delete the oldest auto-saved `.ltw` files in `dir` so that at most `keep`
/// of them remain.
///
/// Two independent protections keep this from ever destroying a workspace
/// file it shouldn't:
///
/// 1. **Never an id-pattern mismatch.** Only filenames matching
///    [`is_autosave_id_stem`] — the shapes the auto-saver itself has ever
///    produced — are eviction candidates at all; a `.ltw` a user explicitly
///    saved into this directory under a name of their own choosing (e.g.
///    `my-notes.ltw`) is invisible to this function, never counted against
///    `keep` and never deleted no matter how old it is.
/// 2. **Never a live `auto_save_path`.** Even an id-pattern file is skipped
///    if it is currently recorded as a workspace's `auto_save_path` in
///    `app-state.json` at `app_state_path` — e.g. opened but left untouched
///    while *other* workspaces churn through their own auto-saves. The
///    `EVICT_KEEP`-per-flush design assumes an active workspace's file is
///    "always among the newest" because it gets rewritten in place on every
///    flush — true only while that workspace keeps generating flushes. A
///    workspace with zero mutations since it was opened never re-flushes, so
///    its file's mtime can age out from under it purely because unrelated
///    workspaces kept flushing; deleting it would silently invalidate
///    `auto_save_path` with nothing to notice or repair the dangling pointer.
///
/// Both kinds of protected files are excluded from the eviction candidate
/// pool entirely (kept in addition to `keep`, not counted against it), so
/// genuinely stale, unreferenced, id-pattern files are still trimmed down to
/// `keep` exactly as before.
///
/// All errors are silently ignored — this is a non-fatal housekeeping operation.
pub fn evict_old_workspaces(dir: &Path, keep: usize, app_state_path: &Path) {
    // Cheap pre-count: statting + sorting every file runs on every flush, but the
    // common case is being under the keep limit. Count only id-pattern `.ltw`
    // entries (no `metadata()` calls) and bail before the expensive pass — a
    // directory full of user-named `.ltw` files never triggers the full scan.
    let ltw_count = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|e| {
                e.path().extension().is_some_and(|ext| ext == "ltw")
                    && e.path().file_stem().and_then(|s| s.to_str()).is_some_and(is_autosave_id_stem)
            })
            .count(),
        Err(_) => return,
    };
    if ltw_count <= keep {
        return;
    }

    let protected: std::collections::HashSet<PathBuf> = app_state::load_app_state(app_state_path)
        .workspaces
        .into_iter()
        .filter_map(|w| w.auto_save_path)
        .map(PathBuf::from)
        .collect();

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let is_id_pattern =
                path.file_stem().and_then(|s| s.to_str()).is_some_and(is_autosave_id_stem);
            if path.extension().is_some_and(|ext| ext == "ltw") && is_id_pattern && !protected.contains(&path) {
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
    use std::io::Write as _;

    /// A UUID-v4-shaped `.ltw` filename distinguished by `i` — the id shape
    /// the auto-saver actually produces, so eviction tests exercise the
    /// real id-pattern gate rather than accidentally relying on filenames
    /// `evict_old_workspaces` would now treat as user-named (and therefore
    /// never touch).
    fn id_ltw_name(i: usize) -> String {
        format!("00000000-0000-4000-8000-{i:012x}.ltw")
    }

    // --- write_atomic -------------------------------------------------------

    /// A fresh destination (no prior file) is created with the written content.
    #[test]
    fn write_atomic_creates_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("state.json");

        write_atomic(&dest, "json.tmp", |mut f| {
            f.write_all(b"hello").map_err(|e| e.to_string())?;
            Ok(f)
        })
        .unwrap();

        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "hello");
        // No leftover temp file.
        assert!(!dir.path().join("state.json.tmp").exists());
    }

    /// A successful write replaces existing content in place; the previous
    /// content is fully gone (rename, not append).
    #[test]
    fn write_atomic_replaces_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("state.json");
        std::fs::write(&dest, "old-content-longer-than-new").unwrap();

        write_atomic(&dest, "json.tmp", |mut f| {
            f.write_all(b"new").map_err(|e| e.to_string())?;
            Ok(f)
        })
        .unwrap();

        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
    }

    /// If `write_fn` fails, the destination (a prior good save) is left
    /// completely untouched, and the temp file is cleaned up.
    #[test]
    fn write_atomic_failure_leaves_dest_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("state.json");
        std::fs::write(&dest, "good-save").unwrap();

        let result = write_atomic(&dest, "json.tmp", |_f| Err("boom".to_string()));

        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "good-save");
        assert!(!dir.path().join("state.json.tmp").exists(), "temp file must be cleaned up");
    }

    /// `evict_old_workspaces` deletes the oldest files when over the keep limit.
    #[test]
    fn evict_keeps_newest() {
        let tmp_dir = tempfile::tempdir().expect("tmpdir");
        let dir = tmp_dir.path();

        // Create 5 id-pattern files with distinct modification times using
        // different content sizes to ensure they are distinct on the filesystem.
        let names: Vec<String> = (0..5).map(id_ltw_name).collect();
        for (i, name) in names.iter().enumerate() {
            let path = dir.join(name);
            std::fs::write(&path, vec![b'x'; i + 1]).expect("write");
            // Small sleep to ensure distinct mtime on coarse-grained filesystems.
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        evict_old_workspaces(dir, 3, &dir.join("app-state.json"));

        let remaining: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        assert_eq!(remaining.len(), 3, "expected 3 files, got {remaining:?}");

        // The 3 newest files (index 2, 3, 4) must survive.
        for name in &[id_ltw_name(2), id_ltw_name(3), id_ltw_name(4)] {
            assert!(
                remaining.contains(name),
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

        evict_old_workspaces(dir, 5, &dir.join("app-state.json"));

        let count = std::fs::read_dir(dir).unwrap().count();
        assert_eq!(count, 2);
    }

    /// `evict_old_workspaces` only counts .ltw files, not other files in the directory.
    #[test]
    fn evict_ignores_non_ltw_files() {
        let tmp_dir = tempfile::tempdir().expect("tmpdir");
        let dir = tmp_dir.path();

        // Create 3 id-pattern .ltw files.
        for i in 0..3 {
            std::fs::write(dir.join(id_ltw_name(i)), vec![b'x'; i + 1]).expect("write ltw");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // Create 2 non-.ltw files.
        std::fs::write(dir.join("readme.txt"), b"text file").expect("write txt");
        std::fs::write(dir.join("other.log"), b"log file").expect("write log");

        // Evict keeping only 2 .ltw files.
        evict_old_workspaces(dir, 2, &dir.join("app-state.json"));

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

    /// A file recorded as a workspace's `auto_save_path` in app-state.json
    /// must survive eviction even when it is the oldest file in the
    /// directory — this is the open-but-untouched-workspace scenario:
    /// its file never gets refreshed by its own flushes, but it is still a
    /// live pointer that app-state.json depends on. Genuinely stale,
    /// unreferenced files are still trimmed down to `keep` as before.
    #[test]
    fn evict_never_deletes_a_referenced_auto_save_path() {
        let tmp_dir = tempfile::tempdir().expect("tmpdir");
        let dir = tmp_dir.path();
        let app_state_path = tmp_dir.path().join("app-state.json");

        // 5 id-pattern files, oldest to newest: index 0 (oldest) .. index 4 (newest).
        let names: Vec<String> = (0..5).map(id_ltw_name).collect();
        for (i, name) in names.iter().enumerate() {
            std::fs::write(dir.join(name), vec![b'x'; i + 1]).expect("write");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // app-state.json records index 0's file — the OLDEST file, otherwise
        // the very first candidate for eviction — as an open workspace's live
        // auto_save_path.
        let protected_path = dir.join(id_ltw_name(0));
        let state = app_state::AppStateFile {
            workspaces: vec![app_state::WorkspaceEntry {
                id: "ws-open".to_string(),
                name: "Open".to_string(),
                ltw_path: None,
                dirty: false,
                auto_save_path: Some(protected_path.to_string_lossy().to_string()),
                last_auto_save_at: Some(123),
            }],
            active_workspace_id: Some("ws-open".to_string()),
        };
        app_state::save_app_state(&app_state_path, &state).expect("write app-state.json");

        // Keep 3 — without protection this would evict file0 and file1.
        evict_old_workspaces(dir, 3, &app_state_path);

        let remaining: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        assert!(
            remaining.contains(&id_ltw_name(0)),
            "index 0's file is a live auto_save_path and must survive eviction; remaining: {remaining:?}"
        );
        // The 3 newest unreferenced files also survive under `keep = 3`.
        for i in [2, 3, 4] {
            assert!(
                remaining.contains(&id_ltw_name(i)),
                "index {i}'s file should survive eviction; remaining: {remaining:?}"
            );
        }
        // index 1's file is genuinely stale and unreferenced — still evicted.
        assert!(
            !remaining.contains(&id_ltw_name(1)),
            "index 1's file is unreferenced and stale; it should still be evicted; remaining: {remaining:?}"
        );
    }

    /// A user-chosen `.ltw` filename (e.g. saved explicitly via a save-as
    /// dialog into this same directory) never matches the auto-saver's id
    /// shapes, so it must never be an eviction candidate — no matter how old
    /// it is, and even though it sits alongside id-pattern files that do get
    /// trimmed down to `keep`.
    #[test]
    fn evict_never_touches_a_user_named_ltw_file() {
        let tmp_dir = tempfile::tempdir().expect("tmpdir");
        let dir = tmp_dir.path();

        // A user-named file, written first so it is the OLDEST file in the
        // directory — otherwise the first eviction candidate by mtime alone.
        std::fs::write(dir.join("my-notes.ltw"), b"user content").expect("write user file");
        std::thread::sleep(std::time::Duration::from_millis(10));

        // 5 id-pattern files, newer than the user file.
        let names: Vec<String> = (0..5).map(id_ltw_name).collect();
        for (i, name) in names.iter().enumerate() {
            std::fs::write(dir.join(name), vec![b'x'; i + 1]).expect("write");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // Keep 3 id-pattern files — trims the 5 id-pattern files down to 3,
        // and must leave the user-named file untouched throughout.
        evict_old_workspaces(dir, 3, &dir.join("app-state.json"));

        let remaining: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        assert!(
            remaining.contains(&"my-notes.ltw".to_string()),
            "my-notes.ltw is user-named and must never be evicted; remaining: {remaining:?}"
        );
        // The id-pattern files still trim down to `keep = 3` (the 3 newest).
        let id_pattern_count = remaining.iter().filter(|n| n != &"my-notes.ltw").count();
        assert_eq!(id_pattern_count, 3, "id-pattern files must still trim to keep=3; remaining: {remaining:?}");
        for i in [2, 3, 4] {
            assert!(
                remaining.contains(&id_ltw_name(i)),
                "index {i}'s id-pattern file should survive eviction; remaining: {remaining:?}"
            );
        }
    }
}
