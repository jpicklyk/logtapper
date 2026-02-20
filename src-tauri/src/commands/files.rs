use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use tauri::State;

use crate::commands::AppState;
use crate::core::line::{
    HighlightKind, HighlightSpan, LineRequest, LineWindow, LogLevel, SearchQuery, SearchSummary,
    ViewLine, ViewMode,
};
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;
use crate::core::session::{AnalysisSession, SectionInfo};

// ---------------------------------------------------------------------------
// DumpstateMetadata
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpstateMetadata {
    pub build_string: Option<String>,
    pub build_fingerprint: Option<String>,
    pub os_version: Option<String>,
    pub build_type: Option<String>,
    pub bootloader: Option<String>,
    pub serial: Option<String>,
    pub uptime: Option<String>,
    pub kernel_version: Option<String>,
    pub sdk_version: Option<String>,
    pub device_model: Option<String>,
    pub manufacturer: Option<String>,
}

// ---------------------------------------------------------------------------
// load_log_file
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub session_id: String,
    pub source_id: String,
    pub source_name: String,
    pub total_lines: usize,
    pub file_size: u64,
    pub first_timestamp: Option<i64>,
    pub last_timestamp: Option<i64>,
    pub source_type: String,
    /// True for live ADB streaming sessions; false for static file sessions.
    pub is_streaming: bool,
}

#[tauri::command]
pub async fn load_log_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<LoadResult, String> {
    let path_obj = Path::new(&path);

    let file_size = std::fs::metadata(path_obj)
        .map(|m| m.len())
        .unwrap_or(0);

    // Derive stable IDs from the path
    let session_id = "default".to_string();
    let source_id = path_obj
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("source")
        .to_string();

    let mut session = AnalysisSession::new(session_id.clone());
    let source_idx = session.add_source_from_file(path_obj, source_id.clone())?;

    let source = &session.sources[source_idx];
    let total_lines = source.total_lines();
    let first_ts = source.first_timestamp();
    let last_ts = source.last_timestamp();
    let source_type = source.source_type.to_string();
    let source_name = source.name.clone();

    let result = LoadResult {
        session_id: session_id.clone(),
        source_id,
        source_name,
        total_lines,
        file_size,
        first_timestamp: first_ts,
        last_timestamp: last_ts,
        source_type,
        is_streaming: false,
    };

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;
    sessions.insert(session_id, session);

    Ok(result)
}

