use rayon::prelude::*;
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

    // ── Change 1: Snapshot all raw lines + section ranges in ONE lock ────────
    // Previously the sessions lock was re-acquired for every line (~633K times
    // for a 76 MB file). Now we take it once, clone all raw bytes, and release.
    let (total_lines, source_id, raw_lines, section_ranges) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Session lock poisoned")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{session_id}' not found"))?;
        let src = session.primary_source().ok_or("No sources in session")?;

        let total = src.total_lines();
        let sid = src.id.clone();
        let lines: Vec<String> = (0..total)
            .map(|n| src.raw_line(n).unwrap_or("").to_string())
            .collect();

        let ranges: Vec<Option<Vec<(usize, usize)>>> = defs
            .iter()
            .map(|def| {
                if def.sections.is_empty() {
                    None
                } else {
                    let r: Vec<(usize, usize)> = def
                        .sections
                        .iter()
                        .filter_map(|name| src.sections.iter().find(|s| s.name == *name))
                        .map(|s| (s.start_line, s.end_line))
                        .collect();
                    if r.is_empty() { None } else { Some(r) }
                }
            })
            .collect();

        (total, sid, lines, ranges)
    };
    // Sessions lock released — all data is now owned locally.

    // ── Build anonymizer ──────────────────────────────────────────────────────
    let anon: Option<LogAnonymizer> = if anonymize {
        let config = {
            let c = state
                .anonymizer_config
                .lock()
                .map_err(|_| "Anonymizer config lock poisoned")?;
            c.clone()
        };
        Some(LogAnonymizer::from_config(&config))
    } else {
        None
    };

    // ── Set up parser and per-processor runs ──────────────────────────────────
    let parser = LogcatParser;
    let mut runs: Vec<ProcessorRun<'_>> = defs.iter().map(ProcessorRun::new).collect();

    // ── Change 3 (+ Change 2): Parse and anonymize in parallel with Rayon ────
    //
    // `LogcatParser` is a stateless unit struct (`Sync`).
    // `LogAnonymizer` is `Sync` because:
    //   - `Vec<Box<dyn PiiDetector>>`: all detector structs are `Send + Sync`
    //   - `PiiMappings`: uses three internal `Mutex<HashMap<...>>` fields
    // Both can be safely shared across Rayon worker threads.
    //
    // Change 2: We anonymize only `ctx.message` (not `ctx.raw` separately).
    // Since `message` is always a suffix of the trimmed `raw` in logcat format,
    // we reconstruct `anon_raw` by keeping the header prefix from `ctx.raw` and
    // appending the already-anonymized message — halving the regex work.
    let parsed_lines: Vec<Option<_>> = raw_lines
        .par_iter()
        .enumerate()
        .map(|(line_num, raw)| {
            let mut ctx = parser.parse_line(raw, &source_id, line_num)?;
            if let Some(ref a) = anon {
                // prefix_len: byte offset where message starts within raw.
                // message is always a suffix of raw (logcat_parser guarantee).
                let prefix_len = ctx.raw.len().saturating_sub(ctx.message.len());
                let (anon_msg, _) = a.anonymize(&ctx.message);
                // Build anonymized raw: keep logcat header, replace message.
                let anon_raw = format!("{}{}", &ctx.raw[..prefix_len], &anon_msg);
                ctx.message = anon_msg;
                ctx.raw = anon_raw;
            }
            Some(ctx)
        })
        .collect();

    // Raw lines no longer needed — drop them to free memory before Phase 2.
    drop(raw_lines);

    // ── Phase 2: Sequential processor pass ────────────────────────────────────
    // ProcessorRun accumulators are stateful so this must remain sequential.
    const PROGRESS_INTERVAL: usize = 5_000;

    for (line_num, maybe_ctx) in parsed_lines.into_iter().enumerate() {
        let ctx = match maybe_ctx {
            Some(c) => c,
            None => continue,
        };

        for (run, ranges) in runs.iter_mut().zip(section_ranges.iter()) {
            if let Some(ranges) = ranges {
                if !ranges.iter().any(|(s, e)| line_num >= *s && line_num <= *e) {
                    continue;
                }
            }
            run.process_line(&ctx);
        }

        if line_num % PROGRESS_INTERVAL == 0 || line_num + 1 == total_lines {
            for proc_id in &processor_ids {
                let _ = app.emit(
                    "pipeline-progress",
                    PipelineProgress {
                        processor_id: proc_id.clone(),
                        lines_processed: line_num + 1,
                        total_lines,
                        percent: (line_num + 1) as f32 / total_lines as f32 * 100.0,
                    },
                );
            }
        }
    }

    // ── Store PII mappings for the session (token → original) for display ────
    if let Some(ref a) = anon {
        let forward = a.mappings.all_mappings(); // raw_value → token
        let inverted: HashMap<String, String> =
            forward.into_iter().map(|(raw, tok)| (tok, raw)).collect();
        if let Ok(mut pm) = state.pii_mappings.lock() {
            pm.insert(session_id.clone(), inverted);
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
