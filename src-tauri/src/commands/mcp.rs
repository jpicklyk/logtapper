/// Commands for controlling the MCP HTTP bridge at runtime.
///
/// The bridge no longer auto-starts on app launch.  The frontend calls
/// `start_mcp_bridge` when `mcpBridgeEnabled` is true and `stop_mcp_bridge`
/// when the user disables it in Settings.
use crate::commands::{lock_or_err, AppState};
use ts_rs::TS;

/// Inner logic for starting the MCP bridge.
///
/// Returns `Ok(Some(rx))` if a new oneshot channel was created and the caller
/// should spawn the bridge task with that receiver.  Returns `Ok(None)` if the
/// bridge is already running (port is set) or a shutdown sender already exists
/// (bridge is in the process of starting up).
pub(crate) fn start_mcp_bridge_inner(
    state: &AppState,
) -> Result<Option<tokio::sync::oneshot::Receiver<()>>, String> {
    {
        let port = lock_or_err(&state.mcp_bridge_port, "mcp_bridge_port")?;
        if port.is_some() {
            return Ok(None);
        }
    }

    let mut shutdown = lock_or_err(&state.mcp_bridge_shutdown, "mcp_bridge_shutdown")?;
    if shutdown.is_some() {
        return Ok(None);
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    *shutdown = Some(tx);
    Ok(Some(rx))
}

/// Inner logic for stopping the MCP bridge.
///
/// Takes the sender out of `AppState::mcp_bridge_shutdown` and sends `()`.
/// Returns `Ok(())` even if the bridge was not running.
pub(crate) fn stop_mcp_bridge_inner(state: &AppState) -> Result<(), String> {
    let sender = {
        let mut shutdown = lock_or_err(&state.mcp_bridge_shutdown, "mcp_bridge_shutdown")?;
        shutdown.take()
    };

    if let Some(tx) = sender {
        // Ignore send errors — the receiver may have already dropped (bridge already
        // stopped on its own, e.g. bind failure).
        let _ = tx.send(());
    }

    Ok(())
}

/// Start the MCP HTTP bridge if it is not already running.
///
/// Creates a oneshot channel, stores the sender in `AppState::mcp_bridge_shutdown`,
/// then spawns `mcp_bridge::start` on the async runtime.  Returns `Ok(())` if the
/// bridge was just started **or** was already running.
#[tauri::command]
pub async fn start_mcp_bridge(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
) -> Result<(), String> {
    if let Some(rx) = start_mcp_bridge_inner(&state)? {
        // Spawn the bridge — it will clear the shutdown sender when it exits.
        // Build the bridge's own context (state + the Tauri-backed sinks)
        // once, here — the bridge itself never resolves anything out of an
        // `AppHandle` any more.
        let ctx = crate::mcp_bridge::BridgeCtx::new(app);
        tauri::async_runtime::spawn(crate::mcp_bridge::start(ctx, rx));
    }
    // The MCP-over-HTTP server rides with the bridge: same on/off switch. Runs
    // on every start call, not only a fresh bridge start, so a child that died
    // (or a sidecar staged after launch) is picked up without toggling.
    spawn_mcp_http_server(&state);
    Ok(())
}

// ── MCP over HTTP — the sidecar served at one fixed localhost URL ───────────
//
// Harnesses that speak Streamable HTTP (Claude Code, Cursor, VS Code, …) get
// `http://127.0.0.1:40405/mcp` instead of a per-install binary path, and the
// server they reach is always the one that shipped with the running app. The
// Claude Desktop bundle is a stdio relay to the same URL (mcp-server/src/relay.ts).

/// Port the app-spawned `logtapper-mcp --http` listens on (loopback only).
pub const MCP_HTTP_PORT: u16 = 40405;

/// The URL harnesses connect to while the HTTP server is up.
pub fn mcp_http_url() -> String {
    format!("http://127.0.0.1:{MCP_HTTP_PORT}/mcp")
}

/// Spawn `logtapper-mcp --http <port>` from next to our own executable.
///
/// No-op (with a log line) when this build ships no sidecar — `tauri dev`
/// unless one was staged by hand — or when one is already running.
pub(crate) fn spawn_mcp_http_server(state: &AppState) {
    let Ok(mut slot) = state.mcp_http_server.lock() else { return };
    if let Some(child) = slot.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return; // still running
        }
        *slot = None;
    }
    let Some(sidecar) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(std::path::Path::to_path_buf))
        .and_then(|d| find_sidecar_in(&d))
    else {
        log::info!("[mcp-http] no logtapper-mcp sidecar next to the executable; HTTP endpoint not started");
        return;
    };

    let mut cmd = std::process::Command::new(&sidecar);
    cmd.arg("--http")
        .arg(MCP_HTTP_PORT.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        // A console-subsystem child of a GUI app would otherwise open a console window.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(child) => {
            log::info!("[mcp-http] spawned {} (pid {}) at {}", sidecar.display(), child.id(), mcp_http_url());
            *slot = Some(child);
        }
        Err(e) => log::warn!("[mcp-http] failed to spawn {}: {e}", sidecar.display()),
    }
}