// ---------------------------------------------------------------------------
// get_lines
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_lines(
    state: State<'_, AppState>,
    request: LineRequest,
) -> Result<LineWindow, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;

    let session = sessions
        .get(&request.session_id)
        .ok_or_else(|| format!("Session '{}' not found", request.session_id))?;

    let source = session
        .primary_source()
        .ok_or("No sources in session")?;

    let total_lines = source.total_lines();
    let parser = LogcatParser;

    match request.mode {
        ViewMode::Full => {
            let start = request.offset.min(total_lines);
            let end = (request.offset + request.count).min(total_lines);

            let mut lines = Vec::with_capacity(end - start);

            for i in start..end {
                let raw = source.raw_line(i).unwrap_or("").to_string();
                // meta_at() adjusts for stream eviction offset; avoids OOB panic.
                let meta = source.meta_at(i);

                let highlights = request
                    .search
                    .as_ref()
                    .map(|q| compute_search_highlights(&raw, q))
                    .unwrap_or_default();

                let view_line = if let Some(ctx) = parser.parse_line(&raw, &source.id, i) {
                    ViewLine {
                        line_num: i,
                        raw: ctx.raw,
                        level: ctx.level,
                        tag: ctx.tag,
                        message: ctx.message,
                        timestamp: ctx.timestamp,
                        pid: ctx.pid,
                        tid: ctx.tid,
                        source_id: ctx.source_id,
                        highlights,
                        matched_by: vec![],
                        is_context: false,
                    }
                } else {
                    // Section header or unparseable — fall back to stored meta.
                    // If meta is None (line was evicted from stream buffer), use defaults.
                    ViewLine {
                        line_num: i,
                        raw: raw.clone(),
                        level: meta.map_or(LogLevel::Info, |m| m.level),
                        tag: meta.map_or_else(String::new, |m| m.tag.clone()),
                        message: raw,
                        timestamp: meta.map_or(0, |m| m.timestamp),
                        pid: 0,
                        tid: 0,
                        source_id: source.id.clone(),
                        highlights,
                        matched_by: vec![],
                        is_context: false,
                    }
                };

                lines.push(view_line);
            }

            Ok(LineWindow { total_lines, lines })
        }

        ViewMode::Processor => {
            let proc_id = request.processor_id.as_deref().ok_or("processor_id required for Processor mode")?;

            // Get the matched line numbers from the last pipeline run.
            let matched: Vec<usize> = {
                let pr = state
                    .pipeline_results
                    .lock()
                    .map_err(|_| "Pipeline results lock poisoned")?;
                pr.get(&request.session_id)
                    .and_then(|s| s.get(proc_id))
                    .map(|r| r.matched_line_nums.clone())
                    .unwrap_or_default()
            };

            if matched.is_empty() {
                return Ok(LineWindow { total_lines, lines: vec![] });
            }

            let ctx_lines = request.context;

            // Build the set of lines to include (matches + context).
            // Use a sorted deduplicated list so we emit in order.
            let mut to_show: Vec<usize> = Vec::new();
            for &m in &matched {
                let start = m.saturating_sub(ctx_lines);
                let end = (m + ctx_lines + 1).min(total_lines);
                for ln in start..end {
                    if to_show.last() != Some(&ln) {
                        to_show.push(ln);
                    }
                }
            }
            to_show.sort_unstable();
            to_show.dedup();

            // Apply offset/count pagination over the collapsed view.
            let total_collapsed = to_show.len();
            let page_start = request.offset.min(total_collapsed);
            let page_end = (page_start + request.count).min(total_collapsed);
            let page = &to_show[page_start..page_end];

            let matched_set: std::collections::HashSet<usize> =
                matched.iter().copied().collect();

            let mut lines = Vec::with_capacity(page.len());
            for &ln in page {
                let raw = source.raw_line(ln).unwrap_or("").to_string();
                let meta = &source.line_meta[ln];
                let highlights = request
                    .search
                    .as_ref()
                    .map(|q| compute_search_highlights(&raw, q))
                    .unwrap_or_default();

                let view_line = if let Some(ctx) = parser.parse_line(&raw, &source.id, ln) {
                    ViewLine {
                        line_num: ln,
                        raw: ctx.raw,
                        level: ctx.level,
                        tag: ctx.tag,
                        message: ctx.message,
                        timestamp: ctx.timestamp,
                        pid: ctx.pid,
                        tid: ctx.tid,
                        source_id: ctx.source_id,
                        highlights,
                        matched_by: if matched_set.contains(&ln) {
                            vec![proc_id.to_string()]
                        } else {
                            vec![]
                        },
                        is_context: !matched_set.contains(&ln),
                    }
                } else {
                    ViewLine {
                        line_num: ln,
                        raw: raw.clone(),
                        level: meta.level,
                        tag: meta.tag.clone(),
                        message: raw,
                        timestamp: meta.timestamp,
                        pid: 0,
                        tid: 0,
                        source_id: source.id.clone(),
                        highlights,
                        matched_by: if matched_set.contains(&ln) {
                            vec![proc_id.to_string()]
                        } else {
                            vec![]
                        },
                        is_context: !matched_set.contains(&ln),
                    }
                };
                lines.push(view_line);
            }

            Ok(LineWindow {
                total_lines: total_collapsed,
                lines,
            })
        }

        ViewMode::Focus(center) => {
            // Return `context` lines before and after center
            let half = request.context.max(25);
            let start = center.saturating_sub(half);
            let end = (center + half + 1).min(total_lines);

            let sub_req = LineRequest {
                session_id: request.session_id.clone(),
                mode: ViewMode::Full,
                offset: start,
                count: end - start,
                context: 0,
                processor_id: None,
                search: request.search.clone(),
            };

            // Recurse with Full mode for the sub-window
            drop(sessions); // release lock before recursive call
            let state_ref: &AppState = &state;
            let inner_sessions = state_ref
                .sessions
                .lock()
                .map_err(|_| "State lock poisoned".to_string())?;
            let inner_session = inner_sessions
                .get(&sub_req.session_id)
                .ok_or("Session not found")?;
            let inner_source = inner_session.primary_source().ok_or("No source")?;

            let mut lines = Vec::new();
            for i in start..end {
                let raw = inner_source.raw_line(i).unwrap_or("").to_string();
                let meta = &inner_source.line_meta[i];
                let highlights = sub_req
                    .search
                    .as_ref()
                    .map(|q| compute_search_highlights(&raw, q))
                    .unwrap_or_default();
                let ctx = parser.parse_line(&raw, &inner_source.id, i);
                let view_line = match ctx {
                    Some(c) => ViewLine {
                        line_num: i,
                        raw: c.raw,
                        level: c.level,
                        tag: c.tag,
                        message: c.message,
                        timestamp: c.timestamp,
                        pid: c.pid,
                        tid: c.tid,
                        source_id: c.source_id,
                        highlights,
                        matched_by: vec![],
                        is_context: i != center,
                    },
                    None => ViewLine {
                        line_num: i,
                        raw: raw.clone(),
                        level: meta.level,
                        tag: meta.tag.clone(),
                        message: raw,
                        timestamp: meta.timestamp,
                        pid: 0,
                        tid: 0,
                        source_id: inner_source.id.clone(),
                        highlights,
                        matched_by: vec![],
                        is_context: i != center,
                    },
                };
                lines.push(view_line);
            }

            Ok(LineWindow { total_lines, lines })
        }
    }
}

