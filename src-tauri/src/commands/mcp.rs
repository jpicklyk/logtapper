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
    spawn_mcp_http_server(std::sync::Arc::clone(state.inner()));
    Ok(())
}

// ── MCP over HTTP — the sidecar served at one fixed localhost URL ───────────
//
// Harnesses that speak Streamable HTTP (Claude Code, Cursor, VS Code, …) get
// `http://127.0.0.1:<port>/mcp` instead of a per-install binary path, and the
// server they reach is always the one that shipped with the running app. The
// Claude Desktop bundle is a stdio relay to the same URL (mcp-server/src/relay.ts).
//
// The port defaults to 40405 and is a user setting for the machine where
// something else owns that port for good. A spawn is supervised on its own
// thread: the sidecar gets a few attempts (a port still in TIME_WAIT after a
// quick toggle frees up within a second), its stderr is captured so Settings
// can show the real reason when every attempt fails, and a stop that races the
// supervisor wins via `mcp_http_generation`.

use std::sync::atomic::Ordering;

/// Default port for the app-spawned `logtapper-mcp --http` (loopback only).
pub const MCP_HTTP_PORT: u16 = 40405;

/// Spawn attempts before giving up, and how long each gets to prove it stays up.
const SPAWN_ATTEMPTS: u32 = 3;
const SPAWN_SETTLE_MS: u64 = 750;
const SPAWN_RETRY_DELAY_MS: u64 = 500;

/// The URL harnesses connect to for a given port.
pub fn mcp_http_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

/// Ports the HTTP server may use: not privileged, not the bridge's own.
pub fn validate_http_port(port: u16) -> Result<u16, String> {
    if port < 1024 {
        return Err(format!("Port {port} is privileged; choose 1024 or higher"));
    }
    if port == crate::mcp_bridge::PORT {
        return Err(format!("Port {port} is the MCP bridge's own port; choose another"));
    }
    Ok(port)
}

/// What Settings shows for the HTTP endpoint.
#[derive(serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpInfo {
    /// The URL while the server is up; `None` when the bridge is off, the
    /// build ships no sidecar, or the last start failed (see `error`).
    pub url: Option<String>,
    /// The configured port, whether or not the server is currently up.
    pub port: u16,
    /// Why the most recent start failed, verbatim from the sidecar's stderr
    /// or the OS spawn error. `None` when it is running or was never tried.
    pub error: Option<String>,
}

fn current_port(state: &AppState) -> u16 {
    lock_or_err(&state.mcp_http_port, "mcp_http_port").map(|p| *p).unwrap_or(MCP_HTTP_PORT)
}

fn record_error(state: &AppState, message: Option<String>) {
    match lock_or_err(&state.mcp_http_last_error, "mcp_http_last_error") {
        Ok(mut e) => *e = message,
        Err(e) => log::warn!("[mcp-http] {e}"),
    }
}

/// Spawn `logtapper-mcp --http <port>` from next to our own executable.
///
/// Returns immediately; the attempts run on a supervisor thread. No-op (with a
/// log line) when this build ships no sidecar — `tauri dev` unless one was
/// staged by hand — or when one is already running.
pub(crate) fn spawn_mcp_http_server(state: std::sync::Arc<AppState>) {
    {
        let mut slot = match lock_or_err(&state.mcp_http_server, "mcp_http_server") {
            Ok(slot) => slot,
            Err(e) => {
                log::warn!("[mcp-http] {e}");
                return;
            }
        };
        if let Some(child) = slot.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return; // still running
            }
            *slot = None;
        }
    }
    let Some(sidecar) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(std::path::Path::to_path_buf))
        .and_then(|d| find_sidecar_in(&d))
    else {
        log::info!("[mcp-http] no logtapper-mcp sidecar next to the executable; HTTP endpoint not started");
        return;
    };
    let port = current_port(&state);
    let generation = state.mcp_http_generation.load(Ordering::SeqCst);
    record_error(&state, None);
    if let Err(e) = std::thread::Builder::new()
        .name("mcp-http-spawn".into())
        .spawn(move || supervise_spawn(state, sidecar, port, generation))
    {
        log::warn!("[mcp-http] could not start supervisor thread: {e}");
    }
}

