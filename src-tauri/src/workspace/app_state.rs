//! Application state persistence — tracks the workspace list across app restarts.
//!
//! Stored as `app-state.json` in the Tauri app data directory.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// A workspace entry in the application state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    /// Unique identifier for this workspace.
    pub id: String,
    /// Display name (e.g. "wifi-debug", "Untitled").
    pub name: String,
    /// Path to the `.ltw` file, or null if not yet saved.
    pub ltw_path: Option<String>,
    /// Whether this workspace has unsaved changes.
    pub dirty: bool,
    /// Path to the app-data-dir auto-save `.ltw` (`workspaces/{id}.ltw`), or
    /// null if this workspace has never been auto-saved. Distinct from
    /// `ltw_path`, which tracks an explicit user save. `#[serde(default)]` so
    /// app-state.json files written before this field existed still parse.
    #[serde(default)]
    pub auto_save_path: Option<String>,
    /// Epoch-millis timestamp of the last completed auto-save, or null. Paired
    /// with `auto_save_path` — both are written together when a flush completes.
    #[serde(default)]
    pub last_auto_save_at: Option<i64>,
}

/// The full application state persisted to disk.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateFile {
    /// List of open workspaces.
    pub workspaces: Vec<WorkspaceEntry>,
    /// ID of the currently active workspace, or null if none.
    pub active_workspace_id: Option<String>,
}

const APP_STATE_FILENAME: &str = "app-state.json";

/// Resolve the path to `app-state.json` in the app data directory.
pub fn app_state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(data_dir.join(APP_STATE_FILENAME))
}

