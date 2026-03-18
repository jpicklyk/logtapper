//! PipelineCore — shared pipeline execution logic for both file-mode and
//! streaming-mode processing. Both `execute_pipeline` (pipeline.rs) and
//! `flush_batch` (adb.rs) delegate to this module for pre-filter construction,
//! transformer application, and Layer 2 parallel processing.

use aho_corasick::AhoCorasick;
use regex::RegexSet;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::anonymizer::config::AnonymizerConfig;
use crate::core::line::{LineContext, PipelineContext};
use crate::core::session::SectionInfo;
use crate::processors::correlator::engine::{CorrelatorResult, CorrelatorRun};
use crate::processors::correlator::schema::CorrelatorDef;
use crate::processors::reporter::engine::{ContinuousRunState, ProcessorRun, RunResult};
use crate::processors::reporter::schema::{FilterRule, PipelineStage, ReporterDef};
use crate::processors::state_tracker::engine::StateTrackerRun;
use crate::processors::state_tracker::schema::StateTrackerDef;
use crate::processors::state_tracker::types::{
    ContinuousTrackerState, StateTrackerResult,
};
use crate::processors::transformer::engine::TransformerRun;
use crate::processors::transformer::schema::TransformerDef;
use crate::processors::transformer::types::ContinuousTransformerState;
use crate::processors::correlator::engine::ContinuousCorrelatorState;

// ---------------------------------------------------------------------------
// Pre-filter — tag, Aho-Corasick, RegexSet
// ---------------------------------------------------------------------------

/// Pre-filter accelerator: quickly skip lines that cannot match any active
/// Layer 2 processor, avoiding expensive regex parsing.
pub struct PreFilter {
    tag_union: HashSet<String>,
    ac_automaton: Option<AhoCorasick>,
    regex_set: Option<RegexSet>,
    use_tag_prefilter: bool,
    use_content_prefilter: bool,
}

impl PreFilter {
    /// Build a pre-filter from the active processor definitions.
    fn build(
        reporter_defs: &[(String, ReporterDef)],
        tracker_defs: &[(String, StateTrackerDef)],
        correlator_defs: &[(String, CorrelatorDef)],
        transformer_defs: &[(String, TransformerDef)],
    ) -> Self {
        let (tag_union, has_unfiltered) = collect_tag_filters(
            reporter_defs, tracker_defs, correlator_defs, transformer_defs,
        );
        let (ac_patterns, _has_proc_without_substring_filter) =
            collect_substring_filters(reporter_defs, tracker_defs, correlator_defs);
        let (regex_patterns, has_proc_without_any_message_filter) =
            collect_regex_filters(reporter_defs, tracker_defs, correlator_defs);

        let ac_automaton = if !ac_patterns.is_empty() {
            AhoCorasick::new(&ac_patterns).ok()
        } else {
            None
        };

        let regex_set = if !regex_patterns.is_empty() {
            RegexSet::new(&regex_patterns).ok()
        } else {
            None
        };

        let use_content_prefilter = !has_unfiltered
            && !has_proc_without_any_message_filter
            && (ac_automaton.is_some() || regex_set.is_some());
        let use_tag_prefilter = !has_unfiltered && !tag_union.is_empty();

        PreFilter {
            tag_union,
            ac_automaton,
            regex_set,
            use_tag_prefilter,
            use_content_prefilter,
        }
    }

    /// Returns `true` if the raw line should be parsed and processed.
    /// Returns `false` if the pre-filter can conclusively determine that no
    /// active processor will match this line.
    pub fn should_process(&self, raw: &str) -> bool {
        // Level 1: tag check
        if self.use_tag_prefilter {
            if let Some(tag) = quick_extract_tag(raw) {
                if !self.tag_union.iter().any(|t| tag.starts_with(t.as_str())) {
                    return false;
                }
            }
        }

        // Levels 2+3: content check (AC substring OR RegexSet)
        if self.use_content_prefilter {
            if let Some(ref ac) = self.ac_automaton {
                if ac.find(raw.as_bytes()).is_some() {
                    return true;
                }
            }
            if let Some(ref rs) = self.regex_set {
                let msg = quick_extract_message(raw).unwrap_or(raw);
                if rs.is_match(msg) {
                    return true;
                }
            }
            return false;
        }

        true
    }

