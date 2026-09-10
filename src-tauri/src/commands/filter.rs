use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{lock_or_err, AppState};
use crate::core::filter::{
    line_matches_criteria_with_needles, FilterCriteria, FilterSession, FilterStatus,
};
use crate::core::line::{LogLevel, ViewLine};
use crate::core::parser::LogParser;
use crate::core::session::parser_for;
use ts_rs::TS;

// ---------------------------------------------------------------------------
// IPC payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilterCreateResult {
    pub filter_id: String,
    pub session_id: String,
    /// Total lines in the source (will be scanned progressively).
    pub total_lines: usize,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilterProgress {
    pub filter_id: String,
    pub matched_so_far: usize,
    pub lines_scanned: usize,
    pub total_lines: usize,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilteredLinesResult {
    pub filter_id: String,
    pub total_matches: usize,
    pub lines: Vec<ViewLine>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, TS)]
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
    state: State<'_, std::sync::Arc<AppState>>,
    session_id: String,
    criteria: FilterCriteria,
) -> Result<FilterCreateResult, String> {
    // Compile the regex up front: a filter with an invalid pattern would
    // otherwise scan the entire source and report zero matches, which the user
    // cannot distinguish from "no lines matched".
    let compiled_regex = criteria.compile_regex()?;

    // Validate session exists and get total lines
    let total_lines = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
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
        let mut filters = lock_or_err(&state.active_filters, "active_filters")?;
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
        scan_filter_background(app_clone, filter_clone, compiled_regex).await;
    });

    Ok(result)
}

// ---------------------------------------------------------------------------
// Background filter scanning
// ---------------------------------------------------------------------------

/// Whether `criteria` actually filters on `pid` — i.e. whether
/// `line_matches_criteria`/`line_matches_criteria_with_needles` will ever
/// consult the `pid` argument. Mirrors the exact condition those functions
/// use (`Some(pids) if !pids.is_empty()`) so the scan loop can skip parsing
/// each line for its pid when the filter doesn't need it.
fn criteria_needs_pid(criteria: &FilterCriteria) -> bool {
    criteria.pids.as_ref().is_some_and(|p| !p.is_empty())
}

