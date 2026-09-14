//! Pipeline Tauri commands — thin adapters over `services::pipeline`.
//!
//! The run itself (per-session serialization, cancellation, pre-filter,
//! `PipelineCore`, result storage) lives in `services::pipeline::run`, which
//! the MCP bridge calls through the same entry point. What stays here is the
//! Tauri surface: the `#[tauri::command]` signatures, the wire types the
//! frontend already parses (`PipelineProgress`, `PipelineRunSummary`,
//! `SkipReason`), and the two commands that only touch `AppState`
//! (`stop_pipeline`, `set_session_pipeline_meta`).

use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::commands::AppState;
use crate::services::pipeline;
use crate::services::wire::PipelineRunResult;
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Progress event payload
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
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
    #[ts(optional)]
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
    #[ts(optional)]
    pub skipped: Option<SkipReason>,
}

/// Why a processor was excluded from a run before it executed.
#[derive(Debug, Clone, Serialize, TS)]
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
pub(crate) fn source_type_skip(
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
pub(crate) fn source_type_filter_skip(
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
// run_pipeline — adapter
// ---------------------------------------------------------------------------

/// Run a processor chain over one session.
///
/// `processor_ids` is optional. `None` (or an empty list) means "use this
/// session's own chain", which the backend now derives from
/// `session_pipeline_meta` in [`pipeline::resolve_effective_chain`] rather than
/// the frontend re-deriving `active − disabled` before every call.
///
/// The old `anonymize: bool` parameter is gone. It had been vestigial since
/// anonymization moved to "is `__pii_anonymizer` in the chain"; Tauri ignores
/// arguments a command does not declare, so a frontend still passing it keeps
/// working unchanged.
///
/// Returns the full [`PipelineRunResult`], whose `effectiveProcessorIds` is the
/// chain the backend actually ran. That is what lets `usePipelineCommands.ts`
/// pass `null` and stop re-deriving `active − disabled` on the frontend: the
/// resolved chain comes back in the response instead of being computed twice.
#[tauri::command]
pub async fn run_pipeline(
    app: AppHandle,
    session_id: String,
    processor_ids: Option<Vec<String>>,
) -> Result<PipelineRunResult, String> {
    // `pipeline::run` owns its own spawn_blocking; the CPU-heavy work never
    // runs on an async runtime thread and no lock guard crosses this await.
    let ctx = crate::commands::adapters::ui_ctx(&app);
    let progress = Arc::new(crate::commands::adapters::TauriProgressSink::new(app.clone()));
    pipeline::run(ctx, session_id, processor_ids, progress)
        .await
        .map_err(|e| e.message())
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
// set_session_pipeline_meta — frontend pushes chain state
// ---------------------------------------------------------------------------

/// Thin adapter over `services::chain::set`. This used to be a bare map
/// insert; it now goes through the same service the bridge's
/// `PUT /mcp/sessions/{id}/chain` uses, so a UI chain edit emits
/// `chain-update`, schedules an autosave and journals like an agent's does.
/// The JS argument names are unchanged.
#[tauri::command]
pub fn set_session_pipeline_meta(
    app: AppHandle,
    session_id: String,
    active_processor_ids: Vec<String>,
    disabled_processor_ids: Vec<String>,
) -> Result<(), String> {
    crate::services::chain::set(
        &crate::commands::adapters::ui_ctx(&app),
        &session_id,
        active_processor_ids,
        disabled_processor_ids,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tests — the wire shapes this module still owns, and the `AppState` run
// registry the service's locking relies on. The run itself is tested in
// `services::pipeline`.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

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
        assert_eq!(json.get("scannedFrom").and_then(serde_json::Value::as_u64), Some(1234));
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
        assert_eq!(json.get("matchedLines").and_then(serde_json::Value::as_u64), Some(0));
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
        // `services::pipeline::run` acquires the lock with
        // `run_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())`;
        // this test exercises that exact recovery against the real Arc handed
        // out by `pipeline_run_lock`, proving a panicked run cannot brick every
        // later run on the (content-derived, cached) session id. The registry
        // this asserts on belongs to `AppState`, which is why the test stays
        // here rather than moving with the run into the service.
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
        // `services::pipeline`. Reaching the assertion proves the subsequent
        // run proceeds rather than erroring out forever.
        let _guard = next.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    }
}
