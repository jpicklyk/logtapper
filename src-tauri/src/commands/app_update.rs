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
    /// Windows only: the running exe is an all-users install and this process
    /// is not elevated, so installing an update will show a credential prompt
    /// (see [`elevated`]). Always `false` elsewhere.
    pub needs_elevation: bool,
}

/// Whether the in-app updater should be offered at all. Called once by the
/// frontend before the silent launch check and the Settings panel decide
/// whether to show update controls or a "managed by ..." message.
#[tauri::command]
pub fn get_app_update_policy(app: AppHandle) -> AppUpdatePolicy {
    #[cfg(windows)]
    let needs_elevation = elevated::machine_install_needs_elevation(&app.package_info().name);
    #[cfg(not(windows))]
    let needs_elevation = {
        let _ = &app;
        false
    };
    AppUpdatePolicy { managed_by: managed_by().map(str::to_string), needs_elevation }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Forward slashes: a backslash-only string is a single component off
    // Windows, and these must pass on every platform cargo test runs on.
    #[test]
    fn detects_scoop_apps_layout() {
        assert!(is_scoop_managed(Path::new("C:/Users/x/scoop/apps/logtapper/current/log-tapper.exe")));
    }

    #[test]
    fn is_case_insensitive() {
        assert!(is_scoop_managed(Path::new("D:/tools/Scoop/Apps/logtapper/current/log-tapper.exe")));
    }

    #[test]
    fn nsis_install_is_not_managed() {
        assert!(!is_scoop_managed(Path::new("C:/Program Files/LogTapper/log-tapper.exe")));
    }

    #[test]
    fn scoop_shim_is_not_an_app_dir() {
        assert!(!is_scoop_managed(Path::new("C:/scoop/shims/x.exe")));
    }

    #[test]
    fn relocated_scoop_root_is_detected_by_the_current_junction() {
        assert!(is_scoop_managed(Path::new("D:/pkgs/apps/logtapper/current/log-tapper.exe")));
    }

    #[test]
    fn a_versioned_dir_under_a_relocated_root_is_not_enough() {
        // Without `scoop` in the path only the shim's `current` junction is
        // proof; a stray `apps/logtapper/0.13.1` tree could be anyone's.
        assert!(!is_scoop_managed(Path::new("D:/pkgs/apps/logtapper/0.13.1/log-tapper.exe")));
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
    let downloaded = update
        .download(
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

    let result = match downloaded {
        Ok(bytes) => install_downloaded(&app, &update, bytes),
        Err(e) => Err(e.to_string()),
    };

    match result {
        Ok(()) => {
            // Windows never gets here: both install paths exit after `on_before_exit`.
            // macOS/Linux: the new build is in place; same cleanup, then relaunch.
            crate::on_app_exit(&app);
            app.restart()
        }
        Err(e) => {
            *lock_or_err(&state.pending_app_update, "pending_app_update")? = Some(update);
            Err(e)
        }
    }
}

/// The plugin's own install, except on Windows when this process cannot write
/// the install it came from — see [`elevated`].
#[cfg_attr(not(windows), allow(unused_variables))]
fn install_downloaded(app: &AppHandle, update: &Update, bytes: Vec<u8>) -> Result<(), String> {
    #[cfg(windows)]
    if elevated::machine_install_needs_elevation(&app.package_info().name) {
        let exit_handle = app.clone();
        return elevated::install(&bytes, &update.version, move || {
            crate::on_app_exit(&exit_handle);
            exit_handle.cleanup_before_exit();
        });
    }
    update.install(bytes).map_err(|e| e.to_string())
}

/// Updating an all-users install from a standard-user process.
///
/// `tauri-plugin-updater` runs the downloaded NSIS installer with
/// `ShellExecuteW("open")`. Tauri's installer is `highestAvailable`, so for a
/// standard user that is *not* elevated and shows no prompt; NSIS MultiUser then
/// has no rights to `Program Files`/HKLM and quietly installs a second, per-user
/// copy next to the untouched all-users one (live finding, 2026-09-21: a
/// per-machine 0.13.1 "updated" to a per-user 0.13.2 in `%LOCALAPPDATA%`). An
/// admin account with UAC gets a consent prompt from `open` and never hits this.
///
/// So when the running exe is the one registered under HKLM and this process
/// is not elevated, the installer is launched with the `runas` verb instead —
/// the credential prompt a standard user needs — with the plugin's exact
/// argument set for `installMode: passive`. The installer relaunches the app
/// through `nsis_tauri_utils::RunAsUser`, i.e. as the desktop user, not the
/// admin. A cancelled prompt keeps the download on hand for a retry.
#[cfg(windows)]
mod elevated {
    use std::ffi::{OsStr, OsString};
    use std::path::{Path, PathBuf};

    const UNINSTALL_ROOT: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    pub(super) fn machine_install_needs_elevation(product_name: &str) -> bool {
        let Ok(exe) = std::env::current_exe() else { return false };
        is_machine_install(&exe, machine_install_location(product_name).as_deref())
            && !process_is_elevated()
    }

    /// `InstallLocation` of the all-users install, if one is registered. The
    /// key name is the product name — what Tauri's NSIS template uses for
    /// `UNINSTKEY`.
    fn machine_install_location(product_name: &str) -> Option<PathBuf> {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
        use winreg::RegKey;
        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(format!(r"{UNINSTALL_ROOT}\{product_name}"), KEY_READ)
            .ok()?;
        let location: String = key.get_value("InstallLocation").ok()?;
        Some(PathBuf::from(location.trim().trim_matches('"')))
    }

    /// Whether `exe` lives in the registered all-users install directory. A
    /// stale HKLM entry for a directory that no longer holds this exe (an
    /// uninstall that left its key behind) must not force elevation.
    pub(super) fn is_machine_install(exe: &Path, machine_location: Option<&Path>) -> bool {
        let (Some(dir), Some(location)) = (exe.parent(), machine_location) else { return false };
        normalize(dir) == normalize(location)
    }

    fn normalize(p: &Path) -> String {
        p.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_lowercase()
    }

    fn process_is_elevated() -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        // SAFETY: plain Win32 token query on our own process; every handle we
        // open is closed, and the out-buffer is exactly `TOKEN_ELEVATION`.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut returned = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            );
            CloseHandle(token);
            ok != 0 && elevation.TokenIsElevated != 0
        }
    }

    /// Write the installer to a temp file and launch it elevated. On success
    /// this never returns: `before_exit` runs and the process exits, exactly
    /// as the plugin's own Windows install does.
    pub(super) fn install(bytes: &[u8], version: &str, before_exit: impl FnOnce()) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;

        let path = std::env::temp_dir().join(format!("LogTapper_{version}_update.exe"));
        std::fs::write(&path, bytes)
            .map_err(|e| format!("Could not write the installer to {}: {e}", path.display()))?;

        let args: Vec<OsString> = std::env::args_os().skip(1).collect();
        let parameters = installer_parameters(&args);
        let wide = |s: &OsStr| s.encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (file, parameters, verb) = (wide(path.as_os_str()), wide(&parameters), wide(OsStr::new("runas")));

        // SAFETY: all three strings are NUL-terminated wide buffers that outlive the call.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                parameters.as_ptr(),
                std::ptr::null(),
                SW_SHOW,
            )
        };
        if result as isize <= 32 {
            let err = std::io::Error::last_os_error();
            // ERROR_CANCELLED: the credential prompt was dismissed.
            return Err(if err.raw_os_error() == Some(1223) {
                "This copy of LogTapper is installed for all users, so Windows needs an administrator's \
                 credentials to update it. The prompt was cancelled; the download is kept, press Install again to retry."
                    .to_string()
            } else {
                format!("Could not start the elevated installer: {err}")
            });
        }

        before_exit();
        std::process::exit(0);
    }

    /// The plugin's `updater_parameters` for an NSIS bundle under
    /// `plugins.updater.windows.installMode = "passive"` (tauri.conf.json):
    /// `/P`, `/UPDATE`, `/R` (relaunch), then `/ARGS` followed by this
    /// process's own arguments so a file opened from the command line survives
    /// the restart.
    pub(super) fn installer_parameters(current_args: &[OsString]) -> OsString {
        let mut out = OsString::from("/P /UPDATE /R /ARGS");
        for arg in current_args {
            out.push(" ");
            out.push(escape_nsis_current_exe_arg(arg));
        }
        out
    }

    /// Ported verbatim from `tauri-plugin-updater` 2.12.0 (`updater.rs`), which
    /// keeps it private: std's Windows argument quoting plus `/`, which NSIS
    /// would otherwise read as the start of its own option.
    fn escape_nsis_current_exe_arg(arg: impl AsRef<OsStr>) -> OsString {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let arg = arg.as_ref();
        let mut cmd: Vec<u16> = Vec::new();
        let quote = arg
            .as_encoded_bytes()
            .iter()
            .any(|c| *c == b' ' || *c == b'\t' || *c == b'/')
            || arg.is_empty();
        if quote {
            cmd.push('"' as u16);
        }
        let mut backslashes: usize = 0;
        for x in arg.encode_wide() {
            if x == '\\' as u16 {
                backslashes += 1;
            } else {
                if x == '"' as u16 {
                    // Add n+1 backslashes to total 2n+1 before internal '"'.
                    cmd.extend((0..=backslashes).map(|_| '\\' as u16));
                }
                backslashes = 0;
            }
            cmd.push(x);
        }
        if quote {
            // Add n backslashes to total 2n before ending '"'.
            cmd.extend((0..backslashes).map(|_| '\\' as u16));
            cmd.push('"' as u16);
        }
        OsString::from_wide(&cmd)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn exe_inside_the_registered_location_is_a_machine_install() {
            let exe = Path::new(r"C:\Program Files\LogTapper\log-tapper.exe");
            assert!(is_machine_install(exe, Some(Path::new(r"C:\Program Files\LogTapper"))));
            // Registry values arrive with whatever case and trailing separator the installer wrote.
            assert!(is_machine_install(exe, Some(Path::new(r"c:\program files\logtapper\"))));
            assert!(is_machine_install(exe, Some(Path::new("C:/Program Files/LogTapper"))));
        }

        #[test]
        fn a_per_user_exe_is_not_a_machine_install_even_with_a_stale_hklm_entry() {
            let exe = Path::new(r"C:\Users\x\AppData\Local\Programs\LogTapper\log-tapper.exe");
            assert!(!is_machine_install(exe, Some(Path::new(r"C:\Program Files\LogTapper"))));
            assert!(!is_machine_install(exe, None));
        }

        #[test]
        fn parameters_match_the_plugins_passive_mode_set() {
            assert_eq!(installer_parameters(&[]), OsString::from("/P /UPDATE /R /ARGS"));
        }

        #[test]
        fn current_args_are_quoted_the_way_nsis_expects() {
            let args = [OsString::from(r"D:\logs\my file.log"), OsString::from("--flag/x"), OsString::from("plain")];
            assert_eq!(
                installer_parameters(&args),
                OsString::from(r#"/P /UPDATE /R /ARGS "D:\logs\my file.log" "--flag/x" plain"#)
            );
        }
    }
}