/// `compiled_regex` is compiled and validated by `create_filter` before the
/// task is spawned, so this path never has to decide what a bad pattern means.
async fn scan_filter_background(
    app: AppHandle,
    filter: Arc<FilterSession>,
    compiled_regex: Option<regex::Regex>,
) {
    let state = app.state::<std::sync::Arc<AppState>>();
    const BATCH_SIZE: usize = 10_000;
    const PROGRESS_INTERVAL: usize = 50_000;

    let total_lines = filter.total_lines.load(Ordering::Relaxed);
    let mut scanned = 0usize;

    // Text/tag needles are immutable for the whole scan — precompute the
    // lowercased forms once (mirrors `compiled_regex`, which is compiled
    // once by `create_filter` rather than per line) instead of letting
    // `line_matches_criteria` re-lowercase them on every scanned line.
    let needles = filter.criteria.precompute_needles();

    // Only parse a line for `pid` when the filter actually filters on pid —
    // otherwise every line pays for a full parse just to read a field that's
    // never checked.
    let needs_pid = criteria_needs_pid(&filter.criteria);

    // Allocate the parser once for the whole scan (the source's type can't
    // change mid-scan) instead of once per line. Lazily created on the first
    // batch that successfully resolves the source, then reused by every
    // subsequent batch.
    let mut parser: Option<Box<dyn LogParser>> = None;

    while scanned < total_lines && !filter.is_cancelled() {
        let batch_end = (scanned + BATCH_SIZE).min(total_lines);

        // Acquire lock, scan batch, release lock
        let batch_matches: Vec<usize> = {
            let Ok(sessions) = state.sessions.lock() else {
                break;
            };
            let Some(session) = sessions.get(&filter.session_id) else {
                break;
            };
            let Some(source) = session.primary_source() else {
                break;
            };

            if needs_pid && parser.is_none() {
                parser = Some(parser_for(source.source_type()));
            }

            let mut matches = Vec::new();
            for i in scanned..batch_end {
                let Some(raw_cow) = source.raw_line(i) else { continue };
                let raw: &str = &raw_cow;
                let Some(meta) = source.meta_at(i) else { continue };

                let tag = session.resolve_tag(meta.tag_id);
                // pid is only worth parsing for when the filter has a pid
                // criterion; otherwise fall back to 0 (matches the old
                // behavior when parsing failed to produce a pid).
                let pid = if needs_pid {
                    parser
                        .as_deref()
                        .and_then(|p| p.parse_line(raw, source.id(), i))
                        .map_or(0, |ctx| ctx.pid)
                } else {
                    0
                };

                if line_matches_criteria_with_needles(
                    &filter.criteria,
                    &needles,
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
    state: State<'_, std::sync::Arc<AppState>>,
    filter_id: String,
    offset: usize,
    count: usize,
) -> Result<FilteredLinesResult, String> {
    let filter = {
        let filters = lock_or_err(&state.active_filters, "active_filters")?;
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
        let sessions = lock_or_err(&state.sessions, "sessions")?;
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
    state: State<'_, std::sync::Arc<AppState>>,
    filter_id: String,
) -> Result<(), String> {
    let filters = lock_or_err(&state.active_filters, "active_filters")?;
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
    state: State<'_, std::sync::Arc<AppState>>,
    filter_id: String,
) -> Result<FilterInfo, String> {
    let filters = lock_or_err(&state.active_filters, "active_filters")?;
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
    state: State<'_, std::sync::Arc<AppState>>,
    filter_id: String,
) -> Result<(), String> {
    let mut filters = lock_or_err(&state.active_filters, "active_filters")?;
    if let Some(filter) = filters.remove(&filter_id) {
        filter.cancel(); // Stop scanning if still running
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// UUID helper
// ---------------------------------------------------------------------------

/// Splitmix64 finalizer — cheap bit-avalanche so a low-entropy seed still
/// spreads across all 64 output bits (no crate dependency required).
fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

fn uuid_v4() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    // No `rand` crate dependency in this crate. `nanos` alone previously fed
    // the top two groups directly via `nanos >> 96` / `>> 80` — but a
    // nanosecond epoch timestamp never gets anywhere near 2^80, so those
    // shifts were always 0 and every generated id started "00000000-0000".
    // Mix the timestamp through splitmix64 instead so every group of the
    // output varies, and fold in a process-wide counter so back-to-back
    // calls landing on the same (or a coarser-resolution) timestamp still
    // produce distinct ids.
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);

    let hi = splitmix64(nanos ^ counter.wrapping_mul(0x2545_F491_4F6C_DD1D));
    let lo = splitmix64(hi ^ counter);

    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (hi >> 32) as u32,
        (hi >> 16) as u16,
        (hi & 0x0fff) as u16,
        ((lo >> 48) as u16 & 0x3fff) | 0x8000,
        lo & 0x0000_ffff_ffff_ffff,
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── uuid_v4 ──────────────────────────────────────────────────────────────
    // Regression: the old implementation shifted a nanosecond-resolution u128
    // timestamp right by 96/80 bits for the first two groups, which are
    // always 0 for any real epoch timestamp — every id started with the
    // literal prefix "00000000-0000".

    #[test]
    fn uuid_v4_does_not_start_with_static_zero_prefix() {
        let id = uuid_v4();
        assert!(
            !id.starts_with("00000000-0000"),
            "uuid_v4 must not reproduce the old always-zero prefix, got: {id}"
        );
    }

    #[test]
    fn uuid_v4_has_expected_shape() {
        let id = uuid_v4();
        let groups: Vec<&str> = id.split('-').collect();
        assert_eq!(groups.len(), 5, "uuid must have 5 hyphen-separated groups: {id}");
        assert_eq!(groups[0].len(), 8);
        assert_eq!(groups[1].len(), 4);
        assert_eq!(groups[2].len(), 4);
        assert_eq!(groups[3].len(), 4);
        assert_eq!(groups[4].len(), 12);
        assert!(groups[2].starts_with('4'), "version nibble must be 4: {id}");
        let variant_nibble = groups[3].chars().next().unwrap();
        assert!(
            matches!(variant_nibble, '8' | '9' | 'a' | 'b'),
            "variant nibble must be 8/9/a/b: {id}"
        );
    }

    #[test]
    fn uuid_v4_generates_distinct_ids_back_to_back() {
        let ids: std::collections::HashSet<String> = (0..100).map(|_| uuid_v4()).collect();
        assert_eq!(ids.len(), 100, "back-to-back uuid_v4 calls must not collide");
    }

    // ── criteria_needs_pid ──────────────────────────────────────────────────
    // `scan_filter_background` only allocates a parser and parses each line
    // for its pid when the filter actually has a pid criterion — this is the
    // exact decision that gates that work, so it must match the condition
    // `line_matches_criteria`/`line_matches_criteria_with_needles` use to
    // decide whether `pid` matters at all.

    #[test]
    fn criteria_needs_pid_false_when_unset() {
        let c = FilterCriteria::default();
        assert!(!criteria_needs_pid(&c));
    }

    #[test]
    fn criteria_needs_pid_false_when_empty_list() {
        let mut c = FilterCriteria::default();
        c.pids = Some(vec![]);
        assert!(!criteria_needs_pid(&c));
    }

    #[test]
    fn criteria_needs_pid_true_when_pids_configured() {
        let mut c = FilterCriteria::default();
        c.pids = Some(vec![1234]);
        assert!(criteria_needs_pid(&c));
    }

    // ── pid filtering correctness (mirrors what scan_filter_background relies on) ──
    // These don't exercise the async scan loop directly (that needs a live
    // Tauri AppHandle), but they pin the two behaviors the loop depends on:
    // a filter WITH a pid criterion must still discriminate on the parsed
    // pid, and a filter WITHOUT one must match irrespective of whatever pid
    // value is passed in (i.e. it's safe to skip parsing and pass 0).

    #[test]
    fn pid_criterion_present_still_filters_by_pid() {
        let mut c = FilterCriteria::default();
        c.text_search = Some("crash".to_string());
        c.pids = Some(vec![1234]);
        assert!(criteria_needs_pid(&c));
        let needles = c.precompute_needles();

        assert!(line_matches_criteria_with_needles(
            &c, &needles, "app crash detected", LogLevel::Error, "", 0, 1234, None
        ));
        assert!(!line_matches_criteria_with_needles(
            &c, &needles, "app crash detected", LogLevel::Error, "", 0, 9999, None
        ));
    }

    #[test]
    fn no_pid_criterion_matches_regardless_of_pid_value() {
        let mut c = FilterCriteria::default();
        c.text_search = Some("crash".to_string());
        assert!(!criteria_needs_pid(&c));
        let needles = c.precompute_needles();

        // Same result no matter what pid is passed — confirms it's safe for
        // the scan loop to skip parsing (and pass the placeholder 0) when
        // criteria_needs_pid is false.
        let with_zero = line_matches_criteria_with_needles(
            &c, &needles, "app crash detected", LogLevel::Error, "", 0, 0, None
        );
        let with_nonzero = line_matches_criteria_with_needles(
            &c, &needles, "app crash detected", LogLevel::Error, "", 0, 4242, None
        );
        assert!(with_zero);
        assert_eq!(with_zero, with_nonzero);
    }
}