/// Kill the HTTP server child if one is running. Safe to call repeatedly.
pub(crate) fn stop_mcp_http_server(state: &AppState) {
    let Ok(mut slot) = state.mcp_http_server.lock() else { return };
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
        log::info!("[mcp-http] stopped");
    }
}

/// The MCP-over-HTTP URL, or `None` when the server is not running.
#[tauri::command]
pub fn get_mcp_http_endpoint(state: tauri::State<'_, std::sync::Arc<AppState>>) -> Option<String> {
    let mut slot = state.mcp_http_server.lock().ok()?;
    let child = slot.as_mut()?;
    match child.try_wait() {
        Ok(None) => Some(mcp_http_url()),
        _ => {
            *slot = None;
            None
        }
    }
}

/// Stop the MCP HTTP bridge by signalling its shutdown channel.
///
/// Takes the sender out of `AppState::mcp_bridge_shutdown` and sends `()`.
/// The bridge task receives the signal, stops the Axum server, and clears
/// `AppState::mcp_bridge_port`.  Returns `Ok(())` even if the bridge was not
/// running.
#[tauri::command]
pub fn stop_mcp_bridge(state: tauri::State<'_, std::sync::Arc<AppState>>) -> Result<(), String> {
    stop_mcp_http_server(&state);
    stop_mcp_bridge_inner(&state)
}

/// Locate the bundled `logtapper-mcp` sidecar inside `dir`.
///
/// Tauri strips the target triple when installing an `externalBin`, so the
/// expected name is plain `logtapper-mcp` (`.exe` on Windows).  A manually
/// copied binary may still carry the triple suffix, so a prefix match is
/// accepted as a fallback.  Returns `None` when no candidate exists — the
/// normal case for dev builds, which have no sidecar.
pub(crate) fn find_sidecar_in(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut fallback: Option<std::path::PathBuf> = None;

    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        if !name.starts_with("logtapper-mcp") {
            continue;
        }
        // Skip build artefacts that share the prefix (.pdb, .d, .dSYM, ...).
        let looks_executable = if cfg!(windows) {
            name.ends_with(".exe")
        } else {
            !name.contains('.')
        };
        if !looks_executable || !entry.path().is_file() {
            continue;
        }

        if name == "logtapper-mcp" || name == "logtapper-mcp.exe" {
            return Some(entry.path());
        }
        fallback.get_or_insert_with(|| entry.path());
    }

    fallback
}

/// Full path to the bundled MCP sidecar, for display in Settings.
///
/// Returns `None` in dev builds (no sidecar is produced by `tauri dev`) — the
/// frontend then shows the `node --experimental-strip-types` launch form
/// instead.  Used to let users copy a ready-to-paste client configuration
/// rather than hunting for the install directory by hand.
#[tauri::command]
pub fn get_mcp_sidecar_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    find_sidecar_in(dir).map(|p| p.to_string_lossy().into_owned())
}

// ── Launcher pointer — lets the installed bundle run *this* app's server ────
//
// The `.mcpb` Claude Desktop installs is a thin launcher (mcp-server/src/
// launcher.ts). It reads this file at every start and execs the sidecar it
// names, so the server Claude Desktop runs is always the one that shipped
// with the currently installed LogTapper — no bundle re-install per release.

