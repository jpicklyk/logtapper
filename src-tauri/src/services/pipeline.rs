//! `pipeline` service — running a processor chain and reading back its results.
//!
//! This is the single implementation both transports adapt to:
//! `commands::pipeline::run_pipeline` (UI, `Caller::Ui`, progress over Tauri
//! events) and `mcp_bridge::routes::pipeline::h_run_pipeline` (agent,
//! `Caller::Agent`). Before this module existed the bridge re-derived its own
//! processor list ("default to every installed processor") and the frontend
//! re-derived the per-session chain in `usePipelineCommands.ts`; both are now
//! [`resolve_effective_chain`], in one place, in Rust.
//!
//! ## Lock discipline
//!
//! `pipeline_run_locks` is the outermost `AppState` lock — taken before any
//! other, held for the whole run — so two runs on one session can never
//! interleave their writes to `pipeline_results` / `state_tracker_results` /
//! `correlator_results`. Everything else here acquires one lock at a time and
//! drops it before taking the next.
//!
//! ## Blocking
//!
//! The run is CPU-heavy (rayon) and owns its own `spawn_blocking`: [`ServiceCtx`]
//! is `Clone + Send + 'static`, so the closure gets a real context rather than
//! the "clone the `AppHandle`, re-resolve the state inside" dance both callers
//! used to perform. No `MutexGuard` crosses into the closure and nothing inside
//! it `.await`s.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use rayon::prelude::*;
use serde::Serialize;
use serde_json::{json, Value};
use ts_rs::TS;

use crate::commands::pipeline::{
    source_type_filter_skip, source_type_skip, PipelineRunSummary,
};
use crate::commands::pipeline_core::{
    excluded_by_declared_source_types, PartitionedDefs, PipelineCore,
};
use crate::commands::processors::MatchedLineInfo;
use crate::commands::AppState;
use crate::core::line::PipelineContext;
use crate::core::log_source::{decode_line_bytes, Encoding, FileLogSource, ZipLogSource};
use crate::core::session::parser_for;
use crate::processors::correlator::engine::CorrelatorResult;
use crate::processors::marketplace::resolve_processor_id_checked;
use crate::processors::state_tracker::types::{StateTrackerResult, StateTransition};
use crate::processors::ProcessorKind;
use crate::services::events::{EventSink, PipelineProgressEvent, ProgressEvent, ProgressSink};
use crate::services::wire::PipelineRunResult;
use crate::services::{chain, lock_svc, policy, Caller, ServiceCtx, ServiceError};

/// The built-in PII transformer. Force-included in the effective chain whenever
/// the caller's redaction gate is on, and exempt from source-type exclusion —
/// a skipped anonymizer means unredacted PII reaching exports and the bridge.
pub const PII_ANONYMIZER_ID: &str = "__pii_anonymizer";

/// Error code for "this processor kind has no detail view". Distinct from the
/// generic `INVALID_ARGUMENT` only so the bridge can reproduce today's error
/// body byte-for-byte (that one branch omits `sessionId`).
pub const UNSUPPORTED_PROCESSOR_TYPE: &str = "UNSUPPORTED_PROCESSOR_TYPE";

/// Max characters of raw line text returned alongside a pipeline result. Matches
/// the bridge's historical `anonymize_line_texts` cap.
const RESULT_LINE_CHARS: usize = 500;

const CHUNK_SIZE: usize = 50_000;

/// Event name for [`PipelineCompleteEvent`].
pub const PIPELINE_COMPLETE_EVENT: &str = "pipeline-complete";

/// Broadcast once per [`run`], after the blocking body returns and before the
/// result is handed back to the caller — on success **and** on failure — so a
/// UI store can land the results of a run it did not start (an agent's) or
/// clear its progress bar when that run failed. Exactly one of `result` /
/// `error` is `Some`. A run cancelled while queued or mid-run arrives as
/// `result: Some` with empty `summaries` (`run_blocking` returns `Ok` for a
/// cancel, so the two are not distinguishable here without changing it).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PipelineCompleteEvent {
    pub session_id: String,
    pub caller: Caller,
    pub result: Option<PipelineRunResult>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Progress plumbing
// ---------------------------------------------------------------------------

/// A [`ProgressSink`] that forwards onto a broadcast [`EventSink`].
///
/// Used by the MCP bridge adapter: an agent-triggered run still lights up the
/// desktop UI's progress bar, exactly as it did when the bridge borrowed the
/// `AppHandle` and called `app.emit` itself. The payload is
/// [`ProgressEvent::payload`], which is `serde_json::to_value` of the same
/// struct `TauriProgressSink` emits — identical on the wire.
pub struct EventSinkProgress {
    events: Arc<dyn EventSink>,
}

impl EventSinkProgress {
    pub fn new(events: Arc<dyn EventSink>) -> Self {
        Self { events }
    }
}

impl ProgressSink for EventSinkProgress {
    fn on_progress(&self, ev: &ProgressEvent) {
        self.events.emit_json(ev.event_name(), ev.payload());
    }
}

// ---------------------------------------------------------------------------
// Effective chain
// ---------------------------------------------------------------------------

/// Decide which processors a run will actually execute.
///
/// Two callers, two shapes:
///
/// - `requested = Some(non-empty)` — an explicit list (the UI's own chain, or an
///   agent naming processors). Each id is resolved bare → qualified via
///   [`resolve_processor_id_checked`]; an unknown or ambiguous id is an
///   [`ServiceError::InvalidArg`] rather than a silently dropped processor.
/// - `requested = None` (or empty) — the session's own chain from
///   `AppState::session_pipeline_meta`: `active − disabled`, filtered to
///   installed processors or ids carrying an `@lts-` namespace (a workspace-local
///   processor that has not been installed globally), **order preserved**. This
///   is `usePipelineCommands.ts`'s `run()` moved into Rust; the frontend's copy
///   and the bridge's old "default to every installed processor" fallback both
///   go away.
///
/// [`PII_ANONYMIZER_ID`] is appended whenever [`policy::should_anonymize`] says
/// this caller must be redacted and it is not already present. An empty result
/// is an error, never a silent no-op or a run of everything.
pub fn resolve_effective_chain(
    ctx: &ServiceCtx,
    session_id: &str,
    requested: Option<&[String]>,
) -> Result<Vec<String>, ServiceError> {
    let mut chain: Vec<String> = match requested {
        Some(ids) if !ids.is_empty() => {
            let procs = lock_svc(&ctx.state().processors, "processors")?;
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                match resolve_processor_id_checked(&procs, id) {
                    Ok(Some(qualified)) => out.push(qualified),
                    Ok(None) => {
                        return Err(ServiceError::invalid_arg(format!(
                            "Cannot run pipeline: processor '{id}' is not installed"
                        )))
                    }
                    Err(e) => {
                        return Err(ServiceError::invalid_arg(format!(
                            "Cannot run pipeline: {e}"
                        )))
                    }
                }
            }
            out
        }
        _ => {
            // Clone the meta out and drop the lock before taking `processors` —
            // one AppState lock at a time.
            let meta = lock_svc(&ctx.state().session_pipeline_meta, "session_pipeline_meta")?
                .get(session_id)
                .cloned();
            let Some(meta) = meta else {
                return Err(no_chain(session_id));
            };
            let disabled: HashSet<&str> = meta
                .disabled_processor_ids
                .iter()
                .map(String::as_str)
                .collect();
            let procs = lock_svc(&ctx.state().processors, "processors")?;
            meta.active_processor_ids
                .iter()
                .filter(|id| !disabled.contains(id.as_str()))
                .filter(|id| procs.contains_key(id.as_str()) || id.contains("@lts-"))
                .cloned()
                .collect()
        }
    };

    if policy::should_anonymize(ctx, session_id)
        && !chain.iter().any(|id| id == PII_ANONYMIZER_ID)
    {
        chain.push(PII_ANONYMIZER_ID.to_string());
    }

    if chain.is_empty() {
        return Err(no_chain(session_id));
    }
    Ok(chain)
}

fn no_chain(session_id: &str) -> ServiceError {
    ServiceError::invalid_arg(format!(
        "no pipeline chain configured for session {session_id}"
    ))
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
                if line_index.is_empty() {
                    0
                } else {
                    line_index.len() - 1
                }
            }
            SourceSnapshot::Stream { raw_lines, .. } => raw_lines.len(),
            SourceSnapshot::Zip { line_index, .. } => {
                if line_index.len() > 1 {
                    line_index.len() - 1
                } else {
                    0
                }
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
            SourceSnapshot::File {
                mmap,
                line_index,
                encoding,
            } => {
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
            SourceSnapshot::Stream {
                raw_lines,
                evicted_offset,
            } => {
                // `n` is absolute (mirrors StreamLogSource::raw_line). Lines
                // before the snapshot's evicted offset were never cloned in —
                // they were spilled to disk and are out of scope for this run.
                let local = n.checked_sub(*evicted_offset)?;
                raw_lines
                    .get(local)
                    .map(|s| std::borrow::Cow::Borrowed(s.as_str()))
            }
            SourceSnapshot::Zip {
                data,
                line_index,
                encoding,
            } => {
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
// run
// ---------------------------------------------------------------------------

/// RAII guard that removes a run's cancellation token from the registry when
/// the run returns — on the happy path or any `?` early return — so the
/// `pipeline_cancels` map never accumulates stale tokens.
struct PipelineRunGuard<'a> {
    state: &'a AppState,
    run_id: u64,
}

impl Drop for PipelineRunGuard<'_> {
    fn drop(&mut self) {
        self.state.unregister_pipeline_run(self.run_id);
    }
}

/// Run a processor chain over one session.
///
/// Owns its own `spawn_blocking`: the caller just `.await`s. `progress` is where
/// per-chunk progress goes — `TauriProgressSink` from the command adapter,
/// [`EventSinkProgress`] from the bridge adapter, `NullProgressSink` in tests.
///
/// Emits [`PipelineCompleteEvent`] once the blocking body returns — on
/// success and on failure alike — then journals `pipeline.run` on completion
/// (not on start), so the activity feed records runs that finished rather
/// than runs that were attempted. An explicit `requested` list is also merged
/// into the session's chain via `services::chain::patch` before the run
/// starts (see `run_blocking`).
pub async fn run(
    ctx: ServiceCtx,
    session_id: String,
    requested: Option<Vec<String>>,
    progress: Arc<dyn ProgressSink>,
) -> Result<PipelineRunResult, ServiceError> {
    let task_ctx = ctx.clone();
    let task_session = session_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        run_blocking(&task_ctx, &task_session, requested.as_deref(), &*progress)
    })
    .await
    .map_err(|e| ServiceError::Internal(format!("Pipeline task panicked: {e}")))
    .and_then(|r| r);

    // Announce the outcome before the caller sees it, either way — a listener
    // that is not the caller (the UI watching an agent's run) has no other way
    // to learn the run finished.
    let (result, error) = match &outcome {
        Ok(result) => (Some(result.clone()), None),
        Err(e) => (None, Some(e.message())),
    };
    ctx.events().emit_json(
        PIPELINE_COMPLETE_EVENT,
        serde_json::to_value(PipelineCompleteEvent {
            session_id: session_id.clone(),
            caller: ctx.caller().clone(),
            result,
            error,
        })
        .unwrap_or_default(),
    );
    let result = outcome?;

    ctx.journal(
        "pipeline.run",
        Some(&session_id),
        format!("{} processors", result.effective_processor_ids.len()),
    );
    Ok(result)
}

