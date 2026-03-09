use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::AppState;
use crate::core::filter::{
    line_matches_criteria, FilterCriteria, FilterSession, FilterStatus,
};
use crate::core::line::{LogLevel, ViewLine};
use crate::core::session::parser_for;

// ---------------------------------------------------------------------------
// IPC payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterCreateResult {
    pub filter_id: String,
    pub session_id: String,
    /// Total lines in the source (will be scanned progressively).
    pub total_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterProgress {
    pub filter_id: String,
    pub matched_so_far: usize,
    pub lines_scanned: usize,
    pub total_lines: usize,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilteredLinesResult {
    pub filter_id: String,
    pub total_matches: usize,
    pub lines: Vec<ViewLine>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterInfo {
    pub filter_id: String,
    pub session_id: String,
    pub total_matches: usize,
    pub lines_scanned: usize,
    pub total_lines: usize,
    pub status: String,
}

// ---------------------------------------------------------------------------
// create_filter — spawn background scanning task
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn create_filter(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    criteria: FilterCriteria,
) -> Result<FilterCreateResult, String> {
    // Validate session exists and get total lines
    let total_lines = {
        let sessions = state.sessions.lock().map_err(|_| "lock poisoned")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{session_id}' not found"))?;
        let source = session.primary_source().ok_or("No source in session")?;
        source.total_lines()
    };

    let filter_id = format!("filter-{}", uuid_v4());
    let filter = Arc::new(FilterSession::new(
        filter_id.clone(),
        session_id.clone(),
        criteria,
        total_lines,
    ));

    // Store in AppState
    {
        let mut filters = state.active_filters.lock().map_err(|_| "lock poisoned")?;
        filters.insert(filter_id.clone(), Arc::clone(&filter));
    }

    let result = FilterCreateResult {
        filter_id,
        session_id,
        total_lines,
    };

    // Spawn background scanning task
    let filter_clone = Arc::clone(&filter);
    let app_clone = app;
    tauri::async_runtime::spawn(async move {
        scan_filter_background(app_clone, filter_clone).await;
    });

    Ok(result)
}

// ---------------------------------------------------------------------------
// Background filter scanning
// ---------------------------------------------------------------------------

async fn scan_filter_background(
    app: AppHandle,
    filter: Arc<FilterSession>,
) {
    let state = app.state::<AppState>();
    const BATCH_SIZE: usize = 10_000;
    const PROGRESS_INTERVAL: usize = 50_000;

    // Compile regex once
    let compiled_regex = filter.criteria.regex.as_ref().and_then(|pattern| {
        regex::Regex::new(pattern).ok()
    });

    let total_lines = filter.total_lines.load(Ordering::Relaxed);
    let mut scanned = 0usize;

    while scanned < total_lines && !filter.is_cancelled() {
        let batch_end = (scanned + BATCH_SIZE).min(total_lines);

        // Acquire lock, scan batch, release lock
        let batch_matches: Vec<usize> = {
            let sessions = match state.sessions.lock() {
                Ok(s) => s,
                Err(_) => break,
            };
            let Some(session) = sessions.get(&filter.session_id) else {
                break;
            };
            let Some(source) = session.primary_source() else {
                break;
            };

            let mut matches = Vec::new();
            for i in scanned..batch_end {
                let Some(raw_cow) = source.raw_line(i) else { continue };
                let raw: &str = &raw_cow;
                let Some(meta) = source.meta_at(i) else { continue };

                let tag = session.resolve_tag(meta.tag_id);
                // We need pid — parse the line for it, or use 0 as fallback
                let parser = parser_for(source.source_type());
                let pid = parser
                    .parse_line(raw, source.id(), i)
                    .map_or(0, |ctx| ctx.pid);

                if line_matches_criteria(
                    &filter.criteria,
                    raw,
                    meta.level,
                    tag,
                    meta.timestamp,
                    pid,
                    compiled_regex.as_ref(),
                ) {
                    matches.push(i);
                }
            }
            matches
        };

        if !batch_matches.is_empty() {
            filter.append_matches(&batch_matches);
        }

        scanned = batch_end;
        filter.lines_scanned.store(scanned, Ordering::Relaxed);

        // Emit progress at intervals or when done
        if scanned % PROGRESS_INTERVAL < BATCH_SIZE || scanned >= total_lines {
            let _ = app.emit(
                "filter-progress",
                FilterProgress {
                    filter_id: filter.filter_id.clone(),
                    matched_so_far: filter.matched_count(),
                    lines_scanned: scanned,
                    total_lines,
                    done: scanned >= total_lines,
                },
            );
        }

        // Yield to other tasks periodically
        tokio::task::yield_now().await;
    }

    if filter.is_cancelled() {
        filter.set_status(FilterStatus::Cancelled);
    } else {
        filter.set_status(FilterStatus::Complete);
    }

    // Final progress event
    let _ = app.emit(
        "filter-progress",
        FilterProgress {
            filter_id: filter.filter_id.clone(),
            matched_so_far: filter.matched_count(),
            lines_scanned: scanned,
            total_lines,
            done: true,
        },
    );
}

// ---------------------------------------------------------------------------
// get_filtered_lines — paginated view of filter results
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_filtered_lines(
    state: State<'_, AppState>,
    filter_id: String,
    offset: usize,
    count: usize,
) -> Result<FilteredLinesResult, String> {
    let filter = {
        let filters = state.active_filters.lock().map_err(|_| "lock poisoned")?;
        filters
            .get(&filter_id)
            .cloned()
            .ok_or_else(|| format!("Filter '{filter_id}' not found"))?
    };

    let total_matches = filter.matched_count();
    let page_line_nums = filter.get_page(offset, count.min(1000));
    let status = filter.status();

    // Build ViewLines from the matched line numbers
    let lines: Vec<ViewLine> = {
        let sessions = state.sessions.lock().map_err(|_| "lock poisoned")?;
        let Some(session) = sessions.get(&filter.session_id) else {
            return Err(format!("Session '{}' not found", filter.session_id));
        };
        let Some(source) = session.primary_source() else {
            return Err("No source in session".to_string());
        };

        let parser = parser_for(source.source_type());
        let mut lines = Vec::with_capacity(page_line_nums.len());

        for (idx, &ln) in page_line_nums.iter().enumerate() {
            let vi = offset + idx;
            let raw = source.raw_line(ln).as_deref().unwrap_or("").to_string();
            let meta = source.meta_at(ln);

            let view_line = if let Some(ctx) = parser.parse_line(&raw, source.id(), ln) {
                ViewLine {
                    line_num: ln,
                    virtual_index: vi,
                    raw: ctx.raw.to_string(),
                    level: ctx.level,
                    tag: ctx.tag.to_string(),
                    message: ctx.message.to_string(),
                    timestamp: ctx.timestamp,
                    pid: ctx.pid,
                    tid: ctx.tid,
                    source_id: ctx.source_id.to_string(),
                    highlights: vec![],
                    matched_by: vec![],
                    is_context: false,
                }
            } else {
                ViewLine {
                    line_num: ln,
                    virtual_index: vi,
                    raw: raw.clone(),
                    level: meta.map_or(LogLevel::Info, |m| m.level),
                    tag: meta
                        .map_or_else(String::new, |m| session.resolve_tag(m.tag_id).to_string()),
                    message: raw,
                    timestamp: meta.map_or(0, |m| m.timestamp),
                    pid: 0,
                    tid: 0,
                    source_id: source.id().to_string(),
                    highlights: vec![],
                    matched_by: vec![],
                    is_context: false,
                }
            };
            lines.push(view_line);
        }
        lines
    };

    let status_str = match status {
        FilterStatus::Scanning => "scanning",
        FilterStatus::Complete => "complete",
        FilterStatus::Cancelled => "cancelled",
    };

    Ok(FilteredLinesResult {
        filter_id,
        total_matches,
        lines,
        status: status_str.to_string(),
    })
}

// ---------------------------------------------------------------------------
// cancel_filter
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn cancel_filter(
    state: State<'_, AppState>,
    filter_id: String,
) -> Result<(), String> {
    let filters = state.active_filters.lock().map_err(|_| "lock poisoned")?;
    if let Some(filter) = filters.get(&filter_id) {
        filter.cancel();
        Ok(())
    } else {
        Err(format!("Filter '{filter_id}' not found"))
    }
}

// ---------------------------------------------------------------------------
// get_filter_info — check status of a filter
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_filter_info(
    state: State<'_, AppState>,
    filter_id: String,
) -> Result<FilterInfo, String> {
    let filters = state.active_filters.lock().map_err(|_| "lock poisoned")?;
    let filter = filters
        .get(&filter_id)
        .ok_or_else(|| format!("Filter '{filter_id}' not found"))?;

    let status = match filter.status() {
        FilterStatus::Scanning => "scanning",
        FilterStatus::Complete => "complete",
        FilterStatus::Cancelled => "cancelled",
    };

    Ok(FilterInfo {
        filter_id: filter.filter_id.clone(),
        session_id: filter.session_id.clone(),
        total_matches: filter.matched_count(),
        lines_scanned: filter.lines_scanned.load(Ordering::Relaxed),
        total_lines: filter.total_lines.load(Ordering::Relaxed),
        status: status.to_string(),
    })
}

// ---------------------------------------------------------------------------
// close_filter — remove a filter from AppState
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn close_filter(
    state: State<'_, AppState>,
    filter_id: String,
) -> Result<(), String> {
    let mut filters = state.active_filters.lock().map_err(|_| "lock poisoned")?;
    if let Some(filter) = filters.remove(&filter_id) {
        filter.cancel(); // Stop scanning if still running
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// UUID helper
// ---------------------------------------------------------------------------

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // Simple pseudo-UUID from timestamp + random bits
    let rand_part: u64 = (nanos as u64).wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (nanos >> 96) as u32,
        (nanos >> 80) as u16,
        (rand_part >> 48) as u16 & 0x0fff,
        (rand_part >> 32) as u16 & 0x3fff | 0x8000,
        rand_part & 0x0000_ffff_ffff_ffff,
    )
}