/// File name of the launcher pointer inside the app data directory.
pub(crate) const LAUNCHER_POINTER_FILE: &str = "mcp-launcher.json";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPointer<'a> {
    command: &'a str,
    args: [&'a str; 0],
    app_version: &'a str,
}

/// Write `<data_dir>/mcp-launcher.json` naming the sidecar found in `exe_dir`.
///
/// Returns the pointer path on success. Returns `None` without touching the
/// file when `exe_dir` holds no sidecar (a plain `tauri dev` build): dev and
/// installed builds share the app data directory, so a dev run must never
/// clobber the pointer an installed build wrote.
pub(crate) fn write_launcher_pointer(
    data_dir: &std::path::Path,
    exe_dir: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let sidecar = find_sidecar_in(exe_dir)?;
    let command = sidecar.to_string_lossy();
    let json = serde_json::to_string_pretty(&LauncherPointer {
        command: &command,
        args: [],
        app_version: env!("CARGO_PKG_VERSION"),
    })
    .ok()?;
    std::fs::create_dir_all(data_dir).ok()?;
    let path = data_dir.join(LAUNCHER_POINTER_FILE);
    std::fs::write(&path, json).ok()?;
    Some(path)
}

// ── MCP Bundle (.mcpb) — one-click install for Claude Desktop ──────────────
//
// The bundle is a self-contained copy of the MCP server that Claude Desktop
// unpacks into its own extensions directory, so — unlike the `logtapper-mcp`
// sidecar, which Claude Code launches by absolute path — nothing downstream
// depends on where LogTapper itself was installed.

/// Path to the bundled `.mcpb`, shipped as a Tauri resource.
///
/// `None` in dev builds, where resources are not staged.
fn bundle_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let path = app.path().resource_dir().ok()?.join("mcp/logtapper.mcpb");
    path.is_file().then_some(path)
}

/// Open a path with the OS default handler.
///
/// Claude Desktop registers the `.mcpb` association when it installs, so this
/// surfaces its install dialog directly. When Claude Desktop is absent there is
/// no handler and the call is a no-op from the user's perspective — the caller
/// is expected to offer "save a copy" alongside it.
fn open_with_os(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer.exe");
        c.arg(path);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(path);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path);
        c
    };

    // explorer.exe returns a non-zero exit code even on success, so only a
    // spawn failure is treated as an error.
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open MCP bundle: {e}"))
}

/// Whether the OS has an application registered to open `.mcpb` files.
///
/// Claude Desktop does not always claim the extension — the Microsoft Store
/// (MSIX) build ships file associations for documents and images but not for
/// `.mcpb`. Handing the file to the shell there raises Windows' "How do you
/// want to open this file?" chooser instead of an install dialog, which is
/// worse than not offering the action at all. Callers gate the one-click
/// install on this and fall back to saving a copy.
#[cfg(target_os = "windows")]
fn has_mcpb_handler() -> bool {
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    // A UserChoice set by the user wins over any machine-wide registration.
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if hkcu
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mcpb\UserChoice",
            KEY_READ,
        )
        .and_then(|k| k.get_value::<String, _>("ProgId"))
        .is_ok_and(|p| !p.is_empty())
    {
        return true;
    }

    // Otherwise the extension must resolve to a non-empty ProgId.
    RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey_with_flags(".mcpb", KEY_READ)
        .and_then(|k| k.get_value::<String, _>(""))
        .is_ok_and(|p| !p.is_empty())
}

/// macOS and Linux register handlers through Launch Services / xdg-mime rather
/// than a readable key. Probing either reliably costs more than it is worth
/// here, so assume a handler and let the caller's fallback cover the miss.
#[cfg(not(target_os = "windows"))]
fn has_mcpb_handler() -> bool {
    true
}

/// The bundled `.mcpb`, if this build ships one.
///
/// `installable` reports whether the OS can actually open it — when false the
/// caller should offer "save a copy" only, since a one-click install would
/// raise an unrelated chooser dialog.
#[derive(serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpBundleInfo {
    pub path: String,
    pub installable: bool,
}