/// The synchronous body of [`run`]. Holds no lock across an `.await` because it
/// contains none; every lock is acquired and released inside.
fn run_blocking(
    ctx: &ServiceCtx,
    session_id: &str,
    requested: Option<&[String]>,
    progress: &dyn ProgressSink,
) -> Result<PipelineRunResult, ServiceError> {
    let state = ctx.state();

    // ── Serialize runs on the same session ───────────────────────────────────
    // Two runs on one session (e.g. the UI and the MCP bridge racing) must not
    // interleave their writes to pipeline_results / state_tracker_results /
    // correlator_results — that leaves stored state mixing one run's trackers
    // with another's reporters. Holding the per-session run lock for the whole
    // run makes each run's three-map write sequence atomic w.r.t. other runs.
    // This lock is the outermost AppState lock (taken before any other), so it
    // introduces no ordering cycle. This function is synchronous and holds no
    // lock across an await; `run` wraps it in spawn_blocking, so parking a
    // blocking-pool thread here does not stall the async runtime.
    let run_lock = state
        .pipeline_run_lock(session_id)
        .map_err(|_| ServiceError::LockPoisoned("pipeline_run_locks"))?;

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
    let _run_guard = run_lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    // ── Resolve the effective chain ──────────────────────────────────────────
    // Inside the run lock, matching the old code's ordering (processor
    // resolution happened after the run lock was taken). Each AppState lock it
    // needs is acquired and released in turn, never nested.
    let processor_ids = resolve_effective_chain(ctx, session_id, requested)?;

    // ── Merge an explicit list into the session's chain ──────────────────────
    // An explicit `processor_ids` (an agent naming processors, or the UI's
    // override path) becomes part of the chain the user sees and the next
    // chain-only run executes — silently running something the chain never
    // learns about is exactly the invisibility this closes. `chain::patch`
    // emits `chain-update` (before the first `pipeline-progress` below) and
    // journals when membership changed; ids are already resolved, so its
    // strict resolution cannot fail on them, and it strips the anonymizer
    // `resolve_effective_chain` may have force-added. Deliberately ahead of
    // the queued-cancel check: a run cancelled while still queued has still
    // expressed which processors the caller wanted in the chain.
    if requested.is_some_and(|r| !r.is_empty()) {
        chain::patch(ctx, session_id, processor_ids.clone(), Vec::new())?;
    }

    // If a stop arrived while we were queued behind another run, honor it now
    // rather than running a full pass. Returning empty leaves any results
    // already stored for this session untouched (a cancelled run is not a
    // failure — mirrors the mid-run cancel path, which also returns Ok).
    if cancel.load(Ordering::Relaxed) {
        return Ok(PipelineRunResult {
            session_id: session_id.to_string(),
            effective_processor_ids: processor_ids,
            summaries: Vec::new(),
        });
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
    let mut declared_source_types: HashMap<String, Vec<String>> = HashMap::new();
    {
        let procs = lock_svc(&state.processors, "processors")?;
        // Ids are already resolved bare → qualified by resolve_effective_chain.
        // A chain entry that is not installed (an `@lts-` workspace processor,
        // say) is skipped here exactly as before.
        for id in &processor_ids {
            if let Some(p) = procs.get(id.as_str()) {
                if let Some(schema) = p.schema.as_ref() {
                    if !schema.source_types.is_empty() {
                        declared_source_types.insert(id.clone(), schema.source_types.clone());
                    }
                }
                match &p.kind {
                    ProcessorKind::Transformer(d) => {
                        defs.transformer_defs.push((id.clone(), Arc::clone(d)));
                    }
                    ProcessorKind::Reporter(d) => {
                        defs.reporter_defs.push((id.clone(), Arc::clone(d)));
                    }
                    ProcessorKind::StateTracker(d) => {
                        defs.tracker_defs.push((id.clone(), Arc::clone(d)));
                    }
                    ProcessorKind::Correlator(d) => {
                        defs.correlator_defs.push((id.clone(), Arc::clone(d)));
                    }
                }
            }
        }
    }

    // ── Snapshot source data ─────────────────────────────────────────────────
    let (source_snapshot, source_id, source_type, src_sections) = {
        let sessions = lock_svc(&state.sessions, "sessions")?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| ServiceError::session_not_found(session_id))?;
        let src = session
            .primary_source()
            .ok_or_else(|| ServiceError::NotFound("No sources in session".to_string()))?;

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
            let stream_src = session.stream_source().ok_or_else(|| {
                ServiceError::Internal("Source is neither File nor Stream".to_string())
            })?;
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
        let declared =
            |id: &str| -> Vec<String> { declared_source_types.get(id).cloned().unwrap_or_default() };
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
        //
        // The one carve-out is the built-in PII anonymizer: a skipped anonymizer
        // means unredacted PII reaching exports and the MCP bridge, which is a
        // security failure, not a wasted pass. It ships with no declared
        // `source_types` today so the check would pass anyway — the explicit
        // guard is here so that stays true if someone ever adds one.
        defs.transformer_defs.retain(|(id, _)| {
            if id == PII_ANONYMIZER_ID {
                return true;
            }
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
    let excluded_reporter_ids: HashSet<&str> = embedded_exclusions
        .reporter_ids
        .iter()
        .map(|(id, _)| id.as_str())
        .collect();
    let excluded_tracker_ids: HashSet<&str> = embedded_exclusions
        .tracker_ids
        .iter()
        .map(|(id, _)| id.as_str())
        .collect();
    let excluded_correlator_ids: HashSet<&str> = embedded_exclusions
        .correlator_ids
        .iter()
        .map(|(id, _)| id.as_str())
        .collect();
    defs.reporter_defs
        .retain(|(id, _)| !excluded_reporter_ids.contains(id.as_str()));
    defs.tracker_defs
        .retain(|(id, _)| !excluded_tracker_ids.contains(id.as_str()));
    defs.correlator_defs
        .retain(|(id, _)| !excluded_correlator_ids.contains(id.as_str()));
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
    let anonymizer_config = lock_svc(&state.anonymizer_config, "anonymizer_config")?.clone();

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
        for proc_id in &processor_ids {
            progress.on_progress(&ProgressEvent::Pipeline(PipelineProgressEvent {
                session_id: session_id.to_string(),
                processor_id: proc_id.clone(),
                lines_processed,
                total_lines,
                percent: lines_processed as f32 / total_lines.max(1) as f32 * 100.0,
            }));
        }
    }

    // ── Collect PII forward mappings ─────────────────────────────────────────
    let forward_pii = core.collect_pii_mappings();
    if !forward_pii.is_empty() {
        let inverted: HashMap<String, String> = forward_pii
            .iter()
            .map(|(raw, tok)| (tok.clone(), raw.clone()))
            .collect();
        if let Ok(mut pm) = state.pii_mappings.lock() {
            pm.insert(session_id.to_string(), inverted);
        }
    }

    // ── Finalize all results ─────────────────────────────────────────────────
    let output = core.finish(&forward_pii);

    // ── Collect summaries ────────────────────────────────────────────────────
    // Order preserved: reporter, state tracker, transformer, correlator.
    // Tracker/correlator summary counts are read from `output` via borrowed
    // `.get()` lookups (in the same `defs.tracker_defs` / `defs.correlator_defs`
    // order the old re-lock-and-read code used) BEFORE `output.tracker_results`
    // / `output.correlator_results` are moved (not cloned) into
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
    // and MCP bridge.
    store_tracker_and_correlator_results(
        state,
        session_id,
        output.tracker_results,
        output.correlator_results,
    );

    {
        let mut pr = lock_svc(&state.pipeline_results, "pipeline_results")?;
        pr.insert(session_id.to_string(), session_pipeline_results);
    }

    // Processors excluded by their declared source_types never executed, so they
    // produced no results to collect above. Append their skip rows so they stay
    // visible in the run rather than silently disappearing from it.
    summaries.extend(skipped);

    Ok(PipelineRunResult {
        session_id: session_id.to_string(),
        effective_processor_ids: processor_ids,
        summaries,
    })
}

/// Overwrite this session's `state_tracker_results` / `correlator_results`
/// entries with the current run's output, unconditionally — including with
/// an empty map when this run had no trackers/correlators. Without this, a
/// rerun that deselects every tracker or correlator (or whose source-type
/// exclusion drops them all) leaves the previous run's stale results in
/// place forever, since `close_session` / `stop_adb_stream` are otherwise the
/// only code that removes entries from these maps. Mirrors the unconditional
/// `pipeline_results` overwrite in [`run_blocking`].
pub(crate) fn store_tracker_and_correlator_results(
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
// Read side — typed aggregates the transports render
// ---------------------------------------------------------------------------

/// One matched line, with its text when the caller asked for it (and the
/// session could resolve it). `None` means "not requested / not resolvable" —
/// distinct from `Some(String::new())`.
#[derive(Debug, Clone, PartialEq)]
pub struct MatchedLine {
    pub line_num: usize,
    pub raw: Option<String>,
}

/// A state transition plus the (redacted) text of the line that produced it.
#[derive(Debug, Clone)]
pub struct TransitionRow {
    pub transition: StateTransition,
    pub raw: Option<String>,
}

/// One serialized emission plus the (redacted) text of its line.
#[derive(Debug, Clone)]
pub struct EmissionRow {
    pub value: Value,
    pub raw: Option<String>,
}

/// Aggregated results for one reporter in a session.
#[derive(Debug, Clone)]
pub struct ReporterResults {
    pub processor_id: String,
    pub name: String,
    pub description: String,
    pub matched_line_count: usize,
    /// First 5 matched lines, with text.
    pub sample_matched_lines: Vec<MatchedLine>,
    pub emission_count: usize,
    /// Last 10 emissions, newest first.
    pub recent_emissions: Vec<Value>,
    pub vars: HashMap<String, Value>,
}

/// Aggregated results for one state tracker in a session. Merges the
/// pipeline-run result with the live ADB-stream state, pipeline winning.
#[derive(Debug, Clone)]
pub struct TrackerResults {
    pub processor_id: String,
    pub name: String,
    pub description: String,
    pub transition_count: usize,
    pub final_state: Value,
    /// Last 20 transitions, newest first.
    pub recent_transitions: Vec<TransitionRow>,
}

/// Everything a session's pipeline produced, aggregated across processors.
#[derive(Debug, Clone)]
pub struct PipelineResults {
    pub session_id: String,
    pub reporters: Vec<ReporterResults>,
    pub state_trackers: Vec<TrackerResults>,
}

impl PipelineResults {
    pub fn has_results(&self) -> bool {
        !self.reporters.is_empty() || !self.state_trackers.is_empty()
    }
}

/// Pagination + inclusion knobs for [`processor_detail`].
#[derive(Debug, Clone, Copy)]
pub struct DetailPage {
    pub offset: usize,
    pub limit: usize,
    /// Reporters only: whether to materialize the emission page at all.
    pub include_emissions: bool,
}

/// Per-processor detail. The variant follows the processor's kind.
#[derive(Debug, Clone)]
pub enum ProcessorDetail {
    Reporter(ReporterDetail),
    StateTracker(TrackerDetail),
}

#[derive(Debug, Clone)]
pub struct ReporterDetail {
    /// The bare→qualified resolved id the results were read under.
    pub resolved_id: String,
    pub name: String,
    pub description: String,
    pub matched_line_count: usize,
    pub emission_count: usize,
    pub vars: HashMap<String, Value>,
    /// First 100 matched lines.
    pub matched_lines: Vec<MatchedLine>,
    /// `None` when emissions were not requested.
    pub emissions: Option<Vec<EmissionRow>>,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Clone)]
pub struct TrackerDetail {
    pub resolved_id: String,
    pub name: String,
    pub description: String,
    pub transition_count: usize,
    pub final_state: Value,
    pub transitions: Vec<TransitionRow>,
    pub offset: usize,
    pub limit: usize,
}

/// Aggregate a session's reporter and state-tracker results.
///
/// `processor_id` filters to one processor, matching either its qualified id or
/// its bare half. Line text goes through [`policy::redact_line`], so an agent
/// caller gets the session's redaction gate applied and a UI caller does not.
pub fn results(
    ctx: &ServiceCtx,
    session_id: &str,
    processor_id: Option<&str>,
) -> Result<PipelineResults, ServiceError> {
    let state = ctx.state();

    // ── Reporters: clone out of `pipeline_results`, then name them ───────────
    struct RawReporter {
        processor_id: String,
        matched_line_count: usize,
        sample_line_nums: Vec<usize>,
        emission_count: usize,
        recent_emissions: Vec<Value>,
        vars: HashMap<String, Value>,
    }

    let raw_reporters: Vec<RawReporter> = {
        let results = lock_svc(&state.pipeline_results, "pipeline_results")?;
        match results.get(session_id) {
            None => Vec::new(),
            Some(session_map) => session_map
                .iter()
                .filter(|(pid, _)| processor_id_matches(pid, processor_id))
                .map(|(pid, run_result)| RawReporter {
                    processor_id: pid.clone(),
                    matched_line_count: run_result.matched_line_nums.len(),
                    sample_line_nums: run_result
                        .matched_line_nums
                        .iter()
                        .take(5)
                        .copied()
                        .collect(),
                    emission_count: run_result.emissions.len(),
                    recent_emissions: run_result
                        .emissions
                        .iter()
                        .rev()
                        .take(10)
                        .map(|e| serde_json::to_value(e).unwrap_or(json!(null)))
                        .collect(),
                    vars: run_result.vars.clone(),
                })
                .collect(),
        }
    };

    // ── Trackers: pipeline results first, then live stream state ─────────────
    struct RawTracker {
        processor_id: String,
        transition_count: usize,
        final_state: Value,
        recent_transitions: Vec<StateTransition>,
    }

    let from_pipeline: Option<HashMap<String, (Vec<StateTransition>, Value)>> = {
        let pipeline_res = lock_svc(&state.state_tracker_results, "state_tracker_results")?;
        pipeline_res.get(session_id).map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), (v.transitions.clone(), json!(v.final_state))))
                .collect()
        })
    };
    let from_stream: Option<HashMap<String, (Vec<StateTransition>, Value)>> = {
        let stream_res = lock_svc(&state.stream_tracker_state, "stream_tracker_state")?;
        stream_res.get(session_id).map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), (v.transitions.clone(), json!(v.current_state))))
                .collect()
        })
    };

    let raw_trackers: Vec<RawTracker> = if from_pipeline.is_none() && from_stream.is_none() {
        Vec::new()
    } else {
        let mut tracker_ids: Vec<String> = from_pipeline
            .as_ref()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        if let Some(sm) = from_stream.as_ref() {
            for id in sm.keys() {
                if !tracker_ids.contains(id) {
                    tracker_ids.push(id.clone());
                }
            }
        }
        tracker_ids
            .into_iter()
            .filter(|tid| processor_id_matches(tid, processor_id))
            .map(|tracker_id| {
                let entry = from_pipeline
                    .as_ref()
                    .and_then(|m| m.get(&tracker_id))
                    .or_else(|| from_stream.as_ref().and_then(|m| m.get(&tracker_id)));
                let (transitions, final_state) = match entry {
                    Some((t, s)) => (t.as_slice(), s.clone()),
                    None => (&[][..], json!({})),
                };
                RawTracker {
                    processor_id: tracker_id,
                    transition_count: transitions.len(),
                    final_state,
                    recent_transitions: transitions.iter().rev().take(20).cloned().collect(),
                }
            })
            .collect()
    };

    // ── Resolve + redact the line text every row references ──────────────────
    let mut needed: Vec<usize> = Vec::new();
    for r in &raw_reporters {
        needed.extend(&r.sample_line_nums);
    }
    for t in &raw_trackers {
        for tr in &t.recent_transitions {
            needed.push(tr.line_num);
        }
    }
    let line_text = redacted_line_texts(ctx, session_id, &needed)?;

    // ── Names come from the processor registry (its own lock scope) ──────────
    let names = processor_names(
        state,
        raw_reporters
            .iter()
            .map(|r| r.processor_id.as_str())
            .chain(raw_trackers.iter().map(|t| t.processor_id.as_str())),
    )?;

    let reporters = raw_reporters
        .into_iter()
        .map(|r| {
            let (name, description) = names
                .get(&r.processor_id)
                .cloned()
                .unwrap_or_else(|| (r.processor_id.clone(), String::new()));
            ReporterResults {
                sample_matched_lines: r
                    .sample_line_nums
                    .iter()
                    .map(|&ln| MatchedLine {
                        line_num: ln,
                        raw: Some(line_text.get(&ln).cloned().unwrap_or_default()),
                    })
                    .collect(),
                processor_id: r.processor_id,
                name,
                description,
                matched_line_count: r.matched_line_count,
                emission_count: r.emission_count,
                recent_emissions: r.recent_emissions,
                vars: r.vars,
            }
        })
        .collect();

    let state_trackers = raw_trackers
        .into_iter()
        .map(|t| {
            let (name, description) = names
                .get(&t.processor_id)
                .cloned()
                .unwrap_or_else(|| (t.processor_id.clone(), String::new()));
            TrackerResults {
                recent_transitions: t
                    .recent_transitions
                    .into_iter()
                    .map(|tr| TransitionRow {
                        raw: Some(line_text.get(&tr.line_num).cloned().unwrap_or_default()),
                        transition: tr,
                    })
                    .collect(),
                processor_id: t.processor_id,
                name,
                description,
                transition_count: t.transition_count,
                final_state: t.final_state,
            }
        })
        .collect();

    Ok(PipelineResults {
        session_id: session_id.to_string(),
        reporters,
        state_trackers,
    })
}