// ---------------------------------------------------------------------------
// search_logs
// ---------------------------------------------------------------------------

/// Parse "HH:MM" or "HH:MM:SS" into nanoseconds within a 24-hour day.
/// Returns None on invalid input.
fn parse_time_to_day_ns(s: &str) -> Option<i64> {
    let mut parts = s.splitn(3, ':');
    let h: i64 = parts.next()?.trim().parse().ok()?;
    let m: i64 = parts.next()?.trim().parse().ok()?;
    let sec: i64 = parts
        .next()
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if !(0..=23).contains(&h) || !(0..=59).contains(&m) || !(0..=59).contains(&sec) {
        return None;
    }
    Some((h * 3600 + m * 60 + sec) * 1_000_000_000)
}

#[tauri::command]
pub async fn search_logs(
    state: State<'_, AppState>,
    session_id: String,
    query: SearchQuery,
) -> Result<SearchSummary, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;

    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{session_id}' not found"))?;

    let source = session.primary_source().ok_or("No sources in session")?;

    let compiled_re = if query.is_regex {
        let pattern = if query.case_sensitive {
            query.text.clone()
        } else {
            format!("(?i){}", query.text)
        };
        Some(Regex::new(&pattern).map_err(|e| format!("Invalid regex: {e}"))?)
    } else {
        None
    };

    let needle_lower = query.text.to_lowercase();

    // Pre-compute time range bounds (nanoseconds within a 24-hour day)
    const DAY_NS: i64 = 86_400_000_000_000; // 24 * 60 * 60 * 1_000_000_000
    let start_ns = query.start_time.as_deref().and_then(parse_time_to_day_ns);
    let end_ns = query.end_time.as_deref().and_then(parse_time_to_day_ns);
    let has_time_filter = start_ns.is_some() || end_ns.is_some();

    let mut match_line_nums: Vec<usize> = Vec::new();
    let mut by_level: HashMap<String, usize> = HashMap::new();
    let mut by_tag: HashMap<String, usize> = HashMap::new();

    for (i, meta) in source.line_meta.iter().enumerate() {
        // Level filter
        if let Some(min_level) = query.min_level {
            if meta.level < min_level {
                continue;
            }
        }

        // Tag filter
        if let Some(ref tags) = query.tags {
            if !tags.is_empty() && !tags.contains(&meta.tag) {
                continue;
            }
        }

        // Time range filter (compare time-of-day component only).
        // Lines with timestamp == 0 have no parsed time and are excluded — they
        // cannot be placed within a time range (section headers, plain content, etc).
        if has_time_filter {
            if meta.timestamp == 0 {
                continue;
            }
            let ts_mod = meta.timestamp % DAY_NS;
            if let Some(s) = start_ns {
                if ts_mod < s {
                    continue;
                }
            }
            if let Some(e) = end_ns {
                if ts_mod > e {
                    continue;
                }
            }
        }

        // Text match (empty text matches everything — allows time/level/tag-only queries)
        let raw = source.raw_line(i).unwrap_or("");
        let matched = if let Some(ref re) = compiled_re {
            re.is_match(raw)
        } else if query.case_sensitive {
            raw.contains(query.text.as_str())
        } else {
            raw.to_lowercase().contains(&needle_lower)
        };

        if matched {
            match_line_nums.push(i);
            *by_level
                .entry(format!("{:?}", meta.level))
                .or_insert(0) += 1;
            if !meta.tag.is_empty() {
                *by_tag.entry(meta.tag.clone()).or_insert(0) += 1;
            }
        }
    }

    Ok(SearchSummary {
        total_matches: match_line_nums.len(),
        match_line_nums,
        by_level,
        by_tag,
    })
}

