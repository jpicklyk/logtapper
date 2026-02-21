use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::commands::AppState;
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;
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
// run_pipeline
// ---------------------------------------------------------------------------

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

    // ── Snapshot raw lines + section ranges ───────────────────────────────────
    let (total_lines, source_id, raw_lines, section_ranges) = {
        let sessions = state.sessions.lock().map_err(|_| "Session lock poisoned")?;
        let session = sessions.get(&session_id)
            .ok_or_else(|| format!("Session '{session_id}' not found"))?;
        let src = session.primary_source().ok_or("No sources in session")?;

        let total = src.total_lines();
        let sid = src.id.clone();
        let lines: Vec<String> = (0..total)
            .map(|n| src.raw_line(n).unwrap_or("").to_string())
            .collect();

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

        (total, sid, lines, ranges)
    };
    // Sessions lock released.

    // ── Snapshot anonymizer config (used to build transformers with user settings) ─
    let anonymizer_config = state.anonymizer_config.lock()
        .map_err(|_| "Anonymizer config lock poisoned")?
        .clone();

    // ── Parse all lines in parallel ───────────────────────────────────────────
    let parser = LogcatParser;
    let mut parsed_lines: Vec<Option<crate::core::line::LineContext>> = raw_lines
        .par_iter()
        .enumerate()
        .map(|(line_num, raw)| parser.parse_line(raw, &source_id, line_num))
        .collect();
    drop(raw_lines);

    // ── Save pre-transform messages for state tracker processing ──────────────
    // State trackers must run on original messages so their capture regexes
    // still match (e.g. IP regex won't match "<IPv4-1>").  After capturing,
    // the stored transition values are post-processed with the PII mapping.
    // source_line_num == position in parsed_lines (set by the parser loop above).
    let pre_transform_msgs: HashMap<usize, String> =
        if !transformer_defs.is_empty() && !tracker_defs.is_empty() {
            parsed_lines
                .iter()
                .filter_map(|opt| opt.as_ref().map(|l| (l.source_line_num, l.message.clone())))
                .collect()
        } else {
            HashMap::new()
        };

    // ── Layer 1: Transformers (sequential — each modifies or drops lines) ─────
    let forward_pii: HashMap<String, String>;
    if !transformer_defs.is_empty() {
        let mut transformer_runs: Vec<TransformerRun> = transformer_defs.iter()
            .map(|(_, def)| TransformerRun::new_with_anonymizer_config(def, &anonymizer_config))
            .collect();

        for line_opt in parsed_lines.iter_mut() {
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

        // Forward mapping: raw→token.  Keep for post-processing state tracker values.
        // Also store inverted (token→raw) for the reveal-PII UI feature.
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
    } else {
        forward_pii = HashMap::new();
    }

    // Collect non-dropped lines for downstream layers
    let mut enriched_lines: Vec<crate::core::line::LineContext> =
        parsed_lines.into_iter().flatten().collect();

    // ── Layer 2a: StateTrackers ────────────────────────────────────────────────
    // Temporarily restore pre-transform messages so capture regexes work on
    // real values.  After capture, changes are post-processed with forward_pii.
    if !tracker_defs.is_empty() {
        // Swap in pre-transform messages; save post-transform ones for restoration.
        let mut saved_post_transform: Vec<String> = Vec::with_capacity(enriched_lines.len());
        if !pre_transform_msgs.is_empty() {
            for line in enriched_lines.iter_mut() {
                let orig = pre_transform_msgs
                    .get(&line.source_line_num)
                    .cloned()
                    .unwrap_or_else(|| line.message.clone());
                saved_post_transform.push(std::mem::replace(&mut line.message, orig));
            }
        }

        let mut session_tracker_results = HashMap::new();
        for (tracker_id, def) in &tracker_defs {
            let mut run = StateTrackerRun::new(tracker_id, def);
            for line in &enriched_lines {
                run.process_line(line);
            }
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

            session_tracker_results.insert(tracker_id.clone(), result);
        }

        // Restore post-transform messages for reporters.
        if !saved_post_transform.is_empty() {
            for (line, post_msg) in enriched_lines.iter_mut().zip(saved_post_transform) {
                line.message = post_msg;
            }
        }

        if let Ok(mut str_results) = state.state_tracker_results.lock() {
            str_results.insert(session_id.clone(), session_tracker_results);
        }
    }

    // ── Layer 2b: Reporters (sequential — stateful accumulators) ──────────────
    const PROGRESS_INTERVAL: usize = 5_000;

    let mut reporter_runs: Vec<ProcessorRun<'_>> = reporter_defs.iter()
        .map(|(_, def)| ProcessorRun::new(def))
        .collect();

    for (idx, ctx) in enriched_lines.iter().enumerate() {
        for (run, ranges) in reporter_runs.iter_mut().zip(section_ranges.iter()) {
            if let Some(ranges) = ranges {
                // Use the original file line number (ctx.source_line_num) for section range check
                if !ranges.iter().any(|(s, e)| ctx.source_line_num >= *s && ctx.source_line_num <= *e) {
                    continue;
                }
            }
            run.process_line(ctx);
        }

        if idx % PROGRESS_INTERVAL == 0 || idx + 1 == enriched_lines.len() {
            for proc_id in &processor_ids {
                let _ = app.emit(
                    "pipeline-progress",
                    PipelineProgress {
                        processor_id: proc_id.clone(),
                        lines_processed: idx + 1,
                        total_lines,
                        percent: (idx + 1) as f32 / total_lines.max(1) as f32 * 100.0,
                    },
                );
            }
        }
    }

    // ── Layer 2c: Correlators ─────────────────────────────────────────────────
    if !correlator_defs.is_empty() {
        let mut session_correlator_results = HashMap::new();
        for (corr_id, corr_def) in &correlator_defs {
            let mut run = CorrelatorRun::new(corr_def);
            for line in &enriched_lines {
                run.process_line(line);
            }
            let result = run.finish();
            session_correlator_results.insert(corr_id.clone(), result);
        }
        if let Ok(mut cr) = state.correlator_results.lock() {
            cr.insert(session_id.clone(), session_correlator_results);
        }
    }

    // ── Collect results ───────────────────────────────────────────────────────
    let mut summaries: Vec<PipelineRunSummary> = Vec::new();
    let mut session_pipeline_results: HashMap<String, _> = HashMap::new();

    // Reporter results
    for ((proc_id, _), run) in reporter_ids.iter().zip(reporter_defs.iter()).zip(reporter_runs.into_iter()) {
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
// stop_pipeline  (best-effort no-op — real cancellation needs tokio)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn stop_pipeline() -> Result<(), String> {
    Ok(())
}