/// Detail for one processor in one session.
///
/// `processor_id` may be bare or qualified. An unknown processor with stored
/// reporter results still resolves (the results are the authority, not the
/// registry) — that is why the `None` processor-type branch falls through to
/// the reporter lookup.
pub fn processor_detail(
    ctx: &ServiceCtx,
    session_id: &str,
    processor_id: &str,
    page: DetailPage,
    include_line_text: bool,
) -> Result<ProcessorDetail, ServiceError> {
    let state = ctx.state();

    let (resolved_id, processor_type, name, description) = {
        let procs = lock_svc(&state.processors, "processors")?;
        let resolved = resolve_processor_id_checked(&procs, processor_id)
            .map_err(ServiceError::invalid_arg)?
            .unwrap_or_else(|| processor_id.to_string());
        let proc = procs.get(&resolved);
        let ptype = proc.map(|p| p.processor_type().to_string());
        let name = proc.map_or_else(|| resolved.clone(), |p| p.meta.name.clone());
        let desc = proc.map(|p| p.meta.description.clone()).unwrap_or_default();
        (resolved, ptype, name, desc)
    };

    match processor_type.as_deref() {
        Some("reporter") | None => {
            let found = {
                let results = lock_svc(&state.pipeline_results, "pipeline_results")?;
                results
                    .get(session_id)
                    .and_then(|m| m.get(&resolved_id))
                    .map(|rr| {
                        (
                            rr.matched_line_nums.iter().take(100).copied().collect::<Vec<_>>(),
                            rr.matched_line_nums.len(),
                            rr.emissions.len(),
                            rr.vars.clone(),
                            if page.include_emissions {
                                rr.emissions
                                    .iter()
                                    .skip(page.offset)
                                    .take(page.limit)
                                    .map(|e| {
                                        (e.line_num, serde_json::to_value(e).unwrap_or(json!(null)))
                                    })
                                    .collect::<Vec<_>>()
                            } else {
                                Vec::new()
                            },
                        )
                    })
            };
            let Some((matched_nums, matched_line_count, emission_count, vars, emission_page)) =
                found
            else {
                return Err(ServiceError::NotFound(
                    "no results for this processor/session".to_string(),
                ));
            };

            let line_text = if include_line_text {
                let mut needed = matched_nums.clone();
                needed.extend(emission_page.iter().map(|(ln, _)| *ln));
                redacted_line_texts(ctx, session_id, &needed)?
            } else {
                HashMap::new()
            };

            Ok(ProcessorDetail::Reporter(ReporterDetail {
                resolved_id,
                name,
                description,
                matched_line_count,
                emission_count,
                vars,
                matched_lines: matched_nums
                    .into_iter()
                    .map(|ln| MatchedLine {
                        line_num: ln,
                        raw: line_text.get(&ln).cloned(),
                    })
                    .collect(),
                emissions: page.include_emissions.then(|| {
                    emission_page
                        .into_iter()
                        .map(|(ln, value)| EmissionRow {
                            value,
                            raw: line_text.get(&ln).cloned(),
                        })
                        .collect()
                }),
                offset: page.offset,
                limit: page.limit,
            }))
        }
        Some("state_tracker") => {
            let from_pipeline = {
                let pipeline_res = lock_svc(&state.state_tracker_results, "state_tracker_results")?;
                pipeline_res
                    .get(session_id)
                    .and_then(|m| m.get(&resolved_id))
                    .map(|pr| (pr.transitions.clone(), json!(pr.final_state)))
            };
            let found = match from_pipeline {
                Some(v) => Some(v),
                None => {
                    let stream_res = lock_svc(&state.stream_tracker_state, "stream_tracker_state")?;
                    stream_res
                        .get(session_id)
                        .and_then(|m| m.get(&resolved_id))
                        .map(|sr| (sr.transitions.clone(), json!(sr.current_state)))
                }
            };
            let Some((transitions, final_state)) = found else {
                return Err(ServiceError::NotFound(
                    "no tracker results for this processor/session".to_string(),
                ));
            };

            let window: Vec<StateTransition> = transitions
                .iter()
                .skip(page.offset)
                .take(page.limit)
                .cloned()
                .collect();

            let line_text = if include_line_text {
                let needed: Vec<usize> = window.iter().map(|t| t.line_num).collect();
                redacted_line_texts(ctx, session_id, &needed)?
            } else {
                HashMap::new()
            };

            Ok(ProcessorDetail::StateTracker(TrackerDetail {
                resolved_id,
                name,
                description,
                transition_count: transitions.len(),
                final_state,
                transitions: window
                    .into_iter()
                    .map(|t| TransitionRow {
                        raw: line_text.get(&t.line_num).cloned(),
                        transition: t,
                    })
                    .collect(),
                offset: page.offset,
                limit: page.limit,
            }))
        }
        Some(other) => Err(ServiceError::InvalidArg {
            code: UNSUPPORTED_PROCESSOR_TYPE,
            message: format!("processor type '{other}' detail not supported"),
        }),
    }
}

