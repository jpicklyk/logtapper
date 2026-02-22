use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::AppState;
use crate::core::session::{LogSourceData, parser_for};
use crate::processors::ProcessorKind;
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
                raw_lines.get(n).map(|s| s.as_str())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// run_pipeline
// ---------------------------------------------------------------------------

const CHUNK_SIZE: usize = 50_000;
const PROGRESS_INTERVAL: usize = 5_000;

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
    // Reset cancellation flag at the start
    state.pipeline_cancel.store(false, Ordering::Relaxed);

    // ── Partition processor IDs by kind ──────────────────────────────────────
    let (transformer_ids, reporter_ids, tracker_ids, correlator_ids) = {
        let procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
        let mut t_ids: Vec<String> = Vec::new();
        let mut r_ids: Vec<String> = Vec::new();
        let mut s_ids: Vec<String> = Vec::new();
        let mut c_ids: Vec<String> = Vec::new();
        for id in &processor_ids {
            if let Some(p) = procs.get(id) {
                match &p.kind {
                    ProcessorKind::Transformer(_) => t_ids.push(id.clone()),
                    ProcessorKind::Reporter(_) => r_ids.push(id.clone()),
                    ProcessorKind::StateTracker(_) => s_ids.push(id.clone()),
                    ProcessorKind::Correlator(_) => c_ids.push(id.clone()),
                    _ => {} // Annotator: schema stub, no engine yet
                }
            }
        }
        (t_ids, r_ids, s_ids, c_ids)
    };

    // ── Clone defs (one lock acquisition per kind, released immediately) ──────
    let transformer_defs: Vec<(String, crate::processors::transformer::schema::TransformerDef)> = {
        let procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
        transformer_ids.iter()
            .filter_map(|id| procs.get(id).and_then(|p| p.as_transformer()).map(|d| (id.clone(), d.clone())))
            .collect()
    };

    let reporter_defs: Vec<(String, crate::processors::reporter::schema::ReporterDef)> = {
        let procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
        reporter_ids.iter()
            .filter_map(|id| procs.get(id).and_then(|p| p.as_reporter()).map(|d| (id.clone(), d.clone())))
            .collect()
    };

    let tracker_defs: Vec<(String, crate::processors::state_tracker::schema::StateTrackerDef)> = {
        let procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
        tracker_ids.iter()
            .filter_map(|id| procs.get(id).and_then(|p| p.as_state_tracker()).map(|d| (id.clone(), d.clone())))
            .collect()
    };

    let correlator_defs: Vec<(String, crate::processors::correlator::schema::CorrelatorDef)> = {
        let procs = state.processors.lock().map_err(|_| "Processor store lock poisoned")?;
        correlator_ids.iter()
            .filter_map(|id| procs.get(id).and_then(|p| p.as_correlator()).map(|d| (id.clone(), d.clone())))
            .collect()
    };

    // ── Snapshot source data + section ranges ────────────────────────────────
    let (source_snapshot, source_id, section_ranges, source_type) = {
        let sessions = state.sessions.lock().map_err(|_| "Session lock poisoned")?;
        let session = sessions.get(&session_id)
            .ok_or_else(|| format!("Session '{session_id}' not found"))?;
        let src = session.primary_source().ok_or("No sources in session")?;

        let sid = src.id.clone();
        let stype = src.source_type.clone();

        let snapshot = match &src.data {
            LogSourceData::File { mmap, line_index } => SourceSnapshot::File {
                mmap: Arc::clone(mmap),
                line_index: line_index.clone(),
            },
            LogSourceData::Stream { raw_lines, .. } => SourceSnapshot::Stream {
                raw_lines: raw_lines.clone(),
            },
        };

        // Section ranges indexed parallel to reporter_defs
        let ranges: Vec<Option<Vec<(usize, usize)>>> = reporter_defs.iter()
            .map(|(_, def)| {
                if def.sections.is_empty() {
                    None
                } else {
                    let r: Vec<(usize, usize)> = def.sections.iter()
                        .filter_map(|name| src.sections.iter().find(|s| s.name == *name))
                        .map(|s| (s.start_line, s.end_line))
                        .collect();
                    if r.is_empty() { None } else { Some(r) }
                }
            })
            .collect();

        (snapshot, sid, ranges, stype)
    };
    // Sessions lock released.

    let total_lines = source_snapshot.total_lines();
    let parser = parser_for(&source_type);

    // ── Snapshot anonymizer config ───────────────────────────────────────────
    let anonymizer_config = state.anonymizer_config.lock()
        .map_err(|_| "Anonymizer config lock poisoned")?
        .clone();

    // ── Initialize transformer runs ──────────────────────────────────────────
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

    // ── Chunked processing loop ──────────────────────────────────────────────
    let mut lines_processed = 0usize;

    for chunk_start in (0..total_lines).step_by(CHUNK_SIZE) {
        // Check cancellation
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let chunk_end = (chunk_start + CHUNK_SIZE).min(total_lines);

        // ── Parse chunk in parallel ──────────────────────────────────────────
        let mut parsed_chunk: Vec<Option<crate::core::line::LineContext>> = (chunk_start..chunk_end)
            .into_par_iter()
            .map(|n| {
                let raw = source_snapshot.raw_line(n).unwrap_or("");
                parser.parse_line(raw, &source_id, n)
            })
            .collect();

        // ── Save pre-transform messages for state tracker processing ─────────
        let pre_transform_msgs: HashMap<usize, String> =
            if !transformer_defs.is_empty() && !tracker_defs.is_empty() {
                parsed_chunk
                    .iter()
                    .filter_map(|opt| opt.as_ref().map(|l| (l.source_line_num, l.message.clone())))
                    .collect()
            } else {
                HashMap::new()
            };

        // ── Layer 1: Transformers ────────────────────────────────────────────
        if !transformer_defs.is_empty() {
            for line_opt in parsed_chunk.iter_mut() {
                if let Some(line) = line_opt.as_mut() {
                    let mut keep = true;
                    for run in transformer_runs.iter_mut() {
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
        let mut enriched_chunk: Vec<crate::core::line::LineContext> =
            parsed_chunk.into_iter().flatten().collect();

        // ── Layer 2a: StateTrackers ──────────────────────────────────────────
        if !tracker_defs.is_empty() {
            // Swap in pre-transform messages so capture regexes work on raw values.
            let mut saved_post_transform: Vec<String> = Vec::new();
            if !pre_transform_msgs.is_empty() {
                saved_post_transform.reserve(enriched_chunk.len());
                for line in enriched_chunk.iter_mut() {
                    let orig = pre_transform_msgs
                        .get(&line.source_line_num)
                        .cloned()
                        .unwrap_or_else(|| line.message.clone());
                    saved_post_transform.push(std::mem::replace(&mut line.message, orig));
                }
            }

            for (_, run) in tracker_runs.iter_mut() {
                for line in &enriched_chunk {
                    run.process_line(line);
                }
            }

            // Restore post-transform messages for reporters.
            if !saved_post_transform.is_empty() {
                for (line, post_msg) in enriched_chunk.iter_mut().zip(saved_post_transform) {
                    line.message = post_msg;
                }
            }
        }

        // ── Layer 2b: Reporters ──────────────────────────────────────────────
        for (idx, ctx) in enriched_chunk.iter().enumerate() {
            reporter_runs.par_iter_mut().for_each(|(run, ranges)| {
                if let Some(ranges) = ranges {
                    if !ranges.iter().any(|(s, e)| ctx.source_line_num >= *s && ctx.source_line_num <= *e) {
                        return;
                    }
                }
                run.process_line(ctx);
            });

            lines_processed += 1;
            let chunk_idx = chunk_start + idx;
            if chunk_idx % PROGRESS_INTERVAL == 0 || lines_processed == total_lines {
                for proc_id in &processor_ids {
                    let _ = app.emit(
                        "pipeline-progress",
                        PipelineProgress {
                            processor_id: proc_id.clone(),
                            lines_processed,
                            total_lines,
                            percent: lines_processed as f32 / total_lines.max(1) as f32 * 100.0,
                        },
                    );
                }
            }
        }

        // ── Layer 2c: Correlators ────────────────────────────────────────────
        for (_, run) in correlator_runs.iter_mut() {
            for line in &enriched_chunk {
                run.process_line(line);
            }
        }
    }

    // ── Collect PII forward mappings from transformer runs ───────────────────
    if !transformer_defs.is_empty() {
        forward_pii = transformer_runs.iter()
            .flat_map(|r| r.get_pii_mappings())
            .collect();
        if !forward_pii.is_empty() {
            let inverted: HashMap<String, String> =
                forward_pii.iter().map(|(raw, tok)| (tok.clone(), raw.clone())).collect();
            if let Ok(mut pm) = state.pii_mappings.lock() {
                pm.insert(session_id.clone(), inverted);
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
                    for transition in result.transitions.iter_mut() {
                        for (_, change) in transition.changes.iter_mut() {
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
            str_results.insert(session_id.clone(), session_tracker_results);
        }
    }

    // ── Finalize correlator results ──────────────────────────────────────────
    if !correlator_defs.is_empty() {
        let session_correlator_results: HashMap<String, _> = correlator_runs.into_iter()
            .map(|(cid, run)| (cid, run.finish()))
            .collect();
        if let Ok(mut cr) = state.correlator_results.lock() {
            cr.insert(session_id.clone(), session_correlator_results);
        }
    }

    // ── Collect results ───────────────────────────────────────────────────────
    let mut summaries: Vec<PipelineRunSummary> = Vec::new();
    let mut session_pipeline_results: HashMap<String, _> = HashMap::new();

    // Reporter results
    for ((proc_id, _), (run, _)) in reporter_ids.iter().zip(reporter_defs.iter()).zip(reporter_runs.into_iter()) {
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
        if let Some(session_str) = str_results.get(&session_id) {
            for tracker_id in &tracker_ids {
                if let Some(result) = session_str.get(tracker_id) {
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
        if let Some(session_map) = cr.get(&session_id) {
            for corr_id in &correlator_ids {
                if let Some(result) = session_map.get(corr_id) {
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
        pr.insert(session_id, session_pipeline_results);
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
