use aho_corasick::AhoCorasick;
use rayon::prelude::*;
use regex::RegexSet;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::AppState;
use crate::core::line::PipelineContext;
use crate::core::log_source::FileLogSource;
use crate::core::session::{parser_for, SectionInfo};
use crate::processors::ProcessorKind;
use crate::processors::marketplace::resolve_processor_id;
use crate::processors::correlator::engine::CorrelatorRun;
use crate::processors::reporter::engine::ProcessorRun;
use crate::processors::state_tracker::engine::StateTrackerRun;
use crate::processors::transformer::engine::TransformerRun;

// ---------------------------------------------------------------------------
// Progress event payload
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgress {
    pub session_id: String,
    pub processor_id: String,
    pub lines_processed: usize,
    pub total_lines: usize,
    pub percent: f32,
}

// ---------------------------------------------------------------------------
// Result summary returned from run_pipeline
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunSummary {
    pub processor_id: String,
    pub matched_lines: usize,
    pub emission_count: usize,
}

// ---------------------------------------------------------------------------
// Source snapshot — data extracted from the session under lock
// ---------------------------------------------------------------------------

/// Lightweight handle to the source data, cloned from the session so we
/// can process without holding the sessions lock.
enum SourceSnapshot {
    File {
        mmap: Arc<memmap2::Mmap>,
        line_index: Vec<u64>,
    },
    Stream {
        raw_lines: Vec<String>,
    },
}

impl SourceSnapshot {
    fn total_lines(&self) -> usize {
        match self {
            // Sentinel-based: line_index has N+1 entries for N lines.
            SourceSnapshot::File { line_index, .. } => {
                if line_index.is_empty() { 0 } else { line_index.len() - 1 }
            }
            SourceSnapshot::Stream { raw_lines } => raw_lines.len(),
        }
    }

