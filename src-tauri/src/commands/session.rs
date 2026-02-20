use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::mcp_bridge::PORT as MCP_PORT;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    /// Seconds since the last request from the MCP client.
    /// None = bridge has never received a request (Claude Code not connected).
    pub idle_secs: Option<u32>,
}

/// Returns the MCP bridge status (bound + last-activity age).
#[tauri::command]
pub fn get_mcp_status(state: State<'_, AppState>) -> McpStatus {
    let port = state.mcp_bridge_port.lock().map(|p| *p).unwrap_or(None);
    let idle_secs = state
        .mcp_last_activity
        .lock()
        .ok()
        .and_then(|ts| *ts)
        .map(|t| t.elapsed().as_secs() as u32);
    McpStatus {
        running: port.is_some(),
        port: port.unwrap_or(MCP_PORT),
        idle_secs,
    }
}
