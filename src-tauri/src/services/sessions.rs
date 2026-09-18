//! Session lifecycle: open, close, list, metadata, status.
//!
//! The single implementation of open/close/list/metadata, replacing what used
//! to be `commands::files::{open_file_inner, load_lts_file_inner,
//! close_session_inner}` (the Tauri UI path) and the MCP bridge's own copies
//! of the same logic in `mcp_bridge::routes::sessions`. Before this package,
//! only the UI could open a `.lts` bundle correctly — an agent opening one
//! over the bridge would have had it mis-parsed as a plain log file, since
//! `h_open_file` always called the plain-file path. `open` now dispatches on
//! the file extension for both callers.
//!
//! `restore_artifacts` / `restamp_analysis_references` (used by
//! [`rescue_artifacts_for_replacement`] below and by the `.lts` restore path)
//! stay in `commands::files` — `commands::workspace_cmd::restore_workspace_session`
//! (a different work package, not yet converted) also calls them directly, so
//! moving them would break that call site. Likewise `LoadResult` /
//! `FileIndexProgress` / `FileIndexComplete` stay defined in `commands::files`
//! (`commands::adb.rs` imports `LoadResult` from there) — this module just
//! constructs them.

use std::path::Path;
use std::sync::Weak;

use memmap2::Mmap;
use serde::Serialize;
use tempfile::NamedTempFile;
use ts_rs::TS;

use crate::commands::files::{FileIndexComplete, LoadResult};
use crate::commands::lock_or_err;
use crate::core::log_source::Encoding;
use crate::core::session::{AnalysisSession, SourceType, parser_for};

use super::events::{IndexProgressEvent, ProgressEvent};
use super::{lock_svc, ServiceCtx, ServiceError};

// ---------------------------------------------------------------------------
// session-closed event
// ---------------------------------------------------------------------------

/// Payload of the `session-closed` Tauri event. Replaces the ad hoc
/// `json!({ "sessionId": ... })` both the bridge and the internal
/// stale-session-replacement path used to build by hand.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionClosedEvent {
    pub session_id: String,
}

fn emit_session_closed(ctx: &ServiceCtx, session_id: &str) {
    ctx.events().emit_json(
        "session-closed",
        serde_json::to_value(SessionClosedEvent {
            session_id: session_id.to_string(),
        })
        .unwrap_or_default(),
    );
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

/// Open a log file (plain file, bugreport `.zip`, or `.lts` session bundle) as
/// one or more sessions.
///
/// `authorize_open` runs FIRST: `Ui` passes through (the native file dialog is
/// the consent step), `Agent` is checked against the open-file allowlist. The
/// canonical path it returns is what gets opened and stored, for both
/// callers — see the module docs on why that is a deliberate, sanctioned
/// change from the UI's historical "store whatever string the dialog handed
/// back" behavior: the id derivation already canonicalizes internally, so
/// this only changes the *displayed* path, and only when the dialog's raw
/// spelling differs from the canonical one (nonexistent for a real dialog
/// pick; harmless either way for `session_id`/`file_path` consumers, which
/// already tolerate two spellings of the same file via `canonical_compare_form`).
///
/// The actual parse/index work — CPU-bound (mmap + line-index build, or for
/// `.lts` the zip read + per-embedded-session decode) — runs on its own
/// blocking thread, mirroring `run_pipeline`'s starvation rationale.
///
/// `session-opened` is emitted only for an [`Caller::Agent`] caller. A
/// UI-initiated open already builds its own tab from the command's return
/// value; emitting the event unconditionally would race it, because the
/// event can reach the frontend's listener *before* the `invoke()` promise
/// resolves (the emit happens inside this function, before the Tauri command
/// returns). `planBridgeSessionOpen`'s `isSessionOpen` idempotency guard
/// checks whether the session is already registered on the frontend — for a
/// UI open that check can run before the synchronous "register from the
/// command's own result" step has happened, so it would NOT reliably no-op
/// and could spawn a duplicate tab. The bridge is otherwise the only way an
/// agent-initiated open becomes visible to the frontend at all, so it always
/// gets the event (this matches today's behavior, where only the bridge
/// emitted it).
pub async fn open(
    ctx: ServiceCtx,
    path: &str,
    source_type_override: Option<SourceType>,
) -> Result<Vec<LoadResult>, ServiceError> {
    let canonical = super::policy::authorize_open(&ctx, path)?;

    // `.lts` bundles carry the source type each embedded session was captured
    // with, so an override does not apply — reject it up front rather than
    // silently ignoring it. Checked here (not per-adapter) so an agent gets
    // the same guard the UI always had; previously the bridge had none.
    let is_lts = canonical.extension().and_then(|e| e.to_str()) == Some("lts");
    if is_lts && source_type_override.is_some() {
        return Err(ServiceError::invalid_arg(
            "source_type override is not supported for .lts session bundles — \
             they carry the source type each session was captured with",
        ));
    }

    let canonical_str = canonical.to_string_lossy().to_string();
    let ctx_for_task = ctx.clone();
    let results = tokio::task::spawn_blocking(move || {
        if is_lts {
            open_lts_file(&ctx_for_task, &canonical_str)
        } else {
            open_file(&ctx_for_task, &canonical_str, source_type_override)
        }
    })
    .await
    .map_err(|e| ServiceError::Internal(format!("open file task panicked: {e}")))??;

    if ctx.caller().is_agent() {
        for result in &results {
            ctx.events().emit_json(
                "session-opened",
                serde_json::to_value(result).unwrap_or(serde_json::Value::Null),
            );
        }
    }

    for result in &results {
        ctx.journal(
            "session.open",
            Some(&result.session_id),
            format!("opened {}", result.source_name),
        );
    }

    Ok(results)
}

/// Extract the dumpstate/bugreport .txt from a bugreport .zip to a temp file.
/// Picks the largest `.txt` file in the archive (the main dumpstate dump).
/// Returns a `NamedTempFile` that must be kept alive for the session duration.
fn extract_bugreport_from_zip(zip_path: &Path) -> Result<NamedTempFile, ServiceError> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| ServiceError::Internal(format!("Cannot open zip '{}': {e}", zip_path.display())))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| ServiceError::Internal(format!("Invalid zip archive '{}': {e}", zip_path.display())))?;

    let best_index = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            if name.ends_with('/') { return None; }
            if name.to_lowercase().ends_with(".txt") {
                Some((i, entry.size()))
            } else {
                None
            }
        })
        .max_by_key(|&(_, size)| size)
        .map(|(i, _)| i);

    let index = best_index.ok_or_else(|| {
        ServiceError::Internal(format!("No .txt file found in zip '{}'", zip_path.display()))
    })?;

    let mut entry = archive.by_index(index)
        .map_err(|e| ServiceError::Internal(format!("Failed to read zip entry: {e}")))?;

    let mut temp = NamedTempFile::new()
        .map_err(|e| ServiceError::Internal(format!("Failed to create temp file: {e}")))?;
    std::io::copy(&mut entry, &mut temp)
        .map_err(|e| ServiceError::Internal(format!("Failed to extract bugreport: {e}")))?;

    Ok(temp)
}