// ---------------------------------------------------------------------------
// get_dumpstate_metadata
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_dumpstate_metadata(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<DumpstateMetadata, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;

    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{session_id}' not found"))?;

    let source = session.primary_source().ok_or("No sources in session")?;

    let mut meta = DumpstateMetadata {
        build_string: None,
        build_fingerprint: None,
        os_version: None,
        build_type: None,
        bootloader: None,
        serial: None,
        uptime: None,
        kernel_version: None,
        sdk_version: None,
        device_model: None,
        manufacturer: None,
    };

    // Track which section we're in based on section header tags.
    let mut in_kernel_section = false;
    let mut kernel_next = false; // next plain content line after KERNEL VERSION header
    let mut in_props_section = false;
    let mut passed_first_section = false;

    for (i, line_m) in source.line_meta.iter().enumerate() {
        let raw = source.raw_line(i).unwrap_or("").trim_end_matches(['\r', '\n']);

        // Detect section boundaries from tag field (BugreportParser sets tag on ------ lines).
        if raw.starts_with("------") {
            if !raw.contains("was the duration of") {
                // Section start header.
                passed_first_section = true;
                let tag = &line_m.tag;
                in_kernel_section = tag == "KERNEL VERSION";
                in_props_section = tag == "SYSTEM PROPERTIES";
                kernel_next = in_kernel_section;
            }
            continue;
        }

        // Skip decorative separators and == dumpstate: lines.
        if raw.starts_with("====") || raw.starts_with("==") {
            continue;
        }

        if in_kernel_section && kernel_next && !raw.trim().is_empty() {
            meta.kernel_version = Some(raw.trim().to_string());
            kernel_next = false;
            in_kernel_section = false;
            continue;
        }

        if in_props_section {
            // Pattern: [ro.build.version.sdk]: [34]
            if let Some(rest) = raw.strip_prefix("[ro.build.version.sdk]: [") {
                meta.sdk_version = rest.strip_suffix(']').map(str::trim).map(String::from);
            } else if let Some(rest) = raw.strip_prefix("[ro.product.model]: [") {
                meta.device_model = rest.strip_suffix(']').map(str::trim).map(String::from);
            } else if let Some(rest) = raw.strip_prefix("[ro.product.manufacturer]: [") {
                meta.manufacturer = rest.strip_suffix(']').map(str::trim).map(String::from);
            }
            continue;
        }

        // Header lines before the first section.
        if !passed_first_section {
            if raw.starts_with("Build: ") && meta.build_string.is_none() {
                let value = raw["Build: ".len()..].trim().to_string();
                // Extract build type from trailing "(user)" / "(userdebug)" / "(eng)".
                if let (Some(lp), Some(rp)) = (value.rfind('('), value.rfind(')')) {
                    if lp < rp {
                        meta.build_type = Some(value[lp + 1..rp].to_string());
                    }
                }
                meta.build_string = Some(value);
            } else if raw.starts_with("Build fingerprint: '") && meta.build_fingerprint.is_none() {
                let fp = raw["Build fingerprint: '".len()..]
                    .trim_end_matches('\'')
                    .trim()
                    .to_string();
                // Extract OS version from fingerprint: brand/product/device:RELEASE/id/...
                // Third `:` separates device from RELEASE.
                if let Some(colon_pos) = fp.find(':') {
                    let after = &fp[colon_pos + 1..];
                    if let Some(slash_pos) = after.find('/') {
                        meta.os_version = Some(after[..slash_pos].to_string());
                    }
                }
                meta.build_fingerprint = Some(fp);
            } else if raw.starts_with("Bootloader: ") && meta.bootloader.is_none() {
                meta.bootloader = Some(raw["Bootloader: ".len()..].trim().to_string());
            } else if raw.contains("androidboot.serialno") && meta.serial.is_none() {
                // androidboot.serialno = "R52X10EJCFA"
                if let Some(eq_pos) = raw.find('=') {
                    let val = raw[eq_pos + 1..].trim().trim_matches('"').to_string();
                    if !val.is_empty() {
                        meta.serial = Some(val);
                    }
                }
            } else if raw.starts_with("Uptime: ") && meta.uptime.is_none() {
                meta.uptime = Some(raw["Uptime: ".len()..].trim().to_string());
            }
        }

        // Stop scanning once we have all header data and have seen system properties.
        if passed_first_section
            && in_props_section
            && meta.sdk_version.is_some()
            && meta.device_model.is_some()
            && meta.manufacturer.is_some()
        {
            break;
        }
    }

    Ok(meta)
}

