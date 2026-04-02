/// Commands for controlling the MCP HTTP bridge at runtime.
///
/// The bridge no longer auto-starts on app launch.  The frontend calls
/// `start_mcp_bridge` when `mcpBridgeEnabled` is true and `stop_mcp_bridge`
/// when the user disables it in Settings.
use crate::commands::{lock_or_err, AppState};

/// Start the MCP HTTP bridge if it is not already running.
///
/// Creates a oneshot channel, stores the sender in `AppState::mcp_bridge_shutdown`,
/// then spawns `mcp_bridge::start` on the async runtime.  Returns `Ok(())` if the
/// bridge was just started **or** was already running.
#[tauri::command]
pub async fn start_mcp_bridge(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Check if already running — if the port is set the bridge is up.
    {
        let port = lock_or_err(&state.mcp_bridge_port, "mcp_bridge_port")?;
        if port.is_some() {
            return Ok(());
        }
    }

    // Atomically check if a shutdown sender already exists (bridge spawned but
    // hasn't bound its port yet) and store the new sender if not.
    let rx = {
        let mut shutdown = lock_or_err(&state.mcp_bridge_shutdown, "mcp_bridge_shutdown")?;
        if shutdown.is_some() {
            return Ok(());
        }
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        *shutdown = Some(tx);
        rx
    };

    // Spawn the bridge — it will clear the shutdown sender when it exits.
    tauri::async_runtime::spawn(crate::mcp_bridge::start(app.clone(), rx));

    Ok(())
}

/// Stop the MCP HTTP bridge by signalling its shutdown channel.
///
/// Takes the sender out of `AppState::mcp_bridge_shutdown` and sends `()`.
/// The bridge task receives the signal, stops the Axum server, and clears
/// `AppState::mcp_bridge_port`.  Returns `Ok(())` even if the bridge was not
/// running.
#[tauri::command]
pub fn stop_mcp_bridge(state: tauri::State<'_, AppState>) -> Result<(), String> {
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