/// Whether a bundled `.mcpb` is available, and whether it can be installed.
#[tauri::command]
pub fn get_mcp_bundle_path(app: tauri::AppHandle) -> Option<McpBundleInfo> {
    bundle_path(&app).map(|p| McpBundleInfo {
        path: p.to_string_lossy().into_owned(),
        installable: has_mcpb_handler(),
    })
}

/// Hand the bundled `.mcpb` to the OS, triggering Claude Desktop's installer.
#[tauri::command]
pub fn open_mcp_bundle(app: tauri::AppHandle) -> Result<(), String> {
    let path = bundle_path(&app).ok_or("No MCP bundle is shipped with this build")?;
    if !has_mcpb_handler() {
        return Err(
            "No application is registered to open .mcpb files. Save the bundle and              install it from Claude Desktop instead."
                .to_string(),
        );
    }
    open_with_os(&path)
}

/// Copy the bundled `.mcpb` to a user-chosen location.
///
/// The fallback when Claude Desktop is not installed, so the OS has no handler
/// for the file and `open_mcp_bundle` would appear to do nothing.
#[tauri::command]
pub fn save_mcp_bundle(app: tauri::AppHandle, dest: String) -> Result<(), String> {
    let src = bundle_path(&app).ok_or("No MCP bundle is shipped with this build")?;
    std::fs::copy(&src, &dest).map_err(|e| format!("Failed to save MCP bundle: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::AppState;

    fn make_state() -> AppState {
        AppState::new()
    }

    // -------------------------------------------------------------------------
    // start_mcp_bridge_inner
    // -------------------------------------------------------------------------

    #[test]
    fn test_start_when_port_already_set() {
        let state = make_state();
        // Simulate a running bridge by setting the port.
        *state.mcp_bridge_port.lock().unwrap() = Some(40404);

        let result = start_mcp_bridge_inner(&state).unwrap();

        assert!(result.is_none(), "should return None when port is already set");
        assert!(
            state.mcp_bridge_shutdown.lock().unwrap().is_none(),
            "shutdown sender must not be created when bridge is already up"
        );
    }

    #[test]
    fn test_start_when_shutdown_sender_exists() {
        let state = make_state();
        // Simulate bridge that has started but not yet bound its port.
        let (tx, _rx) = tokio::sync::oneshot::channel::<()>();
        *state.mcp_bridge_shutdown.lock().unwrap() = Some(tx);

        let result = start_mcp_bridge_inner(&state).unwrap();

        assert!(result.is_none(), "should return None when a shutdown sender already exists");
        // The existing sender must still be in place (not replaced).
        assert!(
            state.mcp_bridge_shutdown.lock().unwrap().is_some(),
            "existing shutdown sender must be preserved"
        );
    }

    #[test]
    fn test_start_fresh() {
        let state = make_state();
        // Both port and shutdown are None — bridge is not running.
        assert!(state.mcp_bridge_port.lock().unwrap().is_none());
        assert!(state.mcp_bridge_shutdown.lock().unwrap().is_none());

        let result = start_mcp_bridge_inner(&state).unwrap();

        assert!(result.is_some(), "should return Some(rx) when starting fresh");
        assert!(
            state.mcp_bridge_shutdown.lock().unwrap().is_some(),
            "shutdown sender must be stored after fresh start"
        );
    }

    // -------------------------------------------------------------------------
    // stop_mcp_bridge_inner
    // -------------------------------------------------------------------------

    #[test]
    fn test_stop_with_sender() {
        let state = make_state();
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        *state.mcp_bridge_shutdown.lock().unwrap() = Some(tx);

        let result = stop_mcp_bridge_inner(&state);

        assert!(result.is_ok(), "stop must return Ok when sender is present");
        assert!(
            state.mcp_bridge_shutdown.lock().unwrap().is_none(),
            "shutdown sender must be cleared after stop"
        );
        // The receiver must have gotten the signal.
        assert!(
            rx.try_recv().is_ok(),
            "receiver must get the shutdown signal"
        );
    }

    #[test]
    fn test_stop_without_sender() {
        let state = make_state();
        // Shutdown is None — bridge is not running.
        assert!(state.mcp_bridge_shutdown.lock().unwrap().is_none());

        let result = stop_mcp_bridge_inner(&state);

        assert!(result.is_ok(), "stop must return Ok even when no sender exists");
    }

    // -------------------------------------------------------------------------
    // find_sidecar_in
    // -------------------------------------------------------------------------

    fn sidecar_name(stem: &str) -> String {
        if cfg!(windows) {
            format!("{stem}.exe")
        } else {
            stem.to_string()
        }
    }

    #[test]
    fn test_find_sidecar_exact_name() {
        let dir = tempfile::tempdir().unwrap();
        let expected = dir.path().join(sidecar_name("logtapper-mcp"));
        std::fs::write(&expected, b"x").unwrap();

        let found = find_sidecar_in(dir.path()).expect("sidecar must be found");

        assert_eq!(found, expected);
    }

    // -------------------------------------------------------------------------
    // write_launcher_pointer
    // -------------------------------------------------------------------------

    #[test]
    fn test_launcher_pointer_names_the_sidecar() {
        let exe_dir = tempfile::tempdir().unwrap();
        let data_dir = tempfile::tempdir().unwrap();
        let sidecar = exe_dir.path().join(sidecar_name("logtapper-mcp"));
        std::fs::write(&sidecar, b"x").unwrap();

        let written = write_launcher_pointer(data_dir.path(), exe_dir.path()).expect("pointer must be written");
        assert_eq!(written, data_dir.path().join(LAUNCHER_POINTER_FILE));

        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&written).unwrap()).unwrap();
        assert_eq!(json["command"], sidecar.to_string_lossy().as_ref());
        assert_eq!(json["args"], serde_json::json!([]));
        assert_eq!(json["appVersion"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn test_launcher_pointer_untouched_without_sidecar() {
        let exe_dir = tempfile::tempdir().unwrap();
        let data_dir = tempfile::tempdir().unwrap();
        let existing = data_dir.path().join(LAUNCHER_POINTER_FILE);
        std::fs::write(&existing, b"{\"command\":\"/installed/logtapper-mcp\"}").unwrap();

        assert!(write_launcher_pointer(data_dir.path(), exe_dir.path()).is_none());
        assert_eq!(
            std::fs::read_to_string(&existing).unwrap(),
            "{\"command\":\"/installed/logtapper-mcp\"}",
            "a build without a sidecar must not clobber an installed build's pointer"
        );
    }

    #[test]
    fn test_find_sidecar_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(sidecar_name("log-tapper")), b"x").unwrap();

        assert!(
            find_sidecar_in(dir.path()).is_none(),
            "the main app binary must not be mistaken for the sidecar"
        );
    }

    #[test]
    fn test_find_sidecar_accepts_target_triple_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let suffixed = dir.path().join(sidecar_name("logtapper-mcp-x86_64-unknown-linux-gnu"));
        std::fs::write(&suffixed, b"x").unwrap();

        let found = find_sidecar_in(dir.path()).expect("suffixed sidecar must be found");

        assert_eq!(found, suffixed);
    }

    #[test]
    fn test_find_sidecar_prefers_exact_over_suffixed() {
        let dir = tempfile::tempdir().unwrap();
        let exact = dir.path().join(sidecar_name("logtapper-mcp"));
        std::fs::write(dir.path().join(sidecar_name("logtapper-mcp-aarch64-apple-darwin")), b"x").unwrap();
        std::fs::write(&exact, b"x").unwrap();

        let found = find_sidecar_in(dir.path()).expect("sidecar must be found");

        assert_eq!(found, exact, "the unsuffixed binary is the installed one");
    }

    #[test]
    fn test_find_sidecar_skips_build_artefacts() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("logtapper-mcp.pdb"), b"x").unwrap();
        std::fs::write(dir.path().join("logtapper-mcp.d"), b"x").unwrap();

        assert!(
            find_sidecar_in(dir.path()).is_none(),
            "debug artefacts sharing the prefix must be ignored"
        );
    }

    #[test]
    fn test_find_sidecar_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("does-not-exist");

        assert!(find_sidecar_in(&gone).is_none(), "unreadable dir must yield None, not panic");
    }
}