// ---------------------------------------------------------------------------
// get_sections
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_sections(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<SectionInfo>, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{session_id}' not found"))?;
    let src = session.primary_source().ok_or("No sources in session")?;
    Ok(src.sections.clone())
}

// ---------------------------------------------------------------------------
// Highlight computation
// ---------------------------------------------------------------------------

pub fn compute_search_highlights(raw: &str, query: &SearchQuery) -> Vec<HighlightSpan> {
    if query.text.is_empty() {
        return vec![];
    }

    let mut spans = Vec::new();

    if query.is_regex {
        let pattern = if query.case_sensitive {
            query.text.clone()
        } else {
            format!("(?i){}", query.text)
        };
        if let Ok(re) = Regex::new(&pattern) {
            for m in re.find_iter(raw) {
                spans.push(HighlightSpan {
                    start: m.start(),
                    end: m.end(),
                    kind: HighlightKind::Search,
                });
            }
        }
    } else if query.case_sensitive {
        let mut offset = 0;
        while let Some(pos) = raw[offset..].find(query.text.as_str()) {
            let abs = offset + pos;
            spans.push(HighlightSpan {
                start: abs,
                end: abs + query.text.len(),
                kind: HighlightKind::Search,
            });
            offset = abs + query.text.len().max(1);
            if offset >= raw.len() {
                break;
            }
        }
    } else {
        let lower_raw = raw.to_lowercase();
        let lower_needle = query.text.to_lowercase();
        let mut offset = 0;
        while let Some(pos) = lower_raw[offset..].find(&lower_needle) {
            let abs = offset + pos;
            spans.push(HighlightSpan {
                start: abs,
                end: abs + lower_needle.len(),
                kind: HighlightKind::Search,
            });
            offset = abs + lower_needle.len().max(1);
            if offset >= lower_raw.len() {
                break;
            }
        }
    }

    spans
}