    fn raw_line(&self, n: usize) -> Option<&str> {
        match self {
            SourceSnapshot::File { mmap, line_index } => {
                if n + 1 >= line_index.len() {
                    return None;
                }
                let start = line_index[n] as usize;
                let end = line_index[n + 1] as usize;
                // Guard against corrupt/stale offsets (can happen during concurrent indexing)
                if start >= end || end > mmap.len() {
                    return None;
                }
                // Trim trailing \n and \r\n
                let slice = &mmap[start..end];
                let trimmed = if slice.ends_with(b"\r\n") {
                    &slice[..slice.len() - 2]
                } else if slice.ends_with(b"\n") {
                    &slice[..slice.len() - 1]
                } else {
                    slice
                };
                std::str::from_utf8(trimmed).ok()
            }
            SourceSnapshot::Stream { raw_lines } => {
                raw_lines.get(n).map(std::string::String::as_str)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pre-filter: quick tag extraction without regex (~10ns vs ~200ns)
// ---------------------------------------------------------------------------

/// Extract the tag from a raw logcat threadtime line without regex.
///
/// Threadtime format: `MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG     : message`
/// The level is a single char (V/D/I/W/E/F/S) preceded by whitespace.
/// The tag follows the level, trimmed, up to the first `: ` or `:` delimiter.
///
/// Returns `None` if the line doesn't look like threadtime format.
fn quick_extract_tag(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    // Threadtime lines start with MM-DD (digit-digit-dash).
    // Quick reject lines that clearly aren't threadtime.
    if bytes.len() < 20 || !bytes[0].is_ascii_digit() {
        return None;
    }

    // Find the log level character. After the timestamp + PID + TID block,
    // there's a single level character. Scan for it starting after position 18
    // (minimum: "MM-DD HH:MM:SS.mmm" = 18 chars).
    // The level char is one of V/D/I/W/E/F/S, preceded by whitespace and
    // followed by either a space or the tag directly.
    let search_start = 18;
    let mut i = search_start;
    while i < bytes.len() {
        let b = bytes[i];
        if matches!(b, b'V' | b'D' | b'I' | b'W' | b'E' | b'F' | b'S') {
            // Verify: preceded by space, followed by space or end
            if i > 0 && bytes[i - 1] == b' ' && (i + 1 >= bytes.len() || bytes[i + 1] == b' ') {
                // Tag starts after the level + space
                let tag_start = i + 2;
                if tag_start >= bytes.len() {
                    return None;
                }
                // Find the ": " delimiter that separates tag from message
                // Tag may have trailing spaces (logcat pads tags to column width)
                if let Some(colon_pos) = raw[tag_start..].find(": ") {
                    let tag = raw[tag_start..tag_start + colon_pos].trim();
                    if !tag.is_empty() {
                        return Some(tag);
                    }
                }
                // Also handle tag ending with ":" at end of visible content
                if let Some(colon_pos) = raw[tag_start..].find(':') {
                    let tag = raw[tag_start..tag_start + colon_pos].trim();
                    if !tag.is_empty() {
                        return Some(tag);
                    }
                }
                return None;
            }
        }
        i += 1;
    }
    None
}

/// Extract the message portion from a raw logcat threadtime line.
///
/// Returns the substring after the first `: ` delimiter following the log level,
/// or `None` if the line doesn't look like threadtime format.
fn quick_extract_message(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    if bytes.len() < 20 || !bytes[0].is_ascii_digit() {
        return None;
    }

    // Find the first ": " after position 18 (past timestamp)
    // This separates "tag     : message"
    let search_start = 18;
    if let Some(pos) = raw[search_start..].find(": ") {
        let msg_start = search_start + pos + 2;
        if msg_start < raw.len() {
            return Some(&raw[msg_start..]);
        }
    }
    None
}

/// Extract the leading literal (non-metacharacter) prefix from a regex pattern.
///
/// Used to populate the tag pre-filter union from `tag_regex` patterns.
/// For example, `NetworkMonitor/\d+` returns `Some("NetworkMonitor")`.
/// Returns `None` when the pattern starts with a metacharacter (empty prefix).
fn extract_regex_literal_prefix(pattern: &str) -> Option<String> {
    let mut prefix = String::new();
    for b in pattern.bytes() {
        if matches!(b, b'.' | b'*' | b'+' | b'?' | b'(' | b')' | b'[' | b']'
                     | b'{' | b'}' | b'^' | b'$' | b'|' | b'\\') {
            break;
        }
        prefix.push(b as char);
    }
    let prefix = prefix.trim_end_matches('/').to_string();
    if prefix.is_empty() { None } else { Some(prefix) }
}

/// Check if a set of filter rules contains a SourceTypeIs that doesn't match the current source type.
fn excluded_by_source_type(rules: &[crate::processors::reporter::schema::FilterRule], source_type: &crate::core::session::SourceType) -> bool {
    rules.iter().any(|rule| {
        matches!(
            rule,
            crate::processors::reporter::schema::FilterRule::SourceTypeIs { source_type: st }
                if !source_type.matches_str(st)
        )
    })
}

/// Collect the union of all tag filters from Layer 2 processors only.
/// Transformers are excluded (they run in Layer 1 on all lines).
///
/// Returns `(tag_union, has_unfiltered)` where:
/// - `tag_union`: set of tag prefixes that any Layer 2 processor filters on
/// - `has_unfiltered`: true if any Layer 2 processor has NO tag filter
fn collect_tag_filters(
    reporter_defs: &[(String, crate::processors::reporter::schema::ReporterDef)],
    tracker_defs: &[(String, crate::processors::state_tracker::schema::StateTrackerDef)],
    correlator_defs: &[(String, crate::processors::correlator::schema::CorrelatorDef)],
    _transformer_defs: &[(String, crate::processors::transformer::schema::TransformerDef)],
) -> (HashSet<String>, bool) {
    let mut tag_union = HashSet::new();
    let mut has_unfiltered = false;

    // Reporters: check pipeline filter stages for TagMatch rules
    for (_, def) in reporter_defs {
        let mut has_tag_filter = false;
        for stage in &def.pipeline {
            if let crate::processors::reporter::schema::PipelineStage::Filter(filter_stage) = stage {
                for rule in &filter_stage.rules {
                    if let crate::processors::reporter::schema::FilterRule::TagMatch { tags, .. } = rule {
                        has_tag_filter = true;
                        tag_union.extend(tags.iter().cloned());
                    }
                }
            }
        }
        if !has_tag_filter {
            has_unfiltered = true;
        }
    }

    // State trackers: check each transition's filter.tag and filter.tag_regex
    for (_, def) in tracker_defs {
        let mut has_tag_filter = true; // assume all transitions have tags
        for transition in &def.transitions {
            let has_exact = transition.filter.tag.is_some();
            let has_regex = transition.filter.tag_regex.is_some();

            if !has_exact && !has_regex {
                has_tag_filter = false;
            } else {
                if let Some(tag) = &transition.filter.tag {
                    tag_union.insert(tag.clone());
                }
                if let Some(pattern) = &transition.filter.tag_regex {
                    if let Some(prefix) = extract_regex_literal_prefix(pattern) {
                        tag_union.insert(prefix);
                    }
                }
            }
        }
        if !has_tag_filter || def.transitions.is_empty() {
            has_unfiltered = true;
        }
    }

    // Correlators: check each source's filter rules for TagMatch
    for (_, def) in correlator_defs {
        for source in &def.sources {
            let mut has_tag_filter = false;
            for rule in &source.filter {
                if let crate::processors::reporter::schema::FilterRule::TagMatch { tags, .. } = rule {
                    has_tag_filter = true;
                    tag_union.extend(tags.iter().cloned());
                }
            }
            if !has_tag_filter {
                has_unfiltered = true;
            }
        }
    }

    // Transformers intentionally excluded — they run in Layer 1 on ALL lines.
    // Their lack of tag filters should not disable pre-filtering for Layer 2.

    (tag_union, has_unfiltered)
}

/// Collect all `MessageContains` and `MessageContainsAny` substring patterns
/// from active processors for Aho-Corasick pre-filtering.
///
/// Returns `(patterns, has_proc_without_substring_filter)` where:
/// - `patterns`: deduplicated list of substrings to build into an AC automaton
/// - `has_proc_without_substring_filter`: true if any processor that has a tag
///   filter (or other filters) but NO substring/regex message filter — meaning
///   it could match any message content and we can't skip based on substrings
fn collect_substring_filters(
    reporter_defs: &[(String, crate::processors::reporter::schema::ReporterDef)],
    tracker_defs: &[(String, crate::processors::state_tracker::schema::StateTrackerDef)],
    correlator_defs: &[(String, crate::processors::correlator::schema::CorrelatorDef)],
) -> (Vec<String>, bool) {
    let mut patterns: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut has_proc_without_substring_filter = false;

    let mut add_pattern = |s: &str| {
        if !seen.contains(s) {
            seen.insert(s.to_string());
            patterns.push(s.to_string());
        }
    };

    // Reporters: check pipeline filter stages for MessageContains / MessageContainsAny / MessageRegex
    for (_, def) in reporter_defs {
        let mut has_message_filter = false;
        for stage in &def.pipeline {
            if let crate::processors::reporter::schema::PipelineStage::Filter(filter_stage) = stage {
                for rule in &filter_stage.rules {
                    match rule {
                        crate::processors::reporter::schema::FilterRule::MessageContains { value } => {
                            has_message_filter = true;
                            add_pattern(value);
                        }
                        crate::processors::reporter::schema::FilterRule::MessageContainsAny { values } => {
                            has_message_filter = true;
                            for v in values {
                                add_pattern(v);
                            }
                        }
                        crate::processors::reporter::schema::FilterRule::MessageRegex { .. } => {
                            // Has a message filter but it's regex — we can't add it to AC,
                            // but the processor IS filtered on message content so it won't
                            // match arbitrary lines. Mark as having a message filter.
                            has_message_filter = true;
                        }
                        _ => {}
                    }
                }
            }
        }
        if !has_message_filter {
            has_proc_without_substring_filter = true;
        }
    }

    // State trackers: check each transition's filter for message_contains
    for (_, def) in tracker_defs {
        let mut has_message_filter = true; // assume all transitions have message filters
        for transition in &def.transitions {
            let has_msg = transition.filter.message_contains.is_some()
                || transition.filter.message_regex.is_some();
            if !has_msg {
                has_message_filter = false;
            }
            if let Some(mc) = &transition.filter.message_contains {
                add_pattern(mc);
            }
        }
        if !has_message_filter || def.transitions.is_empty() {
            has_proc_without_substring_filter = true;
        }
    }

    // Correlators: check each source's filter rules
    for (_, def) in correlator_defs {
        for source in &def.sources {
            let mut has_message_filter = false;
            for rule in &source.filter {
                match rule {
                    crate::processors::reporter::schema::FilterRule::MessageContains { value } => {
                        has_message_filter = true;
                        add_pattern(value);
                    }
                    crate::processors::reporter::schema::FilterRule::MessageContainsAny { values } => {
                        has_message_filter = true;
                        for v in values {
                            add_pattern(v);
                        }
                    }
                    crate::processors::reporter::schema::FilterRule::MessageRegex { .. } => {
                        has_message_filter = true;
                    }
                    _ => {}
                }
            }
            if !has_message_filter {
                has_proc_without_substring_filter = true;
            }
        }
    }

    // Note: Transformers are excluded — they don't have message content filters
    // that would allow skipping. A transformer without a filter applies to all
    // lines, and that's already captured by `has_unfiltered` in collect_tag_filters.

    (patterns, has_proc_without_substring_filter)
}

/// Collect all `MessageRegex` patterns from active processors for RegexSet
/// pre-filtering. Returns `(patterns, has_proc_without_any_message_filter)` where:
/// - `patterns`: deduplicated valid regex patterns from MessageRegex filters
/// - `has_proc_without_any_message_filter`: true if any processor has NO message
///   filter at all (neither substring nor regex) — meaning we can't skip lines
///   based on message content alone
fn collect_regex_filters(
    reporter_defs: &[(String, crate::processors::reporter::schema::ReporterDef)],
    tracker_defs: &[(String, crate::processors::state_tracker::schema::StateTrackerDef)],
    correlator_defs: &[(String, crate::processors::correlator::schema::CorrelatorDef)],
) -> (Vec<String>, bool) {
    let mut patterns: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut has_proc_without_any_message_filter = false;

    let mut add_pattern = |s: &str| {
        if !seen.contains(s) {
            // Only add if it compiles as a valid regex
            if regex::Regex::new(s).is_ok() {
                seen.insert(s.to_string());
                patterns.push(s.to_string());
            }
        }
    };

    // Reporters: extract MessageRegex patterns
    for (_, def) in reporter_defs {
        let mut has_any_message_filter = false;
        for stage in &def.pipeline {
            if let crate::processors::reporter::schema::PipelineStage::Filter(filter_stage) = stage {
                for rule in &filter_stage.rules {
                    match rule {
                        crate::processors::reporter::schema::FilterRule::MessageRegex { pattern } => {
                            has_any_message_filter = true;
                            add_pattern(pattern);
                        }
                        crate::processors::reporter::schema::FilterRule::MessageContains { .. }
                        | crate::processors::reporter::schema::FilterRule::MessageContainsAny { .. } => {
                            has_any_message_filter = true;
                        }
                        _ => {}
                    }
                }
            }
        }
        if !has_any_message_filter {
            has_proc_without_any_message_filter = true;
        }
    }

    // State trackers: extract message_regex patterns
    for (_, def) in tracker_defs {
        let mut has_any_message_filter = true;
        for transition in &def.transitions {
            let has_msg = transition.filter.message_contains.is_some()
                || transition.filter.message_regex.is_some();
            if !has_msg {
                has_any_message_filter = false;
            }
            if let Some(pattern) = &transition.filter.message_regex {
                add_pattern(pattern);
            }
        }
        if !has_any_message_filter || def.transitions.is_empty() {
            has_proc_without_any_message_filter = true;
        }
    }

    // Correlators: extract MessageRegex patterns from source filters
    for (_, def) in correlator_defs {
        for source in &def.sources {
            let mut has_any_message_filter = false;
            for rule in &source.filter {
                match rule {
                    crate::processors::reporter::schema::FilterRule::MessageRegex { pattern } => {
                        has_any_message_filter = true;
                        add_pattern(pattern);
                    }
                    crate::processors::reporter::schema::FilterRule::MessageContains { .. }
                    | crate::processors::reporter::schema::FilterRule::MessageContainsAny { .. } => {
                        has_any_message_filter = true;
                    }
                    _ => {}
                }
            }
            if !has_any_message_filter {
                has_proc_without_any_message_filter = true;
            }
        }
    }

    (patterns, has_proc_without_any_message_filter)
}

// ---------------------------------------------------------------------------
// run_pipeline
// ---------------------------------------------------------------------------

const CHUNK_SIZE: usize = 50_000;

#[tauri::command]
pub async fn run_pipeline(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    processor_ids: Vec<String>,
    // Kept for backward-compat with frontend — anonymization is now driven by
    // having a Transformer processor (e.g. __pii_anonymizer) in processor_ids.
    #[allow(unused_variables)]
    anonymize: bool,
) -> Result<Vec<PipelineRunSummary>, String> {
    execute_pipeline(&state, &app, &session_id, &processor_ids)
}

/// Core pipeline execution logic. Called by both the Tauri command and the MCP bridge.
pub fn execute_pipeline(
    state: &AppState,
    app: &AppHandle,
    session_id: &str,
    processor_ids: &[String],
) -> Result<Vec<PipelineRunSummary>, String> {
    // Reset cancellation flag at the start
    state.pipeline_cancel.store(false, Ordering::Relaxed);

    // ── Partition processor IDs by kind and clone defs (single lock scope) ───
    let mut transformer_defs = Vec::new();
    let mut reporter_defs = Vec::new();
    let mut tracker_defs = Vec::new();
    let mut correlator_defs = Vec::new();
    {
        let procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
        for id in processor_ids {
            let resolved = resolve_processor_id(&procs, id)
                .unwrap_or_else(|| id.clone());
            if let Some(p) = procs.get(resolved.as_str()) {
                match &p.kind {
                    ProcessorKind::Transformer(d) => transformer_defs.push((resolved, d.clone())),
                    ProcessorKind::Reporter(d) => reporter_defs.push((resolved, d.clone())),
                    ProcessorKind::StateTracker(d) => tracker_defs.push((resolved, d.clone())),
                    ProcessorKind::Correlator(d) => correlator_defs.push((resolved, d.clone())),
                    _ => {} // Annotator: schema stub, no engine yet
                }
            }
        }
    }

    // ── Snapshot source data ─────────────────────────────────────────────────
    let (source_snapshot, source_id, source_type, src_sections) = {
        let sessions = state.sessions.lock().map_err(|_| "Session lock poisoned")?;
        let session = sessions.get(session_id)
            .ok_or_else(|| format!("Session '{session_id}' not found"))?;
        let src = session.primary_source().ok_or("No sources in session")?;

        let sid = src.id().to_string();
        let stype = src.source_type().clone();

        // Build snapshot by downcasting to concrete type
        let snapshot = if let Some(file_src) = src.as_any().downcast_ref::<FileLogSource>() {
            SourceSnapshot::File {
                mmap: Arc::clone(file_src.mmap()),
                line_index: file_src.line_index().to_vec(),
            }
        } else {
            // StreamLogSource — clone the raw lines
            let stream_src = session.stream_source().ok_or("Source is neither File nor Stream")?;
            SourceSnapshot::Stream {
                raw_lines: stream_src.raw_lines.clone(),
            }
        };

        let src_sections: Vec<SectionInfo> = src.sections().to_vec();

        (snapshot, sid, stype, src_sections)
    };
    // Sessions lock released.

    // ── Pre-filter: exclude processors whose source_type filter doesn't match ─
    reporter_defs.retain(|(_, def)| {
        !def.pipeline.iter().any(|stage| {
            if let crate::processors::reporter::schema::PipelineStage::Filter(f) = stage {
                excluded_by_source_type(&f.rules, &source_type)
            } else {
                false
            }
        })
    });
    tracker_defs.retain(|(_, def)| {
        !def.transitions.iter().any(|t| {
            t.filter.source_type.as_ref()
                .is_some_and(|st| !source_type.matches_str(st))
        })
    });
    // Correlators are cross-source: retain if ANY source matches (not excluded).
    // A correlator with sources for both Logcat and Bugreport should not be
    // excluded when processing either source type.
    correlator_defs.retain(|(_, def)| {
        def.sources.iter().any(|src| {
            !excluded_by_source_type(&src.filter, &source_type)
        })
    });

    // ── Section ranges indexed parallel to (filtered) reporter_defs ───────────
    let section_ranges: Vec<Option<Vec<(usize, usize)>>> = reporter_defs.iter()
        .map(|(_, def)| {
            // Collect section names from both top-level sections AND SectionIs filter rules
            let mut section_names: Vec<&str> = def.sections.iter().map(std::string::String::as_str).collect();

            for stage in &def.pipeline {
                if let crate::processors::reporter::schema::PipelineStage::Filter(f) = stage {
                    for rule in &f.rules {
                        if let crate::processors::reporter::schema::FilterRule::SectionIs { section } = rule {
                            if !section_names.contains(&section.as_str()) {
                                section_names.push(section.as_str());
                            }
                        }
                    }
                }
            }

            if section_names.is_empty() {
                None
            } else {
                let r: Vec<(usize, usize)> = section_names.iter()
                    .filter_map(|name| src_sections.iter().find(|s| s.name == *name))
                    .map(|s| (s.start_line, s.end_line))
                    .collect();
                if r.is_empty() { None } else { Some(r) }
            }
        })
        .collect();

    let pipeline_ctx = PipelineContext {
        source_type: source_type.clone(),
        source_name: Arc::from(source_id.as_str()),
        is_streaming: matches!(source_snapshot, SourceSnapshot::Stream { .. }),
        sections: Arc::from(src_sections.as_slice()),
    };

    let total_lines = source_snapshot.total_lines();
    let parser = parser_for(&source_type);

    // ── Snapshot anonymizer config ───────────────────────────────────────────
    let anonymizer_config = state.anonymizer_config.lock()
        .map_err(|_| "Anonymizer config lock poisoned")?
        .clone();

    // ── PII pre-processing step (built-in transformer) ──────────────────────
    let mut transformer_runs: Vec<TransformerRun> = transformer_defs.iter()
        .map(|(_, def)| TransformerRun::new_with_anonymizer_config(def, &anonymizer_config))
        .collect();

    // ── Initialize reporter runs ─────────────────────────────────────────────
    #[allow(clippy::type_complexity)]
    let mut reporter_runs: Vec<(ProcessorRun<'_>, &Option<Vec<(usize, usize)>>)> = reporter_defs.iter()
        .zip(section_ranges.iter())
        .map(|((_, def), ranges)| (ProcessorRun::new(def), ranges))
        .collect();

    // ── Initialize tracker runs ──────────────────────────────────────────────
    let mut tracker_runs: Vec<(String, StateTrackerRun)> = tracker_defs.iter()
        .map(|(tid, def)| (tid.clone(), StateTrackerRun::new(tid, def)))
        .collect();

    // ── Initialize correlator runs ───────────────────────────────────────────
    let mut correlator_runs: Vec<(String, CorrelatorRun<'_>)> = correlator_defs.iter()
        .map(|(cid, def)| (cid.clone(), CorrelatorRun::new(def)))
        .collect();

    // Forward PII mapping accumulated across all chunks
    let mut forward_pii: HashMap<String, String> = HashMap::new();

    // Cancellation flag
    let cancel = Arc::clone(&state.pipeline_cancel);

    // ── Pre-filter: collect tag union from all active processors ─────────────
    let (tag_union, has_unfiltered) = collect_tag_filters(
        &reporter_defs, &tracker_defs, &correlator_defs, &transformer_defs,
    );

    // ── Pre-filter: collect substring patterns for Aho-Corasick ─────────────
    let (ac_patterns, _has_proc_without_substring_filter) = collect_substring_filters(
        &reporter_defs, &tracker_defs, &correlator_defs,
    );

    // ── Pre-filter: collect regex patterns for RegexSet ───────────────────────
    let (regex_patterns, has_proc_without_any_message_filter) = collect_regex_filters(
        &reporter_defs, &tracker_defs, &correlator_defs,
    );

    // Build AC automaton from substring patterns (if any exist)
    let ac_automaton: Option<AhoCorasick> = if !ac_patterns.is_empty() {
        AhoCorasick::new(&ac_patterns).ok()
    } else {
        None
    };

    // Build RegexSet from regex patterns (if any exist and aren't covered by AC)
    let regex_set: Option<RegexSet> = if !regex_patterns.is_empty() {
        RegexSet::new(&regex_patterns).ok()
    } else {
        None
    };

    // Content pre-filter is usable when:
    // 1. We're not bypassed by has_unfiltered (some processor has no tag filter)
    // 2. Every processor has SOME message filter (substring or regex)
    // 3. We have at least one content filter mechanism built (AC or RegexSet)
    let use_content_prefilter = !has_unfiltered
        && !has_proc_without_any_message_filter
        && (ac_automaton.is_some() || regex_set.is_some());

    let use_tag_prefilter = !has_unfiltered && !tag_union.is_empty();

    // ── Chunked processing loop ──────────────────────────────────────────────
    let mut lines_processed = 0usize;

    for chunk_start in (0..total_lines).step_by(CHUNK_SIZE) {
        // Check cancellation
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let chunk_end = (chunk_start + CHUNK_SIZE).min(total_lines);

        // ── Pre-filter: build list of lines worth parsing ────────────────────
        // Three-level pre-filter:
        // 1. Tag filter: skip lines whose tag doesn't match any processor (~10ns)
        // 2. Aho-Corasick: skip lines that don't contain any required substring (~20ns)
        // 3. RegexSet: skip lines that don't match any required regex (~50-200ns)
        // Levels 2+3 are OR-ed: a line passes if AC matches OR RegexSet matches.
        // All are conservative: if we can't determine, we assume the line matches.
        let line_indices: Vec<usize> = if use_tag_prefilter || use_content_prefilter {
            (chunk_start..chunk_end)
                .filter(|&n| {
                    let raw = source_snapshot.raw_line(n).unwrap_or("");

                    // Level 1: tag check (prefix match — "NetworkMonitor"
                    // in the union matches "NetworkMonitor/102" in the line)
                    if use_tag_prefilter {
                        if let Some(tag) = quick_extract_tag(raw) {
                            if !tag_union.iter().any(|t| tag.starts_with(t.as_str())) {
                                return false;
                            }
                        }
                    }

                    // Levels 2+3: content check (AC substring OR RegexSet)
                    // A line passes if ANY content filter matches.
                    if use_content_prefilter {
                        // Short-circuit: try AC first (cheaper, ~20ns)
                        if let Some(ref ac) = ac_automaton {
                            if ac.find(raw.as_bytes()).is_some() {
                                return true; // AC matched — no need to check RegexSet
                            }
                        }

                        // Try RegexSet on the message portion only (more expensive)
                        if let Some(ref rs) = regex_set {
                            let msg = quick_extract_message(raw).unwrap_or(raw);
                            if rs.is_match(msg) {
                                return true; // RegexSet matched
                            }
                        }

                        // Neither AC nor RegexSet matched — skip this line
                        return false;
                    }

                    true
                })
                .collect()
        } else {
            (chunk_start..chunk_end).collect()
        };

        let chunk_line_count = chunk_end - chunk_start;

        // ── Parse filtered lines in parallel ─────────────────────────────────
        let mut parsed_chunk: Vec<Option<crate::core::line::LineContext>> = line_indices
            .into_par_iter()
            .map(|n| {
                let raw = source_snapshot.raw_line(n).unwrap_or("");
                parser.parse_line(raw, &source_id, n)
            })
            .collect();

        // ── Save pre-transform messages for state tracker processing ─────────
        // When PII anonymization is active, state trackers need the original
        // (pre-anonymized) messages for their capture regexes.
        let pre_transform_msgs: HashMap<usize, Arc<str>> =
            if !transformer_defs.is_empty() && !tracker_defs.is_empty() {
                parsed_chunk
                    .iter()
                    .filter_map(|opt| opt.as_ref().map(|l| (l.source_line_num, Arc::clone(&l.message))))
                    .collect()
            } else {
                HashMap::new()
            };

        // ── PII pre-processing (built-in transformer) ───────────────────────
        if !transformer_defs.is_empty() {
            for line_opt in &mut parsed_chunk {
                if let Some(line) = line_opt.as_mut() {
                    let mut keep = true;
                    for run in &mut transformer_runs {
                        if !run.process_line(line) {
                            keep = false;
                            break;
                        }
                    }
                    if !keep {
                        *line_opt = None;
                    }
                }
            }
        }

        // Collect non-dropped lines for downstream layers
        let enriched_chunk: Vec<crate::core::line::LineContext> =
            parsed_chunk.into_iter().flatten().collect();

        // ── Prepare pre-anonymization messages for state trackers ────────────
        // State trackers need raw (pre-PII) messages for capture regexes,
        // while reporters need post-anonymization messages. Build both views upfront.
        let tracker_chunk: Vec<crate::core::line::LineContext> =
            if !tracker_defs.is_empty() && !pre_transform_msgs.is_empty() {
                enriched_chunk.iter().map(|line| {
                    let mut clone = line.clone();
                    if let Some(orig) = pre_transform_msgs.get(&line.source_line_num) {
                        clone.message = Arc::clone(orig);
                    }
                    clone
                }).collect()
            } else {
                Vec::new() // empty — trackers will use enriched_chunk directly
            };
        let tracker_lines: &[crate::core::line::LineContext] =
            if !tracker_chunk.is_empty() { &tracker_chunk } else { &enriched_chunk };

        // ── Layers 2a/2b/2c: Data-parallel by processor ─────────────────────
        // Each processor gets its own rayon task iterating all lines in the chunk.
        // State trackers, reporters, and correlators run in parallel with each other.
        rayon::scope(|s| {
            let pctx = &pipeline_ctx;

            // Layer 2a: StateTrackers — one task per tracker
            for (_, run) in &mut tracker_runs {
                let lines = tracker_lines;
                s.spawn(move |_| {
                    for line in lines {
                        run.process_line(line, pctx);
                    }
                });
            }

            // Layer 2b: Reporters — one task per reporter
            for (run, ranges) in &mut reporter_runs {
                let lines = &enriched_chunk;
                s.spawn(move |_| {
                    for ctx in lines {
                        if let Some(ranges) = ranges {
                            if !ranges.iter().any(|(start, end)| {
                                ctx.source_line_num >= *start && ctx.source_line_num <= *end
                            }) {
                                continue;
                            }
                        }
                        run.process_line(ctx, pctx);
                    }
                });
            }

            // Layer 2c: Correlators — one task per correlator
            for (_, run) in &mut correlator_runs {
                let lines = &enriched_chunk;
                s.spawn(move |_| {
                    for line in lines {
                        run.process_line(line, pctx);
                    }
                });
            }
        });

        // ── Progress emission (after chunk completes) ────────────────────────
        // Report progress based on chunk boundaries (all lines in the chunk,
        // including pre-filtered ones, count toward progress).
        lines_processed += chunk_line_count;
        for proc_id in processor_ids {
            let _ = app.emit(
                "pipeline-progress",
                PipelineProgress {
                    session_id: session_id.to_string(),
                    processor_id: proc_id.clone(),
                    lines_processed,
                    total_lines,
                    percent: lines_processed as f32 / total_lines.max(1) as f32 * 100.0,
                },
            );
        }
    }

    // ── Collect PII forward mappings from PII pre-processing ────────────────
    if !transformer_defs.is_empty() {
        forward_pii = transformer_runs.iter()
            .flat_map(super::super::processors::transformer::engine::TransformerRun::get_pii_mappings)
            .collect();
        if !forward_pii.is_empty() {
            let inverted: HashMap<String, String> =
                forward_pii.iter().map(|(raw, tok)| (tok.clone(), raw.clone())).collect();
            if let Ok(mut pm) = state.pii_mappings.lock() {
                pm.insert(session_id.to_string(), inverted);
            }
        }
    }

    // ── Finalize state tracker results ───────────────────────────────────────
    if !tracker_defs.is_empty() {
        let session_tracker_results: HashMap<String, _> = tracker_runs.into_iter()
            .map(|(tracker_id, run)| {
                let mut result = run.finish();

                // Post-process: replace any captured raw PII values with tokens.
                if !forward_pii.is_empty() {
                    for transition in &mut result.transitions {
                        for change in transition.changes.values_mut() {
                            if let serde_json::Value::String(s) = &change.to {
                                if let Some(token) = forward_pii.get(s.as_str()) {
                                    change.to = serde_json::Value::String(token.clone());
                                }
                            }
                            if let serde_json::Value::String(s) = &change.from {
                                if let Some(token) = forward_pii.get(s.as_str()) {
                                    change.from = serde_json::Value::String(token.clone());
                                }
                            }
                        }
                    }
                    // Also anonymize the final_state snapshot
                    for val in result.final_state.values_mut() {
                        if let serde_json::Value::String(s) = val {
                            if let Some(token) = forward_pii.get(s.as_str()) {
                                *s = token.clone();
                            }
                        }
                    }
                }

                (tracker_id, result)
            })
            .collect();

        if let Ok(mut str_results) = state.state_tracker_results.lock() {
            str_results.insert(session_id.to_string(), session_tracker_results);
        }
    }

    // ── Finalize correlator results ──────────────────────────────────────────
    if !correlator_defs.is_empty() {
        let session_correlator_results: HashMap<String, _> = correlator_runs.into_iter()
            .map(|(cid, run)| (cid, run.finish()))
            .collect();
        if let Ok(mut cr) = state.correlator_results.lock() {
            cr.insert(session_id.to_string(), session_correlator_results);
        }
    }

    // ── Collect results ───────────────────────────────────────────────────────
    let mut summaries: Vec<PipelineRunSummary> = Vec::new();
    let mut session_pipeline_results: HashMap<String, _> = HashMap::new();

    // Reporter results
    for ((proc_id, _def), (run, _sorted)) in reporter_defs.iter().zip(reporter_runs.into_iter()) {
        let result = run.finish();
        summaries.push(PipelineRunSummary {
            processor_id: proc_id.clone(),
            matched_lines: result.matched_line_nums.len(),
            emission_count: result.emissions.len(),
        });
        session_pipeline_results.insert(proc_id.clone(), result);
    }

    // StateTracker summaries (transition count as matched_lines)
    if let Ok(str_results) = state.state_tracker_results.lock() {
        if let Some(session_str) = str_results.get(session_id) {
            for (tracker_id, _) in &tracker_defs {
                if let Some(result) = session_str.get(tracker_id.as_str()) {
                    summaries.push(PipelineRunSummary {
                        processor_id: tracker_id.clone(),
                        matched_lines: result.transitions.len(),
                        emission_count: 0,
                    });
                }
            }
        }
    }

    // Transformer summaries (no matched lines concept — emit 0)
    for (t_id, _) in &transformer_defs {
        summaries.push(PipelineRunSummary {
            processor_id: t_id.clone(),
            matched_lines: 0,
            emission_count: 0,
        });
    }

    // Correlator summaries (event count as emission_count)
    if let Ok(cr) = state.correlator_results.lock() {
        if let Some(session_map) = cr.get(session_id) {
            for (corr_id, _) in &correlator_defs {
                if let Some(result) = session_map.get(corr_id.as_str()) {
                    summaries.push(PipelineRunSummary {
                        processor_id: corr_id.clone(),
                        matched_lines: result.events.len(),
                        emission_count: result.events.len(),
                    });
                }
            }
        }
    }

    {
        let mut pr = state.pipeline_results.lock()
            .map_err(|_| "Pipeline results lock poisoned")?;
        pr.insert(session_id.to_string(), session_pipeline_results);
    }

    Ok(summaries)
}

// ---------------------------------------------------------------------------
// stop_pipeline — sets cancellation flag for the active pipeline run
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn stop_pipeline(state: State<'_, AppState>) -> Result<(), String> {
    state.pipeline_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::extract_regex_literal_prefix;

    #[test]
    fn extract_prefix_simple_tag() {
        assert_eq!(extract_regex_literal_prefix(r"NetworkMonitor/\d+"), Some("NetworkMonitor".into()));
    }

    #[test]
    fn extract_prefix_with_groups() {
        assert_eq!(extract_regex_literal_prefix(r"NetworkMonitor/(\d+)"), Some("NetworkMonitor".into()));
    }

    #[test]
    fn extract_prefix_exact_tag() {
        assert_eq!(extract_regex_literal_prefix("ActivityManager"), Some("ActivityManager".into()));
    }

    #[test]
    fn extract_prefix_starts_with_metachar() {
        assert_eq!(extract_regex_literal_prefix(r".*NetworkMonitor"), None);
        assert_eq!(extract_regex_literal_prefix(r"(foo)"), None);
        assert_eq!(extract_regex_literal_prefix(r"\d+"), None);
    }

    #[test]
    fn extract_prefix_empty_pattern() {
        assert_eq!(extract_regex_literal_prefix(""), None);
    }
}