/// Accumulated variables for one reporter in one session. Backs the
/// `get_processor_vars` command.
pub fn processor_vars(
    ctx: &ServiceCtx,
    session_id: &str,
    processor_id: &str,
) -> Result<HashMap<String, Value>, ServiceError> {
    let pr = lock_svc(&ctx.state().pipeline_results, "pipeline_results")?;
    let session_results = pr.get(session_id).ok_or_else(|| {
        ServiceError::NotFound(format!("No pipeline results for session '{session_id}'"))
    })?;
    let result = session_results
        .get(processor_id)
        .ok_or_else(|| ServiceError::NotFound(format!("No result for processor '{processor_id}'")))?;
    Ok(result.vars.clone())
}

/// Every line one processor touched, with its text. Backs the
/// `get_matched_lines` command.
///
/// Falls back through the three result kinds in order — reporter matched lines,
/// state-tracker transition lines, correlator trigger lines — because a caller
/// only knows a processor id, not which of the three maps holds its output.
pub fn matched_lines(
    ctx: &ServiceCtx,
    session_id: &str,
    processor_id: &str,
) -> Result<Vec<MatchedLineInfo>, ServiceError> {
    let state = ctx.state();

    // 1. Reporter pipeline results
    let mut line_nums: Vec<usize> = {
        let pr = lock_svc(&state.pipeline_results, "pipeline_results")?;
        pr.get(session_id)
            .and_then(|s| s.get(processor_id))
            .map(|r| r.matched_line_nums.clone())
    }
    .or_else(|| {
        // 2. State tracker transition lines
        state
            .state_tracker_results
            .lock()
            .ok()
            .and_then(|m| {
                m.get(session_id)
                    .and_then(|s| s.get(processor_id))
                    .map(|r| r.transitions.iter().map(|t| t.line_num).collect::<Vec<_>>())
            })
    })
    .or_else(|| {
        // 3. Correlator event trigger lines
        state.correlator_results.lock().ok().and_then(|m| {
            m.get(session_id)
                .and_then(|s| s.get(processor_id))
                .map(|r| {
                    r.events
                        .iter()
                        .map(|e| e.trigger_line_num)
                        .collect::<Vec<_>>()
                })
        })
    })
    .unwrap_or_default();
    line_nums.sort_unstable();

    // Raw text under the sessions lock, redaction after it is dropped (see
    // `policy::anonymize_for_session` on why that order is load-bearing).
    let raw: Vec<(usize, String)> = {
        let sessions = lock_svc(&state.sessions, "sessions")?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| ServiceError::session_not_found(session_id))?;
        let src = session
            .primary_source()
            .ok_or_else(|| ServiceError::NotFound("No sources in session".to_string()))?;
        line_nums
            .iter()
            .map(|&n| {
                (
                    n,
                    src.raw_line(n)
                        .as_deref()
                        .unwrap_or("")
                        .trim_end_matches(['\r', '\n'])
                        .to_string(),
                )
            })
            .collect()
    };

    Ok(raw
        .into_iter()
        .map(|(line_num, text)| MatchedLineInfo {
            line_num,
            // No character cap here: this backs the UI's matched-line list,
            // which renders whole lines. `redact_line` still applies the
            // caller's anonymization gate.
            raw: policy::redact_line(ctx, session_id, &text, usize::MAX),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Read-side helpers
// ---------------------------------------------------------------------------

/// Whether a qualified (or bare) processor id matches an optional filter.
/// `None` matches everything; a filter matches the full id or its bare half.
///
/// Spelled as a `match` rather than `Option::is_none_or` — that method landed in
/// Rust 1.82 and this crate's MSRV is 1.78.
fn processor_id_matches(candidate: &str, filter: Option<&str>) -> bool {
    match filter {
        None => true,
        Some(f) => {
            f == candidate
                || crate::processors::marketplace::split_qualified_id(candidate).0 == f
        }
    }
}

/// Look up display name + description for a set of processor ids in one
/// `processors` lock scope. Ids with no registry entry are simply absent from
/// the map; callers fall back to the id itself.
fn processor_names<'a>(
    state: &AppState,
    ids: impl Iterator<Item = &'a str>,
) -> Result<HashMap<String, (String, String)>, ServiceError> {
    let procs = lock_svc(&state.processors, "processors")?;
    let mut out = HashMap::new();
    for id in ids {
        if out.contains_key(id) {
            continue;
        }
        if let Some(p) = procs.get(id) {
            out.insert(
                id.to_string(),
                (p.meta.name.clone(), p.meta.description.clone()),
            );
        }
    }
    Ok(out)
}

/// Resolve `line_nums` to redacted text, one line per entry that exists.
///
/// Raw text is collected under the `sessions` lock and the lock is dropped
/// before [`policy::redact_line`] runs — `redact_line` takes
/// `agent_raw_access` / `anonymizer_config` / `mcp_anonymizers`, and nesting
/// those under `sessions` would violate the lock ordering both transports
/// rely on.
fn redacted_line_texts(
    ctx: &ServiceCtx,
    session_id: &str,
    line_nums: &[usize],
) -> Result<HashMap<usize, String>, ServiceError> {
    let mut needed: Vec<usize> = line_nums.to_vec();
    needed.sort_unstable();
    needed.dedup();
    if needed.is_empty() {
        return Ok(HashMap::new());
    }

    let raw: Vec<(usize, String)> = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        match sessions.get(session_id).and_then(|s| s.primary_source()) {
            None => Vec::new(),
            Some(source) => needed
                .iter()
                .filter_map(|&ln| source.raw_line(ln).map(|r| (ln, r.into_owned())))
                .collect(),
        }
    };

    Ok(raw
        .into_iter()
        .map(|(ln, text)| {
            (
                ln,
                policy::redact_line(ctx, session_id, &text, RESULT_LINE_CHARS),
            )
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anonymizer::config::AnonymizerConfig;
    use crate::commands::pipeline_core::PartitionedDefs;
    use crate::core::line::{LineMeta, LogLevel};
    use crate::core::log_source::StreamLogSource;
    use crate::core::session::SourceType;
    use crate::processors::marketplace::SchemaContract;
    use crate::processors::reporter::engine::{Emission, RunResult};
    use crate::processors::reporter::schema::ReporterDef;
    use crate::processors::state_tracker::types::FieldChange;
    use crate::processors::{AnyProcessor, ProcessorMeta};
    use crate::services::events::NullProgressSink;
    use crate::services::testing::test_ctx;
    use crate::services::Caller;
    use crate::workspace::SessionMeta;

    // ── Fixtures ───────────────────────────────────────────────────────────

    fn meta(id: &str) -> ProcessorMeta {
        ProcessorMeta {
            id: id.to_string(),
            name: format!("Name of {id}"),
            version: "1.0.0".to_string(),
            author: String::new(),
            description: format!("Desc of {id}"),
            tags: vec![],
            builtin: false,
            license: None,
            category: None,
            repository: None,
            deprecated: false,
        }
    }

    const REPORTER_YAML: &str = r#"
meta:
  id: r
  name: R
pipeline:
  - stage: filter
    rules:
      - type: message_contains
        value: "x"
"#;

    const TRACKER_YAML: &str = r#"
type: state_tracker
id: t
name: T
version: 1.0.0
state:
  - name: enabled
    type: bool
    default: false
transitions:
  - name: turn_on
    filter:
      message_contains: on
    set:
      enabled: true
"#;

    /// A registry-shaped processor whose meta name/description are derived from
    /// `id`, so a test can tell "the registry supplied this" from "the id was
    /// used as a fallback".
    fn processor_from(id: &str, yaml: &str) -> AnyProcessor {
        let mut p = AnyProcessor::from_yaml(yaml).expect("fixture yaml parses");
        p.meta = meta(id);
        p
    }

    fn reporter_processor(id: &str) -> AnyProcessor {
        processor_from(id, REPORTER_YAML)
    }

    fn tracker_processor(id: &str) -> AnyProcessor {
        processor_from(id, TRACKER_YAML)
    }

    const TRANSFORMER_YAML: &str = r#"
type: transformer
id: __xform
name: X
version: 1.0.0
transforms:
  - op: replace_field
    field: message
    regex: "secret"
    replacement: "***"
"#;

    fn transformer_processor(id: &str) -> AnyProcessor {
        processor_from(id, TRANSFORMER_YAML)
    }

    fn install(ctx: &ServiceCtx, id: &str, proc: AnyProcessor) {
        ctx.state()
            .processors
            .lock()
            .unwrap()
            .insert(id.to_string(), proc);
    }

    fn set_meta(ctx: &ServiceCtx, session_id: &str, active: &[&str], disabled: &[&str]) {
        ctx.state().session_pipeline_meta.lock().unwrap().insert(
            session_id.to_string(),
            SessionMeta {
                active_processor_ids: active.iter().map(|s| s.to_string()).collect(),
                disabled_processor_ids: disabled.iter().map(|s| s.to_string()).collect(),
            },
        );
    }

    // ── resolve_effective_chain ────────────────────────────────────────────

    #[test]
    fn requested_ids_resolve_bare_to_qualified() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "wifi@official", reporter_processor("wifi"));

        let chain =
            resolve_effective_chain(&ctx, "s1", Some(&["wifi".to_string()])).expect("resolves");
        assert_eq!(chain, vec!["wifi@official".to_string()]);
    }

    #[test]
    fn requested_qualified_id_passes_through_unchanged() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "wifi@official", reporter_processor("wifi"));

        let chain = resolve_effective_chain(&ctx, "s1", Some(&["wifi@official".to_string()]))
            .expect("resolves");
        assert_eq!(chain, vec!["wifi@official".to_string()]);
    }

    #[test]
    fn requested_unknown_id_is_an_invalid_argument() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        let err = resolve_effective_chain(&ctx, "s1", Some(&["nope".to_string()])).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert!(err.message().contains("nope"), "{}", err.message());
    }

    #[test]
    fn requested_ambiguous_bare_id_is_an_invalid_argument() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "wifi@official", reporter_processor("wifi"));
        install(&ctx, "wifi@my-team", reporter_processor("wifi"));

        let err = resolve_effective_chain(&ctx, "s1", Some(&["wifi".to_string()])).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert!(err.message().contains("ambiguous"), "{}", err.message());
    }

    #[test]
    fn no_request_uses_the_sessions_active_minus_disabled_chain_in_order() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official", reporter_processor("a"));
        install(&ctx, "b@official", reporter_processor("b"));
        install(&ctx, "c@official", reporter_processor("c"));
        set_meta(
            &ctx,
            "s1",
            &["c@official", "a@official", "b@official"],
            &["a@official"],
        );

        let chain = resolve_effective_chain(&ctx, "s1", None).expect("resolves");
        assert_eq!(
            chain,
            vec!["c@official".to_string(), "b@official".to_string()],
            "order must follow active_processor_ids, minus disabled"
        );
    }

    #[test]
    fn no_request_filters_out_uninstalled_ids_but_keeps_lts_ones() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(
            &ctx,
            "s1",
            &["a@official", "ghost@official", "local@lts-abc123"],
            &[],
        );

        let chain = resolve_effective_chain(&ctx, "s1", None).expect("resolves");
        assert_eq!(
            chain,
            vec!["a@official".to_string(), "local@lts-abc123".to_string()],
            "uninstalled ids drop out unless they carry an @lts- namespace"
        );
    }

    #[test]
    fn an_empty_request_falls_through_to_the_session_chain() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(&ctx, "s1", &["a@official"], &[]);

        let chain = resolve_effective_chain(&ctx, "s1", Some(&[])).expect("resolves");
        assert_eq!(chain, vec!["a@official".to_string()]);
    }

    #[test]
    fn a_session_with_no_meta_is_an_invalid_argument_not_a_run_of_everything() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official", reporter_processor("a"));

        let err = resolve_effective_chain(&ctx, "s1", None).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert_eq!(
            err.message(),
            "no pipeline chain configured for session s1",
            "the bridge's old 'default to every installed processor' fallback is gone"
        );
    }

    #[test]
    fn a_fully_disabled_chain_is_an_invalid_argument() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(&ctx, "s1", &["a@official"], &["a@official"]);

        let err = resolve_effective_chain(&ctx, "s1", None).unwrap_err();
        assert_eq!(err.message(), "no pipeline chain configured for session s1");
    }

    #[test]
    fn an_agent_caller_gets_the_pii_anonymizer_forced_into_the_chain() {
        let (ctx, _t) = test_ctx().agent("claude-code").with_session("s1", 1).build();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(&ctx, "s1", &["a@official"], &[]);

        // Nothing configured — an agent is anonymized by default.
        let chain = resolve_effective_chain(&ctx, "s1", None).expect("resolves");
        assert_eq!(
            chain,
            vec!["a@official".to_string(), PII_ANONYMIZER_ID.to_string()]
        );
    }

    #[test]
    fn the_pii_anonymizer_is_not_added_twice() {
        let (ctx, _t) = test_ctx().agent("mcp").with_session("s1", 1).build();
        install(&ctx, PII_ANONYMIZER_ID, reporter_processor(PII_ANONYMIZER_ID));
        set_meta(&ctx, "s1", &[PII_ANONYMIZER_ID], &[]);

        let chain = resolve_effective_chain(&ctx, "s1", None).expect("resolves");
        assert_eq!(chain, vec![PII_ANONYMIZER_ID.to_string()]);
    }

    #[test]
    fn a_ui_caller_never_gets_the_anonymizer_forced_in() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(&ctx, "s1", &["a@official"], &[]);

        let chain = resolve_effective_chain(&ctx, "s1", None).expect("resolves");
        assert_eq!(
            chain,
            vec!["a@official".to_string()],
            "the desktop user is the owner of their own logs — never force-redacted"
        );
    }

    #[test]
    fn an_agent_gets_no_forced_anonymizer_after_the_user_opted_out() {
        let (ctx, _t) = test_ctx()
            .agent("mcp")
            .with_session("s1", 1)
            .agent_raw_access(true)
            .build();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(&ctx, "s1", &["a@official"], &[]);

        let chain = resolve_effective_chain(&ctx, "s1", None).expect("resolves");
        assert_eq!(chain, vec!["a@official".to_string()]);
    }

    // ── The __pii_anonymizer carve-out ─────────────────────────────────────

    /// The security-critical invariant, driven through the real `run_blocking`
    /// transformer-retain carve-out (~line 550) rather than a duplicated
    /// inline closure: a transformer whose declared `source_types` exclude
    /// this session is dropped from the run and reported as a skip row, but
    /// the built-in anonymizer — given the *same* excluding declaration, so
    /// the guard is what saves it rather than the shipped YAML happening to
    /// declare no schema — always survives and actually runs.
    #[tokio::test]
    async fn the_pii_anonymizer_is_never_excluded_by_declared_source_types() {
        let (ctx, _t) = test_ctx()
            .agent("mcp")
            .with_session("s1", 3)
            .build();

        // The fixture session is a logcat StreamLogSource (see
        // `services::testing::fixture_session`); this declared list excludes it.
        let mismatched = vec!["kernel".to_string()];

        let mut ordinary = transformer_processor("mismatched-transformer");
        ordinary.schema = Some(SchemaContract {
            source_types: mismatched.clone(),
            emissions: vec![],
            mcp: None,
        });
        install(&ctx, "mismatched-transformer@official", ordinary);

        let mut anonymizer = transformer_processor(PII_ANONYMIZER_ID);
        anonymizer.schema = Some(SchemaContract {
            source_types: mismatched.clone(),
            emissions: vec![],
            mcp: None,
        });
        install(&ctx, PII_ANONYMIZER_ID, anonymizer);

        let out = run(
            ctx.clone(),
            "s1".to_string(),
            Some(vec!["mismatched-transformer".to_string()]),
            Arc::new(NullProgressSink),
        )
        .await
        .expect("run succeeds");

        assert!(
            out.effective_processor_ids
                .contains(&PII_ANONYMIZER_ID.to_string()),
            "should_anonymize must force the anonymizer into the effective chain"
        );

        let anonymizer_summary = out
            .summaries
            .iter()
            .find(|s| s.processor_id == PII_ANONYMIZER_ID)
            .expect(
                "the built-in anonymizer must survive source-type exclusion — a skipped \
                 anonymizer means unredacted PII reaching exports and the MCP bridge",
            );
        assert!(
            anonymizer_summary.skipped.is_none(),
            "the anonymizer must actually run, not merely appear in the chain"
        );

        let transformer_summary = out
            .summaries
            .iter()
            .find(|s| s.processor_id == "mismatched-transformer@official")
            .expect("an excluded transformer still gets a skip row, not silent removal");
        let reason = transformer_summary
            .skipped
            .as_ref()
            .expect("an ordinary transformer that declares a mismatched source type is skipped");
        assert_eq!(reason.reason, "source_type_mismatch");
        assert_eq!(reason.declared, mismatched);
        assert_eq!(reason.actual, SourceType::Logcat.to_string());
    }

    /// A processor excluded by an *embedded* `source_type_is` filter rule
    /// (as opposed to declared `schema.source_types` metadata, covered by the
    /// test above) must also surface as a skip row — not vanish from the
    /// summary with no trace, and not be conflated with the declared-metadata
    /// exclusion's `"source_type_mismatch"` reason. `find_embedded_source_type_exclusions`
    /// identifies the exclusion; this exercises the full `run()` path end to
    /// end to prove the resulting `PipelineRunSummary` actually carries the
    /// distinct `"source_type_filter_excluded"` discriminant.
    #[tokio::test]
    async fn reporter_excluded_by_embedded_source_type_is_gets_a_distinct_skip_row() {
        let (ctx, _t) = test_ctx().with_session("s1", 3).build();

        // The fixture session is a Logcat StreamLogSource; this reporter's
        // own filter stage restricts it to Kernel, so it is excluded by the
        // *embedded* pass (find_embedded_source_type_exclusions), not by any
        // declared `schema.source_types` metadata (none is set here).
        let yaml = r#"
meta:
  id: kernel_only_reporter
  name: Kernel Only
pipeline:
  - stage: filter
    rules:
      - type: source_type_is
        source_type: Kernel
"#;
        install(&ctx, "kernel_only_reporter@official", processor_from("kernel_only_reporter", yaml));
        set_meta(&ctx, "s1", &["kernel_only_reporter@official"], &[]);

        let out = run(
            ctx.clone(),
            "s1".to_string(),
            None,
            Arc::new(NullProgressSink),
        )
        .await
        .expect("run succeeds");

        let summary = out
            .summaries
            .iter()
            .find(|s| s.processor_id == "kernel_only_reporter@official")
            .expect("a processor excluded by an embedded source_type_is rule still gets a skip row, not silent removal");
        let reason = summary
            .skipped
            .as_ref()
            .expect("the embedded filter-rule exclusion must produce a SkipReason");
        assert_eq!(
            reason.reason, "source_type_filter_excluded",
            "must use its own discriminant, distinct from the declared-metadata \"source_type_mismatch\""
        );
        assert_eq!(reason.declared, vec!["Kernel".to_string()]);
        assert_eq!(reason.actual, SourceType::Logcat.to_string());
    }

    // ── run() ──────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn run_reports_the_effective_chain_and_journals_on_completion() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 3).build_recording();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(&ctx, "s1", &["a@official"], &[]);

        let out = run(
            ctx.clone(),
            "s1".to_string(),
            None,
            Arc::new(NullProgressSink),
        )
        .await
        .expect("run succeeds");

        assert_eq!(out.session_id, "s1");
        assert_eq!(out.effective_processor_ids, vec!["a@official".to_string()]);
        assert_eq!(out.summaries.len(), 1);
        assert_eq!(out.summaries[0].processor_id, "a@official");

        let entry = sink.only_event("activity");
        assert_eq!(entry["action"], "pipeline.run");
        assert_eq!(entry["sessionId"], "s1");
        assert_eq!(entry["summary"], "1 processors");
    }

    #[tokio::test]
    async fn run_emits_pipeline_progress_through_the_sink() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 3).build_recording();
        install(&ctx, "a@official", reporter_processor("a"));

        let progress: Arc<dyn ProgressSink> = Arc::clone(&sink) as Arc<dyn ProgressSink>;
        run(
            ctx.clone(),
            "s1".to_string(),
            Some(vec!["a@official".to_string()]),
            progress,
        )
        .await
        .expect("run succeeds");

        let events = sink.progress_events();
        assert_eq!(events.len(), 1, "one chunk, one processor");
        assert_eq!(events[0].event_name(), "pipeline-progress");
        assert_eq!(events[0].payload()["processorId"], "a@official");
        assert_eq!(events[0].payload()["totalLines"], 3);
    }

    #[tokio::test]
    async fn run_rejects_an_unresolvable_chain_before_touching_results() {
        let (ctx, _t) = test_ctx().with_session("s1", 3).build();
        let err = run(ctx, "s1".to_string(), None, Arc::new(NullProgressSink))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
    }

    #[tokio::test]
    async fn run_on_a_missing_session_reports_session_not_found() {
        let (ctx, _t) = test_ctx().build();
        install(&ctx, "a@official", reporter_processor("a"));
        let err = run(
            ctx,
            "ghost".to_string(),
            Some(vec!["a@official".to_string()]),
            Arc::new(NullProgressSink),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        assert_eq!(err.message(), "Session 'ghost' not found");
    }

    #[tokio::test]
    async fn a_queued_cancel_aborts_the_run_without_clearing_stored_results() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 3).build_recording();
        install(&ctx, "a@official", reporter_processor("a"));

        // Seed a sentinel result so we can tell a queued-cancel abort left
        // previously stored results untouched rather than clearing them.
        let mut sentinel_results = HashMap::new();
        sentinel_results.insert(
            "sentinel@official".to_string(),
            RunResult {
                matched_line_nums: vec![42],
                ..Default::default()
            },
        );
        ctx.state()
            .pipeline_results
            .lock()
            .unwrap()
            .insert("s1".to_string(), sentinel_results);

        let state = ctx.state_arc();

        // Hold the session's run lock on a real OS thread BEFORE starting the
        // run — mirrors `commands::pipeline::tests::poisoned_run_lock_...`,
        // which drives the same lock via a spawned `std::thread`. This forces
        // `run_blocking` down the actual "queued" path: it registers its
        // cancellation token (before attempting the run lock, per its own
        // comment) and then blocks on `run_lock.lock()` until this thread
        // releases it — exactly what `stop_pipeline` targets when a run is
        // still queued behind another same-session run.
        let run_lock = state.pipeline_run_lock("s1").expect("run lock");
        let (held_tx, held_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let lock_for_holder = Arc::clone(&run_lock);
        let holder = std::thread::spawn(move || {
            let _guard = lock_for_holder.lock().unwrap();
            held_tx.send(()).expect("test thread still listening");
            let _ = release_rx.recv();
        });
        held_rx.recv().expect("holder thread acquired the run lock");

        let run_ctx = ctx.clone();
        let handle = tokio::task::spawn(async move {
            run(
                run_ctx,
                "s1".to_string(),
                Some(vec!["a".to_string()]),
                Arc::new(NullProgressSink),
            )
            .await
        });

        // Wait deterministically for `run_blocking` to register its token
        // (it does so before ever touching the run lock) instead of sleeping
        // a guessed delay — the registry is a `pub` AppState field so the
        // test can observe it directly.
        loop {
            if state.pipeline_cancels.lock().unwrap().len() == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }

        // This is the queued run's own token — cancel it exactly as
        // `stop_pipeline` would while the run is still queued behind the
        // held lock.
        let signalled = state.cancel_all_pipeline_runs();
        assert_eq!(signalled, 1, "the queued run's token must be the one signalled");

        // Let the queued run proceed now that its token is already cancelled.
        release_tx.send(()).expect("holder thread still listening");
        holder.join().expect("holder thread must not panic");

        let out = handle
            .await
            .expect("run task must not panic")
            .expect("a queued-cancel abort returns Ok, not an error");

        assert!(
            out.summaries.is_empty(),
            "a queued cancel must abort before any processor executes"
        );

        let stored = ctx.state().pipeline_results.lock().unwrap();
        assert!(
            stored
                .get("s1")
                .is_some_and(|m| m.contains_key("sentinel@official")),
            "a queued-cancel abort must leave previously stored results untouched"
        );
        drop(stored);

        // A cancelled run still announces itself — as a success with no
        // summaries, which is all `run_blocking` lets `run` tell apart.
        let done = sink.only_event(PIPELINE_COMPLETE_EVENT);
        assert_eq!(done["error"], Value::Null);
        assert_eq!(done["result"]["summaries"], json!([]));
        assert_eq!(done["result"]["effectiveProcessorIds"], json!(["a@official"]));

        // …and the explicit id reached the chain even though the run never
        // executed: the merge is deliberately ahead of the queued-cancel check.
        sink.only_event(chain::CHAIN_UPDATE_EVENT);
        assert_eq!(
            chain::get(&ctx, "s1").expect("chain").active_processor_ids,
            vec!["a@official".to_string()]
        );
    }

    // ── chain merge + pipeline-complete ────────────────────────────────────

    /// An explicit-ids run adds those ids to the session's chain, and the
    /// `chain-update` announcing that lands before the first
    /// `pipeline-progress` — both through the same broadcast sink, the way
    /// the bridge wires them (`EventSinkProgress` over `ctx.events()`).
    #[tokio::test]
    async fn an_explicit_ids_run_merges_into_the_chain_before_any_progress() {
        let (ctx, sink, _t) = test_ctx().agent("claude").with_session("s1", 3).build_recording();
        install(&ctx, "a@official", reporter_processor("a"));
        install(&ctx, "b@official", reporter_processor("b"));
        set_meta(&ctx, "s1", &["a@official"], &[]);

        let progress: Arc<dyn ProgressSink> =
            Arc::new(EventSinkProgress::new(Arc::clone(&sink) as Arc<dyn EventSink>));
        let out = run(ctx.clone(), "s1".to_string(), Some(vec!["b".to_string()]), progress)
            .await
            .expect("run succeeds");
        // The agent is redacted by default, so the run itself carries the
        // force-included anonymizer — which must NOT reach the chain below.
        assert_eq!(
            out.effective_processor_ids,
            vec!["b@official".to_string(), PII_ANONYMIZER_ID.to_string()]
        );

        let names: Vec<String> = sink.events().into_iter().map(|e| e.name).collect();
        let chain_at = names
            .iter()
            .position(|n| n == chain::CHAIN_UPDATE_EVENT)
            .expect("an explicit-ids run must emit chain-update");
        let progress_at = names
            .iter()
            .position(|n| n == "pipeline-progress")
            .expect("the run must emit progress");
        assert!(
            chain_at < progress_at,
            "chain-update must precede the first pipeline-progress: {names:?}"
        );

        let ev = sink.only_event(chain::CHAIN_UPDATE_EVENT);
        assert_eq!(ev["activeProcessorIds"], json!(["a@official", "b@official"]));
        assert_eq!(ev["caller"], json!({ "kind": "agent", "client": "claude" }));

        let stored = chain::get(&ctx, "s1").expect("chain");
        assert_eq!(stored.active_processor_ids, vec!["a@official".to_string(), "b@official".to_string()]);

        // Both the chain edit and the run are in the feed, in that order.
        let actions: Vec<String> = sink
            .events_named("activity")
            .into_iter()
            .map(|e| e.payload["action"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(actions, vec!["chain.update".to_string(), "pipeline.run".to_string()]);
    }

    #[tokio::test]
    async fn a_chain_only_run_emits_no_chain_update() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 3).build_recording();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(&ctx, "s1", &["a@official"], &[]);

        run(ctx.clone(), "s1".to_string(), None, Arc::new(NullProgressSink))
            .await
            .expect("run succeeds");

        assert!(
            sink.events_named(chain::CHAIN_UPDATE_EVENT).is_empty(),
            "running the chain as configured is not a chain edit"
        );
    }

    #[tokio::test]
    async fn an_explicit_ids_run_over_ids_already_in_the_chain_is_not_a_chain_edit() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 3).build_recording();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(&ctx, "s1", &["a@official"], &[]);

        run(ctx.clone(), "s1".to_string(), Some(vec!["a".to_string()]), Arc::new(NullProgressSink))
            .await
            .expect("run succeeds");

        assert!(sink.events_named(chain::CHAIN_UPDATE_EVENT).is_empty());
        let entry = sink.only_event("activity");
        assert_eq!(entry["action"], "pipeline.run");
    }

    #[tokio::test]
    async fn pipeline_complete_carries_the_result_on_success() {
        let (ctx, sink, _t) = test_ctx().agent("claude").with_session("s1", 3).build_recording();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(&ctx, "s1", &["a@official"], &[]);

        let out = run(ctx.clone(), "s1".to_string(), None, Arc::new(NullProgressSink))
            .await
            .expect("run succeeds");

        let done = sink.only_event(PIPELINE_COMPLETE_EVENT);
        assert_eq!(done["sessionId"], "s1");
        assert_eq!(done["caller"], json!({ "kind": "agent", "client": "claude" }));
        assert_eq!(done["error"], Value::Null);
        assert_eq!(done["result"], serde_json::to_value(&out).unwrap(), "the event carries the same result the caller gets");

        // Emitted before the journal entry, so a listener sees the outcome
        // first and the feed line second.
        let names: Vec<String> = sink.events().into_iter().map(|e| e.name).collect();
        let done_at = names.iter().position(|n| n == PIPELINE_COMPLETE_EVENT).unwrap();
        let journal_at = names.iter().position(|n| n == "activity").unwrap();
        assert!(done_at < journal_at, "{names:?}");
    }

    #[tokio::test]
    async fn pipeline_complete_carries_the_error_on_failure() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 3).build_recording();

        let err = run(ctx.clone(), "s1".to_string(), None, Arc::new(NullProgressSink))
            .await
            .unwrap_err();

        let done = sink.only_event(PIPELINE_COMPLETE_EVENT);
        assert_eq!(done["sessionId"], "s1");
        assert_eq!(done["caller"], json!({ "kind": "ui" }));
        assert_eq!(done["result"], Value::Null);
        assert_eq!(done["error"], err.message());
        assert!(sink.events_named("activity").is_empty(), "a failed run is not journaled");
    }

    // ── SourceSnapshot (moved with the run logic) ──────────────────────────

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
            format!("svc-pipeline-{label}"),
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

        assert_eq!(
            snap.scanned_from(),
            4,
            "scanned_from must equal the evicted offset"
        );
        assert_eq!(
            snap.total_lines(),
            6,
            "only the 6 retained lines are in the snapshot"
        );
    }

    #[test]
    fn stream_snapshot_raw_line_uses_absolute_indices() {
        let src = make_evicted_stream("raw-line", 10, 4);
        let snap = snapshot_of(&src);

        // Evicted lines (0..4) were never cloned into the snapshot — they
        // live only in the spill file, which the run intentionally never
        // reads. Absolute indices below the offset must miss.
        for n in 0..4 {
            assert!(
                snap.raw_line(n).is_none(),
                "line {n} was evicted and must not resolve from the snapshot"
            );
        }

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

        for n in scanned_from..(scanned_from + total_lines) {
            let raw = snap.raw_line(n).expect("retained line must resolve");
            let ctx = parser
                .parse_line(raw.as_ref(), "test-src", n)
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
        let mut parsed_chunk: Vec<Option<crate::core::line::LineContext>> = (scanned_from
            ..(scanned_from + total_lines))
            .map(|n| {
                let raw = snap.raw_line(n).unwrap();
                parser.parse_line(raw.as_ref(), "test-src", n)
            })
            .collect();
        core.process_batch(&mut parsed_chunk);

        let output = core.finish(&HashMap::new());
        let result = output
            .reporter_results
            .get("ping_reporter")
            .expect("reporter ran");

        let expected: Vec<usize> = (evicted..(evicted + retained)).collect();
        let mut matched = result.matched_line_nums.clone();
        matched.sort_unstable();
        assert_eq!(
            matched, expected,
            "matched_line_nums must be absolute line numbers starting at the evicted offset, \
             with every evicted line excluded from the run"
        );
    }

    // ── PipelineRunGuard ───────────────────────────────────────────────────

    #[test]
    fn pipeline_run_guard_deregisters_on_drop() {
        let state = AppState::new();
        let (run_id, _tok) = state.register_pipeline_run();
        {
            let _guard = PipelineRunGuard {
                state: &state,
                run_id,
            };
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

    // ── store_tracker_and_correlator_results ───────────────────────────────

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

        let mut first_trackers = HashMap::new();
        first_trackers.insert(
            "wifi-state".to_string(),
            sample_tracker_result("wifi-state"),
        );
        let mut first_correlators = HashMap::new();
        first_correlators.insert("boot-corr".to_string(), sample_correlator_result());
        store_tracker_and_correlator_results(
            &state,
            session_id,
            first_trackers,
            first_correlators,
        );
        assert!(state
            .state_tracker_results
            .lock()
            .unwrap()
            .get(session_id)
            .is_some());
        assert!(state
            .correlator_results
            .lock()
            .unwrap()
            .get(session_id)
            .is_some());

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

    // ── Read side ──────────────────────────────────────────────────────────

    pub(super) fn seed_reporter(ctx: &ServiceCtx, session_id: &str, proc_id: &str) {
        let mut vars = HashMap::new();
        vars.insert("count".to_string(), json!(2));
        let rr = RunResult {
            emissions: vec![
                Emission {
                    line_num: 0,
                    fields: vec![("kind".to_string(), json!("first"))],
                },
                Emission {
                    line_num: 2,
                    fields: vec![("kind".to_string(), json!("second"))],
                },
            ],
            vars,
            matched_line_nums: vec![0, 2],
            script_errors: 0,
            first_script_error: None,
        };
        let mut per_session = HashMap::new();
        per_session.insert(proc_id.to_string(), rr);
        ctx.state()
            .pipeline_results
            .lock()
            .unwrap()
            .insert(session_id.to_string(), per_session);
    }

    pub(super) fn seed_tracker(ctx: &ServiceCtx, session_id: &str, tracker_id: &str) {
        let mut changes = HashMap::new();
        changes.insert(
            "enabled".to_string(),
            FieldChange {
                from: json!(false),
                to: json!(true),
            },
        );
        let mut final_state = HashMap::new();
        final_state.insert("enabled".to_string(), json!(true));
        let result = StateTrackerResult {
            tracker_id: tracker_id.to_string(),
            transitions: vec![StateTransition {
                line_num: 1,
                timestamp: 42,
                transition_name: "turn_on".to_string(),
                changes,
            }],
            final_state,
            source_sections: Vec::new(),
            mode: Default::default(),
        };
        let mut per_session = HashMap::new();
        per_session.insert(tracker_id.to_string(), result);
        ctx.state()
            .state_tracker_results
            .lock()
            .unwrap()
            .insert(session_id.to_string(), per_session);
    }

    #[test]
    fn results_aggregates_reporters_and_trackers_with_names_and_line_text() {
        let (ctx, _t) = test_ctx().with_session("s1", 5).build();
        install(&ctx, "rep@official", reporter_processor("rep"));
        seed_reporter(&ctx, "s1", "rep@official");
        seed_tracker(&ctx, "s1", "trk@official");

        let out = results(&ctx, "s1", None).expect("results");
        assert!(out.has_results());
        assert_eq!(out.reporters.len(), 1);
        let r = &out.reporters[0];
        assert_eq!(r.name, "Name of rep");
        assert_eq!(r.description, "Desc of rep");
        assert_eq!(r.matched_line_count, 2);
        assert_eq!(r.emission_count, 2);
        assert_eq!(
            r.recent_emissions.len(),
            2,
            "last 10 emissions, newest first"
        );
        // `Emission`'s hand-written Serialize nests its payload under
        // `fields` and spells the line number `line_num` — the shape the MCP
        // bridge has always emitted, preserved verbatim by this move.
        assert_eq!(r.recent_emissions[0]["fields"]["kind"], "second");
        assert_eq!(r.recent_emissions[0]["line_num"], 2);
        assert_eq!(
            r.sample_matched_lines
                .iter()
                .map(|m| m.line_num)
                .collect::<Vec<_>>(),
            vec![0, 2]
        );
        assert_eq!(r.sample_matched_lines[0].raw.as_deref(), Some("line 0"));

        assert_eq!(out.state_trackers.len(), 1);
        let t = &out.state_trackers[0];
        assert_eq!(
            t.name, "trk@official",
            "an unregistered tracker falls back to its id"
        );
        assert_eq!(t.transition_count, 1);
        assert_eq!(t.final_state["enabled"], true);
        assert_eq!(t.recent_transitions[0].raw.as_deref(), Some("line 1"));
    }

    #[test]
    fn results_filters_by_bare_or_qualified_processor_id() {
        let (ctx, _t) = test_ctx().with_session("s1", 5).build();
        seed_reporter(&ctx, "s1", "rep@official");

        assert_eq!(results(&ctx, "s1", Some("rep")).unwrap().reporters.len(), 1);
        assert_eq!(
            results(&ctx, "s1", Some("rep@official"))
                .unwrap()
                .reporters
                .len(),
            1
        );
        assert_eq!(
            results(&ctx, "s1", Some("other")).unwrap().reporters.len(),
            0
        );
    }

    #[test]
    fn results_for_an_agent_redacts_line_text() {
        let (ctx, _t) = test_ctx().agent("mcp").with_pii_session("s1", 5).build();
        seed_reporter(&ctx, "s1", "rep@official");

        let out = results(&ctx, "s1", None).expect("results");
        let raw = out.reporters[0].sample_matched_lines[0]
            .raw
            .clone()
            .unwrap_or_default();
        assert!(
            !raw.contains("@example.com"),
            "an agent must not see raw PII: {raw}"
        );
    }

    #[test]
    fn results_for_the_ui_leaves_line_text_alone() {
        let (ctx, _t) = test_ctx().with_pii_session("s1", 5).build();
        seed_reporter(&ctx, "s1", "rep@official");

        let out = results(&ctx, "s1", None).expect("results");
        let raw = out.reporters[0].sample_matched_lines[0]
            .raw
            .clone()
            .unwrap_or_default();
        assert!(raw.contains("@example.com"), "{raw}");
    }

    #[test]
    fn results_on_an_empty_session_has_no_results() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        let out = results(&ctx, "s1", None).expect("results");
        assert!(!out.has_results());
    }

    #[test]
    fn processor_detail_reporter_paginates_emissions_and_caps_matched_lines() {
        let (ctx, _t) = test_ctx().with_session("s1", 5).build();
        install(&ctx, "rep@official", reporter_processor("rep"));
        seed_reporter(&ctx, "s1", "rep@official");

        let detail = processor_detail(
            &ctx,
            "s1",
            "rep",
            DetailPage {
                offset: 1,
                limit: 50,
                include_emissions: true,
            },
            true,
        )
        .expect("detail");
        let ProcessorDetail::Reporter(r) = detail else {
            panic!("expected a reporter detail");
        };
        assert_eq!(r.resolved_id, "rep@official");
        assert_eq!(r.matched_line_count, 2);
        assert_eq!(r.emission_count, 2);
        let emissions = r.emissions.expect("emissions requested");
        assert_eq!(emissions.len(), 1, "offset 1 of 2");
        assert_eq!(emissions[0].value["fields"]["kind"], "second");
        assert_eq!(emissions[0].raw.as_deref(), Some("line 2"));
        assert_eq!(r.matched_lines[0].raw.as_deref(), Some("line 0"));
    }

    #[test]
    fn processor_detail_omits_line_text_when_not_requested() {
        let (ctx, _t) = test_ctx().with_session("s1", 5).build();
        seed_reporter(&ctx, "s1", "rep@official");

        let detail = processor_detail(
            &ctx,
            "s1",
            "rep@official",
            DetailPage {
                offset: 0,
                limit: 50,
                include_emissions: false,
            },
            false,
        )
        .expect("detail");
        let ProcessorDetail::Reporter(r) = detail else {
            panic!("expected a reporter detail");
        };
        assert!(r.emissions.is_none());
        assert!(r.matched_lines.iter().all(|m| m.raw.is_none()));
    }

    #[test]
    fn processor_detail_reports_missing_results() {
        let (ctx, _t) = test_ctx().with_session("s1", 5).build();
        let err = processor_detail(
            &ctx,
            "s1",
            "nothing",
            DetailPage {
                offset: 0,
                limit: 50,
                include_emissions: false,
            },
            false,
        )
        .unwrap_err();
        assert_eq!(err.message(), "no results for this processor/session");
    }

    #[test]
    fn processor_detail_for_a_tracker_pages_transitions() {
        let (ctx, _t) = test_ctx().with_session("s1", 5).build();
        install(
            &ctx,
            "trk@official",
            tracker_processor("trk"),
        );
        seed_tracker(&ctx, "s1", "trk@official");

        let detail = processor_detail(
            &ctx,
            "s1",
            "trk",
            DetailPage {
                offset: 0,
                limit: 50,
                include_emissions: false,
            },
            true,
        )
        .expect("detail");
        let ProcessorDetail::StateTracker(t) = detail else {
            panic!("expected a tracker detail");
        };
        assert_eq!(t.transition_count, 1);
        assert_eq!(t.transitions[0].transition.transition_name, "turn_on");
        assert_eq!(t.transitions[0].raw.as_deref(), Some("line 1"));
        assert_eq!(t.final_state["enabled"], true);
    }

    #[test]
    fn processor_vars_reports_both_missing_levels_distinctly() {
        let (ctx, _t) = test_ctx().with_session("s1", 5).build();
        assert_eq!(
            processor_vars(&ctx, "s1", "rep@official")
                .unwrap_err()
                .message(),
            "No pipeline results for session 's1'"
        );

        seed_reporter(&ctx, "s1", "rep@official");
        assert_eq!(
            processor_vars(&ctx, "s1", "ghost").unwrap_err().message(),
            "No result for processor 'ghost'"
        );
        assert_eq!(
            processor_vars(&ctx, "s1", "rep@official").unwrap()["count"],
            json!(2)
        );
    }

    #[test]
    fn matched_lines_falls_back_from_reporter_to_tracker_results() {
        let (ctx, _t) = test_ctx().with_session("s1", 5).build();
        seed_tracker(&ctx, "s1", "trk@official");

        let lines = matched_lines(&ctx, "s1", "trk@official").expect("matched lines");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].line_num, 1);
        assert_eq!(lines[0].raw, "line 1");
    }

    #[test]
    fn matched_lines_are_sorted_and_untruncated_for_the_ui() {
        let (ctx, _t) = test_ctx().with_session("s1", 5).build();
        seed_reporter(&ctx, "s1", "rep@official");

        let lines = matched_lines(&ctx, "s1", "rep@official").expect("matched lines");
        assert_eq!(
            lines.iter().map(|l| l.line_num).collect::<Vec<_>>(),
            vec![0, 2]
        );
        assert_eq!(lines[0].raw, "line 0");
    }

    #[test]
    fn matched_lines_on_a_missing_session_is_not_found() {
        let (ctx, _t) = test_ctx().build();
        let err = matched_lines(&ctx, "ghost", "rep").unwrap_err();
        assert_eq!(err.message(), "Session 'ghost' not found");
    }

    // ── EventSinkProgress ──────────────────────────────────────────────────

    #[test]
    fn event_sink_progress_forwards_under_the_wire_event_name() {
        let (ctx, sink, _t) = test_ctx().build_recording();
        let _ = &ctx;
        let fwd = EventSinkProgress::new(Arc::clone(&sink) as Arc<dyn EventSink>);
        fwd.on_progress(&ProgressEvent::Pipeline(PipelineProgressEvent {
            session_id: "s1".into(),
            processor_id: "p".into(),
            lines_processed: 5,
            total_lines: 10,
            percent: 50.0,
        }));
        let payload = sink.only_event("pipeline-progress");
        assert_eq!(payload["sessionId"], "s1");
        assert_eq!(payload["linesProcessed"], 5);
    }

    #[test]
    fn caller_identity_is_what_drives_the_forced_anonymizer() {
        // Guards the one line that turns identity into a chain decision.
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official", reporter_processor("a"));
        set_meta(&ctx, "s1", &["a@official"], &[]);
        assert_eq!(*ctx.caller(), Caller::Ui);
        assert_eq!(resolve_effective_chain(&ctx, "s1", None).unwrap().len(), 1);

        let agent = ctx.with_caller(Caller::agent("mcp"));
        assert_eq!(resolve_effective_chain(&agent, "s1", None).unwrap().len(), 2);
    }
}