/// Open a plain log file (or a bugreport `.zip`) and register it as a
/// session. Moved verbatim from `commands::files::open_file_inner` (formerly
/// shared between the UI command and the bridge's `h_open_file` by direct
/// function call; now shared because both adapters call [`open`]).
///
/// Sync — both callers of [`open`] already hop to a blocking thread around
/// the whole `open`/`open_lts_file` dispatch.
fn open_file(
    ctx: &ServiceCtx,
    path: &str,
    source_type_override: Option<SourceType>,
) -> Result<Vec<LoadResult>, ServiceError> {
    let path_obj = Path::new(path);
    let state = ctx.state();

    let (effective_path, _temp_file) = if path_obj.extension().and_then(|e| e.to_str()) == Some("zip") {
        let extracted = extract_bugreport_from_zip(path_obj)?;
        let p = extracted.path().to_string_lossy().to_string();
        (p, Some(extracted))
    } else {
        (path.to_string(), None)
    };
    let effective_path_obj = Path::new(&effective_path);

    let file_size = std::fs::metadata(effective_path_obj)
        .map(|m| m.len())
        .map_err(|e| ServiceError::Internal(format!("Failed to read metadata for {effective_path}: {e}")))?;

    let override_label = source_type_override.as_ref().map(ToString::to_string);
    let session_id = crate::core::session_identity::derive_file_session_id_from_disk(
        path_obj,
        override_label.as_deref(),
    );
    let source_id = path_obj
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("source")
        .to_string();

    let rescued = rescue_artifacts_for_replacement(ctx, path_obj, path, &session_id)?;

    let closed_ids = close_stale_sessions(ctx, path)?;

    for stale_id in closed_ids.iter().filter(|id| *id != &session_id) {
        emit_session_closed(ctx, stale_id);
    }

    const INITIAL_BYTES: usize = 1_000_000;

    let mut session = AnalysisSession::new(session_id.clone());
    session.file_path = Some(path.to_string());
    session.source_type_override = override_label;
    session.temp_file = _temp_file;
    let (mmap_weak, total_bytes, bytes_consumed) = session
        .add_source_partial_typed(effective_path_obj, source_id.clone(), INITIAL_BYTES, source_type_override)
        .map_err(ServiceError::Internal)?;

    let source = session
        .primary_source()
        .ok_or_else(|| ServiceError::Internal("No source after partial load".to_string()))?;
    let total_lines = source.total_lines();
    let first_ts = source.first_timestamp();
    let last_ts = source.last_timestamp();
    let source_type_str = source.source_type().to_string();
    let source_name = source.name().to_string();
    let is_indexing = source.is_indexing();
    let has_crlf = source.has_crlf();
    let source_type = source.source_type().clone();
    let encoding = source.encoding();

    let result = LoadResult {
        session_id: session_id.clone(),
        source_id,
        source_name,
        file_path: Some(path.to_string()),
        total_lines,
        file_size,
        first_timestamp: first_ts,
        last_timestamp: last_ts,
        source_type: source_type_str,
        is_streaming: false,
        is_indexing,
        has_crlf,
        encoding: encoding.display_name().to_string(),
    };

    let session_generation = session.generation();

    {
        let mut sessions = lock_svc(&state.sessions, "sessions")?;
        sessions.insert(session_id.clone(), session);
    }

    rescued.restore_onto(ctx, &session_id)?;

    if is_indexing {
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        {
            let mut tasks = lock_svc(&state.indexing_tasks, "indexing_tasks")?;
            tasks.insert(session_id.clone(), cancel_tx);
        }
        let ctx_for_indexer = ctx.clone();
        let sid = session_id;
        let initial_line_count = total_lines;
        ctx.spawner().spawn(Box::pin(async move {
            run_background_indexer(
                ctx_for_indexer,
                sid,
                mmap_weak,
                source_type,
                encoding,
                bytes_consumed,
                total_bytes,
                initial_line_count,
                session_generation,
                cancel_rx,
            )
            .await;
        }));
    }

    Ok(vec![result])
}

/// Open a `.lts` multi-session bundle. Moved verbatim from
/// `commands::files::load_lts_file_inner`.
fn open_lts_file(ctx: &ServiceCtx, lts_path: &str) -> Result<Vec<LoadResult>, ServiceError> {
    let path_obj = Path::new(lts_path);

    let lts = crate::workspace::lts::read_lts(path_obj).map_err(ServiceError::Internal)?;

    if lts.sessions.is_empty() {
        return Err(ServiceError::invalid_arg("No sessions in .lts file"));
    }

    close_stale_sessions(ctx, lts_path)?;

    let file_size = path_obj.metadata().map(|m| m.len()).unwrap_or(0);

    let crate::workspace::lts::LtsData { sessions, processor_manifest, processor_yamls, editor_tabs, .. } = lts;

    let mut results = Vec::with_capacity(sessions.len());
    // Every session id this import has actually inserted into `state.sessions`
    // so far — used to roll the whole import back if a later entry fails. Only
    // ids that made it past the insert below are pushed here; an entry that
    // fails before inserting (bad zip bytes, no primary source) leaves nothing
    // of its own to clean up, but every *earlier* entry in this same import
    // must still be torn down rather than left stranded in `AppState`.
    let mut inserted_session_ids: Vec<String> = Vec::with_capacity(sessions.len());

    for (entry_index, session_data) in sessions.into_iter().enumerate() {
        match import_lts_session_entry(
            ctx,
            path_obj,
            lts_path,
            file_size,
            entry_index,
            session_data,
            &processor_manifest,
            &processor_yamls,
        ) {
            Ok((session_id, result)) => {
                inserted_session_ids.push(session_id);
                results.push(result);
            }
            Err(e) => {
                // Roll back every session this import inserted — reuses the
                // same cleanup `close_stale_sessions` relies on so all its
                // steps (stream/indexing tasks, pipeline/tracker/correlator
                // results, bookmarks, watches, filters, lts-scoped processors,
                // ...) run, rather than hand-rolling a partial `sessions.remove`.
                for sid in &inserted_session_ids {
                    let _ = close_session_state(ctx, sid);
                }
                return Err(e);
            }
        }
    }

    if !editor_tabs.is_empty() {
        ctx.events().emit_json(
            "lts-editor-tabs",
            serde_json::to_value(&editor_tabs).unwrap_or_default(),
        );
    }

    Ok(results)
}

/// Import one entry of a `.lts` bundle: build its session, insert it into
/// `AppState`, restore its artifacts, and record its pipeline meta. Returns
/// the new session id (so the caller can track it for rollback) alongside the
/// `LoadResult` to surface. Split out of `open_lts_file`'s loop body so a
/// later entry's failure can roll back every entry already inserted by this
/// same import instead of leaving them stranded.
#[allow(clippy::too_many_arguments)]
fn import_lts_session_entry(
    ctx: &ServiceCtx,
    path_obj: &Path,
    lts_path: &str,
    file_size: u64,
    entry_index: usize,
    session_data: crate::workspace::lts::LtsSessionData,
    processor_manifest: &crate::workspace::lts::LtsProcessorManifest,
    processor_yamls: &std::collections::HashMap<String, String>,
) -> Result<(String, LoadResult), ServiceError> {
    let state = ctx.state();
    let session_id = crate::core::session_identity::derive_lts_session_id(path_obj, entry_index);

    let bare_to_scoped: std::collections::HashMap<String, String> =
        crate::commands::export::resolve_lts_processors_raw(
            state,
            processor_manifest,
            processor_yamls,
            &session_id,
        )
        .map_err(ServiceError::Internal)?
        .into_iter()
        .collect();

    let source_id = std::path::Path::new(&session_data.source_filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("lts-source")
        .to_string();

    let mut session = crate::core::session::AnalysisSession::new(session_id.clone());
    session.file_path = Some(lts_path.to_string());

    let source_filename = session_data.source_filename.clone();
    session
        .add_zip_source(session_data.source_bytes, source_id.clone(), source_filename)
        .map_err(ServiceError::Internal)?;

    let source = session
        .primary_source()
        .ok_or_else(|| ServiceError::Internal("No source after zip load".to_string()))?;
    let total_lines = source.total_lines();
    let first_ts = source.first_timestamp();
    let last_ts = source.last_timestamp();
    let source_type_str = source.source_type().to_string();
    let source_name = source.name().to_string();
    let has_crlf = source.has_crlf();
    let encoding = source.encoding().display_name().to_string();

    let result = LoadResult {
        session_id: session_id.clone(),
        source_id,
        source_name,
        file_path: Some(lts_path.to_string()),
        total_lines,
        file_size,
        first_timestamp: first_ts,
        last_timestamp: last_ts,
        source_type: source_type_str,
        is_streaming: false,
        is_indexing: false,
        has_crlf,
        encoding,
    };

    {
        let mut sessions = lock_svc(&state.sessions, "sessions")?;
        sessions.insert(session_id.clone(), session);
    }

    let (bm_count, an_count) = crate::commands::files::restore_artifacts(
        state,
        &session_id,
        session_data.bookmarks,
        session_data.analyses,
    );

    let mut meta: crate::workspace::SessionMeta = session_data.session_meta.into();
    let remap = |ids: &[String]| -> Vec<String> {
        ids.iter().map(|id| bare_to_scoped.get(id).cloned().unwrap_or_else(|| id.clone())).collect()
    };
    meta.active_processor_ids = remap(&meta.active_processor_ids);
    meta.disabled_processor_ids = remap(&meta.disabled_processor_ids);

    emit_workspace_restored(ctx, &session_id, bm_count, an_count, meta, "lts");

    Ok((session_id, result))
}

/// Store pipeline meta in `AppState` and emit `workspace-restored`.
///
/// Shared by the `.lts` bundle import above (`source = "lts"`) and by
/// [`super::workspace::restore_session`] (`source = "workspace"`), so it is
/// the single emit site for this event. The payload is the typed
/// [`super::workspace::WorkspaceRestoredEvent`] — field-for-field identical to
/// the ad hoc `serde_json::json!{}` it replaced, so the frontend listener is
/// unchanged.
pub(crate) fn emit_workspace_restored(
    ctx: &ServiceCtx,
    session_id: &str,
    bm_count: usize,
    an_count: usize,
    meta: crate::workspace::SessionMeta,
    source: &str,
) {
    let has_chain = !meta.active_processor_ids.is_empty();
    if has_chain {
        let mut map = ctx
            .state()
            .session_pipeline_meta
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        map.insert(session_id.to_string(), meta.clone());
    }

    if bm_count > 0 || an_count > 0 || has_chain {
        ctx.events().emit_json(
            "workspace-restored",
            serde_json::to_value(super::workspace::WorkspaceRestoredEvent {
                session_id: session_id.to_string(),
                bookmark_count: bm_count,
                analysis_count: an_count,
                active_processor_ids: meta.active_processor_ids,
                disabled_processor_ids: meta.disabled_processor_ids,
                source: source.to_string(),
            })
            .unwrap_or_default(),
        );
    }
}

/// Close **all** sessions whose `file_path` refers to the same on-disk file as
/// `path`. Moved verbatim from `commands::files::close_stale_sessions`.
/// Returns the ids actually closed WITHOUT emitting `session-closed` — the
/// caller ([`open_file`]) decides which of those to notify the frontend about
/// (not the one about to be reused under the same id).
fn close_stale_sessions(ctx: &ServiceCtx, path: &str) -> Result<Vec<String>, ServiceError> {
    let incoming_canonical = crate::commands::bridge_access::canonical_compare_form(Path::new(path));
    let stale_ids: Vec<String> = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        sessions
            .values()
            .filter(|s| {
                s.file_path
                    .as_deref()
                    .is_some_and(|stored| stale_path_matches(stored, path, incoming_canonical.as_deref()))
            })
            .map(|s| s.id.clone())
            .collect()
    };
    for stale_id in &stale_ids {
        close_session_state(ctx, stale_id)?;
    }
    Ok(stale_ids)
}