/// One attempt: spawn, capture stderr, and report whether the child was still
/// alive after `SPAWN_SETTLE_MS`. On failure the error text is returned.
fn try_spawn_once(sidecar: &std::path::Path, port: u16) -> Result<std::process::Child, String> {
    let mut cmd = std::process::Command::new(sidecar);
    cmd.arg("--http")
        .arg(port.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        // A console-subsystem child of a GUI app would otherwise open a console window.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start {}: {e}", sidecar.display()))?;

    // Drain stderr on its own thread for the child's whole life (a full pipe
    // would block the sidecar) and keep the last line as the failure reason.
    let last_line = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    if let Some(stderr) = child.stderr.take() {
        let last = std::sync::Arc::clone(&last_line);
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                log::info!("[mcp-http] {line}");
                if let Ok(mut l) = last.lock() {
                    *l = Some(line);
                }
            }
        });
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(SPAWN_SETTLE_MS);
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Ok(Some(status)) => {
                // Give the reader a moment to catch the last line.
                std::thread::sleep(std::time::Duration::from_millis(50));
                let reason = last_line.lock().ok().and_then(|l| l.clone()).unwrap_or_default();
                return Err(if reason.is_empty() { format!("exited with {status}") } else { reason });
            }
            Err(e) => return Err(format!("could not poll {}: {e}", sidecar.display())),
        }
    }
    Ok(child)
}

fn supervise_spawn(state: std::sync::Arc<AppState>, sidecar: std::path::PathBuf, port: u16, generation: u64) {
    let mut last_err = String::new();
    for attempt in 1..=SPAWN_ATTEMPTS {
        match try_spawn_once(&sidecar, port) {
            Ok(mut child) => {
                if state.mcp_http_generation.load(Ordering::SeqCst) != generation {
                    // A stop (or a port change) happened meanwhile; ours is stale.
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                log::info!(
                    "[mcp-http] spawned {} (pid {}) at {} on attempt {attempt}",
                    sidecar.display(),
                    child.id(),
                    mcp_http_url(port)
                );
                match lock_or_err(&state.mcp_http_server, "mcp_http_server") {
                    Ok(mut slot) => *slot = Some(child),
                    Err(e) => log::warn!("[mcp-http] {e}"),
                }
                record_error(&state, None);
                return;
            }
            Err(e) => {
                log::warn!("[mcp-http] attempt {attempt}/{SPAWN_ATTEMPTS} on port {port} failed: {e}");
                last_err = e;
                if attempt < SPAWN_ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(SPAWN_RETRY_DELAY_MS));
                }
            }
        }
    }
    record_error(&state, Some(last_err));
}

/// Kill the HTTP server child if one is running. Safe to call repeatedly.
pub(crate) fn stop_mcp_http_server(state: &AppState) {
    state.mcp_http_generation.fetch_add(1, Ordering::SeqCst);
    let mut slot = match lock_or_err(&state.mcp_http_server, "mcp_http_server") {
        Ok(slot) => slot,
        Err(e) => {
            log::warn!("[mcp-http] {e}");
            return;
        }
    };
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
        log::info!("[mcp-http] stopped");
    }
}

/// The endpoint's current state for Settings.
#[tauri::command]
pub fn get_mcp_http_info(state: tauri::State<'_, std::sync::Arc<AppState>>) -> Result<McpHttpInfo, String> {
    let port = current_port(&state);
    let error = lock_or_err(&state.mcp_http_last_error, "mcp_http_last_error")?.clone();
    let mut slot = lock_or_err(&state.mcp_http_server, "mcp_http_server")?;
    let alive = match slot.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    };
    if !alive {
        *slot = None; // reap a child that exited so the next start is not skipped
    }
    Ok(McpHttpInfo { url: alive.then(|| mcp_http_url(port)), port, error })
}