    /// Whether any prefiltering is active (used to decide whether to iterate
    /// all lines or only filtered ones).
    pub fn is_active(&self) -> bool {
        self.use_tag_prefilter || self.use_content_prefilter
    }
}

// ---------------------------------------------------------------------------
// PipelineCore — unified processing state
// ---------------------------------------------------------------------------

/// Holds all processor runs, pre-filter, and section ranges for a single
/// pipeline execution (file or streaming). Callers build a `PipelineCore`,
/// feed it parsed batches, then collect results.
/// Type alias for the complex reporter run tuple to satisfy clippy::type_complexity.
type ReporterRunEntry<'a> = (String, ProcessorRun<'a>, Option<Vec<(usize, usize)>>);

pub struct PipelineCore<'a> {
    pub transformer_runs: Vec<(String, TransformerRun)>,
    pub reporter_runs: Vec<ReporterRunEntry<'a>>,
    pub tracker_runs: Vec<(String, StateTrackerRun)>,
    pub correlator_runs: Vec<(String, CorrelatorRun<'a>)>,
    pub pipeline_ctx: PipelineContext,
    pub prefilter: PreFilter,
}

/// Definitions partitioned by processor kind, ready for pipeline construction.
pub struct PartitionedDefs {
    pub transformer_defs: Vec<(String, TransformerDef)>,
    pub reporter_defs: Vec<(String, ReporterDef)>,
    pub tracker_defs: Vec<(String, StateTrackerDef)>,
    pub correlator_defs: Vec<(String, CorrelatorDef)>,
}

/// All results produced by a pipeline run.
pub struct PipelineOutput {
    pub reporter_results: HashMap<String, RunResult>,
    pub tracker_results: HashMap<String, StateTrackerResult>,
    pub correlator_results: HashMap<String, CorrelatorResult>,
    pub forward_pii: HashMap<String, String>,
}

/// Continuous state for all processor kinds, used to persist between
/// streaming batches.
pub struct ContinuousStates {
    pub reporter_states: HashMap<String, ContinuousRunState>,
    pub tracker_states: HashMap<String, ContinuousTrackerState>,
    pub transformer_states: HashMap<String, ContinuousTransformerState>,
    pub correlator_states: HashMap<String, ContinuousCorrelatorState>,
}

/// Intermediate result snapshot for streaming — non-consuming.
pub struct StreamingSnapshot {
    pub reporter_results: HashMap<String, RunResult>,
    pub correlator_results: HashMap<String, CorrelatorResult>,
}

