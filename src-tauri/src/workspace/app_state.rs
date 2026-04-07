//! Application state persistence — tracks the workspace list across app restarts.
//!
//! Stored as `app-state.json` in the Tauri app data directory.

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

/// Load the application state from disk. Returns default (empty) state if
/// the file doesn't exist or is corrupt.
pub fn load_app_state(path: &Path) -> AppStateFile {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => AppStateFile::default(),
    }
}

/// Save the application state to disk.
pub fn save_app_state(path: &Path, state: &AppStateFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize app state: {e}"))?;
    std::fs::write(path, json)
        .map_err(|e| format!("Failed to write app state to '{}': {e}", path.display()))
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
                },
                WorkspaceEntry {
                    id: "ws-2".into(),
                    name: "Untitled".into(),
                    ltw_path: None,
                    dirty: true,
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
            }],
            active_workspace_id: Some("ws-2".into()),
        };
        save_app_state(&path, &state2).unwrap();

        let loaded = load_app_state(&path);
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].name, "Second");
    }
}