/// Load the application state from disk.
///
/// A *missing* file is the normal first-run case and quietly yields the
/// default (empty) state. A file that *exists* but fails to read or parse is
/// a corruption signal (e.g. a crash mid-write before atomic saves existed,
/// or disk damage) — silently discarding it would make the whole workspace
/// list vanish with no trace. Instead it is renamed aside (`.corrupt`) so the
/// data isn't lost, logged, and only then does loading fall back to default.
pub fn load_app_state(path: &Path) -> AppStateFile {
    match std::fs::read_to_string(path) {
        Ok(contents) => match serde_json::from_str(&contents) {
            Ok(state) => state,
            Err(e) => {
                log::warn!(
                    "[app-state] '{}' exists but failed to parse ({e}); backing up as corrupt and falling back to default",
                    path.display()
                );
                backup_corrupt_file(path);
                AppStateFile::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AppStateFile::default(),
        Err(e) => {
            log::warn!(
                "[app-state] '{}' exists but failed to read ({e}); backing up as corrupt and falling back to default",
                path.display()
            );
            backup_corrupt_file(path);
            AppStateFile::default()
        }
    }
}

/// Rename a corrupt/unreadable `app-state.json` aside to `app-state.json.corrupt`
/// so the raw bytes are preserved for inspection/recovery instead of being
/// silently discarded. Best-effort: if the rename itself fails, log and move on
/// — `load_app_state` still falls back to the default state either way.
fn backup_corrupt_file(path: &Path) {
    let backup_path = path.with_extension("json.corrupt");
    if let Err(e) = std::fs::rename(path, &backup_path) {
        log::warn!(
            "[app-state] failed to back up corrupt file '{}' to '{}': {e}",
            path.display(),
            backup_path.display()
        );
    }
}

/// Save the application state to disk. Written atomically (via
/// `workspace::write_atomic`): a crash or power loss mid-write can never
/// truncate the previously saved `app-state.json`.
pub fn save_app_state(path: &Path, state: &AppStateFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize app state: {e}"))?;
    crate::workspace::write_atomic(path, "json.tmp", |mut file| {
        file.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write app state to '{}': {e}", path.display()))?;
        Ok(file)
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn default_state_is_empty() {
        let state = AppStateFile::default();
        assert!(state.workspaces.is_empty());
        assert!(state.active_workspace_id.is_none());
    }

    #[test]
    fn round_trip_empty_state() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("app-state.json");

        let state = AppStateFile::default();
        save_app_state(&path, &state).unwrap();

        let loaded = load_app_state(&path);
        assert!(loaded.workspaces.is_empty());
        assert!(loaded.active_workspace_id.is_none());
    }

    #[test]
    fn round_trip_with_workspaces() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("app-state.json");

        let state = AppStateFile {
            workspaces: vec![
                WorkspaceEntry {
                    id: "ws-1".into(),
                    name: "wifi-debug".into(),
                    ltw_path: Some("/data/wifi-debug.ltw".into()),
                    dirty: false,
                    auto_save_path: None,
                    last_auto_save_at: None,
                },
                WorkspaceEntry {
                    id: "ws-2".into(),
                    name: "Untitled".into(),
                    ltw_path: None,
                    dirty: true,
                    auto_save_path: None,
                    last_auto_save_at: None,
                },
            ],
            active_workspace_id: Some("ws-1".into()),
        };

        save_app_state(&path, &state).unwrap();
        let loaded = load_app_state(&path);

        assert_eq!(loaded.workspaces.len(), 2);
        assert_eq!(loaded.workspaces[0].name, "wifi-debug");
        assert_eq!(loaded.workspaces[0].ltw_path.as_deref(), Some("/data/wifi-debug.ltw"));
        assert!(!loaded.workspaces[0].dirty);
        assert_eq!(loaded.workspaces[1].name, "Untitled");
        assert!(loaded.workspaces[1].ltw_path.is_none());
        assert!(loaded.workspaces[1].dirty);
        assert_eq!(loaded.active_workspace_id.as_deref(), Some("ws-1"));
    }

    #[test]
    fn round_trip_auto_save_fields() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("app-state.json");

        let state = AppStateFile {
            workspaces: vec![WorkspaceEntry {
                id: "ws-1".into(),
                name: "Untitled".into(),
                ltw_path: None,
                dirty: true,
                auto_save_path: Some("/data/workspaces/ws-1.ltw".into()),
                last_auto_save_at: Some(1_700_000_000_123),
            }],
            active_workspace_id: Some("ws-1".into()),
        };

        save_app_state(&path, &state).unwrap();
        let loaded = load_app_state(&path);

        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(
            loaded.workspaces[0].auto_save_path.as_deref(),
            Some("/data/workspaces/ws-1.ltw")
        );
        assert_eq!(loaded.workspaces[0].last_auto_save_at, Some(1_700_000_000_123));
    }

    #[test]
    fn old_file_without_auto_save_fields_parses() {
        // A field-less app-state.json written before auto_save_path /
        // last_auto_save_at existed must still deserialize (serde defaults).
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("app-state.json");
        let legacy = r#"{
            "workspaces": [
                { "id": "ws-1", "name": "wifi-debug", "ltwPath": "/data/wifi-debug.ltw", "dirty": false }
            ],
            "activeWorkspaceId": "ws-1"
        }"#;
        std::fs::write(&path, legacy).unwrap();

        let loaded = load_app_state(&path);
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].name, "wifi-debug");
        assert_eq!(loaded.workspaces[0].ltw_path.as_deref(), Some("/data/wifi-debug.ltw"));
        // Missing fields default to None rather than failing the parse.
        assert!(loaded.workspaces[0].auto_save_path.is_none());
        assert!(loaded.workspaces[0].last_auto_save_at.is_none());
    }

    #[test]
    fn load_missing_file_returns_default() {
        let path = Path::new("/nonexistent/app-state.json");
        let loaded = load_app_state(path);
        assert!(loaded.workspaces.is_empty());
    }

    #[test]
    fn load_corrupt_file_returns_default() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("app-state.json");
        std::fs::write(&path, "not valid json {{{").unwrap();

        let loaded = load_app_state(&path);
        assert!(loaded.workspaces.is_empty());
    }

    /// A corrupt-but-existing app-state.json must be renamed aside to
    /// `.corrupt` (never deleted) rather than silently discarded, so the raw
    /// bytes stay recoverable. `load_app_state` still returns the default.
    #[test]
    fn load_corrupt_file_is_backed_up_not_deleted() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("app-state.json");
        let corrupt_bytes = "not valid json {{{ definitely corrupt";
        std::fs::write(&path, corrupt_bytes).unwrap();

        let loaded = load_app_state(&path);

        // Falls back to default.
        assert!(loaded.workspaces.is_empty());
        assert!(loaded.active_workspace_id.is_none());

        // Original path no longer holds the corrupt content...
        assert!(!path.exists(), "corrupt file must be moved aside, not left in place");

        // ...but the corrupt bytes survive at the backup path.
        let backup_path = dir.path().join("app-state.json.corrupt");
        assert!(backup_path.exists(), "corrupt backup must be created");
        assert_eq!(std::fs::read_to_string(&backup_path).unwrap(), corrupt_bytes);
    }

    /// A missing file is the ordinary first-run case: default state, no
    /// spurious `.corrupt` backup created.
    #[test]
    fn load_missing_file_creates_no_backup() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("app-state.json");

        let loaded = load_app_state(&path);

        assert!(loaded.workspaces.is_empty());
        assert!(!dir.path().join("app-state.json.corrupt").exists());
    }

    #[test]
    fn save_overwrites_existing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("app-state.json");

        let state1 = AppStateFile {
            workspaces: vec![WorkspaceEntry {
                id: "ws-1".into(),
                name: "First".into(),
                ltw_path: None,
                dirty: false,
                auto_save_path: None,
                last_auto_save_at: None,
            }],
            active_workspace_id: Some("ws-1".into()),
        };
        save_app_state(&path, &state1).unwrap();

        let state2 = AppStateFile {
            workspaces: vec![WorkspaceEntry {
                id: "ws-2".into(),
                name: "Second".into(),
                ltw_path: Some("/path.ltw".into()),
                dirty: true,
                auto_save_path: None,
                last_auto_save_at: None,
            }],
            active_workspace_id: Some("ws-2".into()),
        };
        save_app_state(&path, &state2).unwrap();

        let loaded = load_app_state(&path);
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].name, "Second");
    }
}
