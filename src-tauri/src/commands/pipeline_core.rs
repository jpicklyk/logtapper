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
        _transformer_defs: &[(String, TransformerDef)],
    ) -> Self {
        let desc = collect_prefilter_info(reporter_defs, tracker_defs, correlator_defs);

        let ac_automaton = if !desc.ac_patterns.is_empty() {
            AhoCorasick::new(&desc.ac_patterns).ok()
        } else {
            None
        };

        let regex_set = if !desc.regex_patterns.is_empty() {
            RegexSet::new(&desc.regex_patterns).ok()
        } else {
            None
        };

        let use_tag_prefilter = !desc.has_tag_unfiltered && !desc.tag_union.is_empty();
        let use_content_prefilter = !desc.has_content_unfiltered
            && (ac_automaton.is_some() || regex_set.is_some());

        PreFilter {
            tag_union: desc.tag_union,
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
/// Type alias for the state tracker run tuple (mirrors ReporterRunEntry).
type TrackerRunEntry = (String, StateTrackerRun, Option<Vec<(usize, usize)>>);

pub struct PipelineCore<'a> {
    pub transformer_runs: Vec<(String, TransformerRun)>,
    pub reporter_runs: Vec<ReporterRunEntry<'a>>,
    pub tracker_runs: Vec<TrackerRunEntry>,
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

        let tracker_section_ranges = compute_tracker_section_ranges(&defs.tracker_defs, sections);
        let tracker_runs: Vec<TrackerRunEntry> = defs
            .tracker_defs
            .iter()
            .zip(tracker_section_ranges)
            .map(|((tid, def), ranges)| (tid.clone(), StateTrackerRun::new(tid, def), ranges))
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

        // Streaming: no section filtering (sections always empty)
        let tracker_runs: Vec<TrackerRunEntry> = defs
            .tracker_defs
            .iter()
            .map(|(tid, def)| {
                let cont = state
                    .tracker_states
                    .remove(tid)
                    .unwrap_or_default();
                (tid.clone(), StateTrackerRun::new_seeded(tid, def, cont), None)
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
            // Layer 2a: StateTrackers (with section filtering)
            for (_, run, ranges) in &mut self.tracker_runs {
                let lines = tracker_lines;
                s.spawn(move |_| {
                    for line in lines {
                        if let Some(ranges) = ranges {
                            if !ranges.iter().any(|(start, end)| {
                                line.source_line_num >= *start && line.source_line_num <= *end
                            }) {
                                continue;
                            }
                        }
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
            .map(|(id, run, _)| {
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
            .map(|(id, run, _)| (id, run.into_continuous_state(last_line)))
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

/// Compute section ranges parallel to tracker_defs. Merges top-level `sections`
/// with any per-transition `SectionIs` filter rules.
fn compute_tracker_section_ranges(
    tracker_defs: &[(String, StateTrackerDef)],
    sections: &[SectionInfo],
) -> Vec<Option<Vec<(usize, usize)>>> {
    tracker_defs
        .iter()
        .map(|(_, def)| {
            let mut section_names: Vec<&str> =
                def.sections.iter().map(String::as_str).collect();

            // Also collect section names from per-transition SectionIs filters
            for transition in &def.transitions {
                if let Some(ref sec) = transition.filter.section {
                    if !section_names.contains(&sec.as_str()) {
                        section_names.push(sec.as_str());
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
// Pre-filter descriptor — single-pass collection over all processor defs
// ---------------------------------------------------------------------------

/// All pre-filter information collected in one pass over the processor defs.
struct PreFilterDescriptor {
    /// Union of all tag literals across Layer 2 processors.
    tag_union: HashSet<String>,
    /// True if any Layer 2 processor has no tag filter → disables tag pre-filter.
    has_tag_unfiltered: bool,
    /// Aho-Corasick literal substring patterns (MessageContains / MessageContainsAny).
    ac_patterns: Vec<String>,
    /// RegexSet patterns (MessageRegex).
    regex_patterns: Vec<String>,
    /// True if any processor has NO message filters at all → disables content pre-filter.
    has_content_unfiltered: bool,
}

/// Collect all pre-filter info in a single pass over the three Layer 2 processor slices.
/// Transformers are excluded — they run in Layer 1 on all lines and must not influence
/// the pre-filter (an unfiltered transformer would disable the whole pre-filter).
fn collect_prefilter_info(
    reporter_defs: &[(String, ReporterDef)],
    tracker_defs: &[(String, StateTrackerDef)],
    correlator_defs: &[(String, CorrelatorDef)],
) -> PreFilterDescriptor {
    let mut tag_union: HashSet<String> = HashSet::new();
    let mut has_tag_unfiltered = false;
    let mut ac_patterns: Vec<String> = Vec::new();
    let mut ac_seen: HashSet<String> = HashSet::new();
    let mut regex_patterns: Vec<String> = Vec::new();
    let mut regex_seen: HashSet<String> = HashSet::new();
    let mut has_content_unfiltered = false;

    let add_ac = |s: &str, patterns: &mut Vec<String>, seen: &mut HashSet<String>| {
        if !seen.contains(s) {
            seen.insert(s.to_string());
            patterns.push(s.to_string());
        }
    };
    let add_regex = |s: &str, patterns: &mut Vec<String>, seen: &mut HashSet<String>| {
        if !seen.contains(s) && regex::Regex::new(s).is_ok() {
            seen.insert(s.to_string());
            patterns.push(s.to_string());
        }
    };

    // --- Reporters ---
    for (_, def) in reporter_defs {
        let mut has_tag_filter = false;
        let mut has_any_message_filter = false;
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
                        FilterRule::MessageContains { value } => {
                            has_any_message_filter = true;
                            add_ac(value, &mut ac_patterns, &mut ac_seen);
                        }
                        FilterRule::MessageContainsAny { values } => {
                            has_any_message_filter = true;
                            for v in values {
                                add_ac(v, &mut ac_patterns, &mut ac_seen);
                            }
                        }
                        FilterRule::MessageRegex { pattern } => {
                            has_any_message_filter = true;
                            add_regex(pattern, &mut regex_patterns, &mut regex_seen);
                        }
                        _ => {}
                    }
                }
            }
        }
        if !has_tag_filter {
            has_tag_unfiltered = true;
        }
        if !has_any_message_filter {
            has_content_unfiltered = true;
        }
    }

    // --- State Trackers ---
    for (_, def) in tracker_defs {
        // A tracker is tag-unfiltered if any transition lacks a tag filter.
        let mut all_transitions_have_tag = !def.transitions.is_empty();
        // A tracker is content-unfiltered if any transition lacks any message filter.
        let mut all_transitions_have_msg = !def.transitions.is_empty();

        for transition in &def.transitions {
            let has_tag = transition.filter.tag.is_some() || transition.filter.tag_regex.is_some();
            let has_msg = transition.filter.message_contains.is_some()
                || transition.filter.message_regex.is_some();

            if has_tag {
                if let Some(tag) = &transition.filter.tag {
                    tag_union.insert(tag.clone());
                }
                if let Some(pattern) = &transition.filter.tag_regex {
                    if let Some(prefix) = extract_regex_literal_prefix(pattern) {
                        tag_union.insert(prefix);
                    }
                }
            } else {
                all_transitions_have_tag = false;
            }

            if has_msg {
                if let Some(mc) = &transition.filter.message_contains {
                    add_ac(mc, &mut ac_patterns, &mut ac_seen);
                }
                if let Some(pattern) = &transition.filter.message_regex {
                    add_regex(pattern, &mut regex_patterns, &mut regex_seen);
                }
            } else {
                all_transitions_have_msg = false;
            }
        }

        if !all_transitions_have_tag {
            has_tag_unfiltered = true;
        }
        if !all_transitions_have_msg {
            has_content_unfiltered = true;
        }
    }

    // --- Correlators ---
    for (_, def) in correlator_defs {
        for source in &def.sources {
            let mut has_tag_filter = false;
            let mut has_any_message_filter = false;
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
                    FilterRule::MessageContains { value } => {
                        has_any_message_filter = true;
                        add_ac(value, &mut ac_patterns, &mut ac_seen);
                    }
                    FilterRule::MessageContainsAny { values } => {
                        has_any_message_filter = true;
                        for v in values {
                            add_ac(v, &mut ac_patterns, &mut ac_seen);
                        }
                    }
                    FilterRule::MessageRegex { pattern } => {
                        has_any_message_filter = true;
                        add_regex(pattern, &mut regex_patterns, &mut regex_seen);
                    }
                    _ => {}
                }
            }
            if !has_tag_filter {
                has_tag_unfiltered = true;
            }
            if !has_any_message_filter {
                has_content_unfiltered = true;
            }
        }
    }

    PreFilterDescriptor {
        tag_union,
        has_tag_unfiltered,
        ac_patterns,
        regex_patterns,
        has_content_unfiltered,
    }
}

// ---------------------------------------------------------------------------
// Tests (moved from pipeline.rs)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    // ── extract_regex_literal_prefix ─────────────────────────────────────────

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

    // ── Gap 1a: quick_extract_tag ─────────────────────────────────────────────

    #[test]
    fn quick_extract_tag_normal() {
        let line = "03-13 11:33:42.416  1000  2723  5261 D NetdEventListenerService: DNS Requested";
        assert_eq!(quick_extract_tag(line), Some("NetdEventListenerService"));
    }

    #[test]
    fn quick_extract_tag_with_spaces() {
        // Tag with trailing spaces — should be trimmed
        let line = "03-13 11:33:42.416  1000  2723  5261 D MyTag   : some message";
        let tag = quick_extract_tag(line);
        assert_eq!(tag, Some("MyTag"));
    }

    #[test]
    fn quick_extract_tag_non_logcat() {
        let line = "DUMP OF SERVICE activity:";
        assert_eq!(quick_extract_tag(line), None);
    }

    #[test]
    fn quick_extract_tag_short_line() {
        let line = "short line";
        assert_eq!(quick_extract_tag(line), None);
    }

    // ── Gap 1b: PreFilter::should_process ────────────────────────────────────

    fn make_prefilter_with_tag(tag: &str) -> PreFilter {
        let mut tag_union = HashSet::new();
        tag_union.insert(tag.to_string());
        PreFilter {
            tag_union,
            ac_automaton: None,
            regex_set: None,
            use_tag_prefilter: true,
            use_content_prefilter: false,
        }
    }

    #[test]
    fn prefilter_passes_matching_tag() {
        let pf = make_prefilter_with_tag("NetdEventListenerService");
        let line = "03-13 11:33:42.416  1000  2723  5261 D NetdEventListenerService: DNS event";
        assert!(pf.should_process(line));
    }

    #[test]
    fn prefilter_rejects_non_matching_tag() {
        let pf = make_prefilter_with_tag("NetdEventListenerService");
        let line = "03-13 11:33:42.416  1000  2723  5261 D ActivityManager: starting activity";
        assert!(!pf.should_process(line));
    }

    #[test]
    fn prefilter_passes_when_inactive() {
        // use_tag_prefilter = false means all lines pass regardless of tag
        let pf = PreFilter {
            tag_union: {
                let mut s = HashSet::new();
                s.insert("OnlyThisTag".to_string());
                s
            },
            ac_automaton: None,
            regex_set: None,
            use_tag_prefilter: false,
            use_content_prefilter: false,
        };
        let line = "03-13 11:33:42.416  1000  2723  5261 D SomeOtherTag: message";
        assert!(pf.should_process(line));
    }

    #[test]
    fn prefilter_tag_prefix_matching() {
        // tag_union has "ConnectivityService", line has "ConnectivityServiceHandler"
        // should_process uses starts_with so it should pass
        let pf = make_prefilter_with_tag("ConnectivityService");
        let line = "03-13 11:33:42.416  1000  2723  5261 D ConnectivityServiceHandler: some event";
        assert!(pf.should_process(line));
    }

    // ── Gap 1c: collect_prefilter_info / transformer exclusion ───────────────

    #[test]
    fn transformer_does_not_disable_prefilter() {
        use crate::processors::reporter::schema::{FilterRule, FilterStage, PipelineStage, ReporterDef};
        use crate::processors::transformer::schema::TransformerDef;

        // A reporter with a tag filter
        let reporter_yaml = r#"
meta:
  id: test_reporter
  name: Test Reporter
pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: [ActivityManager]
"#;
        let reporter_def: ReporterDef = serde_yaml::from_str(reporter_yaml).unwrap();
        let reporter_defs = vec![("test_reporter".to_string(), reporter_def)];

        // A transformer with NO tag filter (no filter at all)
        let transformer_def = TransformerDef {
            filter: None,
            transforms: vec![],
            builtin: None,
        };
        let transformer_defs = vec![("test_transformer".to_string(), transformer_def)];

        let desc = collect_prefilter_info(&reporter_defs, &[], &[]);
        // Transformers are excluded — should not set has_tag_unfiltered
        assert!(!desc.has_tag_unfiltered, "Transformer without tag filter must not disable tag pre-filter");
        assert!(desc.tag_union.contains("ActivityManager"));

        // Verify PreFilter::build also uses transformer_defs arg without disabling the filter
        let prefilter = PreFilter::build(&reporter_defs, &[], &[], &transformer_defs);
        assert!(prefilter.use_tag_prefilter, "Tag pre-filter should be active when transformer is excluded");
    }

    #[test]
    fn tag_content_prefilter_decoupled() {
        use crate::processors::reporter::schema::{FilterRule, FilterStage, PipelineStage, ReporterDef};

        // Reporter with NO tag filter but WITH a message_contains filter
        let reporter_yaml = r#"
meta:
  id: test_reporter
  name: Test Reporter
pipeline:
  - stage: filter
    rules:
      - type: message_contains
        value: "ERROR"
"#;
        let reporter_def: ReporterDef = serde_yaml::from_str(reporter_yaml).unwrap();
        let reporter_defs = vec![("test_reporter".to_string(), reporter_def)];

        let desc = collect_prefilter_info(&reporter_defs, &[], &[]);
        // No tag filter → has_tag_unfiltered = true
        assert!(desc.has_tag_unfiltered, "Reporter with no tag filter should set has_tag_unfiltered");
        // Has message filter → has_content_unfiltered = false
        assert!(!desc.has_content_unfiltered, "Reporter with message_contains filter should not set has_content_unfiltered");
        // The AC pattern should be collected
        assert!(desc.ac_patterns.contains(&"ERROR".to_string()), "AC patterns should contain the message_contains value");
    }

    // ── Streaming tracker via PipelineCore ────────────────────────────────

    fn make_line(source_line_num: usize, tag: &str, message: &str) -> LineContext {
        use crate::core::line::LogLevel;
        LineContext {
            source_line_num,
            tag: Arc::from(tag),
            message: Arc::from(message),
            raw: Arc::from(format!("{} {}", tag, message).as_str()),
            pid: 0,
            tid: 0,
            timestamp: source_line_num as i64 * 1000,
            level: LogLevel::Info,
            source_id: Arc::from("test"),
            fields: Default::default(),
            annotations: vec![],
        }
    }

    fn load_battery_health_def() -> crate::processors::state_tracker::schema::StateTrackerDef {
        let yaml = include_str!("../../../marketplace/processors/battery_health.yaml");
        let proc = crate::processors::AnyProcessor::from_yaml(yaml)
            .expect("battery_health.yaml parses");
        match proc.kind {
            crate::processors::ProcessorKind::StateTracker(def) => def,
            _ => panic!("expected StateTracker kind"),
        }
    }

    /// Verify that PipelineCore processes state trackers in streaming mode
    /// (from_continuous_state path). This is the exact path flush_batch uses.
    #[test]
    fn streaming_pipeline_core_runs_state_tracker() {
        let tracker_def = load_battery_health_def();
        let tracker_id = "battery-health".to_string();

        let defs = PartitionedDefs {
            transformer_defs: Vec::new(),
            reporter_defs: Vec::new(),
            tracker_defs: vec![(tracker_id.clone(), tracker_def.clone())],
            correlator_defs: Vec::new(),
        };

        // Simulate initial state (as update_stream_trackers would create)
        let initial_state: HashMap<String, serde_json::Value> = tracker_def.state.iter()
            .map(|f| (f.name.clone(), f.default.clone()))
            .collect();
        let cont_state = ContinuousTrackerState {
            current_state: initial_state,
            transitions: Vec::new(),
            last_processed_line: 0,
        };

        let mut tracker_states = HashMap::new();
        tracker_states.insert(tracker_id.clone(), cont_state);

        let continuous = ContinuousStates {
            reporter_states: HashMap::new(),
            tracker_states,
            transformer_states: HashMap::new(),
            correlator_states: HashMap::new(),
        };

        let pipeline_ctx = crate::core::line::PipelineContext {
            source_type: crate::core::session::SourceType::Logcat,
            source_name: Arc::from("test"),
            is_streaming: true,
            sections: Arc::from([]),
        };

        let mut core = PipelineCore::from_continuous_state(&defs, pipeline_ctx, continuous);

        // Feed a line that matches "Health Update" transition (tag=PowerUI, BATTERY_HEALTH_CHECK)
        let line = make_line(1, "PowerUI", "BATTERY_HEALTH_CHECK extraHealth=2 mBatteryMiscEvent=65536");
        core.run_layer2_parallel(&[line], &HashMap::new());

        // Extract continuous state and verify the tracker recorded a transition
        let final_state = core.into_continuous_state(2);
        let tracker_cont = final_state.tracker_states.get("battery-health")
            .expect("tracker state should be present after processing");
        assert!(!tracker_cont.transitions.is_empty(),
            "Battery Health tracker should record a transition for BATTERY_HEALTH_CHECK line");
        assert_eq!(tracker_cont.current_state["health"], serde_json::json!("2"));
    }

    /// Verify that PipelineCore with empty tracker_states produces no tracker
    /// results — simulating the bug where trackers were never registered.
    #[test]
    fn streaming_pipeline_core_no_trackers_means_no_results() {
        let defs = PartitionedDefs {
            transformer_defs: Vec::new(),
            reporter_defs: Vec::new(),
            tracker_defs: Vec::new(), // no trackers registered
            correlator_defs: Vec::new(),
        };

        let continuous = ContinuousStates {
            reporter_states: HashMap::new(),
            tracker_states: HashMap::new(),
            transformer_states: HashMap::new(),
            correlator_states: HashMap::new(),
        };

        let pipeline_ctx = crate::core::line::PipelineContext {
            source_type: crate::core::session::SourceType::Logcat,
            source_name: Arc::from("test"),
            is_streaming: true,
            sections: Arc::from([]),
        };

        let mut core = PipelineCore::from_continuous_state(&defs, pipeline_ctx, continuous);

        // Feed a matching line — but no tracker is registered to capture it
        let line = make_line(1, "PowerUI", "BATTERY_HEALTH_CHECK extraHealth=2 mBatteryMiscEvent=65536");
        core.run_layer2_parallel(&[line], &HashMap::new());

        let final_state = core.into_continuous_state(2);
        assert!(final_state.tracker_states.is_empty(),
            "No trackers should appear in results when none are registered");
    }

    /// Verify that continuous state properly seeds a tracker across multiple batches.
    /// Simulates what flush_batch does: process batch 1, extract state, then
    /// re-seed for batch 2 and verify accumulated transitions.
    #[test]
    fn streaming_tracker_accumulates_across_batches() {
        let tracker_def = load_battery_health_def();
        let tracker_id = "battery-health".to_string();

        let defs = PartitionedDefs {
            transformer_defs: Vec::new(),
            reporter_defs: Vec::new(),
            tracker_defs: vec![(tracker_id.clone(), tracker_def.clone())],
            correlator_defs: Vec::new(),
        };

        let initial_state: HashMap<String, serde_json::Value> = tracker_def.state.iter()
            .map(|f| (f.name.clone(), f.default.clone()))
            .collect();

        let pipeline_ctx = crate::core::line::PipelineContext {
            source_type: crate::core::session::SourceType::Logcat,
            source_name: Arc::from("test"),
            is_streaming: true,
            sections: Arc::from([]),
        };

        // ── Batch 1: health=2 ────────────────────────────────────────────────
        let cont1 = ContinuousStates {
            reporter_states: HashMap::new(),
            tracker_states: {
                let mut m = HashMap::new();
                m.insert(tracker_id.clone(), ContinuousTrackerState {
                    current_state: initial_state.clone(),
                    transitions: Vec::new(),
                    last_processed_line: 0,
                });
                m
            },
            transformer_states: HashMap::new(),
            correlator_states: HashMap::new(),
        };

        let mut core1 = PipelineCore::from_continuous_state(&defs, pipeline_ctx.clone(), cont1);
        let line1 = make_line(1, "PowerUI", "BATTERY_HEALTH_CHECK extraHealth=2 mBatteryMiscEvent=65536");
        core1.run_layer2_parallel(&[line1], &HashMap::new());
        let state_after_batch1 = core1.into_continuous_state(2);

        // ── Batch 2: protect_mode=true ───────────────────────────────────────
        let cont2 = ContinuousStates {
            reporter_states: HashMap::new(),
            tracker_states: state_after_batch1.tracker_states,
            transformer_states: HashMap::new(),
            correlator_states: HashMap::new(),
        };

        let mut core2 = PipelineCore::from_continuous_state(&defs, pipeline_ctx, cont2);
        let line2 = make_line(2, "AODBatteryManager", "saveBatteryData : AOD BatteryData [mBatteryLevel=54, mBatteryProtectMode=true, mBatteryChargerType=NORMAL, mBatterySwellingMode=NONE]");
        core2.run_layer2_parallel(&[line2], &HashMap::new());
        let final_state = core2.into_continuous_state(3);

        let tracker = final_state.tracker_states.get("battery-health").unwrap();
        // Should have transitions from both batches
        assert!(tracker.transitions.len() >= 2,
            "Tracker should accumulate transitions across batches, got {}",
            tracker.transitions.len());
        // State should reflect both updates
        assert_eq!(tracker.current_state["health"], serde_json::json!("2"));
        assert_eq!(tracker.current_state["protect_mode"], serde_json::json!(true));
    }
}