/// True if a stored session `file_path` refers to the same on-disk file as the
/// `incoming` open path. Moved verbatim from `commands::files::stale_path_matches`.
fn stale_path_matches(stored: &str, incoming: &str, incoming_canonical: Option<&str>) -> bool {
    match (
        crate::commands::bridge_access::canonical_compare_form(Path::new(stored)),
        incoming_canonical,
    ) {
        (Some(stored_canonical), Some(incoming_canonical)) => stored_canonical == incoming_canonical,
        _ => stored == incoming,
    }
}

/// Bookmarks/pipeline-meta lifted off a session about to be replaced by a
/// reopen of the same file, so they can be re-keyed onto the new session id.
/// Moved verbatim from `commands::files::RescuedArtifacts`.
#[derive(Default)]
struct RescuedArtifacts {
    bookmarks: Vec<crate::core::bookmark::Bookmark>,
    pipeline_meta: Option<crate::workspace::SessionMeta>,
}

impl RescuedArtifacts {
    fn is_empty(&self) -> bool {
        self.bookmarks.is_empty() && self.pipeline_meta.is_none()
    }

    fn restore_onto(self, ctx: &ServiceCtx, session_id: &str) -> Result<(), ServiceError> {
        if self.is_empty() {
            return Ok(());
        }
        crate::commands::files::restore_artifacts(ctx.state(), session_id, self.bookmarks, vec![]);
        if let Some(meta) = self.pipeline_meta {
            let mut pm = lock_svc(&ctx.state().session_pipeline_meta, "session_pipeline_meta")?;
            pm.insert(session_id.to_string(), meta);
        }
        Ok(())
    }
}