/// Change the HTTP port. Takes effect immediately when the bridge is on (the
/// server is restarted on the new port); otherwise on the next bridge start.
#[tauri::command]
pub fn set_mcp_http_port(port: u16, state: tauri::State<'_, std::sync::Arc<AppState>>) -> Result<(), String> {
    let port = validate_http_port(port)?;
    let changed = {
        let mut current = lock_or_err(&state.mcp_http_port, "mcp_http_port")?;
        let changed = *current != port;
        *current = port;
        changed
    };
    let bridge_on = lock_or_err(&state.mcp_bridge_port, "mcp_bridge_port")?.is_some();
    let server_down = lock_or_err(&state.mcp_http_server, "mcp_http_server")?.is_none();
    if bridge_on && (changed || server_down) {
        stop_mcp_http_server(&state);
        spawn_mcp_http_server(std::sync::Arc::clone(state.inner()));
    }
    Ok(())
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

    #[test]
    fn test_find_sidecar_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(sidecar_name("log-tapper")), b"x").unwrap();

        assert!(
            find_sidecar_in(dir.path()).is_none(),
            "the main app binary must not be mistaken for the sidecar"
        );
    }

    // -------------------------------------------------------------------------
    // MCP over HTTP: port validation and the spawn attempt
    // -------------------------------------------------------------------------

    #[test]
    fn test_validate_http_port_rejects_privileged_and_bridge_ports() {
        assert!(validate_http_port(80).is_err());
        assert!(validate_http_port(1023).is_err());
        assert!(validate_http_port(crate::mcp_bridge::PORT).is_err(), "must not collide with the bridge");
        assert_eq!(validate_http_port(1024), Ok(1024));
        assert_eq!(validate_http_port(MCP_HTTP_PORT), Ok(MCP_HTTP_PORT));
        assert_eq!(validate_http_port(65535), Ok(65535));
    }

    #[test]
    fn test_mcp_http_url_uses_the_given_port() {
        assert_eq!(mcp_http_url(41000), "http://127.0.0.1:41000/mcp");
    }

    #[test]
    fn test_try_spawn_once_reports_a_spawn_error_for_a_non_executable() {
        // A text file named like the sidecar: spawn fails at the OS level, and
        // the error must name the path so Settings can show something useful.
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join(sidecar_name("logtapper-mcp"));
        std::fs::write(&fake, b"not a program").unwrap();

        let err = try_spawn_once(&fake, MCP_HTTP_PORT).expect_err("a text file cannot be spawned");
        assert!(err.contains("logtapper-mcp"), "error should name the sidecar: {err}");
    }

    #[test]
    fn test_set_port_persists_without_bridge_and_reports_via_info_shape() {
        // With the bridge off, set_mcp_http_port only records the port; the
        // supervisor is not started. Exercised through the state directly.
        let state = make_state();
        {
            let mut p = state.mcp_http_port.lock().unwrap();
            *p = 41000;
        }
        assert_eq!(current_port(&state), 41000);
        record_error(&state, Some("boom".into()));
        assert_eq!(state.mcp_http_last_error.lock().unwrap().as_deref(), Some("boom"));
        record_error(&state, None);
        assert!(state.mcp_http_last_error.lock().unwrap().is_none());
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

    // -------------------------------------------------------------------------
    // stop_mcp_http_server — the exit-path mechanism
    // -------------------------------------------------------------------------

    /// A long-lived stand-in for the sidecar: something that stays up until
    /// killed, on either platform, with no window.
    fn spawn_long_lived_child() -> std::process::Child {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd")
                .args(["/C", "ping -n 60 127.0.0.1 >NUL"])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .spawn()
                .expect("spawn cmd")
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("sleep").arg("60").spawn().expect("spawn sleep")
        }
    }

    /// The update path: on Windows the updater plugin launches the installer
    /// and exits this process without going through `RunEvent::Exit`, so
    /// `on_app_exit` runs from the plugin's `on_before_exit` hook and calls
    /// this. The sidecar's exe is one of the files the installer overwrites;
    /// if the child is still alive when this returns, the install fails with
    /// NSIS "Error opening file for writing" (live finding, 2026-09-21). So:
    /// after the call the child must be dead — not merely signalled — and the
    /// slot empty, and a second call must be a no-op.
    #[test]
    fn stop_mcp_http_server_kills_a_running_sidecar_before_returning() {
        let state = make_state();
        let child = spawn_long_lived_child();
        let pid = child.id();
        *state.mcp_http_server.lock().unwrap() = Some(child);

        stop_mcp_http_server(&state);

        assert!(state.mcp_http_server.lock().unwrap().is_none(), "slot must be cleared");
        // `stop` waited on the child, so its exit is already reaped; the pid
        // must not answer as a live process any more. `tasklist`/`kill -0`
        // are the only portable-enough probes without a new dependency.
        #[cfg(windows)]
        let alive = {
            let out = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .expect("tasklist");
            String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
        };
        #[cfg(not(windows))]
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(!alive, "sidecar pid {pid} must be dead after stop_mcp_http_server");

        stop_mcp_http_server(&state); // idempotent
        assert!(state.mcp_http_server.lock().unwrap().is_none());
    }

    /// `stop` bumps the spawn generation so a supervisor thread mid-retry
    /// abandons its attempt instead of re-registering a child after the exit
    /// path already ran. Pinned separately because the kill above would pass
    /// even if this regressed.
    #[test]
    fn stop_mcp_http_server_advances_the_spawn_generation() {
        let state = make_state();
        let before = state.mcp_http_generation.load(Ordering::SeqCst);
        stop_mcp_http_server(&state);
        assert_eq!(state.mcp_http_generation.load(Ordering::SeqCst), before + 1);
    }
}
