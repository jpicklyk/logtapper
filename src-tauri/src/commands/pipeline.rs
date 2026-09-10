use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{lock_or_err, AppState};
use crate::commands::pipeline_core::{
    excluded_by_declared_source_types, PartitionedDefs, PipelineCore,
};
use crate::core::line::PipelineContext;
use crate::core::log_source::{decode_line_bytes, Encoding, FileLogSource, ZipLogSource};
use crate::core::session::parser_for;
use crate::processors::ProcessorKind;
use crate::processors::correlator::engine::CorrelatorResult;
use crate::processors::marketplace::resolve_processor_id_checked;
use crate::processors::state_tracker::types::StateTrackerResult;

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
    /// Absolute line number of the first line scanned in this run (see
    /// `SourceSnapshot::scanned_from`). Zero for files and streams that
    /// haven't evicted; equals the stream's `evicted_count` at snapshot time
    /// otherwise, so callers can tell that lines before this one were
    /// excluded (spilled to disk, never read into the run) rather than just
    /// not matching.
    #[serde(skip_serializing_if = "is_zero_usize")]
    pub scanned_from: usize,
    /// Set when the processor was excluded before execution rather than run.
    /// `matched_lines` is zero because it never ran, which is a different fact
    /// from running and matching nothing — the same distinction `scanned_from`
    /// draws one level down. Consumers render this; they do not re-derive it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<SkipReason>,
}

/// Why a processor was excluded from a run before it executed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipReason {
    /// Stable machine-readable discriminant: `"source_type_mismatch"` for the
    /// declared-`schema.source_types` exclusion, or
    /// `"source_type_filter_excluded"` for an embedded `source_type_is`
    /// filter rule that excludes this source.
    pub reason: &'static str,
    /// The declared or filter-embedded `source_types` that caused exclusion.
    pub declared: Vec<String>,
    /// The session's actual source type.
    pub actual: String,
}

/// Build the summary row for a processor excluded by its declared
/// `source_types`. Free function rather than a closure so the exclusion passes
/// below can each borrow the skip list independently.
fn source_type_skip(
    processor_id: &str,
    declared: &[String],
    actual: &crate::core::session::SourceType,
) -> PipelineRunSummary {
    PipelineRunSummary {
        processor_id: processor_id.to_string(),
        matched_lines: 0,
        emission_count: 0,
        script_errors: 0,
        first_script_error: None,
        scanned_from: 0,
        skipped: Some(SkipReason {
            reason: "source_type_mismatch",
            declared: declared.to_vec(),
            actual: actual.to_string(),
        }),
    }
}

/// Build the summary row for a processor excluded by an embedded
/// `source_type_is` filter rule (as opposed to declared `schema.source_types`
/// metadata — see [`source_type_skip`]). Same shape, distinct `reason`, so
/// consumers can tell the two exclusion sources apart without re-deriving
/// which pass produced the row.
fn source_type_filter_skip(
    processor_id: &str,
    declared: Vec<String>,
    actual: &crate::core::session::SourceType,
) -> PipelineRunSummary {
    PipelineRunSummary {
        processor_id: processor_id.to_string(),
        matched_lines: 0,
        emission_count: 0,
        script_errors: 0,
        first_script_error: None,
        scanned_from: 0,
        skipped: Some(SkipReason {
            reason: "source_type_filter_excluded",
            declared,
            actual: actual.to_string(),
        }),
    }
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}

fn is_zero_usize(v: &usize) -> bool {
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
        encoding: Encoding,
    },
    Stream {
        raw_lines: Vec<String>,
        /// Absolute line number of `raw_lines[0]` at snapshot time — the
        /// stream's `evicted_count`. Lines before this offset were already
        /// spilled to disk and are intentionally excluded from this run (the
        /// spill file is never read into the snapshot).
        evicted_offset: usize,
    },
    Zip {
        data: Arc<Vec<u8>>,
        line_index: Vec<u64>,
        encoding: Encoding,
    },
}

impl SourceSnapshot {
    fn total_lines(&self) -> usize {
        match self {
            // Sentinel-based: line_index has N+1 entries for N lines.
            SourceSnapshot::File { line_index, .. } => {
                if line_index.is_empty() { 0 } else { line_index.len() - 1 }
            }
            SourceSnapshot::Stream { raw_lines, .. } => raw_lines.len(),
            SourceSnapshot::Zip { line_index, .. } => {
                if line_index.len() > 1 { line_index.len() - 1 } else { 0 }
            }
        }
    }

    /// Absolute line number of the first line included in this snapshot.
    /// Zero for files/zips and streams with no eviction; equals the stream's
    /// `evicted_count` at snapshot time otherwise. Everything this snapshot
    /// produces (`raw_line` input, `parse_line` output `source_line_num`) is
    /// numbered starting from this offset, mirroring the absolute,
    /// eviction-transparent semantics of `StreamLogSource::raw_line`/`meta_at`.
    fn scanned_from(&self) -> usize {
        match self {
            SourceSnapshot::Stream { evicted_offset, .. } => *evicted_offset,
            SourceSnapshot::File { .. } | SourceSnapshot::Zip { .. } => 0,
        }
    }

