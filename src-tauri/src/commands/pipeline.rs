use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::{lock_or_err, AppState};
use crate::commands::pipeline_core::{
    excluded_by_source_type, PartitionedDefs, PipelineCore,
};
use crate::core::line::PipelineContext;
use crate::core::log_source::{FileLogSource, ZipLogSource};
use crate::core::session::parser_for;
use crate::processors::ProcessorKind;
use crate::processors::marketplace::resolve_processor_id;

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
    /// Number of Rhai script errors encountered (reporters only).
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub script_errors: u32,
    /// First script error message for diagnostics (reporters only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_script_error: Option<String>,
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
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
    Zip {
        data: Arc<Vec<u8>>,
        line_index: Vec<u64>,
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
            SourceSnapshot::Zip { line_index, .. } => {
                if line_index.len() > 1 { line_index.len() - 1 } else { 0 }
            }
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
            SourceSnapshot::Zip { data, line_index } => {
                if n + 1 >= line_index.len() {
                    return None;
                }
                let start = line_index[n] as usize;
                let end = line_index[n + 1] as usize;
                if start >= end || end > data.len() {
                    return None;
                }
                // Trim trailing \r\n or \n
                let mut slice_end = end;
                if slice_end > start && data[slice_end - 1] == b'\n' {
                    slice_end -= 1;
                }
                if slice_end > start && data[slice_end - 1] == b'\r' {
                    slice_end -= 1;
                }
                std::str::from_utf8(&data[start..slice_end]).ok()
            }
        }
    }
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
    let mut defs = PartitionedDefs {
        transformer_defs: Vec::new(),
        reporter_defs: Vec::new(),
        tracker_defs: Vec::new(),
        correlator_defs: Vec::new(),
    };
    {
        let procs = lock_or_err(&state.processors, "processors")?;
        for id in processor_ids {
            let resolved = resolve_processor_id(&procs, id)
                .unwrap_or_else(|| id.clone());
            if let Some(p) = procs.get(resolved.as_str()) {
                match &p.kind {
                    ProcessorKind::Transformer(d) => defs.transformer_defs.push((resolved, d.clone())),
                    ProcessorKind::Reporter(d) => defs.reporter_defs.push((resolved, d.clone())),
                    ProcessorKind::StateTracker(d) => defs.tracker_defs.push((resolved, d.clone())),
                    ProcessorKind::Correlator(d) => defs.correlator_defs.push((resolved, d.clone())),
                    _ => {} // Annotator: schema stub, no engine yet
                }
            }
        }
    }

    // ── Snapshot source data ─────────────────────────────────────────────────
    let (source_snapshot, source_id, source_type, src_sections) = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
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
        } else if let Some(zip_src) = src.as_any().downcast_ref::<ZipLogSource>() {
            SourceSnapshot::Zip {
                data: Arc::clone(zip_src.data()),
                line_index: zip_src.line_index().to_vec(),
            }
        } else {
            // StreamLogSource — clone the raw lines
            let stream_src = session.stream_source().ok_or("Source is neither File nor Stream")?;
            SourceSnapshot::Stream {
                raw_lines: stream_src.raw_lines.clone(),
            }
        };

        let src_sections = src.sections().to_vec();

        (snapshot, sid, stype, src_sections)
    };
    // Sessions lock released.

    // ── Pre-filter: exclude processors whose source_type filter doesn't match ─
    defs.reporter_defs.retain(|(_, def)| {
        !def.pipeline.iter().any(|stage| {
            if let crate::processors::reporter::schema::PipelineStage::Filter(f) = stage {
                excluded_by_source_type(&f.rules, &source_type)
            } else {
                false
            }
        })
    });
    defs.tracker_defs.retain(|(_, def)| {
        !def.transitions.iter().any(|t| {
            t.filter.source_type.as_ref()
                .is_some_and(|st| !source_type.matches_str(st))
        })
    });
    defs.correlator_defs.retain(|(_, def)| {
        def.sources.iter().any(|src| {
            !excluded_by_source_type(&src.filter, &source_type)
        })
    });

    let pipeline_ctx = PipelineContext {
        source_type: source_type.clone(),
        source_name: Arc::from(source_id.as_str()),
        is_streaming: matches!(source_snapshot, SourceSnapshot::Stream { .. }),
        sections: Arc::from(src_sections.as_slice()),
    };

    let total_lines = source_snapshot.total_lines();
    let parser = parser_for(&source_type);

    // ── Snapshot anonymizer config ───────────────────────────────────────────
    let anonymizer_config = lock_or_err(&state.anonymizer_config, "anonymizer_config")?
        .clone();

    // ── Build PipelineCore ──────────────────────────────────────────────────
    let mut core = PipelineCore::new(&defs, pipeline_ctx, &src_sections, &anonymizer_config);

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

        // ── Pre-filter: build list of lines worth parsing ────────────────────
        let line_indices: Vec<usize> = if core.prefilter.is_active() {
            (chunk_start..chunk_end)
                .filter(|&n| {
                    let raw = source_snapshot.raw_line(n).unwrap_or("");
                    core.prefilter.should_process(raw)
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

        // ── Run the unified pipeline core ────────────────────────────────────
        core.process_batch(&mut parsed_chunk);

        // ── Progress emission (after chunk completes) ────────────────────────
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

    // ── Collect PII forward mappings ─────────────────────────────────────────
    let forward_pii = core.collect_pii_mappings();
    if !forward_pii.is_empty() {
        let inverted: HashMap<String, String> =
            forward_pii.iter().map(|(raw, tok)| (tok.clone(), raw.clone())).collect();
        if let Ok(mut pm) = state.pii_mappings.lock() {
            pm.insert(session_id.to_string(), inverted);
        }
    }

    // ── Finalize all results ─────────────────────────────────────────────────
    let output = core.finish(&forward_pii);

    // ── Store state tracker results ──────────────────────────────────────────
    if !output.tracker_results.is_empty() {
        if let Ok(mut str_results) = state.state_tracker_results.lock() {
            str_results.insert(session_id.to_string(), output.tracker_results.clone());
        }
    }

    // ── Store correlator results ─────────────────────────────────────────────
    if !output.correlator_results.is_empty() {
        if let Ok(mut cr) = state.correlator_results.lock() {
            cr.insert(session_id.to_string(), output.correlator_results.clone());
        }
    }

    // ── Collect summaries ────────────────────────────────────────────────────
    let mut summaries: Vec<PipelineRunSummary> = Vec::new();
    let mut session_pipeline_results: HashMap<String, _> = HashMap::new();

    // Reporter results
    for (proc_id, result) in &output.reporter_results {
        summaries.push(PipelineRunSummary {
            processor_id: proc_id.clone(),
            matched_lines: result.matched_line_nums.len(),
            emission_count: result.emissions.len(),
            script_errors: result.script_errors,
            first_script_error: result.first_script_error.clone(),
        });
        session_pipeline_results.insert(proc_id.clone(), result.clone());
    }

    // StateTracker summaries (transition count as matched_lines)
    if let Ok(str_results) = state.state_tracker_results.lock() {
        if let Some(session_str) = str_results.get(session_id) {
            for (tracker_id, _) in &defs.tracker_defs {
                if let Some(result) = session_str.get(tracker_id.as_str()) {
                    summaries.push(PipelineRunSummary {
                        processor_id: tracker_id.clone(),
                        matched_lines: result.transitions.len(),
                        emission_count: 0,
                        script_errors: 0,
                        first_script_error: None,
                    });
                }
            }
        }
    }

    // Transformer summaries (no matched lines concept — emit 0)
    for (t_id, _) in &defs.transformer_defs {
        summaries.push(PipelineRunSummary {
            processor_id: t_id.clone(),
            matched_lines: 0,
            emission_count: 0,
            script_errors: 0,
            first_script_error: None,
        });
    }

    // Correlator summaries (event count as emission_count)
    if let Ok(cr) = state.correlator_results.lock() {
        if let Some(session_map) = cr.get(session_id) {
            for (corr_id, _) in &defs.correlator_defs {
                if let Some(result) = session_map.get(corr_id.as_str()) {
                    summaries.push(PipelineRunSummary {
                        processor_id: corr_id.clone(),
                        matched_lines: result.events.len(),
                        emission_count: result.events.len(),
                        script_errors: 0,
                        first_script_error: None,
                    });
                }
            }
        }
    }

    {
        let mut pr = lock_or_err(&state.pipeline_results, "pipeline_results")?;
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

// ---------------------------------------------------------------------------
// set_session_pipeline_meta — frontend pushes chain state for workspace saves
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn set_session_pipeline_meta(
    state: State<'_, AppState>,
    session_id: String,
    active_processor_ids: Vec<String>,
    disabled_processor_ids: Vec<String>,
) -> Result<(), String> {
    let meta = crate::workspace::SessionMeta {
        active_processor_ids,
        disabled_processor_ids,
    };
    let mut map = lock_or_err(&state.session_pipeline_meta, "session_pipeline_meta")?;
    map.insert(session_id, meta);
    Ok(())
}
