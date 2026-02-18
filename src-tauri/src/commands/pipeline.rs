use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::anonymizer::LogAnonymizer;
use crate::commands::AppState;
use crate::core::logcat_parser::LogcatParser;
use crate::core::parser::LogParser;
use crate::processors::interpreter::ProcessorRun;

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
    anonymize: bool,
) -> Result<Vec<PipelineRunSummary>, String> {
    // ── Gather processor defs ────────────────────────────────────────────────
    let defs = {
        let procs = state
            .processors
            .lock()
            .map_err(|_| "Processor store lock poisoned")?;
        processor_ids
            .iter()
            .map(|id| {
                procs
                    .get(id)
                    .cloned()
                    .ok_or_else(|| format!("Processor '{}' not found", id))
            })
            .collect::<Result<Vec<_>, _>>()?
    };

    // ── Get session / source ─────────────────────────────────────────────────
    // We need to hold the lock only briefly to snapshot the data we need.
    let (total_lines, source_id) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Session lock poisoned")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{session_id}' not found"))?;
        let src = session.primary_source().ok_or("No sources in session")?;
        (src.total_lines(), src.id.clone())
    };

    // ── Set up per-processor runs ─────────────────────────────────────────────
    let mut runs: Vec<ProcessorRun<'_>> = defs.iter().map(ProcessorRun::new).collect();

    let parser = LogcatParser;
    let anon = if anonymize {
        Some(LogAnonymizer::new())
    } else {
        None
    };

    const PROGRESS_INTERVAL: usize = 5_000;

    // ── Main loop ─────────────────────────────────────────────────────────────
    for line_num in 0..total_lines {
        // Re-acquire sessions lock for each line (coarse, but correct).
        // For real perf we'd snapshot the whole source, but mmap stays valid.
        let raw = {
            let sessions = state
                .sessions
                .lock()
                .map_err(|_| "Session lock poisoned")?;
            let session = sessions.get(&session_id).ok_or("Session not found")?;
            let src = session.primary_source().ok_or("No source")?;
            src.raw_line(line_num).unwrap_or("").to_string()
        };

        // Parse the line
        let mut ctx = match parser.parse_line(&raw, &source_id, line_num) {
            Some(c) => c,
            None => continue,
        };

        // Optionally anonymize message and raw
        if let Some(ref a) = anon {
            let (anon_msg, _) = a.anonymize(&ctx.message);
            ctx.message = anon_msg;
            let (anon_raw, _) = a.anonymize(&ctx.raw);
            ctx.raw = anon_raw;
        }

        // Run through each processor
        for run in &mut runs {
            run.process_line(&ctx);
        }

        // Emit progress periodically
        if line_num % PROGRESS_INTERVAL == 0 || line_num == total_lines - 1 {
            for (i, proc_id) in processor_ids.iter().enumerate() {
                let _ = app.emit(
                    "pipeline-progress",
                    PipelineProgress {
                        processor_id: proc_id.clone(),
                        lines_processed: line_num + 1,
                        total_lines,
                        percent: (line_num + 1) as f32 / total_lines as f32 * 100.0,
                    },
                );
                let _ = i;
            }
        }
    }

    // ── Collect results ───────────────────────────────────────────────────────
    let mut summaries = Vec::new();
    let mut session_results: HashMap<String, _> = HashMap::new();

    for (proc_id, run) in processor_ids.iter().zip(runs.into_iter()) {
        let result = run.finish();
        summaries.push(PipelineRunSummary {
            processor_id: proc_id.clone(),
            matched_lines: result.matched_line_nums.len(),
            emission_count: result.emissions.len(),
        });
        session_results.insert(proc_id.clone(), result);
    }

    // Store results
    {
        let mut pr = state
            .pipeline_results
            .lock()
            .map_err(|_| "Pipeline results lock poisoned")?;
        pr.insert(session_id, session_results);
    }

    Ok(summaries)
}

// ---------------------------------------------------------------------------
// stop_pipeline  (Phase 2: best-effort no-op — real cancellation needs tokio)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn stop_pipeline() -> Result<(), String> {
    // Phase 2: pipeline runs synchronously; cancellation not yet implemented.
    Ok(())
}
