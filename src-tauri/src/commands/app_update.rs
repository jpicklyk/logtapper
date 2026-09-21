//! In-app update, driven from Rust so the app owns its own exit.
//!
//! The updater plugin's JS API would do the same check/download/install — but
//! on Windows its install path runs the installer and then leaves this process
//! through `std::process::exit`, with only Tauri's generic
//! `cleanup_before_exit` in between. That never reaches `RunEvent::Exit`, so
//! nothing killed the MCP sidecar; the installer then could not overwrite
//! `logtapper-mcp.exe` and the update died in an NSIS "Error opening file for
//! writing" dialog (live finding, 2026-09-21). Building the `Updater` here lets
//! us put [`crate::on_app_exit`] in front of that exit, and lets the
//! macOS/Linux relaunch go through the same cleanup. The frontend therefore
//! calls these two commands and nothing from `plugin:updater` directly.
//!
//! Nothing here touches raw log text or any agent gate; both commands are
//! `Ui`-only by construction (there is no bridge route to them).

use std::path::Path;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use ts_rs::TS;

use crate::commands::{lock_or_err, AppState};

/// Whether `path` sits inside a Scoop app directory. Scoop's layout is
/// `<scoop-root>/apps/<app>/current/...`: the root is conventionally named
/// `scoop`, but `$env:SCOOP` can relocate it to anything (`D:\pkgs`), so the
/// second pattern keys on the `apps/logtapper/current` run instead — the
/// `current` junction is Scoop's own and the shim launches through it, which
/// is the path `current_exe` reports. Case-insensitive because Windows paths
/// are. `C:\scoop\shims\x.exe` (Scoop's shim dir, not an app dir) is
/// deliberately `false`.
fn is_scoop_managed(path: &Path) -> bool {
    let components: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect();
    components.windows(2).any(|w| w[0] == "scoop" && w[1] == "apps")
        || components
            .windows(3)
            .any(|w| w[0] == "apps" && w[1] == "logtapper" && w[2] == "current")
}

/// The package manager this running executable is installed under, if any.
/// `None` means the normal NSIS-installed layout, where the in-app updater
/// applies.
fn managed_by() -> Option<&'static str> {
    let exe = std::env::current_exe().ok()?;
    is_scoop_managed(&exe).then_some("scoop")
}

/// The error both update commands return when [`managed_by`] says this
/// executable came from a package manager: that manager owns replacing the
/// binary, and the in-app updater downloading a second copy alongside it
/// would leave two installs on disk.
fn managed_update_error(manager: &str) -> String {
    format!("Updates are managed by {manager}; run `{manager} update logtapper` instead.")
}

/// What the frontend needs to know before offering the in-app updater at all.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdatePolicy {
    /// The package manager managing this install (currently only `"scoop"`),
    /// or `None` for a normal NSIS/DMG/AppImage install.
    pub managed_by: Option<String>,
}

/// Whether the in-app updater should be offered at all. Called once by the
/// frontend before the silent launch check and the Settings panel decide
/// whether to show update controls or a "managed by ..." message.
#[tauri::command]
pub fn get_app_update_policy() -> AppUpdatePolicy {
    AppUpdatePolicy { managed_by: managed_by().map(str::to_string) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_scoop_apps_layout() {
        assert!(is_scoop_managed(Path::new(r"C:\Users\x\scoop\apps\logtapper\current\log-tapper.exe")));
    }

    #[test]
    fn is_case_insensitive() {
        assert!(is_scoop_managed(Path::new(r"D:\tools\Scoop\Apps\logtapper\current\log-tapper.exe")));
    }

    #[test]
    fn nsis_install_is_not_managed() {
        assert!(!is_scoop_managed(Path::new(r"C:\Program Files\LogTapper\log-tapper.exe")));
    }

    #[test]
    fn scoop_shim_is_not_an_app_dir() {
        assert!(!is_scoop_managed(Path::new(r"C:\scoop\shims\x.exe")));
    }

    #[test]
    fn relocated_scoop_root_is_detected_by_the_current_junction() {
        assert!(is_scoop_managed(Path::new(r"D:\pkgs\apps\logtapper\current\log-tapper.exe")));
    }

    #[test]
    fn a_versioned_dir_under_a_relocated_root_is_not_enough() {
        // Without `scoop` in the path only the shim's `current` junction is
        // proof; a stray `apps/logtapper/0.13.1` tree could be anyone's.
        assert!(!is_scoop_managed(Path::new(r"D:\pkgs\apps\logtapper\0.13.1\log-tapper.exe")));
    }
}

/// What the release manifest says about a newer version than the running one.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    /// The version on offer, e.g. `0.13.1`.
    pub version: String,
    /// The version this process is running.
    pub current_version: String,
    /// Release notes from the manifest; `None` when it carries none (or only whitespace).
    pub notes: Option<String>,
    /// RFC 3339 publication date from the manifest, or `None`.
    pub date: Option<String>,
}

