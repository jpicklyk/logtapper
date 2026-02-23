use std::collections::HashMap;

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

/// Enable or disable PII anonymization for MCP query results.
/// Called by the frontend whenever __pii_anonymizer is added to or removed from the chain.
#[tauri::command]
pub fn set_mcp_anonymize(state: State<'_, AppState>, enabled: bool) {
    if let Ok(mut flag) = state.mcp_anonymize.lock() {
        *flag = enabled;
    }
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

// ---------------------------------------------------------------------------
// Session metadata — rich overview for agents and MCP
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub session_id: String,
    pub source_name: String,
    pub source_type: String,
    pub total_lines: usize,
    pub file_size: u64,
    pub is_live: bool,
    pub is_indexing: bool,
    /// First non-zero timestamp in the log (ns since 2000-01-01 UTC), or null.
    pub first_timestamp: Option<i64>,
    /// Last non-zero timestamp in the log (ns since 2000-01-01 UTC), or null.
    pub last_timestamp: Option<i64>,
    /// Distribution of log levels: { "Info": 12345, "Error": 42, ... }
    pub log_level_distribution: HashMap<String, usize>,
    /// Top tags by frequency (up to 50).
    pub top_tags: Vec<TagCount>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

#[tauri::command]
pub fn get_session_metadata(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionMetadata, String> {
    let sessions = state.sessions.lock().map_err(|_| "lock poisoned")?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let source = session.primary_source().ok_or("No source in session")?;

    let total_lines = source.total_lines();
    let first_ts = source.first_timestamp();
    let last_ts = source.last_timestamp();

    // Compute file size
    let file_size = if let Some(file_src) = session.file_source() {
        file_src.mmap().len() as u64
    } else if let Some(stream_src) = session.stream_source() {
        stream_src.stream_byte_count()
    } else {
        0
    };

    // Scan line meta for level distribution and tag counts
    let mut level_dist: HashMap<String, usize> = HashMap::new();
    let mut tag_counts: HashMap<u16, usize> = HashMap::new();

    for meta in source.line_meta_slice() {
        *level_dist.entry(format!("{:?}", meta.level)).or_insert(0) += 1;
        *tag_counts.entry(meta.tag_id).or_insert(0) += 1;
    }

    // Resolve tag IDs to strings and sort by count descending
    let mut top_tags: Vec<TagCount> = tag_counts
        .into_iter()
        .map(|(tag_id, count)| TagCount {
            tag: session.resolve_tag(tag_id).to_string(),
            count,
        })
        .collect();
    top_tags.sort_by(|a, b| b.count.cmp(&a.count));
    top_tags.truncate(50);

    Ok(SessionMetadata {
        session_id,
        source_name: source.name().to_string(),
        source_type: source.source_type().to_string(),
        total_lines,
        file_size,
        is_live: source.is_live(),
        is_indexing: source.is_indexing(),
        first_timestamp: first_ts,
        last_timestamp: last_ts,
        log_level_distribution: level_dist,
        top_tags,
    })
}