impl<'a> PipelineCore<'a> {
    /// Create a fresh pipeline core for file-mode processing.
    ///
    /// `defs` must already be source-type-filtered (processors whose
    /// `SourceTypeIs` filter doesn't match have been removed).
    /// `sections` are the source's section boundaries for section-filtered
    /// reporters.
    pub fn new(
        defs: &'a PartitionedDefs,
        pipeline_ctx: PipelineContext,
        sections: &[SectionInfo],
        anonymizer_config: &AnonymizerConfig,
    ) -> Self {
        let prefilter = PreFilter::build(
            &defs.reporter_defs,
            &defs.tracker_defs,
            &defs.correlator_defs,
            &defs.transformer_defs,
        );

        let transformer_runs: Vec<(String, TransformerRun)> = defs
            .transformer_defs
            .iter()
            .map(|(id, def)| {
                (
                    id.clone(),
                    TransformerRun::new_with_anonymizer_config(def, anonymizer_config),
                )
            })
            .collect();

        let section_ranges = compute_section_ranges(&defs.reporter_defs, sections);

        let reporter_runs: Vec<ReporterRunEntry<'a>> = defs
            .reporter_defs
            .iter()
            .zip(section_ranges)
            .map(|((id, def), ranges)| (id.clone(), ProcessorRun::new(def), ranges))
            .collect();

        let tracker_runs: Vec<(String, StateTrackerRun)> = defs
            .tracker_defs
            .iter()
            .map(|(tid, def)| (tid.clone(), StateTrackerRun::new(tid, def)))
            .collect();

        let correlator_runs: Vec<(String, CorrelatorRun<'a>)> = defs
            .correlator_defs
            .iter()
            .map(|(cid, def)| (cid.clone(), CorrelatorRun::new(def)))
            .collect();

        PipelineCore {
            transformer_runs,
            reporter_runs,
            tracker_runs,
            correlator_runs,
            pipeline_ctx,
            prefilter,
        }
    }

    /// Create a pipeline core seeded from saved continuous state (streaming).
    pub fn from_continuous_state(
        defs: &'a PartitionedDefs,
        pipeline_ctx: PipelineContext,
        mut state: ContinuousStates,
    ) -> Self {
        let prefilter = PreFilter::build(
            &defs.reporter_defs,
            &defs.tracker_defs,
            &defs.correlator_defs,
            &defs.transformer_defs,
        );

        let transformer_runs: Vec<(String, TransformerRun)> = defs
            .transformer_defs
            .iter()
            .map(|(id, def)| {
                let cont = state
                    .transformer_states
                    .remove(id)
                    .unwrap_or_default();
                (id.clone(), TransformerRun::new_seeded(def, cont))
            })
            .collect();

        // Streaming: no section filtering (sections always empty)
        let reporter_runs: Vec<ReporterRunEntry<'a>> = defs
            .reporter_defs
            .iter()
            .map(|(id, def)| {
                if let Some(cont) = state.reporter_states.remove(id) {
                    (id.clone(), ProcessorRun::new_seeded(def, cont), None)
                } else {
                    (id.clone(), ProcessorRun::new(def), None)
                }
            })
            .collect();

        let tracker_runs: Vec<(String, StateTrackerRun)> = defs
            .tracker_defs
            .iter()
            .map(|(tid, def)| {
                let cont = state
                    .tracker_states
                    .remove(tid)
                    .unwrap_or_default();
                (tid.clone(), StateTrackerRun::new_seeded(tid, def, cont))
            })
            .collect();

        let correlator_runs: Vec<(String, CorrelatorRun<'a>)> = defs
            .correlator_defs
            .iter()
            .map(|(cid, def)| {
                let cont = state.correlator_states.remove(cid);
                if let Some(cs) = cont {
                    (cid.clone(), CorrelatorRun::new_seeded(def, cs))
                } else {
                    (cid.clone(), CorrelatorRun::new(def))
                }
            })
            .collect();

        PipelineCore {
            transformer_runs,
            reporter_runs,
            tracker_runs,
            correlator_runs,
            pipeline_ctx,
            prefilter,
        }
    }

    /// Run Layer 1 (transformers) on a batch of parsed lines.
    ///
    /// Lines that a transformer drops are set to `None`. Returns the
    /// pre-transform message map for state trackers (if transformers are active
    /// and trackers exist).
    pub fn run_transformers(
        &mut self,
        parsed_chunk: &mut [Option<LineContext>],
    ) -> HashMap<usize, Arc<str>> {
        // Save pre-transform messages for state trackers
        let pre_transform_msgs: HashMap<usize, Arc<str>> =
            if !self.transformer_runs.is_empty() && !self.tracker_runs.is_empty() {
                parsed_chunk
                    .iter()
                    .filter_map(|opt| {
                        opt.as_ref()
                            .map(|l| (l.source_line_num, Arc::clone(&l.message)))
                    })
                    .collect()
            } else {
                HashMap::new()
            };

        if !self.transformer_runs.is_empty() {
            for line_opt in parsed_chunk.iter_mut() {
                if let Some(line) = line_opt.as_mut() {
                    let mut keep = true;
                    for (_, run) in &mut self.transformer_runs {
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

        pre_transform_msgs
    }

    /// Run Layer 2 (reporters, trackers, correlators) on a chunk of lines
    /// using rayon for parallelism.
    ///
    /// `enriched_chunk` contains post-transformer lines (no Nones).
    /// `pre_transform_msgs` provides original messages for state trackers
    /// when transformers are active.
    pub fn run_layer2_parallel(
        &mut self,
        enriched_chunk: &[LineContext],
        pre_transform_msgs: &HashMap<usize, Arc<str>>,
    ) {
        // Build tracker-specific view with pre-anonymization messages
        let tracker_chunk: Vec<LineContext> =
            if !self.tracker_runs.is_empty() && !pre_transform_msgs.is_empty() {
                enriched_chunk
                    .iter()
                    .map(|line| {
                        let mut clone = line.clone();
                        if let Some(orig) = pre_transform_msgs.get(&line.source_line_num) {
                            clone.message = Arc::clone(orig);
                        }
                        clone
                    })
                    .collect()
            } else {
                Vec::new()
            };
        let tracker_lines: &[LineContext] =
            if !tracker_chunk.is_empty() { &tracker_chunk } else { enriched_chunk };

        let pctx = &self.pipeline_ctx;

        rayon::scope(|s| {
            // Layer 2a: StateTrackers
            for (_, run) in &mut self.tracker_runs {
                let lines = tracker_lines;
                s.spawn(move |_| {
                    for line in lines {
                        run.process_line(line, pctx);
                    }
                });
            }

            // Layer 2b: Reporters (with section filtering)
            for (_, run, ranges) in &mut self.reporter_runs {
                let lines = enriched_chunk;
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

            // Layer 2c: Correlators
            for (_, run) in &mut self.correlator_runs {
                let lines = enriched_chunk;
                s.spawn(move |_| {
                    for line in lines {
                        run.process_line(line, pctx);
                    }
                });
            }
        });
    }

    /// Process a full batch: Layer 1 transformers then Layer 2 parallel.
    /// This is the primary entry point for both file and streaming callers.
    pub fn process_batch(&mut self, parsed_chunk: &mut Vec<Option<LineContext>>) {
        let pre_transform_msgs = self.run_transformers(parsed_chunk);

        let enriched_chunk: Vec<LineContext> =
            parsed_chunk.drain(..).flatten().collect();

        self.run_layer2_parallel(&enriched_chunk, &pre_transform_msgs);
    }

    /// Collect PII forward mappings from all transformer runs.
    pub fn collect_pii_mappings(&self) -> HashMap<String, String> {
        self.transformer_runs
            .iter()
            .flat_map(|(_, run)| run.get_pii_mappings())
            .collect()
    }

    /// Non-consuming snapshot of current results (for streaming per-batch emission).
    pub fn current_results(&self) -> StreamingSnapshot {
        let reporter_results: HashMap<String, RunResult> = self
            .reporter_runs
            .iter()
            .map(|(id, run, _)| (id.clone(), run.current_result()))
            .collect();

        let correlator_results: HashMap<String, CorrelatorResult> = self
            .correlator_runs
            .iter()
            .map(|(id, run)| (id.clone(), run.current_result()))
            .collect();

        StreamingSnapshot {
            reporter_results,
            correlator_results,
        }
    }

    /// Consume the pipeline and return final results (file mode).
    pub fn finish(self, forward_pii: &HashMap<String, String>) -> PipelineOutput {
        let reporter_results: HashMap<String, RunResult> = self
            .reporter_runs
            .into_iter()
            .map(|(id, run, _)| (id, run.finish()))
            .collect();

        let tracker_results: HashMap<String, StateTrackerResult> = self
            .tracker_runs
            .into_iter()
            .map(|(id, run)| {
                let mut result = run.finish();
                // Post-process: replace captured raw PII values with tokens.
                if !forward_pii.is_empty() {
                    anonymize_tracker_result(&mut result, forward_pii);
                }
                (id, result)
            })
            .collect();

        let correlator_results: HashMap<String, CorrelatorResult> = self
            .correlator_runs
            .into_iter()
            .map(|(id, run)| (id, run.finish()))
            .collect();

        PipelineOutput {
            reporter_results,
            tracker_results,
            correlator_results,
            forward_pii: forward_pii.clone(),
        }
    }

    /// Consume the pipeline and serialize state for streaming persistence.
    pub fn into_continuous_state(self, last_line: usize) -> ContinuousStates {
        let reporter_states: HashMap<String, ContinuousRunState> = self
            .reporter_runs
            .into_iter()
            .map(|(id, run, _)| (id, run.into_continuous_state(last_line, true)))
            .collect();

        let tracker_states: HashMap<String, ContinuousTrackerState> = self
            .tracker_runs
            .into_iter()
            .map(|(id, run)| (id, run.into_continuous_state(last_line)))
            .collect();

        let transformer_states: HashMap<String, ContinuousTransformerState> = self
            .transformer_runs
            .into_iter()
            .map(|(id, run)| (id, run.into_continuous_state(last_line)))
            .collect();

        let correlator_states: HashMap<String, ContinuousCorrelatorState> = self
            .correlator_runs
            .into_iter()
            .map(|(id, run)| (id, run.into_continuous_state()))
            .collect();

        ContinuousStates {
            reporter_states,
            tracker_states,
            transformer_states,
            correlator_states,
        }
    }
}

// ---------------------------------------------------------------------------
// Helper: anonymize state tracker results with PII forward map
// ---------------------------------------------------------------------------

fn anonymize_tracker_result(
    result: &mut StateTrackerResult,
    forward_pii: &HashMap<String, String>,
) {
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
    for val in result.final_state.values_mut() {
        if let serde_json::Value::String(s) = val {
            if let Some(token) = forward_pii.get(s.as_str()) {
                *s = token.clone();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Section range computation
// ---------------------------------------------------------------------------

/// Compute section ranges parallel to reporter_defs, used for section-filtered
/// reporters (bugreport sections).
fn compute_section_ranges(
    reporter_defs: &[(String, ReporterDef)],
    sections: &[SectionInfo],
) -> Vec<Option<Vec<(usize, usize)>>> {
    reporter_defs
        .iter()
        .map(|(_, def)| {
            let mut section_names: Vec<&str> =
                def.sections.iter().map(String::as_str).collect();

            for stage in &def.pipeline {
                if let PipelineStage::Filter(f) = stage {
                    for rule in &f.rules {
                        if let FilterRule::SectionIs { section } = rule {
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
                let r: Vec<(usize, usize)> = section_names
                    .iter()
                    .filter_map(|name| sections.iter().find(|s| s.name == *name))
                    .map(|s| (s.start_line, s.end_line))
                    .collect();
                if r.is_empty() { None } else { Some(r) }
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Source-type exclusion helper
// ---------------------------------------------------------------------------

/// Check if a set of filter rules contains a SourceTypeIs that doesn't match
/// the current source type.
pub fn excluded_by_source_type(
    rules: &[FilterRule],
    source_type: &crate::core::session::SourceType,
) -> bool {
    rules.iter().any(|rule| {
        matches!(
            rule,
            FilterRule::SourceTypeIs { source_type: st } if !source_type.matches_str(st)
        )
    })
}

// ---------------------------------------------------------------------------
// Pre-filter helpers (moved from pipeline.rs)
// ---------------------------------------------------------------------------

/// Extract the tag from a raw logcat threadtime line without regex.
///
/// Threadtime format: `MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG     : message`
/// The level is a single char (V/D/I/W/E/F/S) preceded by whitespace.
/// The tag follows the level, trimmed, up to the first `: ` or `:` delimiter.
///
/// Returns `None` if the line doesn't look like threadtime format.
pub fn quick_extract_tag(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    if bytes.len() < 20 || !bytes[0].is_ascii_digit() {
        return None;
    }

    let search_start = 18;
    let mut i = search_start;
    while i < bytes.len() {
        let b = bytes[i];
        if matches!(b, b'V' | b'D' | b'I' | b'W' | b'E' | b'F' | b'S')
            && i > 0 && bytes[i - 1] == b' ' && (i + 1 >= bytes.len() || bytes[i + 1] == b' ')
        {
            let tag_start = i + 2;
            if tag_start >= bytes.len() {
                return None;
            }
            if let Some(colon_pos) = raw[tag_start..].find(": ") {
                let tag = raw[tag_start..tag_start + colon_pos].trim();
                if !tag.is_empty() {
                    return Some(tag);
                }
            }
            if let Some(colon_pos) = raw[tag_start..].find(':') {
                let tag = raw[tag_start..tag_start + colon_pos].trim();
                if !tag.is_empty() {
                    return Some(tag);
                }
            }
            return None;
        }
        i += 1;
    }
    None
}

/// Extract the message portion from a raw logcat threadtime line.
pub fn quick_extract_message(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    if bytes.len() < 20 || !bytes[0].is_ascii_digit() {
        return None;
    }

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
pub fn extract_regex_literal_prefix(pattern: &str) -> Option<String> {
    let mut prefix = String::new();
    for b in pattern.bytes() {
        if matches!(
            b,
            b'.' | b'*' | b'+' | b'?' | b'(' | b')' | b'[' | b']'
                | b'{' | b'}' | b'^' | b'$' | b'|' | b'\\'
        ) {
            break;
        }
        prefix.push(b as char);
    }
    let prefix = prefix.trim_end_matches('/').to_string();
    if prefix.is_empty() {
        None
    } else {
        Some(prefix)
    }
}

// ---------------------------------------------------------------------------
// Tag filter collection
// ---------------------------------------------------------------------------

/// Collect the union of all tag filters from Layer 2 processors only.
/// Transformers are excluded (they run in Layer 1 on all lines).
fn collect_tag_filters(
    reporter_defs: &[(String, ReporterDef)],
    tracker_defs: &[(String, StateTrackerDef)],
    correlator_defs: &[(String, CorrelatorDef)],
    _transformer_defs: &[(String, TransformerDef)],
) -> (HashSet<String>, bool) {
    let mut tag_union = HashSet::new();
    let mut has_unfiltered = false;

    for (_, def) in reporter_defs {
        let mut has_tag_filter = false;
        for stage in &def.pipeline {
            if let PipelineStage::Filter(filter_stage) = stage {
                for rule in &filter_stage.rules {
                    match rule {
                        FilterRule::TagMatch { tags, .. } => {
                            has_tag_filter = true;
                            tag_union.extend(tags.iter().cloned());
                        }
                        FilterRule::TagRegex { pattern } => {
                            has_tag_filter = true;
                            if let Some(prefix) = extract_regex_literal_prefix(pattern) {
                                tag_union.insert(prefix);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        if !has_tag_filter {
            has_unfiltered = true;
        }
    }

    for (_, def) in tracker_defs {
        let mut has_tag_filter = true;
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

    for (_, def) in correlator_defs {
        for source in &def.sources {
            let mut has_tag_filter = false;
            for rule in &source.filter {
                match rule {
                    FilterRule::TagMatch { tags, .. } => {
                        has_tag_filter = true;
                        tag_union.extend(tags.iter().cloned());
                    }
                    FilterRule::TagRegex { pattern } => {
                        has_tag_filter = true;
                        if let Some(prefix) = extract_regex_literal_prefix(pattern) {
                            tag_union.insert(prefix);
                        }
                    }
                    _ => {}
                }
            }
            if !has_tag_filter {
                has_unfiltered = true;
            }
        }
    }

    (tag_union, has_unfiltered)
}

// ---------------------------------------------------------------------------
// Substring filter collection (Aho-Corasick)
// ---------------------------------------------------------------------------

fn collect_substring_filters(
    reporter_defs: &[(String, ReporterDef)],
    tracker_defs: &[(String, StateTrackerDef)],
    correlator_defs: &[(String, CorrelatorDef)],
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

    for (_, def) in reporter_defs {
        let mut has_message_filter = false;
        for stage in &def.pipeline {
            if let PipelineStage::Filter(filter_stage) = stage {
                for rule in &filter_stage.rules {
                    match rule {
                        FilterRule::MessageContains { value } => {
                            has_message_filter = true;
                            add_pattern(value);
                        }
                        FilterRule::MessageContainsAny { values } => {
                            has_message_filter = true;
                            for v in values {
                                add_pattern(v);
                            }
                        }
                        FilterRule::MessageRegex { .. } => {
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

    for (_, def) in tracker_defs {
        let mut has_message_filter = true;
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

    for (_, def) in correlator_defs {
        for source in &def.sources {
            let mut has_message_filter = false;
            for rule in &source.filter {
                match rule {
                    FilterRule::MessageContains { value } => {
                        has_message_filter = true;
                        add_pattern(value);
                    }
                    FilterRule::MessageContainsAny { values } => {
                        has_message_filter = true;
                        for v in values {
                            add_pattern(v);
                        }
                    }
                    FilterRule::MessageRegex { .. } => {
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

    (patterns, has_proc_without_substring_filter)
}

// ---------------------------------------------------------------------------
// Regex filter collection (RegexSet)
// ---------------------------------------------------------------------------

fn collect_regex_filters(
    reporter_defs: &[(String, ReporterDef)],
    tracker_defs: &[(String, StateTrackerDef)],
    correlator_defs: &[(String, CorrelatorDef)],
) -> (Vec<String>, bool) {
    let mut patterns: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut has_proc_without_any_message_filter = false;

    let mut add_pattern = |s: &str| {
        if !seen.contains(s) && regex::Regex::new(s).is_ok() {
            seen.insert(s.to_string());
            patterns.push(s.to_string());
        }
    };

    for (_, def) in reporter_defs {
        let mut has_any_message_filter = false;
        for stage in &def.pipeline {
            if let PipelineStage::Filter(filter_stage) = stage {
                for rule in &filter_stage.rules {
                    match rule {
                        FilterRule::MessageRegex { pattern } => {
                            has_any_message_filter = true;
                            add_pattern(pattern);
                        }
                        FilterRule::MessageContains { .. }
                        | FilterRule::MessageContainsAny { .. } => {
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

    for (_, def) in correlator_defs {
        for source in &def.sources {
            let mut has_any_message_filter = false;
            for rule in &source.filter {
                match rule {
                    FilterRule::MessageRegex { pattern } => {
                        has_any_message_filter = true;
                        add_pattern(pattern);
                    }
                    FilterRule::MessageContains { .. }
                    | FilterRule::MessageContainsAny { .. } => {
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
// Tests (moved from pipeline.rs)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::extract_regex_literal_prefix;

    #[test]
    fn extract_prefix_simple_tag() {
        assert_eq!(
            extract_regex_literal_prefix(r"NetworkMonitor/\d+"),
            Some("NetworkMonitor".into())
        );
    }

    #[test]
    fn extract_prefix_with_groups() {
        assert_eq!(
            extract_regex_literal_prefix(r"NetworkMonitor/(\d+)"),
            Some("NetworkMonitor".into())
        );
    }

    #[test]
    fn extract_prefix_exact_tag() {
        assert_eq!(
            extract_regex_literal_prefix("ActivityManager"),
            Some("ActivityManager".into())
        );
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
