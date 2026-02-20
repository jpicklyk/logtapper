use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::mcp_bridge::PORT as MCP_PORT;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
}

/// Returns the MCP bridge status (is it bound and listening?).
#[tauri::command]
pub fn get_mcp_status(state: State<'_, AppState>) -> McpStatus {
    let port = state.mcp_bridge_port.lock().map(|p| *p).unwrap_or(None);
    McpStatus {
        running: port.is_some(),
        port: port.unwrap_or(MCP_PORT),
    }
}