/// Take the bookmarks/pipeline-meta of every session bound to `path` whose id
/// can still be reproduced from the file's current bytes, and restamp
/// workspace analysis references from those old ids onto `new_session_id`.
/// Moved verbatim from `commands::files::rescue_artifacts_for_replacement`.
fn rescue_artifacts_for_replacement(
    ctx: &ServiceCtx,
    path_obj: &Path,
    path: &str,
    new_session_id: &str,
) -> Result<RescuedArtifacts, ServiceError> {
    let candidates: Vec<(String, Option<String>)> = {
        let incoming_canonical = crate::commands::bridge_access::canonical_compare_form(path_obj);
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        sessions
            .values()
            .filter(|s| {
                s.file_path
                    .as_deref()
                    .is_some_and(|stored| stale_path_matches(stored, path, incoming_canonical.as_deref()))
            })
            .map(|s| (s.id.clone(), s.source_type_override.clone()))
            .collect()
    };

    let migratable: Vec<String> = candidates
        .into_iter()
        .filter(|(id, override_label)| {
            crate::core::session_identity::derive_file_session_id_from_disk(path_obj, override_label.as_deref())
                == *id
        })
        .map(|(id, _)| id)
        .collect();

    crate::commands::files::restamp_analysis_references(ctx.state(), &migratable, new_session_id)
        .map_err(ServiceError::Internal)?;

    if migratable.is_empty() {
        return Ok(RescuedArtifacts::default());
    }

    let mut out = RescuedArtifacts::default();
    {
        let mut bm = lock_svc(&ctx.state().bookmarks, "bookmarks")?;
        for id in &migratable {
            if let Some(v) = bm.remove(id) {
                out.bookmarks.extend(v);
            }
        }
    }
    {
        let mut pm = lock_svc(&ctx.state().session_pipeline_meta, "session_pipeline_meta")?;
        for id in &migratable {
            if let Some(m) = pm.remove(id) {
                out.pipeline_meta = Some(m);
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

/// Close a session: stop its stream/indexer, purge every session-keyed map,
/// emit `session-closed`, and journal `session.close` — for either caller.
///
/// Unlike the historical UI command (which never emitted `session-closed`,
/// on the theory that the UI already knows it initiated the close), this
/// always emits. The frontend's listener closes whatever pane/tab is bound
/// to the session id, which is idempotent for a close the UI itself just
/// requested.
pub fn close(ctx: &ServiceCtx, session_id: &str) -> Result<(), ServiceError> {
    close_session_state(ctx, session_id)?;
    emit_session_closed(ctx, session_id);
    ctx.journal("session.close", Some(session_id), format!("closed {session_id}"));
    Ok(())
}

/// The pure state-cleanup half of [`close`] — no event emission, no journal.
/// Moved verbatim from `commands::files::close_session_inner` (which took an
/// `Option<&AppHandle>` parameter that was already unused — dropped here).
/// Used both by the public [`close`] and internally by [`close_stale_sessions`],
/// which decides on its own whether the replaced session should be announced
/// to the frontend (never for the id about to be reused).
fn close_session_state(ctx: &ServiceCtx, session_id: &str) -> Result<(), ServiceError> {
    let state = ctx.state();

    if let Some(cancel_tx) = lock_svc(&state.stream_tasks, "stream_tasks")?.remove(session_id) {
        let _ = cancel_tx.send(());
    }

    if let Some(cancel_tx) = lock_svc(&state.indexing_tasks, "indexing_tasks")?.remove(session_id) {
        let _ = cancel_tx.send(());
    }

    lock_svc(&state.sessions, "sessions")?.remove(session_id);

    lock_svc(&state.state_tracker_results, "state_tracker_results")?.remove(session_id);

    lock_svc(&state.correlator_results, "correlator_results")?.remove(session_id);

    // `clear_stream_epoch_with`'s closure is fixed to `Result<(), String>` by
    // `commands::mod.rs` (not owned here) — keep `lock_or_err` inside it and
    // map the whole call at the boundary.
    state
        .clear_stream_epoch_with(session_id, || {
            lock_or_err(&state.pipeline_results, "pipeline_results")?.remove(session_id);
            lock_or_err(&state.stream_processor_state, "stream_processor_state")?.remove(session_id);
            lock_or_err(&state.stream_tracker_state, "stream_tracker_state")?.remove(session_id);
            lock_or_err(&state.stream_transformer_state, "stream_transformer_state")?.remove(session_id);
            lock_or_err(&state.pii_mappings, "pii_mappings")?.remove(session_id);
            Ok(())
        })
        .map_err(ServiceError::Internal)?;

    lock_svc(&state.mcp_anonymizers, "mcp_anonymizers")?.remove(session_id);
    lock_svc(&state.stream_excluded_processors, "stream_excluded_processors")?.remove(session_id);

    lock_svc(&state.bookmarks, "bookmarks")?.remove(session_id);
    lock_svc(&state.session_pipeline_meta, "session_pipeline_meta")?.remove(session_id);

    let lts_suffix = format!(
        "{}{}{}",
        crate::processors::marketplace::NAMESPACE_SEP,
        crate::processors::marketplace::LTS_NS_PREFIX,
        session_id,
    );
    lock_svc(&state.processors, "processors")?.retain(|key, _| !key.ends_with(&lts_suffix));
    lock_svc(&state.lts_processor_yamls, "lts_processor_yamls")?.retain(|key, _| !key.ends_with(&lts_suffix));

    lock_svc(&state.active_watches, "active_watches")?.remove(session_id);

    lock_svc(&state.active_filters, "active_filters")?.retain(|_, filter| {
        if filter.session_id == session_id {
            filter.cancel();
            false
        } else {
            true
        }
    });

    lock_svc(&state.pipeline_run_locks, "pipeline_run_locks")?.remove(session_id);

    Ok(())
}

// ---------------------------------------------------------------------------
// Background indexer
// ---------------------------------------------------------------------------

/// Decide whether the background indexer should stop. Moved verbatim from
/// `commands::files::indexer_cancelled`.
fn indexer_cancelled(recv: Result<(), tokio::sync::oneshot::error::TryRecvError>) -> bool {
    !matches!(recv, Err(tokio::sync::oneshot::error::TryRecvError::Empty))
}

/// Moved from `commands::files::run_background_indexer`. `ctx` is owned
/// (moved into the spawned future by [`open_file`] via `ctx.spawner()`)
/// rather than resolved from an `AppHandle` — progress ticks and the
/// completion notice go through `ctx.events()` instead of `app.emit`.
#[allow(clippy::too_many_arguments)]
async fn run_background_indexer(
    ctx: ServiceCtx,
    session_id: String,
    mmap: Weak<Mmap>,
    source_type: SourceType,
    encoding: Encoding,
    start_byte: usize,
    total_bytes: usize,
    initial_line_count: usize,
    expected_generation: u64,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) {
    const CHUNK_BYTES: usize = 8_000_000;

    let state = ctx.state();
    let parser = parser_for(&source_type);

    if matches!(source_type, SourceType::Bugreport | SourceType::Dumpstate) && start_byte > 0 {
        let initial_text = {
            let Ok(sessions) = state.sessions.lock() else { return };
            let Some(session) = sessions.get(&session_id) else { return };
            if session.generation() != expected_generation {
                return;
            }
            let Some(mmap_strong) = mmap.upgrade() else { return };
            let data: &[u8] = mmap_strong.as_ref();
            let end = start_byte.min(data.len());
            if encoding.is_utf16() {
                crate::core::log_source::decode_utf16_bytes(
                    &data[encoding.bom_len()..end],
                    encoding == Encoding::Utf16Be,
                ).unwrap_or_default()
            } else {
                std::str::from_utf8(&data[..end]).unwrap_or("").to_string()
            }
        };
        for line in initial_text.lines() {
            if line.trim_start().starts_with("== dumpstate:") {
                let _ = parser.parse_meta(line.trim(), 0);
                break;
            }
        }
    }

    let mut cursor = start_byte;
    let mut total_indexed: usize = initial_line_count;

    while cursor < total_bytes {
        if indexer_cancelled(cancel_rx.try_recv()) {
            return;
        }

        let (chunk_line_count, bytes_in_chunk) = {
            let Ok(mut sessions) = state.sessions.lock() else { return };
            let Some(session) = sessions.get_mut(&session_id) else { return };

            if session.generation() != expected_generation {
                return;
            }

            let Some(mmap_strong) = mmap.upgrade() else { return };
            let data: &[u8] = mmap_strong.as_ref();

            if cursor >= data.len() {
                (0usize, 0usize)
            } else {
                let remaining = &data[cursor..];
                let (mut chunk_index, mut chunk_meta, bytes_in_chunk) =
                    crate::core::session::build_partial_line_index(
                        remaining,
                        parser.as_ref(),
                        &mut session.tag_interner,
                        CHUNK_BYTES,
                        encoding,
                    );

                if bytes_in_chunk == 0 {
                    (0usize, 0usize)
                } else {
                    let sentinel = crate::core::session::adjust_and_strip_sentinel(
                        &mut chunk_index, &mut chunk_meta, cursor, bytes_in_chunk,
                    );

                    let new_cursor = cursor + bytes_in_chunk;
                    let done = new_cursor >= total_bytes;
                    let chunk_line_count = chunk_meta.len();

                    session.extend_source_index(chunk_index, chunk_meta, sentinel, done);

                    (chunk_line_count, bytes_in_chunk)
                }
            }
        };

        if bytes_in_chunk == 0 {
            break;
        }

        cursor += bytes_in_chunk;
        let done = cursor >= total_bytes;
        total_indexed += chunk_line_count;

        let ev = ProgressEvent::Index(IndexProgressEvent {
            session_id: session_id.clone(),
            indexed_lines: total_indexed,
            bytes_scanned: cursor,
            total_bytes,
        });
        ctx.events().emit_json(ev.event_name(), ev.payload());

        if done {
            ctx.events().emit_json(
                "file-index-complete",
                serde_json::to_value(FileIndexComplete {
                    session_id: session_id.clone(),
                    total_lines: total_indexed,
                })
                .unwrap_or_default(),
            );
            if let Ok(mut tasks) = state.indexing_tasks.lock() {
                tasks.remove(&session_id);
            }
            return;
        }

        tokio::task::yield_now().await;
    }
}

// ---------------------------------------------------------------------------
// list / metadata / status
// ---------------------------------------------------------------------------

/// One session's source entry, as `GET /mcp/sessions` renders it.
#[derive(Debug)]
pub struct SessionSourceInfo {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub total_lines: usize,
    /// Absolute source-file path (null for ADB streams).
    pub path: Option<String>,
}

/// One `GET /mcp/sessions` entry.
#[derive(Debug)]
pub struct SessionListEntry {
    pub id: String,
    pub sources: Vec<SessionSourceInfo>,
    pub focused: bool,
}

/// One entry of the installed-processors summary `GET /mcp/sessions` renders.
#[derive(Debug)]
pub struct InstalledProcessorInfo {
    pub id: String,
    pub name: String,
    pub processor_type: String,
}

/// Everything `GET /mcp/sessions` needs. Plain data, not `#[derive(TS)]` —
/// the route still renders today's ad hoc JSON shape (WP-13 unifies it).
#[derive(Debug)]
pub struct SessionsOverview {
    pub sessions: Vec<SessionListEntry>,
    pub processors_with_results: Vec<String>,
    pub installed_processors: Vec<InstalledProcessorInfo>,
}

/// List every open session plus which processors have results and which are
/// installed. Moved from `mcp_bridge::routes::sessions::h_sessions`.
pub fn list(ctx: &ServiceCtx) -> Result<SessionsOverview, ServiceError> {
    let state = ctx.state();

    let focused_session_id: Option<String> =
        state.focused_session.lock().map(|f| f.clone()).unwrap_or(None);

    let sessions: Vec<SessionListEntry> = {
        let sessions_map = lock_svc(&state.sessions, "sessions")?;
        sessions_map
            .values()
            .map(|session| {
                let sources = session
                    .primary_source()
                    .map(|src| {
                        vec![SessionSourceInfo {
                            id: src.id().to_string(),
                            name: src.name().to_string(),
                            source_type: src.source_type().to_string(),
                            total_lines: src.total_lines(),
                            path: session.file_path.clone(),
                        }]
                    })
                    .unwrap_or_default();
                SessionListEntry {
                    id: session.id.clone(),
                    sources,
                    focused: focused_session_id.as_deref() == Some(session.id.as_str()),
                }
            })
            .collect()
    };

    let processors_with_results: Vec<String> = {
        let results = lock_svc(&state.pipeline_results, "pipeline_results")?;
        let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for session_map in results.values() {
            ids.extend(session_map.keys().cloned());
        }
        ids.into_iter().collect()
    };

    let installed_processors: Vec<InstalledProcessorInfo> = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        procs
            .values()
            .map(|p| InstalledProcessorInfo {
                id: p.meta.id.clone(),
                name: p.meta.name.clone(),
                processor_type: p.processor_type().to_string(),
            })
            .collect()
    };

    Ok(SessionsOverview { sessions, processors_with_results, installed_processors })
}

/// Everything `GET /mcp/status` needs beyond the trivially-known `running`
/// (always true — the bridge is answering) and `port` constant. Moved from
/// `mcp_bridge::routes::sessions::h_status`.
#[derive(Debug)]
pub struct BridgeStatus {
    pub session_ids: Vec<String>,
    pub installed_processor_count: usize,
}

pub fn bridge_status(ctx: &ServiceCtx) -> Result<BridgeStatus, ServiceError> {
    let state = ctx.state();
    let session_ids: Vec<String> = {
        let sessions = lock_svc(&state.sessions, "sessions")?;
        sessions.keys().cloned().collect()
    };
    let installed_processor_count = {
        let procs = state.processors.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        procs.len()
    };
    Ok(BridgeStatus { session_ids, installed_processor_count })
}

/// Bridge running/idle status for the desktop UI's status pill. Moved
/// verbatim from `commands::session::get_mcp_status`.
pub fn mcp_status(ctx: &ServiceCtx) -> crate::commands::session::McpStatus {
    let state = ctx.state();
    let port = state.mcp_bridge_port.lock().map(|p| *p).unwrap_or(None);
    let idle_secs = state
        .mcp_last_activity
        .lock()
        .ok()
        .and_then(|ts| *ts)
        .map(|t| t.elapsed().as_secs() as u32);
    // One computation of "are agents raw right now", shared with
    // `GET /mcp/settings/agent_access` so the pill and the agent agree.
    let access = super::settings::agent_access(ctx).unwrap_or_default();
    crate::commands::session::McpStatus {
        running: port.is_some(),
        port: port.unwrap_or(crate::mcp_bridge::PORT),
        idle_secs,
        agent_raw_access: access.agent_raw_access,
        anonymizer_mode: access.anonymizer_mode,
        effective_agent_raw: access.effective_agent_raw,
    }
}

/// Rich per-session metadata (level distribution, top tags) for
/// `get_session_metadata` — the UI/agent Tauri command. Moved verbatim from
/// `commands::session::get_session_metadata`.
///
/// Deliberately separate from [`bridge_metadata`]: that route has never
/// scanned every line for level/tag distribution, and folding the two into
/// one function would make every `GET .../metadata` call over the bridge pay
/// for a scan it never needed.
pub fn metadata(
    ctx: &ServiceCtx,
    session_id: &str,
) -> Result<crate::commands::session::SessionMetadata, ServiceError> {
    let state = ctx.state();
    let sessions = lock_svc(&state.sessions, "sessions")?;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| ServiceError::session_not_found(session_id))?;

    let source = session
        .primary_source()
        .ok_or_else(|| ServiceError::Internal("No source in session".to_string()))?;

    let total_lines = source.total_lines();
    let first_ts = source.first_timestamp();
    let last_ts = source.last_timestamp();

    let file_size = if let Some(file_src) = session.file_source() {
        file_src.mmap().len() as u64
    } else if let Some(stream_src) = session.stream_source() {
        stream_src.stream_byte_count()
    } else {
        0
    };

    let mut level_dist: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut tag_counts: std::collections::HashMap<u16, usize> = std::collections::HashMap::new();

    for meta in source.line_meta_slice() {
        *level_dist.entry(format!("{:?}", meta.level)).or_insert(0) += 1;
        *tag_counts.entry(meta.tag_id).or_insert(0) += 1;
    }

    let mut top_tags: Vec<crate::commands::session::TagCount> = tag_counts
        .into_iter()
        .map(|(tag_id, count)| crate::commands::session::TagCount {
            tag: session.resolve_tag(tag_id).to_string(),
            count,
        })
        .collect();
    top_tags.sort_by(|a, b| b.count.cmp(&a.count));
    top_tags.truncate(50);

    Ok(crate::commands::session::SessionMetadata {
        session_id: session_id.to_string(),
        source_name: source.name().to_string(),
        source_type: source.source_type().to_string(),
        total_lines,
        file_size,
        is_live: source.is_live(),
        is_indexing: source.is_indexing(),
        first_timestamp: first_ts,
        last_timestamp: last_ts,
        log_level_distribution: level_dist,
        top_tags,
    })
}

/// The light per-session metadata `GET /mcp/sessions/{id}/metadata` has
/// always returned — no level/tag scan, but a section count the rich
/// [`metadata`] does not compute. Moved from
/// `mcp_bridge::routes::sessions::h_metadata`.
#[derive(Debug)]
pub struct BridgeSessionMetadata {
    pub source_name: String,
    pub source_type: String,
    pub total_lines: usize,
    pub file_size: u64,
    pub is_live: bool,
    pub is_indexing: bool,
    pub first_timestamp: Option<i64>,
    pub last_timestamp: Option<i64>,
    pub section_count: usize,
}

pub fn bridge_metadata(ctx: &ServiceCtx, session_id: &str) -> Result<BridgeSessionMetadata, ServiceError> {
    let state = ctx.state();
    let sessions = lock_svc(&state.sessions, "sessions")?;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| ServiceError::NotFound(format!("Session not found: {session_id}")))?;
    let source = session
        .primary_source()
        .ok_or_else(|| ServiceError::Internal(format!("Session has no sources: {session_id}")))?;

    let file_size = if let Some(file_src) = session.file_source() {
        file_src.mmap().len() as u64
    } else if let Some(stream_src) = session.stream_source() {
        stream_src.stream_byte_count()
    } else {
        0
    };

    Ok(BridgeSessionMetadata {
        source_name: source.name().to_string(),
        source_type: source.source_type().to_string(),
        total_lines: source.total_lines(),
        file_size,
        is_live: source.is_live(),
        is_indexing: source.is_indexing(),
        first_timestamp: source.first_timestamp(),
        last_timestamp: source.last_timestamp(),
        section_count: source.sections().len(),
    })
}

/// Record which session is the frontend's currently focused pane session.
pub fn set_focused(ctx: &ServiceCtx, session_id: Option<String>) -> Result<(), ServiceError> {
    let mut focused = lock_svc(&ctx.state().focused_session, "focused_session")?;
    *focused = session_id;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;
    use crate::services::Caller;
    use std::io::Write;
    use std::sync::Arc;

    fn sample_bookmark(id: &str, session_id: &str, line: u32) -> crate::core::bookmark::Bookmark {
        use crate::core::bookmark::{Bookmark, CreatedBy};
        Bookmark {
            id: id.to_string(),
            session_id: session_id.to_string(),
            line_number: line,
            line_number_end: None,
            snippet: None,
            category: None,
            tags: None,
            label: "Test".to_string(),
            note: String::new(),
            created_by: CreatedBy::User,
            created_at: 1000,
        }
    }

    fn insert_session(ctx: &ServiceCtx, id: &str, file_path: Option<&str>) {
        let mut session = AnalysisSession::new(id.to_string());
        session.file_path = file_path.map(str::to_string);
        ctx.state().sessions.lock().unwrap().insert(id.to_string(), session);
    }

    // ── indexer_cancelled ────────────────────────────────────────────────────

    #[test]
    fn indexer_cancelled_treats_ok_and_closed_as_cancel() {
        use tokio::sync::oneshot::error::TryRecvError;
        assert!(indexer_cancelled(Ok(())));
        assert!(indexer_cancelled(Err(TryRecvError::Closed)));
        assert!(!indexer_cancelled(Err(TryRecvError::Empty)));
    }

    #[test]
    fn indexer_cancelled_on_dropped_sender_via_channel() {
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        drop(tx);
        assert!(indexer_cancelled(rx.try_recv()), "dropped sender must cancel");

        let (_tx, mut rx2) = tokio::sync::oneshot::channel::<()>();
        assert!(!indexer_cancelled(rx2.try_recv()), "live+empty must not cancel");

        let (tx3, mut rx3) = tokio::sync::oneshot::channel::<()>();
        tx3.send(()).unwrap();
        assert!(indexer_cancelled(rx3.try_recv()), "signalled must cancel");
    }

    // ── close / close_session_state ──────────────────────────────────────────

    #[test]
    fn close_removes_session_from_map() {
        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "sess-1", None);
        assert!(ctx.state().sessions.lock().unwrap().contains_key("sess-1"));

        close(&ctx, "sess-1").unwrap();

        assert!(!ctx.state().sessions.lock().unwrap().contains_key("sess-1"));
    }

    #[test]
    fn close_emits_session_closed_once_with_session_id() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        insert_session(&ctx, "sess-1", None);

        close(&ctx, "sess-1").unwrap();

        let payload = sink.only_event("session-closed");
        assert_eq!(payload["sessionId"], "sess-1");
    }

    #[test]
    fn close_journals_for_the_calling_caller() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        insert_session(&ctx, "sess-1", None);

        close(&ctx, "sess-1").unwrap();

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "session.close");
        assert_eq!(activity[0].caller, Caller::agent("claude-code"));
    }

    #[test]
    fn close_sends_indexing_cancellation() {
        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "sess-2", None);
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
        ctx.state().indexing_tasks.lock().unwrap().insert("sess-2".to_string(), cancel_tx);

        close(&ctx, "sess-2").unwrap();

        assert!(cancel_rx.try_recv().is_ok());
    }

    #[test]
    fn close_removes_pipeline_results() {
        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "sess-3", None);
        ctx.state().pipeline_results.lock().unwrap().insert("sess-3".to_string(), Default::default());

        close(&ctx, "sess-3").unwrap();

        assert!(!ctx.state().pipeline_results.lock().unwrap().contains_key("sess-3"));
    }

    #[test]
    fn close_removes_pipeline_run_lock() {
        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "sess-runlock", None);
        let _ = ctx.state().pipeline_run_lock("sess-runlock").unwrap();
        assert!(ctx.state().pipeline_run_locks.lock().unwrap().contains_key("sess-runlock"));

        close(&ctx, "sess-runlock").unwrap();

        assert!(!ctx.state().pipeline_run_locks.lock().unwrap().contains_key("sess-runlock"));
    }

    #[test]
    fn close_is_noop_on_unknown_id() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(close(&ctx, "nonexistent").is_ok());
    }

    #[test]
    fn close_drops_mmap_so_file_can_be_renamed() {
        let (ctx, _tmp) = test_ctx().build();
        let id = "mmap-drop-sess";

        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let mut temp_path = std::env::temp_dir();
        temp_path.push(format!("logtapper_close_mmap_{unique}.log"));
        std::fs::write(
            &temp_path,
            "01-01 00:00:00.000  1000  1000 I TestTag: first line\n\
             01-01 00:00:00.001  1000  1000 I TestTag: second line\n",
        ).expect("write temp log file");

        let weak_mmap = {
            let mut session = AnalysisSession::new(id.to_string());
            session.file_path = Some(temp_path.to_string_lossy().to_string());
            let (weak_mmap, _, _) = session
                .add_source_partial(&temp_path, "src-0".to_string(), 1_000_000)
                .expect("add_source_partial should open + index the file");
            ctx.state().sessions.lock().unwrap().insert(id.to_string(), session);
            weak_mmap
        };
        assert!(weak_mmap.upgrade().is_some(), "precondition: mmap must be live before close");

        close(&ctx, id).unwrap();

        assert!(!ctx.state().sessions.lock().unwrap().contains_key(id));
        assert!(weak_mmap.upgrade().is_none(), "Weak<Mmap> must not upgrade after close");

        let moved_path = temp_path.with_extension("moved");
        let _ = std::fs::remove_file(&moved_path);
        std::fs::rename(&temp_path, &moved_path)
            .expect("rename must succeed after close — a lingering mmap keeps the file locked on Windows");
        let _ = std::fs::remove_file(&moved_path);
    }

    #[test]
    fn close_removes_bookmarks_but_keeps_analyses() {
        use crate::core::analysis::AnalysisArtifact;

        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "sess-bm", None);
        ctx.state().bookmarks.lock().unwrap().insert("sess-bm".to_string(), vec![sample_bookmark("bm-1", "sess-bm", 42)]);
        ctx.state().analyses.lock().unwrap().push(AnalysisArtifact {
            id: "art-1".to_string(),
            title: "Test".to_string(),
            created_at: 2000,
            sections: vec![],
            legacy_session_id: None,
        });

        close(&ctx, "sess-bm").unwrap();

        assert!(!ctx.state().bookmarks.lock().unwrap().contains_key("sess-bm"));
        assert_eq!(ctx.state().analyses.lock().unwrap().len(), 1, "analyses are workspace-owned and survive");
    }

    #[test]
    fn close_cleans_up_pipeline_meta() {
        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "sess-pm", None);
        ctx.state().session_pipeline_meta.lock().unwrap().insert(
            "sess-pm".to_string(),
            crate::workspace::SessionMeta { active_processor_ids: vec!["proc-a".to_string()], disabled_processor_ids: vec![] },
        );

        close(&ctx, "sess-pm").unwrap();

        assert!(!ctx.state().session_pipeline_meta.lock().unwrap().contains_key("sess-pm"));
    }

    #[test]
    fn close_removes_watches() {
        use crate::core::filter::FilterCriteria;
        use crate::core::watch::WatchSession;

        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "sess-w", None);
        insert_session(&ctx, "sess-w-other", None);
        {
            let mut watches = ctx.state().active_watches.lock().unwrap();
            watches.insert("sess-w".to_string(), vec![Arc::new(WatchSession::new("watch-1".to_string(), "sess-w".to_string(), FilterCriteria::default()).unwrap())]);
            watches.insert("sess-w-other".to_string(), vec![Arc::new(WatchSession::new("watch-2".to_string(), "sess-w-other".to_string(), FilterCriteria::default()).unwrap())]);
        }

        close(&ctx, "sess-w").unwrap();

        let watches = ctx.state().active_watches.lock().unwrap();
        assert!(!watches.contains_key("sess-w"));
        assert!(watches.contains_key("sess-w-other"));
    }

    #[test]
    fn close_removes_and_cancels_filters() {
        use crate::core::filter::{FilterCriteria, FilterSession};

        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "sess-f", None);
        let closed_filter = Arc::new(FilterSession::new("filter-1".to_string(), "sess-f".to_string(), FilterCriteria::default(), 100));
        let other_filter = Arc::new(FilterSession::new("filter-2".to_string(), "sess-f-other".to_string(), FilterCriteria::default(), 100));
        {
            let mut filters = ctx.state().active_filters.lock().unwrap();
            filters.insert("filter-1".to_string(), Arc::clone(&closed_filter));
            filters.insert("filter-2".to_string(), Arc::clone(&other_filter));
        }

        close(&ctx, "sess-f").unwrap();

        let filters = ctx.state().active_filters.lock().unwrap();
        assert!(!filters.contains_key("filter-1"));
        assert!(closed_filter.is_cancelled());
        assert!(filters.contains_key("filter-2"));
        assert!(!other_filter.is_cancelled());
    }

    // ── close_stale_sessions ─────────────────────────────────────────────────

    #[test]
    fn close_stale_sessions_matches_differently_cased_paths_to_same_file() {
        let (ctx, tmp) = test_ctx().build();
        let file = tmp.path().join("device.log");
        std::fs::write(&file, "line one\nline two\n").expect("write test file");

        let stored_path = file.to_string_lossy().into_owned();
        insert_session(&ctx, "stale-id", Some(&stored_path));

        let reopened_path = stored_path.to_uppercase();
        assert_ne!(reopened_path, stored_path, "test needs a case-differing spelling");

        close_stale_sessions(&ctx, &reopened_path).unwrap();
        insert_session(&ctx, "fresh-id", Some(&reopened_path));

        let sessions = ctx.state().sessions.lock().unwrap();
        assert!(!sessions.contains_key("stale-id"));
        assert_eq!(sessions.len(), 1);
        assert!(sessions.contains_key("fresh-id"));
    }

    #[test]
    fn close_stale_sessions_falls_back_to_raw_equality_for_uncanonicalizable_paths() {
        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "stale-id", Some("/nonexistent/virtual/device.log"));

        close_stale_sessions(&ctx, "/nonexistent/virtual/device.log").unwrap();

        assert!(!ctx.state().sessions.lock().unwrap().contains_key("stale-id"));
    }

    #[test]
    fn close_stale_sessions_removes_all_duplicates() {
        let (ctx, _tmp) = test_ctx().build();
        let path = "/logs/device-dumpstate.log";
        insert_session(&ctx, "sess-old-1", Some(path));
        insert_session(&ctx, "sess-old-2", Some(path));
        insert_session(&ctx, "sess-old-3", Some(path));
        insert_session(&ctx, "sess-other", Some("/logs/other.log"));

        close_stale_sessions(&ctx, path).unwrap();

        let sessions = ctx.state().sessions.lock().unwrap();
        assert!(!sessions.contains_key("sess-old-1"));
        assert!(!sessions.contains_key("sess-old-2"));
        assert!(!sessions.contains_key("sess-old-3"));
        assert!(sessions.contains_key("sess-other"));
    }

    #[test]
    fn close_stale_sessions_leaves_workspace_analyses_intact() {
        use crate::core::analysis::AnalysisArtifact;

        let (ctx, _tmp) = test_ctx().build();
        let path = "/logs/device-dumpstate.log";
        insert_session(&ctx, "sess-stale-a", Some(path));
        insert_session(&ctx, "sess-stale-b", Some(path));
        ctx.state().analyses.lock().unwrap().push(AnalysisArtifact {
            id: "art-mcp-1".to_string(),
            title: "Memory Overview".to_string(),
            created_at: 1000,
            sections: vec![],
            legacy_session_id: None,
        });

        close_stale_sessions(&ctx, path).unwrap();

        let sessions = ctx.state().sessions.lock().unwrap();
        let analyses = ctx.state().analyses.lock().unwrap();
        assert!(!sessions.contains_key("sess-stale-a"));
        assert!(!sessions.contains_key("sess-stale-b"));
        assert_eq!(analyses.len(), 1);
    }

    #[test]
    fn close_stale_sessions_is_noop_when_no_match() {
        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "sess-keep", Some("/logs/other.log"));

        close_stale_sessions(&ctx, "/logs/no-match.log").unwrap();

        assert!(ctx.state().sessions.lock().unwrap().contains_key("sess-keep"));
    }

    // ── open_lts_file rollback ───────────────────────────────────────────────

    /// A `.lts` bundle with 3 sessions sharing one bundled processor. The
    /// first two entries import cleanly; a custom [`EventSink`] poisons
    /// `state.processors` the instant the second entry's `workspace-restored`
    /// fires, so the third entry's own `resolve_lts_processors_raw` call
    /// (which touches that same lock for *every* entry, not just the last
    /// one) fails. This reproduces "some entry fails after earlier ones
    /// already succeeded" without depending on any per-entry step that is
    /// otherwise unconditionally infallible today (`add_zip_source`) — the
    /// import must still roll back the two sessions already inserted by this
    /// same call and return the error, rather than stranding them.
    #[test]
    fn open_lts_file_rolls_back_partially_inserted_sessions_on_later_entry_failure() {
        use crate::services::events::EventSink;
        use crate::services::paths::{FixedPaths, NullSpawner};
        use crate::workspace::lts::{LtsSessionData, LtsSessionMeta, write_lts};

        let tmp = tempfile::tempdir().expect("tmpdir");
        let lts_path = tmp.path().join("bundle.lts");

        let make_entry = |i: usize| LtsSessionData {
            source_bytes: format!("01-01 00:00:00.00{i}  1000  1000 I Tag: line {i}\n").into_bytes(),
            source_filename: format!("source{i}.log"),
            bookmarks: vec![],
            analyses: vec![],
            // A non-empty active_processor_ids guarantees `emit_workspace_restored`
            // fires `workspace-restored` for every successfully-imported entry
            // (`has_chain` becomes true), which this test's poisoning hook relies on.
            session_meta: LtsSessionMeta {
                active_processor_ids: vec!["test-proc".to_string()],
                disabled_processor_ids: vec![],
            },
        };
        let sessions = vec![make_entry(0), make_entry(1), make_entry(2)];

        let processor_yaml = "meta:\n  id: test-proc\n  name: Test Proc\n  version: \"1.0.0\"\n";
        write_lts(
            &lts_path,
            &sessions,
            &[("test-proc".to_string(), "test-proc.yaml".to_string(), processor_yaml.to_string())],
            &[],
        )
        .expect("write_lts must succeed");

        let state = Arc::new(crate::commands::AppState::new());

        /// Poisons `state.processors` on the second `workspace-restored`
        /// event, i.e. right after the second entry finishes importing and
        /// before the third entry's own processor-resolution step runs.
        struct PoisonProcessorsAfterSecondEntry {
            state: Arc<crate::commands::AppState>,
            seen: std::sync::atomic::AtomicUsize,
        }
        impl EventSink for PoisonProcessorsAfterSecondEntry {
            fn emit_json(&self, event: &str, _payload: serde_json::Value) {
                if event != "workspace-restored" {
                    return;
                }
                if self.seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 == 2 {
                    let state = Arc::clone(&self.state);
                    // Poison from another thread so this thread's own call
                    // stack is never unwound — only the mutex ends up poisoned.
                    let _ = std::thread::spawn(move || {
                        let _guard = state.processors.lock().unwrap();
                        panic!("deliberate poison for rollback test");
                    })
                    .join();
                }
            }
        }

        let sink = Arc::new(PoisonProcessorsAfterSecondEntry {
            state: Arc::clone(&state),
            seen: std::sync::atomic::AtomicUsize::new(0),
        });

        let ctx = ServiceCtx::new(
            Arc::clone(&state),
            sink,
            Arc::new(FixedPaths(tmp.path().to_path_buf())),
            Arc::new(NullSpawner),
            Caller::Ui,
        );

        let result = open_lts_file(&ctx, lts_path.to_str().expect("utf8 tmp path"));

        assert!(result.is_err(), "the third entry must fail once state.processors is poisoned mid-import");
        let remaining: Vec<String> = state.sessions.lock().unwrap().keys().cloned().collect();
        assert!(
            remaining.is_empty(),
            "AppState must hold none of the import's sessions after rollback; found {remaining:?}"
        );
    }

    /// The happy path companion to the rollback test above: a good 3-session
    /// `.lts` file must still yield exactly 3 `LoadResult`s and 3 live
    /// sessions, so the rollback wiring never fires spuriously.
    #[test]
    fn open_lts_file_imports_all_sessions_when_none_fail() {
        use crate::workspace::lts::{LtsSessionData, LtsSessionMeta, write_lts};

        let tmp = tempfile::tempdir().expect("tmpdir");
        let lts_path = tmp.path().join("bundle-good.lts");

        let make_entry = |i: usize| LtsSessionData {
            source_bytes: format!("01-01 00:00:00.00{i}  1000  1000 I Tag: line {i}\n").into_bytes(),
            source_filename: format!("source{i}.log"),
            bookmarks: vec![],
            analyses: vec![],
            session_meta: LtsSessionMeta::default(),
        };
        let sessions = vec![make_entry(0), make_entry(1), make_entry(2)];

        write_lts(&lts_path, &sessions, &[], &[]).expect("write_lts must succeed");

        let (ctx, _tmp2) = test_ctx().build();
        let results = open_lts_file(&ctx, lts_path.to_str().expect("utf8 tmp path")).expect("import must succeed");

        assert_eq!(results.len(), 3);
        assert_eq!(ctx.state().sessions.lock().unwrap().len(), 3);
    }

    #[test]
    fn load_same_file_twice_yields_same_id_and_one_live_session() {
        let mut tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        writeln!(tmp, "01-01 00:00:01.000  100  101 I Tag: hello").unwrap();
        tmp.flush().unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        let path_obj = tmp.path();

        let (ctx, _tmp2) = test_ctx().build();

        let id1 = crate::core::session_identity::derive_file_session_id_from_disk(path_obj, None);
        close_stale_sessions(&ctx, &path).unwrap();
        insert_session(&ctx, &id1, Some(&path));

        let id2 = crate::core::session_identity::derive_file_session_id_from_disk(path_obj, None);
        assert_eq!(id1, id2);
        close_stale_sessions(&ctx, &path).unwrap();
        insert_session(&ctx, &id2, Some(&path));

        let sessions = ctx.state().sessions.lock().unwrap();
        let for_path: Vec<_> = sessions.values().filter(|s| s.file_path.as_deref() == Some(path.as_str())).collect();
        assert_eq!(for_path.len(), 1);
        assert_eq!(for_path[0].id, id1);
    }

    // ── rescue_artifacts_for_replacement ─────────────────────────────────────

    #[test]
    fn reopen_with_override_carries_artifacts_to_the_new_session() {
        let (ctx, tmp) = test_ctx().build();
        let file = tmp.path().join("board.txt");
        std::fs::write(&file, "[    0.000000] boot\n[    1.000000] more\n").expect("write");
        let path = file.to_string_lossy().to_string();

        let detected_id = crate::core::session_identity::derive_file_session_id_from_disk(&file, None);
        insert_session(&ctx, &detected_id, Some(&path));
        ctx.state().bookmarks.lock().unwrap().insert(detected_id.clone(), vec![sample_bookmark("bm-1", &detected_id, 42)]);

        let override_id = crate::core::session_identity::derive_file_session_id_from_disk(&file, Some("Kernel"));
        assert_ne!(override_id, detected_id);

        let rescued = rescue_artifacts_for_replacement(&ctx, &file, &path, &override_id).expect("rescue must succeed");

        assert_eq!(rescued.bookmarks.len(), 1);
        assert_eq!(rescued.bookmarks[0].line_number, 42);
        assert!(ctx.state().bookmarks.lock().unwrap().get(&detected_id).is_none());

        rescued.restore_onto(&ctx, &override_id).expect("restore");

        let bm = ctx.state().bookmarks.lock().unwrap();
        let carried = bm.get(&override_id).expect("the new session must inherit the bookmark");
        assert_eq!(carried.len(), 1);
        assert_eq!(carried[0].session_id, override_id);
    }

    #[test]
    fn replaced_file_does_not_inherit_stale_artifacts() {
        let (ctx, tmp) = test_ctx().build();
        let file = tmp.path().join("device.log");
        std::fs::write(&file, "original content\n").expect("write");
        let path = file.to_string_lossy().to_string();

        let old_id = crate::core::session_identity::derive_file_session_id_from_disk(&file, None);
        insert_session(&ctx, &old_id, Some(&path));
        ctx.state().bookmarks.lock().unwrap().insert(old_id.clone(), vec![sample_bookmark("bm-stale", &old_id, 3)]);

        std::fs::write(&file, "completely different content, many more lines\n").expect("rewrite");

        let new_id = crate::core::session_identity::derive_file_session_id_from_disk(&file, None);
        let rescued = rescue_artifacts_for_replacement(&ctx, &file, &path, &new_id).expect("rescue must succeed");

        assert!(rescued.bookmarks.is_empty());
        assert!(ctx.state().bookmarks.lock().unwrap().get(&old_id).is_some());
    }

    // ── open (agent-only session-opened + journal) ───────────────────────────

    #[tokio::test]
    async fn open_denies_an_agent_outside_the_allowlist() {
        let (ctx, tmp) = test_ctx().agent("claude-code").build();
        let f = tmp.path().join("some.log");
        std::fs::write(&f, "01-01 00:00:00.000  1  1 I Tag: hi\n").unwrap();

        let err = open(ctx, &f.to_string_lossy(), None).await.unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[tokio::test]
    async fn open_gives_the_same_denial_for_nonexistent_paths_inside_or_outside_the_allowlist() {
        let (ctx, tmp) = test_ctx().agent("claude-code").build();
        let missing = tmp.path().join("missing.log");

        let err = open(ctx, &missing.to_string_lossy(), None).await.unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert_eq!(err.message(), "path is not allowed");
    }

    #[tokio::test]
    async fn open_permits_a_ui_caller_and_bypasses_the_allowlist() {
        let (ctx, tmp) = test_ctx().build();
        let f = tmp.path().join("ui.log");
        std::fs::write(&f, "01-01 00:00:00.000  1  1 I Tag: hi\n").unwrap();

        let results = open(ctx, &f.to_string_lossy(), None).await.expect("ui open always allowed");
        assert_eq!(results.len(), 1);
    }

    #[tokio::test]
    async fn open_does_not_emit_session_opened_for_a_ui_caller() {
        let (ctx, sink, tmp) = test_ctx().build_recording();
        let f = tmp.path().join("ui.log");
        std::fs::write(&f, "01-01 00:00:00.000  1  1 I Tag: hi\n").unwrap();

        open(ctx, &f.to_string_lossy(), None).await.expect("ui open");

        assert!(sink.events_named("session-opened").is_empty(), "a UI-initiated open must not emit session-opened");
    }

    #[tokio::test]
    async fn open_emits_session_opened_for_an_agent_caller() {
        let (ctx, sink, tmp) = test_ctx().agent("claude-code").build_recording();
        let f = tmp.path().join("agent.log");
        std::fs::write(&f, "01-01 00:00:00.000  1  1 I Tag: hi\n").unwrap();
        ctx.state().mcp_open_allowlist.lock().unwrap().allowed_dirs.push(tmp.path().to_string_lossy().to_string());

        open(ctx, &f.to_string_lossy(), None).await.expect("agent open inside allowlist");

        assert_eq!(sink.events_named("session-opened").len(), 1, "an agent-initiated open must emit session-opened");
    }

    #[tokio::test]
    async fn open_journals_for_the_calling_caller() {
        let (ctx, tmp) = test_ctx().build();
        let f = tmp.path().join("ui.log");
        std::fs::write(&f, "01-01 00:00:00.000  1  1 I Tag: hi\n").unwrap();

        open(ctx.clone(), &f.to_string_lossy(), None).await.expect("open");

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "session.open");
        assert_eq!(activity[0].caller, Caller::Ui);
    }

    #[tokio::test]
    async fn open_rejects_a_source_type_override_on_an_lts_bundle() {
        let (ctx, tmp) = test_ctx().build();
        let f = tmp.path().join("bundle.lts");
        std::fs::write(&f, b"not really a zip, never reached").unwrap();

        let err = open(ctx, &f.to_string_lossy(), Some(SourceType::Logcat)).await.unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert!(err.message().contains(".lts session bundles"));
    }

    // ── metadata / bridge_metadata / list / status ──────────────────────────

    #[test]
    fn metadata_reports_level_distribution_and_top_tags() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        let m = metadata(&ctx, "s1").expect("metadata for an existing session");
        assert_eq!(m.session_id, "s1");
        assert_eq!(m.total_lines, 5);
        assert!(m.log_level_distribution.get("Info").copied().unwrap_or(0) >= 5);
    }

    #[test]
    fn metadata_errors_for_unknown_session() {
        let (ctx, _tmp) = test_ctx().build();
        let err = metadata(&ctx, "nope").unwrap_err();
        assert_eq!(err.message(), "Session 'nope' not found");
    }

    #[test]
    fn bridge_metadata_reports_section_count_without_scanning_levels() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        let m = bridge_metadata(&ctx, "s1").expect("metadata for an existing session");
        assert_eq!(m.total_lines, 5);
    }

    #[test]
    fn bridge_metadata_errors_for_unknown_session_with_the_bridges_historical_wording() {
        let (ctx, _tmp) = test_ctx().build();
        let err = bridge_metadata(&ctx, "nope").unwrap_err();
        assert_eq!(err.message(), "Session not found: nope");
    }

    #[test]
    fn list_marks_the_focused_session() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 2).with_session("s2", 2).build();
        *ctx.state().focused_session.lock().unwrap() = Some("s2".to_string());

        let overview = list(&ctx).expect("list");
        let s1 = overview.sessions.iter().find(|s| s.id == "s1").unwrap();
        let s2 = overview.sessions.iter().find(|s| s.id == "s2").unwrap();
        assert!(!s1.focused);
        assert!(s2.focused);
    }

    /// Two sessions loaded from the same filename (e.g. "dumpstate.txt" from
    /// two different devices) must carry distinguishable `path` values, and
    /// only the actually-focused one reports `focused: true` — the scenario
    /// `session_to_json`'s tests pinned before that helper moved here.
    #[test]
    fn list_disambiguates_same_named_sessions_by_path() {
        let mut s23 = crate::services::testing::fixture_session("sess-s23", 1);
        s23.file_path = Some("/logs/S23/dumpstate.txt".to_string());
        let mut xcover6 = crate::services::testing::fixture_session("sess-xcover6", 1);
        xcover6.file_path = Some("/logs/XCover6/dumpstate.txt".to_string());

        let (ctx, _tmp) = test_ctx().with_session_object(s23).with_session_object(xcover6).build();
        *ctx.state().focused_session.lock().unwrap() = Some("sess-xcover6".to_string());

        let overview = list(&ctx).expect("list");
        let s23 = overview.sessions.iter().find(|s| s.id == "sess-s23").unwrap();
        let xcover6 = overview.sessions.iter().find(|s| s.id == "sess-xcover6").unwrap();

        assert_ne!(s23.sources[0].path, xcover6.sources[0].path);
        assert_eq!(s23.sources[0].path.as_deref(), Some("/logs/S23/dumpstate.txt"));
        assert!(!s23.focused);
        assert!(xcover6.focused);
    }

    #[test]
    fn list_sources_empty_when_session_has_no_source() {
        let (ctx, _tmp) = test_ctx().build();
        insert_session(&ctx, "sess-empty", None);

        let overview = list(&ctx).expect("list");
        let entry = overview.sessions.iter().find(|s| s.id == "sess-empty").unwrap();
        assert!(entry.sources.is_empty());
        assert!(!entry.focused);
    }

    #[test]
    fn bridge_status_reports_session_ids_and_processor_count() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 1).with_session("s2", 1).build();
        let status = bridge_status(&ctx).expect("status");
        assert_eq!(status.session_ids.len(), 2);
    }

    #[test]
    fn set_focused_stores_the_session_id() {
        let (ctx, _tmp) = test_ctx().build();
        set_focused(&ctx, Some("s1".to_string())).unwrap();
        assert_eq!(*ctx.state().focused_session.lock().unwrap(), Some("s1".to_string()));
        set_focused(&ctx, None).unwrap();
        assert_eq!(*ctx.state().focused_session.lock().unwrap(), None);
    }
}