impl From<&Update> for AppUpdateInfo {
    fn from(u: &Update) -> Self {
        Self {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            notes: u.body.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
            date: u
                .date
                .and_then(|d| d.format(&time::format_description::well_known::Rfc3339).ok()),
        }
    }
}

/// Download progress on the install channel. `received` is cumulative; `total`
/// is `None` when the server sent no `Content-Length`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "phase")]
pub enum AppUpdateProgress {
    Started {
        #[ts(type = "number | null")]
        total: Option<u64>,
    },
    Progress {
        #[ts(type = "number")]
        received: u64,
        #[ts(type = "number | null")]
        total: Option<u64>,
    },
    Finished,
}

/// The plugin's updater with this app's exit hook in front of the Windows
/// `process::exit`. The plugin's own `updater_builder()` already installs
/// Tauri's `cleanup_before_exit`; `on_before_exit` *replaces* rather than
/// chains, so it is called again here after ours.
fn build_updater(app: &AppHandle) -> Result<Updater, String> {
    let exit_handle = app.clone();
    app.updater_builder()
        .on_before_exit(move || {
            crate::on_app_exit(&exit_handle);
            exit_handle.cleanup_before_exit();
        })
        .build()
        .map_err(|e| e.to_string())
}

/// Ask the configured endpoint whether a newer version exists. `None` means
/// the running version is current. The found update is kept in `AppState` for
/// `install_app_update`; a repeat check replaces it.
#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
) -> Result<Option<AppUpdateInfo>, String> {
    if let Some(manager) = managed_by() {
        return Err(managed_update_error(manager));
    }
    let update = build_updater(&app)?.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(AppUpdateInfo::from);
    *lock_or_err(&state.pending_app_update, "pending_app_update")? = update;
    Ok(info)
}

/// Download, verify and install the update `check_app_update` found, then
/// hand off: on Windows the plugin runs the installer and exits this process
/// (through `on_before_exit` above); elsewhere we run the same cleanup and
/// relaunch. A failure — signature mismatch, network — keeps the update on
/// hand so the next call is a retry, and never touches the running install.
#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    on_event: Channel<AppUpdateProgress>,
) -> Result<(), String> {
    if let Some(manager) = managed_by() {
        return Err(managed_update_error(manager));
    }
    // Taken out of the slot so no mutex is held across the download.
    let update = lock_or_err(&state.pending_app_update, "pending_app_update")?
        .take()
        .ok_or_else(|| "No update has been found to install; check for updates first.".to_string())?;

    let mut received: u64 = 0;
    let mut total: Option<u64> = None;
    let mut started = false;
    let progress = &on_event;
    let result = update
        .download_and_install(
            |chunk, content_length| {
                if !started {
                    started = true;
                    total = content_length;
                    let _ = progress.send(AppUpdateProgress::Started { total });
                }
                received += chunk as u64;
                let _ = progress.send(AppUpdateProgress::Progress { received, total });
            },
            || {
                let _ = progress.send(AppUpdateProgress::Finished);
            },
        )
        .await;

    match result {
        Ok(()) => {
            // Windows never gets here: the plugin exited after `on_before_exit`.
            // macOS/Linux: the new build is in place; same cleanup, then relaunch.
            crate::on_app_exit(&app);
            app.restart()
        }
        Err(e) => {
            *lock_or_err(&state.pending_app_update, "pending_app_update")? = Some(update);
            Err(e.to_string())
        }
    }
}
