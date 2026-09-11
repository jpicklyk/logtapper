//! Thin Tauri adapters over `services::sessions`. Each command builds a
//! [`crate::commands::adapters::ui_ctx`], calls one service function, and
//! marshals the `Result<T, ServiceError>` into the `Result<T, String>` the
//! frontend expects.

use std::collections::HashMap;

use serde::Serialize;
use ts_rs::TS;

use crate::commands::adapters::ui_ctx;

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    /// Seconds since the last request from the MCP client.
    /// None = bridge has never received a request (Claude Code not connected).
    pub idle_secs: Option<u32>,
    /// `true` when the user has opted agents out of PII anonymization
    /// (Settings → General → MCP Integration). Surfaced here so the status
    /// pill can warn that agents are reading raw log text.
    pub agent_raw_access: bool,
}

/// Records which session is currently the focused pane session in the
/// frontend UI (or `None` when no pane is focused). Pushed by the frontend
/// whenever focus changes — see `src-next/bridge/commands.ts::setFocusedSession`
/// and the focus-sync effect in `context/index.tsx` (`HookWiring`). Exposed
/// over the MCP bridge via `GET /mcp/sessions` (`focused` field) so an agent
/// can tell which of several open — possibly same-named — sessions the user
/// is actually looking at.
#[tauri::command]
pub fn set_focused_session(app: tauri::AppHandle, session_id: Option<String>) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    Ok(crate::services::sessions::set_focused(&ctx, session_id)?)
}

/// Returns the MCP bridge status (bound + last-activity age). Thin adapter
/// over [`crate::services::sessions::mcp_status`].
#[tauri::command]
pub fn get_mcp_status(app: tauri::AppHandle) -> McpStatus {
    let ctx = ui_ctx(&app);
    crate::services::sessions::mcp_status(&ctx)
}

// ---------------------------------------------------------------------------
// Session metadata — rich overview for agents and MCP
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub session_id: String,
    pub source_name: String,
    pub source_type: String,
    pub total_lines: usize,
    #[ts(type = "number")]
    pub file_size: u64,
    pub is_live: bool,
    pub is_indexing: bool,
    /// First non-zero timestamp in the log (ns since 2000-01-01 UTC), or null.
    #[ts(type = "number | null")]
    pub first_timestamp: Option<i64>,
    /// Last non-zero timestamp in the log (ns since 2000-01-01 UTC), or null.
    #[ts(type = "number | null")]
    pub last_timestamp: Option<i64>,
    /// Distribution of log levels: { "Info": 12345, "Error": 42, ... }
    #[ts(type = "Record<string, number>")]
    pub log_level_distribution: HashMap<String, usize>,
    /// Top tags by frequency (up to 50).
    pub top_tags: Vec<TagCount>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

/// Thin adapter over [`crate::services::sessions::metadata`].
#[tauri::command]
pub fn get_session_metadata(app: tauri::AppHandle, session_id: String) -> Result<SessionMetadata, String> {
    let ctx = ui_ctx(&app);
    Ok(crate::services::sessions::metadata(&ctx, &session_id)?)
}
