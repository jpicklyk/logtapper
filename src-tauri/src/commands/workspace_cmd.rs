//! Tauri adapters for workspace lifecycle operations.
//!
//! Every command here builds a `Caller::Ui` [`ServiceCtx`] via
//! [`crate::commands::adapters::ui_ctx`], calls one
//! [`crate::services::workspace`] function and converts its error to a
//! `String`. The implementations — save, auto-save, envelope sync, switch,
//! load, restore, and `app-state.json` persistence — live in the service.
//!
//! Command names, argument shapes, return shapes and emitted events are
//! unchanged from before the extraction. The desktop's workspace save/restore
//! sequence is the most load-bearing user workflow in the app; the option and
//! result structs moved module (to `services::workspace`) but not shape, and
//! `ts-rs` names generated files after the type, not its path, so
//! `src-next/bridge/generated/**` is byte-identical either way.
//!
//! The one intentional behavioural change is that `load_workspace_v4` now
//! routes through `services::policy::authorize_open`, whose `Ui` branch
//! canonicalises the path (`simplified_path`) instead of passing the dialog
//! string through verbatim — the same change `services::sessions::open` made
//! for file opens in WP-6, and for the same reason (one gate, one spelling,
//! for both callers).

use tauri::AppHandle;

use crate::commands::adapters::ui_ctx;
use crate::services::workspace as svc;
use crate::workspace::app_state::{AppStateFile, WorkspaceEntry};

pub use crate::services::workspace::{
    AutoSaveWorkspaceOptions, DeleteWorkspaceRequest, LoadWorkspaceResult, LoadWorkspaceSessionData,
    RenameWorkspaceRequest, RestoreSessionOptions, SaveWorkspaceOptions, SyncWorkspaceEnvelopeOptions,
};

// ---------------------------------------------------------------------------
// Save / auto-save
// ---------------------------------------------------------------------------

/// Collect all open sessions and their artifacts, then write a `.ltw` v4 file.
#[tauri::command]
pub async fn save_workspace_v4(app: AppHandle, options: SaveWorkspaceOptions) -> Result<(), String> {
    Ok(svc::save(&ui_ctx(&app), options)?)
}

/// Auto-save the active workspace to `app_data_dir/workspaces/{workspace_id}.ltw`.
/// Returns the path where it was saved.
#[tauri::command]
pub async fn auto_save_workspace(
    app: AppHandle,
    options: AutoSaveWorkspaceOptions,
) -> Result<String, String> {
    Ok(svc::auto_save(&ui_ctx(&app), options)?)
}

/// Refresh the backend workspace-envelope cache from the frontend without
/// writing any file.
#[tauri::command]
pub async fn sync_workspace_envelope(
    app: AppHandle,
    options: SyncWorkspaceEnvelopeOptions,
) -> Result<(), String> {
    Ok(svc::sync_envelope(&ui_ctx(&app), options)?)
}

/// Open the backend autosave switch-suppression window at the start of a
/// workspace teardown (new / open / switch).
#[tauri::command]
pub async fn begin_workspace_switch(app: AppHandle) -> Result<(), String> {
    Ok(svc::begin_switch(&ui_ctx(&app))?)
}

// ---------------------------------------------------------------------------
// Load / restore
// ---------------------------------------------------------------------------

/// Read a `.ltw` v4 file and return its contents for frontend orchestration.
///
/// Deliberately stops at reading: the *restore rules* — which candidate to
/// trust, how to pair manifest entries with the sessions an open produced,
/// drift detection, auto-run scheduling — stay in
/// `src-next/hooks/workspace/*.ts`. The agent-side end-to-end open
/// (`services::workspace::load_and_restore`) exists only because an agent has
/// no frontend to run them.
#[tauri::command]
pub async fn load_workspace_v4(app: AppHandle, path: String) -> Result<LoadWorkspaceResult, String> {
    Ok(svc::load(&ui_ctx(&app), &path)?)
}

/// Restore bookmarks, analyses, and pipeline meta for a session that was just
/// loaded as part of a `.ltw` workspace restore. Emits `workspace-restored`
/// (and `analysis-update` for a legacy per-session analyses payload) — see
/// [`crate::services::workspace::restore_session`] for the full contract.
#[tauri::command]
pub async fn restore_workspace_session(
    app: AppHandle,
    options: RestoreSessionOptions,
) -> Result<(), String> {
    svc::restore_session(&ui_ctx(&app), options)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// App state persistence
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_app_state(app: AppHandle) -> Result<AppStateFile, String> {
    Ok(svc::app_state(&ui_ctx(&app))?)
}

#[tauri::command]
pub async fn save_app_state_cmd(app: AppHandle, state: AppStateFile) -> Result<(), String> {
    Ok(svc::save_app_state(&ui_ctx(&app), state)?)
}

// ---------------------------------------------------------------------------
// Rename / delete (B3)
// ---------------------------------------------------------------------------

/// Rename a workspace's `app-state.json` entry. Returns the updated entry.
#[tauri::command]
pub async fn rename_workspace(app: AppHandle, request: RenameWorkspaceRequest) -> Result<WorkspaceEntry, String> {
    Ok(svc::rename_workspace(&ui_ctx(&app), request)?)
}

/// Remove a workspace from `app-state.json` (and its auto-save file, if any);
/// optionally also delete its explicit `.ltw`. See
/// [`crate::services::workspace::delete_workspace`] for the active-workspace
/// and file-safety rules.
#[tauri::command]
pub async fn delete_workspace(app: AppHandle, request: DeleteWorkspaceRequest) -> Result<(), String> {
    Ok(svc::delete_workspace(&ui_ctx(&app), request)?)
}
