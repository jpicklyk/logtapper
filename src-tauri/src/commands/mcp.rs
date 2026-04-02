/// Commands for controlling the MCP HTTP bridge at runtime.
///
/// The bridge no longer auto-starts on app launch.  The frontend calls
/// `start_mcp_bridge` when `mcpBridgeEnabled` is true and `stop_mcp_bridge`
/// when the user disables it in Settings.
use crate::commands::{lock_or_err, AppState};

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
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if let Some(rx) = start_mcp_bridge_inner(&state)? {
        // Spawn the bridge — it will clear the shutdown sender when it exits.
        tauri::async_runtime::spawn(crate::mcp_bridge::start(app.clone(), rx));
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
pub fn stop_mcp_bridge(state: tauri::State<'_, AppState>) -> Result<(), String> {
    stop_mcp_bridge_inner(&state)
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
}