    fn raw_line(&self, n: usize) -> Option<std::borrow::Cow<'_, str>> {
        match self {
            SourceSnapshot::File { mmap, line_index, encoding } => {
                if n + 1 >= line_index.len() {
                    return None;
                }
                let start = line_index[n] as usize;
                let end = line_index[n + 1] as usize;
                if start >= end || end > mmap.len() {
                    return None;
                }
                decode_line_bytes(mmap.as_ref(), start, end, *encoding)
            }
            SourceSnapshot::Stream { raw_lines, evicted_offset } => {
                // `n` is absolute (mirrors StreamLogSource::raw_line). Lines
                // before the snapshot's evicted offset were never cloned in —
                // they were spilled to disk and are out of scope for this run.
                let local = n.checked_sub(*evicted_offset)?;
                raw_lines.get(local).map(|s| std::borrow::Cow::Borrowed(s.as_str()))
            }
            SourceSnapshot::Zip { data, line_index, encoding } => {
                if n + 1 >= line_index.len() {
                    return None;
                }
                let start = line_index[n] as usize;
                let end = line_index[n + 1] as usize;
                if start >= end || end > data.len() {
                    return None;
                }
                decode_line_bytes(data.as_ref(), start, end, *encoding)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// run_pipeline
// ---------------------------------------------------------------------------

const CHUNK_SIZE: usize = 50_000;

/// RAII guard that removes a run's cancellation token from the registry when
/// `execute_pipeline` returns — on the happy path or any `?` early return — so
/// the `pipeline_cancels` map never accumulates stale tokens.
struct PipelineRunGuard<'a> {
    state: &'a AppState,
    run_id: u64,
}

impl Drop for PipelineRunGuard<'_> {
    fn drop(&mut self) {
        self.state.unregister_pipeline_run(self.run_id);
    }
}

#[tauri::command]
pub async fn run_pipeline(
    app: AppHandle,
    session_id: String,
    processor_ids: Vec<String>,
    // Kept for backward-compat with frontend — anonymization is now driven by
    // having a Transformer processor (e.g. __pii_anonymizer) in processor_ids.
    #[allow(unused_variables)]
    anonymize: bool,
) -> Result<Vec<PipelineRunSummary>, String> {
    // The pipeline is CPU-heavy (rayon) and previously ran directly on the async
    // runtime thread, starving other IPC. Run it on a blocking thread, matching
    // the MCP bridge's `h_run_pipeline`. No lock guard is held across this await:
    // `execute_pipeline` is synchronous and acquires/releases all locks inside
    // the blocking closure.
    let app_for_task = app.clone();
    tokio::task::spawn_blocking(move || {
        let state = app_for_task.state::<std::sync::Arc<AppState>>();
        execute_pipeline(&state, &app_for_task, &session_id, &processor_ids)
    })
    .await
    .map_err(|e| format!("Pipeline task panicked: {e}"))?
}

/// Core pipeline execution logic. Called by both the Tauri command and the MCP bridge.
pub fn execute_pipeline(
    state: &AppState,
    app: &AppHandle,
    session_id: &str,
    processor_ids: &[String],
) -> Result<Vec<PipelineRunSummary>, String> {
    // ── Serialize runs on the same session ───────────────────────────────────
    // Two runs on one session (e.g. the UI and the MCP bridge racing) must not
    // interleave their writes to pipeline_results / state_tracker_results /
    // correlator_results — that leaves stored state mixing one run's trackers
    // with another's reporters. Holding the per-session run lock for the whole
    // run makes each run's three-map write sequence atomic w.r.t. other runs.
    // This lock is the outermost AppState lock (taken before any other), so it
    // introduces no ordering cycle. execute_pipeline is synchronous and holds no
    // lock across an await; both callers wrap it in spawn_blocking, so parking a
    // blocking-pool thread here does not stall the async runtime.
    let run_lock = state.pipeline_run_lock(session_id)?;

    // ── Register this run's cancellation token BEFORE waiting on the run lock ──
    // Each run owns a distinct token keyed by a fresh run id, so starting this
    // run never clears another run's pending cancel. Registering *before* we
    // block on the run lock means a `stop_pipeline` issued while this run is
    // still queued behind another same-session run lands on a live token (which
    // we re-check right after acquisition below) instead of being missed — the
    // queued run would otherwise slip past the stop and execute a full pass
    // under a fresh, uncancelled token. `_cancel_guard` removes the token on
    // every exit path (the `?` early returns, the queued-cancel abort, and the
    // happy path).
    let (run_id, cancel) = state.register_pipeline_run();
    let _cancel_guard = PipelineRunGuard { state, run_id };

    // Acquire the per-session run lock, RECOVERING from a poisoned lock. This
    // `Mutex<()>` guards no data — it is a pure serialization gate — so a prior
    // run that panicked while holding it left behind no corrupt invariant to
    // protect against; taking the guard out of the `PoisonError` is safe.
    // Propagating the poison instead would make every later run on this session
    // fail forever: session ids are content-derived and the run-lock entry is
    // cached, so even closing and reopening the same file would reuse the
    // poisoned lock, bricking pipeline runs until the app restarts.
    let _run_guard = run_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

    // If a stop arrived while we were queued behind another run, honor it now
    // rather than running a full pass. Returning empty leaves any results
    // already stored for this session untouched (a cancelled run is not a
    // failure — mirrors the mid-run cancel path, which also returns Ok).
    if cancel.load(Ordering::Relaxed) {
        return Ok(Vec::new());
    }

    // ── Partition processor IDs by kind and clone defs (single lock scope) ───
    let mut defs = PartitionedDefs {
        transformer_defs: Vec::new(),
        reporter_defs: Vec::new(),
        tracker_defs: Vec::new(),
        correlator_defs: Vec::new(),
    };
    // Declared `source_types` lives on `AnyProcessor::schema`, not on the
    // per-kind def structs, so it has to be captured here while the registry
    // entry is still in scope. Deliberately not copied onto the def types —
    // that would duplicate the schema into the execution types and give it a
    // second place to drift from.
    let mut declared_source_types: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    {
        let procs = lock_or_err(&state.processors, "processors")?;
        for id in processor_ids {
            // Surface ambiguity rather than silently guessing: if `id` is a
            // bare id that matches more than one installed source (e.g.
            // `wifi-state@official` and `wifi-state@my-team`), fail the run
            // instead of picking one — same "explicit, not silent" principle
            // as the source-type skip rows below.
            let resolved = resolve_processor_id_checked(&procs, id)
                .map_err(|e| format!("Cannot run pipeline: {e}"))?
                .unwrap_or_else(|| id.clone());
            if let Some(p) = procs.get(resolved.as_str()) {
                if let Some(schema) = p.schema.as_ref() {
                    if !schema.source_types.is_empty() {
                        declared_source_types
                            .insert(resolved.clone(), schema.source_types.clone());
                    }
                }
                match &p.kind {
                    ProcessorKind::Transformer(d) => defs.transformer_defs.push((resolved, Arc::clone(d))),
                    ProcessorKind::Reporter(d) => defs.reporter_defs.push((resolved, Arc::clone(d))),
                    ProcessorKind::StateTracker(d) => defs.tracker_defs.push((resolved, Arc::clone(d))),
                    ProcessorKind::Correlator(d) => defs.correlator_defs.push((resolved, Arc::clone(d))),
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
        let src_encoding = src.encoding();

        // Build snapshot by downcasting to concrete type
        let snapshot = if let Some(file_src) = src.as_any().downcast_ref::<FileLogSource>() {
            SourceSnapshot::File {
                mmap: Arc::clone(file_src.mmap()),
                line_index: file_src.line_index().to_vec(),
                encoding: src_encoding,
            }
        } else if let Some(zip_src) = src.as_any().downcast_ref::<ZipLogSource>() {
            SourceSnapshot::Zip {
                data: Arc::clone(zip_src.data()),
                line_index: zip_src.line_index().to_vec(),
                encoding: src_encoding,
            }
        } else {
            // StreamLogSource — clone the retained raw lines. Evicted lines
            // stay on disk (spill file) and are intentionally excluded from
            // this run; the evicted offset is captured so every line number
            // this snapshot produces stays absolute.
            let stream_src = session.stream_source().ok_or("Source is neither File nor Stream")?;
            SourceSnapshot::Stream {
                raw_lines: stream_src.raw_lines.clone(),
                evicted_offset: stream_src.evicted_count(),
            }
        };

        let src_sections = src.sections().to_vec();

        (snapshot, sid, stype, src_sections)
    };
    // Sessions lock released.

    // ── Exclude processors whose declared source_types exclude this source ───
    // Enforced here, in the backend, as the single decision point: the frontend
    // renders this outcome rather than re-deriving the rule, so the two cannot
    // drift. Excluded processors are reported as skip rows below instead of
    // being dropped, because a processor that simply vanished from the run is
    // indistinguishable from one that ran and matched nothing.
    let mut skipped: Vec<PipelineRunSummary> = Vec::new();
    {
        let declared = |id: &str| -> Vec<String> {
            declared_source_types.get(id).cloned().unwrap_or_default()
        };
        defs.reporter_defs.retain(|(id, _)| {
            let d = declared(id);
            if excluded_by_declared_source_types(&d, &source_type) {
                skipped.push(source_type_skip(id, &d, &source_type));
                return false;
            }
            true
        });
        defs.tracker_defs.retain(|(id, _)| {
            let d = declared(id);
            if excluded_by_declared_source_types(&d, &source_type) {
                skipped.push(source_type_skip(id, &d, &source_type));
                return false;
            }
            true
        });
        defs.correlator_defs.retain(|(id, _)| {
            let d = declared(id);
            if excluded_by_declared_source_types(&d, &source_type) {
                skipped.push(source_type_skip(id, &d, &source_type));
                return false;
            }
            true
        });
        // Transformers are included even though they are Layer 1, not Layer 2.
        // They are excluded from the *pre-filter* (see `collect_prefilter_info`)
        // for a different reason — an unfiltered transformer there would disable
        // the whole optimisation — and that exemption must not be mistaken for a
        // source-type exemption. A transformer rewrites or drops lines before any
        // reporter, tracker or correlator sees them, so running one against a
        // source it does not understand corrupts every downstream processor's
        // input rather than merely wasting work.
        defs.transformer_defs.retain(|(id, _)| {
            let d = declared(id);
            if excluded_by_declared_source_types(&d, &source_type) {
                skipped.push(source_type_skip(id, &d, &source_type));
                return false;
            }
            true
        });
    }

    // ── Pre-filter: exclude processors whose source_type filter doesn't match ─
    // Same principle as the declared-source_types pass above: a processor
    // dropped here because an embedded `source_type_is` filter rule excludes
    // this source must surface as a skip row, not vanish from the summary —
    // otherwise it is indistinguishable from one that ran and matched
    // nothing. `find_embedded_source_type_exclusions` is the single source of
    // truth for "who gets excluded and why" (it inspects a different place
    // per processor kind: a reporter's filter stage, a tracker's transition
    // filters, or a correlator's per-source filters); the retains below just
    // act on its answer.
    let embedded_exclusions =
        crate::commands::pipeline_core::find_embedded_source_type_exclusions(&defs, &source_type);
    let excluded_reporter_ids: std::collections::HashSet<&str> = embedded_exclusions
        .reporter_ids
        .iter()
        .map(|(id, _)| id.as_str())
        .collect();
    let excluded_tracker_ids: std::collections::HashSet<&str> = embedded_exclusions
        .tracker_ids
        .iter()
        .map(|(id, _)| id.as_str())
        .collect();
    let excluded_correlator_ids: std::collections::HashSet<&str> = embedded_exclusions
        .correlator_ids
        .iter()
        .map(|(id, _)| id.as_str())
        .collect();
    defs.reporter_defs.retain(|(id, _)| !excluded_reporter_ids.contains(id.as_str()));
    defs.tracker_defs.retain(|(id, _)| !excluded_tracker_ids.contains(id.as_str()));
    defs.correlator_defs.retain(|(id, _)| !excluded_correlator_ids.contains(id.as_str()));
    for (id, declared) in embedded_exclusions.reporter_ids {
        skipped.push(source_type_filter_skip(&id, declared, &source_type));
    }
    for (id, declared) in embedded_exclusions.tracker_ids {
        skipped.push(source_type_filter_skip(&id, declared, &source_type));
    }
    for (id, declared) in embedded_exclusions.correlator_ids {
        skipped.push(source_type_filter_skip(&id, declared, &source_type));
    }

    let pipeline_ctx = PipelineContext {
        source_type: source_type.clone(),
        source_name: Arc::from(source_id.as_str()),
        is_streaming: matches!(source_snapshot, SourceSnapshot::Stream { .. }),
        sections: Arc::from(src_sections.as_slice()),
    };

    let total_lines = source_snapshot.total_lines();
    let scanned_from = source_snapshot.scanned_from();
    let parser = parser_for(&source_type);

    // ── Snapshot anonymizer config ───────────────────────────────────────────
    let anonymizer_config = lock_or_err(&state.anonymizer_config, "anonymizer_config")?
        .clone();

    // ── Build PipelineCore ──────────────────────────────────────────────────
    let mut core = PipelineCore::new(&defs, pipeline_ctx, &src_sections, &anonymizer_config);

    // `cancel` is this run's own token (from register_pipeline_run above).

    // ── Chunked processing loop ──────────────────────────────────────────────
    let mut lines_processed = 0usize;

    // Absolute line numbers: for files/zips `scanned_from` is 0 so this loop
    // behaves exactly as before. For streams it starts at the snapshot's
    // evicted offset so every produced `source_line_num` (and hence every
    // matched line, emission, state-tracker transition, and correlation
    // event) stays absolute — consistent with `StreamLogSource::raw_line`.
    let scan_end = scanned_from + total_lines;

    for chunk_start in (scanned_from..scan_end).step_by(CHUNK_SIZE) {
        // Check cancellation
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let chunk_end = (chunk_start + CHUNK_SIZE).min(scan_end);

        // ── Pre-filter: build list of lines worth parsing ────────────────────
        let line_indices: Vec<usize> = if core.prefilter.is_active() {
            (chunk_start..chunk_end)
                .filter(|&n| {
                    let raw = source_snapshot.raw_line(n);
                    let raw_str = raw.as_deref().unwrap_or("");
                    core.prefilter.should_process(raw_str)
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
                let raw = source_snapshot.raw_line(n);
                let raw_str = raw.as_deref().unwrap_or("");
                parser.parse_line(raw_str, &source_id, n)
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

    // ── Collect summaries ────────────────────────────────────────────────────
    // Order preserved from before this fix: reporter, state tracker,
    // transformer, correlator. Tracker/correlator summary counts are read
    // from `output` via borrowed `.get()` lookups (in the same
    // `defs.tracker_defs` / `defs.correlator_defs` order the old
    // re-lock-and-read code used) BEFORE `output.tracker_results` /
    // `output.correlator_results` are moved (not cloned) into
    // `store_tracker_and_correlator_results` further down — this avoids
    // re-locking `state.state_tracker_results` / `state.correlator_results`
    // afterward just to read back the same data this run already produced.
    let mut summaries: Vec<PipelineRunSummary> = Vec::new();
    let mut session_pipeline_results: HashMap<String, _> = HashMap::new();

    // Reporter results — consume `output.reporter_results` by value so each
    // RunResult (which owns a Vec<Emission>, potentially large) is moved
    // straight into `session_pipeline_results` instead of being deep-cloned.
    // Only `first_script_error` (a small `Option<String>`) still needs a
    // clone, since the summary and the stored result both need it.
    for (proc_id, result) in output.reporter_results {
        summaries.push(PipelineRunSummary {
            processor_id: proc_id.clone(),
            matched_lines: result.matched_line_nums.len(),
            emission_count: result.emissions.len(),
            script_errors: result.script_errors,
            first_script_error: result.first_script_error.clone(),
            scanned_from,
            skipped: None,
        });
        session_pipeline_results.insert(proc_id, result);
    }

    // StateTracker summaries (transition count as matched_lines)
    for (tracker_id, _) in &defs.tracker_defs {
        if let Some(result) = output.tracker_results.get(tracker_id.as_str()) {
            summaries.push(PipelineRunSummary {
                processor_id: tracker_id.clone(),
                matched_lines: result.transitions.len(),
                emission_count: 0,
                script_errors: 0,
                first_script_error: None,
                scanned_from,
                skipped: None,
            });
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
            scanned_from,
            skipped: None,
        });
    }

    // Correlator summaries (event count as emission_count)
    for (corr_id, _) in &defs.correlator_defs {
        if let Some(result) = output.correlator_results.get(corr_id.as_str()) {
            summaries.push(PipelineRunSummary {
                processor_id: corr_id.clone(),
                matched_lines: result.events.len(),
                emission_count: result.events.len(),
                script_errors: 0,
                first_script_error: None,
                scanned_from,
                skipped: None,
            });
        }
    }

    // ── Store state tracker + correlator results ─────────────────────────────
    // Overwritten unconditionally (even with an empty map) for the same reason
    // `pipeline_results` below is: a rerun that deselects every tracker/
    // correlator (or whose source-type exclusion drops them all) must not
    // leave the previous run's results stranded and still served to the UI
    // and MCP bridge. `output.tracker_results` / `output.correlator_results`
    // hold exactly one entry per selected def for *this* run (built from
    // `PipelineCore::tracker_runs` / `correlator_runs`, seeded from `defs` —
    // see `pipeline_core.rs::finish`), so an empty map here means "no such
    // processors ran this time", not "ran and produced nothing". Moved (not
    // cloned) into storage — the summary counts above were already extracted
    // from borrowed references.
    store_tracker_and_correlator_results(
        state,
        session_id,
        output.tracker_results,
        output.correlator_results,
    );

    {
        let mut pr = lock_or_err(&state.pipeline_results, "pipeline_results")?;
        pr.insert(session_id.to_string(), session_pipeline_results);
    }

    // Processors excluded by their declared source_types never executed, so they
    // produced no results to collect above. Append their skip rows so they stay
    // visible in the run rather than silently disappearing from it.
    summaries.extend(skipped);

    Ok(summaries)
}

/// Overwrite this session's `state_tracker_results` / `correlator_results`
/// entries with the current run's output, unconditionally — including with
/// an empty map when this run had no trackers/correlators. Without this, a
/// rerun that deselects every tracker or correlator (or whose source-type
/// exclusion drops them all) leaves the previous run's stale results in
/// place forever, since `close_session` / `stop_adb_stream` are otherwise the
/// only code that removes entries from these maps. Mirrors the unconditional
/// `pipeline_results` overwrite in `execute_pipeline`.
fn store_tracker_and_correlator_results(
    state: &AppState,
    session_id: &str,
    tracker_results: HashMap<String, StateTrackerResult>,
    correlator_results: HashMap<String, CorrelatorResult>,
) {
    if let Ok(mut str_results) = state.state_tracker_results.lock() {
        str_results.insert(session_id.to_string(), tracker_results);
    }
    if let Ok(mut cr) = state.correlator_results.lock() {
        cr.insert(session_id.to_string(), correlator_results);
    }
}

// ---------------------------------------------------------------------------
// stop_pipeline — sets cancellation flag for the active pipeline run
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn stop_pipeline(state: State<'_, std::sync::Arc<AppState>>) -> Result<(), String> {
    // No run/session parameter (the UI stop button carries none): signal every
    // currently-registered run. Starting a run never clears another's token, so
    // this only affects runs actually in flight when stop is pressed.
    state.cancel_all_pipeline_runs();
    Ok(())
}

// ---------------------------------------------------------------------------
// set_session_pipeline_meta — frontend pushes chain state for workspace saves
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn set_session_pipeline_meta(
    state: State<'_, std::sync::Arc<AppState>>,
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

// ---------------------------------------------------------------------------
// Tests — SourceSnapshot::Stream absolute line numbering after eviction
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anonymizer::config::AnonymizerConfig;
    use crate::core::line::{LineMeta, LogLevel};
    use crate::core::log_source::StreamLogSource;
    use crate::core::session::SourceType;
    use crate::processors::reporter::schema::ReporterDef;
    use crate::processors::state_tracker::types::StateTransition;

    /// Build a StreamLogSource with `n` lines pushed, then evict the first
    /// `evicted` of them (writing them to a real spill file, exactly like a
    /// live ADB capture hitting its retention cap). Each retained line embeds
    /// its own absolute line number as `seq=<n>` so tests can verify content
    /// stayed aligned with the number stamped onto it.
    ///
    /// `label` must be unique per caller — the spill file path is derived
    /// from the session id, and tests run in parallel, so two tests sharing
    /// one id would race on the same temp file.
    fn make_evicted_stream(label: &str, n: usize, evicted: usize) -> StreamLogSource {
        let mut src = StreamLogSource::new(
            "test-src".into(),
            "test-src".into(),
            format!("test-session-{label}"),
            std::env::temp_dir(),
        );
        for i in 0..n {
            src.push_raw_line(format!(
                "03-13 11:33:42.{:03}  1000  2723  5261 D PingTag: PING seq={i}",
                i % 1000
            ));
            src.push_meta(LineMeta {
                level: LogLevel::Debug,
                tag_id: 0,
                timestamp: i as i64,
                byte_offset: 0,
                byte_len: 0,
                is_section_boundary: false,
            });
        }
        if evicted > 0 {
            src.evict(evicted);
        }
        src
    }

    /// Build the same `SourceSnapshot::Stream` execute_pipeline builds under
    /// the sessions lock, from an already-evicted StreamLogSource.
    fn snapshot_of(src: &StreamLogSource) -> SourceSnapshot {
        SourceSnapshot::Stream {
            raw_lines: src.raw_lines.clone(),
            evicted_offset: src.evicted_count(),
        }
    }

    #[test]
    fn stream_snapshot_scanned_from_matches_evicted_count() {
        let src = make_evicted_stream("scanned-from", 10, 4);
        let snap = snapshot_of(&src);

        assert_eq!(snap.scanned_from(), 4, "scanned_from must equal the evicted offset");
        assert_eq!(snap.total_lines(), 6, "only the 6 retained lines are in the snapshot");
    }

    #[test]
    fn stream_snapshot_raw_line_uses_absolute_indices() {
        let src = make_evicted_stream("raw-line", 10, 4);
        let snap = snapshot_of(&src);

        // Evicted lines (0..4) were never cloned into the snapshot — they
        // live only in the spill file, which run_pipeline intentionally
        // never reads. Absolute indices below the offset must miss.
        for n in 0..4 {
            assert!(
                snap.raw_line(n).is_none(),
                "line {n} was evicted and must not resolve from the snapshot"
            );
        }

        // Retained lines (4..10) must resolve by their ABSOLUTE line number,
        // not a snapshot-relative index — this is the crux of the bug fix.
        for n in 4..10 {
            let raw = snap.raw_line(n).expect("retained line must resolve");
            assert!(
                raw.contains(&format!("seq={n}")),
                "raw_line({n}) returned {raw:?}, expected the line whose seq matches its own absolute number"
            );
        }
    }

    #[test]
    fn stream_snapshot_parse_line_stamps_absolute_source_line_num() {
        let src = make_evicted_stream("parse-line", 10, 4);
        let snap = snapshot_of(&src);
        let parser = parser_for(&SourceType::Logcat);

        let scanned_from = snap.scanned_from();
        let total_lines = snap.total_lines();

        // Mirrors exactly what execute_pipeline's chunk loop does: iterate
        // the absolute range and parse each raw line at its absolute number.
        for n in scanned_from..(scanned_from + total_lines) {
            let raw = snap.raw_line(n).expect("retained line must resolve");
            let raw_str = raw.as_ref();
            let ctx = parser.parse_line(raw_str, "test-src", n)
                .expect("threadtime-format line must parse");
            assert_eq!(
                ctx.source_line_num, n,
                "parse_line must stamp the ABSOLUTE line number, not a snapshot-relative one"
            );
            assert!(
                ctx.message.contains(&format!("seq={n}")),
                "line content must still match its own absolute number: {:?}",
                ctx.message
            );
        }
    }

    #[test]
    fn stream_snapshot_reporter_matches_are_absolute_and_exclude_evicted_lines() {
        // 500_000-scale eviction offsets are realistic for a long capture,
        // but any nonzero offset exercises the bug — keep it small for a
        // fast, readable test.
        let evicted = 1_000;
        let retained = 5;
        let src = make_evicted_stream("reporter", evicted + retained, evicted);
        let snap = snapshot_of(&src);
        let parser = parser_for(&SourceType::Logcat);

        let yaml = r#"
meta:
  id: ping_reporter
  name: Ping Reporter
pipeline:
  - stage: filter
    rules:
      - type: message_contains
        value: "PING"
"#;
        let reporter_def = ReporterDef::from_yaml(yaml).expect("reporter yaml parses");
        let defs = PartitionedDefs {
            transformer_defs: Vec::new(),
            reporter_defs: vec![("ping_reporter".to_string(), Arc::new(reporter_def))],
            tracker_defs: Vec::new(),
            correlator_defs: Vec::new(),
        };

        let pipeline_ctx = PipelineContext {
            source_type: SourceType::Logcat,
            source_name: Arc::from("test-src"),
            is_streaming: true,
            sections: Arc::from([]),
        };

        let anonymizer_config = AnonymizerConfig::with_defaults();
        let mut core = PipelineCore::new(&defs, pipeline_ctx, &[], &anonymizer_config);

        let scanned_from = snap.scanned_from();
        let total_lines = snap.total_lines();
        let mut parsed_chunk: Vec<Option<crate::core::line::LineContext>> =
            (scanned_from..(scanned_from + total_lines))
                .map(|n| {
                    let raw = snap.raw_line(n).unwrap();
                    parser.parse_line(raw.as_ref(), "test-src", n)
                })
                .collect();
        core.process_batch(&mut parsed_chunk);

        let output = core.finish(&HashMap::new());
        let result = output.reporter_results.get("ping_reporter").expect("reporter ran");

        let expected: Vec<usize> = (evicted..(evicted + retained)).collect();
        let mut matched = result.matched_line_nums.clone();
        matched.sort_unstable();
        assert_eq!(
            matched, expected,
            "matched_line_nums must be absolute line numbers starting at the evicted offset, \
             with every evicted line excluded from the run"
        );
    }

    #[test]
    fn pipeline_run_summary_scanned_from_skips_serialization_when_zero() {
        let zero = PipelineRunSummary {
            processor_id: "p".into(),
            matched_lines: 0,
            emission_count: 0,
            script_errors: 0,
            first_script_error: None,
            scanned_from: 0,
            skipped: None,
        };
        let json = serde_json::to_value(&zero).unwrap();
        assert!(json.get("scannedFrom").is_none(), "scannedFrom must be omitted when zero (files, unevicted streams)");

        let nonzero = PipelineRunSummary {
            processor_id: "p".into(),
            matched_lines: 0,
            emission_count: 0,
            script_errors: 0,
            first_script_error: None,
            scanned_from: 1234,
            skipped: None,
        };
        let json = serde_json::to_value(&nonzero).unwrap();
        assert_eq!(json.get("scannedFrom").and_then(|v| v.as_u64()), Some(1234));
    }

    /// A skipped processor must be distinguishable from one that ran and
    /// matched nothing — both report `matchedLines: 0`, so `skipped` is the
    /// only thing carrying the difference to the frontend.
    #[test]
    fn skip_reason_serializes_only_when_present() {
        let ran = PipelineRunSummary {
            processor_id: "p".into(),
            matched_lines: 0,
            emission_count: 0,
            script_errors: 0,
            first_script_error: None,
            scanned_from: 0,
            skipped: None,
        };
        let json = serde_json::to_value(&ran).unwrap();
        assert!(json.get("skipped").is_none(), "ran-but-matched-nothing carries no skip reason");

        let skipped = source_type_skip(
            "ethernet-config-audit",
            &["logcat".to_string(), "bugreport".to_string()],
            &crate::core::session::SourceType::Kernel,
        );
        let json = serde_json::to_value(&skipped).unwrap();
        let s = json.get("skipped").expect("skipped processor carries a reason");
        assert_eq!(s.get("reason").and_then(|v| v.as_str()), Some("source_type_mismatch"));
        assert_eq!(s.get("actual").and_then(|v| v.as_str()), Some("Kernel"));
        assert_eq!(json.get("matchedLines").and_then(|v| v.as_u64()), Some(0));
    }

    // ── Per-run cancellation registry semantics ──────────────────────────────
    //
    // These lock in the guarantees that motivated replacing the single global
    // `pipeline_cancel: Arc<AtomicBool>`: starting run B must never clear run A's
    // pending cancel, `stop_pipeline` must cancel exactly the runs in flight, and
    // a finished run must leave the registry so its token can't be re-signalled.

    #[test]
    fn starting_a_run_does_not_clear_another_runs_pending_cancel() {
        let state = AppState::new();
        // Run A starts and is then cancelled (user hit stop while only A ran).
        let (id_a, tok_a) = state.register_pipeline_run();
        tok_a.store(true, Ordering::Relaxed);
        // Run B starts afterwards — the old global-flag reset would clobber A's
        // pending cancel here. With per-run tokens it must not.
        let (id_b, tok_b) = state.register_pipeline_run();
        assert_ne!(id_a, id_b, "each run must get a distinct id");
        assert!(
            tok_a.load(Ordering::Relaxed),
            "starting run B must NOT clear run A's pending cancel"
        );
        assert!(
            !tok_b.load(Ordering::Relaxed),
            "run B must begin uncancelled"
        );
    }

    #[test]
    fn stop_cancels_all_currently_active_runs() {
        let state = AppState::new();
        let (_a, tok_a) = state.register_pipeline_run();
        let (_b, tok_b) = state.register_pipeline_run();
        let signalled = state.cancel_all_pipeline_runs();
        assert_eq!(signalled, 2, "both in-flight runs must be signalled");
        assert!(tok_a.load(Ordering::Relaxed));
        assert!(tok_b.load(Ordering::Relaxed));
    }

    #[test]
    fn completing_a_run_removes_it_from_the_registry() {
        let state = AppState::new();
        let (id_a, tok_a) = state.register_pipeline_run();
        let (_id_b, tok_b) = state.register_pipeline_run();
        // Run A finishes and deregisters (mirrors PipelineRunGuard::drop).
        state.unregister_pipeline_run(id_a);
        let signalled = state.cancel_all_pipeline_runs();
        assert_eq!(signalled, 1, "a completed run must no longer be in the registry");
        assert!(
            !tok_a.load(Ordering::Relaxed),
            "the completed run's token must not be re-signalled"
        );
        assert!(tok_b.load(Ordering::Relaxed), "the still-active run is signalled");
    }

    #[test]
    fn pipeline_run_guard_deregisters_on_drop() {
        let state = AppState::new();
        let (run_id, _tok) = state.register_pipeline_run();
        {
            let _guard = PipelineRunGuard { state: &state, run_id };
            assert_eq!(
                state.cancel_all_pipeline_runs(),
                1,
                "run is registered while the guard is alive"
            );
        } // guard drops here → unregisters
        assert_eq!(
            state.cancel_all_pipeline_runs(),
            0,
            "dropping the guard must remove the run from the registry"
        );
    }

    #[test]
    fn pipeline_run_lock_is_per_session() {
        let state = AppState::new();
        let a1 = state.pipeline_run_lock("session-1").unwrap();
        let a2 = state.pipeline_run_lock("session-1").unwrap();
        let b = state.pipeline_run_lock("session-2").unwrap();
        assert!(
            Arc::ptr_eq(&a1, &a2),
            "the same session must share one run lock (so its runs serialize)"
        );
        assert!(
            !Arc::ptr_eq(&a1, &b),
            "different sessions must get distinct run locks (so they stay concurrent)"
        );
    }

    #[test]
    fn poisoned_run_lock_does_not_brick_subsequent_runs() {
        // A run that panics while holding the per-session run lock poisons it.
        // execute_pipeline acquires the lock with
        // `run_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())`;
        // this test exercises that exact recovery against the real Arc handed
        // out by `pipeline_run_lock`, proving a panicked run cannot brick every
        // later run on the (content-derived, cached) session id. execute_pipeline
        // itself needs a Tauri AppHandle + a populated session, so it is not
        // unit-testable directly — this asserts the mechanism it relies on.
        let state = AppState::new();
        let lock = state.pipeline_run_lock("sess-poison").unwrap();

        // Simulate a run that panics mid-execution while holding the run lock.
        let lock_for_panic = Arc::clone(&lock);
        let joined = std::thread::spawn(move || {
            let _held = lock_for_panic.lock().unwrap();
            panic!("run panicked while holding the run lock");
        })
        .join();
        assert!(joined.is_err(), "the spawned run must have panicked");
        assert!(lock.is_poisoned(), "the panic must have poisoned the run lock");

        // The next run fetches the SAME Arc (same session id) ...
        let next = state.pipeline_run_lock("sess-poison").unwrap();
        assert!(Arc::ptr_eq(&lock, &next), "same session reuses the cached run lock");

        // ... and must still acquire it via the poison-recovering path used by
        // execute_pipeline. Reaching the assertion proves the subsequent run
        // proceeds rather than erroring out forever.
        let _guard = next.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    }

    // ── Stale tracker/correlator results must not survive a rerun that ──────
    // ── deselects them (bug f220a66b) ────────────────────────────────────────
    //
    // `execute_pipeline` itself needs a Tauri `AppHandle` + a populated
    // session (see `poisoned_run_lock_does_not_brick_subsequent_runs` above),
    // so it can't be driven end-to-end in a unit test. This exercises the
    // extracted `store_tracker_and_correlator_results` helper directly — the
    // exact call `execute_pipeline` makes with `output.tracker_results` /
    // `output.correlator_results` from `PipelineCore::finish` — which is
    // where the bug lived and where the fix was applied.

    fn sample_tracker_result(tracker_id: &str) -> StateTrackerResult {
        StateTrackerResult {
            tracker_id: tracker_id.to_string(),
            transitions: vec![StateTransition {
                line_num: 1,
                timestamp: 0,
                transition_name: "on".to_string(),
                changes: HashMap::new(),
            }],
            final_state: HashMap::new(),
            source_sections: Vec::new(),
            mode: Default::default(),
        }
    }

    fn sample_correlator_result() -> CorrelatorResult {
        CorrelatorResult {
            guidance: None,
            events: vec![],
        }
    }

    #[test]
    fn rerun_with_no_trackers_or_correlators_clears_stale_session_entries() {
        let state = AppState::new();
        let session_id = "sess-stale-tracker";

        // First run: a tracker and a correlator were selected and produced
        // results — mirrors execute_pipeline storing a non-empty
        // `output.tracker_results` / `output.correlator_results`.
        let mut first_trackers = HashMap::new();
        first_trackers.insert("wifi-state".to_string(), sample_tracker_result("wifi-state"));
        let mut first_correlators = HashMap::new();
        first_correlators.insert("boot-corr".to_string(), sample_correlator_result());
        store_tracker_and_correlator_results(
            &state,
            session_id,
            first_trackers,
            first_correlators,
        );
        assert!(
            state.state_tracker_results.lock().unwrap().get(session_id).is_some(),
            "precondition: first run's tracker result must be stored"
        );
        assert!(
            state.correlator_results.lock().unwrap().get(session_id).is_some(),
            "precondition: first run's correlator result must be stored"
        );

        // Second run: the tracker and correlator were deselected, so
        // PipelineCore::finish produced empty maps this time (no tracker_runs
        // / correlator_runs entries — see pipeline_core.rs::finish). Before
        // the fix, execute_pipeline's `if !output.tracker_results.is_empty()`
        // guard skipped the insert entirely, leaving the first run's stale
        // "wifi-state" / "boot-corr" entries in place forever.
        store_tracker_and_correlator_results(&state, session_id, HashMap::new(), HashMap::new());

        let trackers_after = state.state_tracker_results.lock().unwrap();
        let session_trackers = trackers_after
            .get(session_id)
            .expect("session entry must still exist (as an empty map), not be stale");
        assert!(
            session_trackers.is_empty(),
            "deselected tracker's stale result must be cleared, found: {session_trackers:?}"
        );

        let correlators_after = state.correlator_results.lock().unwrap();
        let session_correlators = correlators_after
            .get(session_id)
            .expect("session entry must still exist (as an empty map), not be stale");
        assert!(
            session_correlators.is_empty(),
            "deselected correlator's stale result must be cleared"
        );
    }

    #[test]
    fn rerun_with_different_trackers_replaces_rather_than_merges() {
        // A rerun that swaps which tracker is selected must not leave the old
        // tracker's entry alongside the new one under the same session.
        let state = AppState::new();
        let session_id = "sess-swap-tracker";

        let mut first = HashMap::new();
        first.insert("tracker-a".to_string(), sample_tracker_result("tracker-a"));
        store_tracker_and_correlator_results(&state, session_id, first, HashMap::new());

        let mut second = HashMap::new();
        second.insert("tracker-b".to_string(), sample_tracker_result("tracker-b"));
        store_tracker_and_correlator_results(&state, session_id, second, HashMap::new());

        let results = state.state_tracker_results.lock().unwrap();
        let session_trackers = results.get(session_id).unwrap();
        assert!(
            !session_trackers.contains_key("tracker-a"),
            "the previous run's deselected tracker must not linger"
        );
        assert!(
            session_trackers.contains_key("tracker-b"),
            "the current run's tracker must be present"
        );
    }
}
