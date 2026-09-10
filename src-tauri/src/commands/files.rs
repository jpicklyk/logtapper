use memmap2::Mmap;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Weak;
#[cfg(test)]
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tempfile::NamedTempFile;

use crate::commands::{lock_or_err, AppState};
use crate::core::line::{
    HighlightKind, HighlightSpan, LineRequest, LineWindow, LogLevel, SearchQuery,
    SearchSummary, ViewLine, ViewMode,
};
use crate::core::session::{AnalysisSession, SectionInfo, parser_for};
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Zip extraction for bugreport .zip files
// ---------------------------------------------------------------------------

/// Extract the dumpstate/bugreport .txt from a bugreport .zip to a temp file.
/// Picks the largest `.txt` file in the archive (the main dumpstate dump).
/// Returns a `NamedTempFile` that must be kept alive for the session duration.
fn extract_bugreport_from_zip(zip_path: &Path) -> Result<NamedTempFile, String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("Cannot open zip '{}': {e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid zip archive '{}': {e}", zip_path.display()))?;

    // Find the largest .txt entry (the main bugreport/dumpstate text).
    let best_index = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            if name.ends_with('/') { return None; } // skip directories
            if name.to_lowercase().ends_with(".txt") {
                Some((i, entry.size()))
            } else {
                None
            }
        })
        .max_by_key(|&(_, size)| size)
        .map(|(i, _)| i);

    let index = best_index.ok_or_else(|| {
        format!("No .txt file found in zip '{}'", zip_path.display())
    })?;

    let mut entry = archive.by_index(index)
        .map_err(|e| format!("Failed to read zip entry: {e}"))?;

    let mut temp = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temp file: {e}"))?;
    std::io::copy(&mut entry, &mut temp)
        .map_err(|e| format!("Failed to extract bugreport: {e}"))?;

    Ok(temp)
}

// ---------------------------------------------------------------------------
// DumpstateMetadata
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DumpstateMetadata {
    pub build_string: Option<String>,
    pub build_fingerprint: Option<String>,
    pub os_version: Option<String>,
    pub build_type: Option<String>,
    pub bootloader: Option<String>,
    pub serial: Option<String>,
    pub uptime: Option<String>,
    pub kernel_version: Option<String>,
    pub sdk_version: Option<String>,
    pub device_model: Option<String>,
    pub manufacturer: Option<String>,
}

// ---------------------------------------------------------------------------
// load_log_file
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub session_id: String,
    pub source_id: String,
    pub source_name: String,
    /// Full filesystem path for file-backed sessions; None for ADB streams.
    pub file_path: Option<String>,
    pub total_lines: usize,
    #[ts(type = "number")]
    pub file_size: u64,
    #[ts(type = "number | null")]
    pub first_timestamp: Option<i64>,
    #[ts(type = "number | null")]
    pub last_timestamp: Option<i64>,
    pub source_type: String,
    /// True for live ADB streaming sessions; false for static file sessions.
    pub is_streaming: bool,
    /// True while background indexing is still in progress for this session.
    pub is_indexing: bool,
    /// True if the file uses CRLF (`\r\n`) line endings. Always false for streams.
    pub has_crlf: bool,
    /// Detected file encoding (e.g. "UTF-8", "UTF-16 LE", "UTF-16 BE").
    pub encoding: String,
}

// ---------------------------------------------------------------------------
// Progressive indexing event payloads
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexProgress {
    session_id: String,
    indexed_lines: usize,
    bytes_scanned: usize,
    total_bytes: usize,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexComplete {
    session_id: String,
    total_lines: usize,
}

#[tauri::command]
pub async fn load_log_file(
    app: AppHandle,
    path: String,
    source_type: Option<String>,
) -> Result<Vec<LoadResult>, String> {
    let path_obj = Path::new(&path);

    // Reject an unknown label rather than silently falling back to detection —
    // a typo that quietly reverted to the detected type would be invisible, and
    // the caller supplied the override precisely because detection was wrong.
    let source_type_override = match source_type.as_deref() {
        None => None,
        Some(label) => Some(
            crate::core::session::SourceType::from_label(label).ok_or_else(|| {
                format!(
                    "Unknown source type '{label}'. Expected one of: {}",
                    crate::core::session::SourceType::labels().join(", ")
                )
            })?,
        ),
    };

    // If the file is a .lts session export, use the dedicated multi-session import path.
    // `.lts` bundles are LogTapper's own export format and carry the source type
    // each embedded session was captured with, so an override does not apply.
    let is_lts = path_obj.extension().and_then(|e| e.to_str()) == Some("lts");
    if is_lts && source_type_override.is_some() {
        return Err(
            "source_type override is not supported for .lts session bundles — \
             they carry the source type each session was captured with"
                .to_string(),
        );
    }

    // The parse/index phase (mmap + line-index build for a plain file, or the
    // zip read + per-embedded-session decode for a `.lts` bundle) is CPU-bound
    // and previously ran directly on the async runtime thread, starving other
    // IPC exactly like the pipeline run this mirrors — see `run_pipeline`
    // (commands/pipeline.rs:246-268) for the same starvation rationale. Run it
    // on a blocking thread instead.
    //
    // `State<'_, std::sync::Arc<AppState>>` cannot cross into the 'static `spawn_blocking`
    // closure (it borrows this invocation's lifetime), so — same as
    // `run_pipeline` — the closure re-resolves `AppState` from the moved
    // `AppHandle` instead of taking a `state` parameter at all. Neither `app`
    // nor `path` is used again after this point, so they move into the
    // closure directly rather than being cloned first.
    tokio::task::spawn_blocking(move || {
        let state = app.state::<std::sync::Arc<AppState>>();
        if is_lts {
            load_lts_file_inner(&state, &app, &path)
        } else {
            // Reused verbatim by the MCP `open_file` bridge endpoint so both
            // openers produce identical sessions (that caller wraps its own
            // call the same way — see `h_open_file` in `mcp_bridge.rs`).
            open_file_inner(&state, &app, &path, source_type_override)
        }
    })
    .await
    .map_err(|e| format!("File open task panicked: {e}"))?
}

/// Open a plain log file (or a bugreport `.zip`) and register it as a session.
///
/// Extracted verbatim from the plain-file branch of [`load_log_file`] so the MCP
/// bridge's `open_file` endpoint can reuse the exact same open path: identical
/// `LoadResult`, identical stale-session close, identical `sessions.insert`, and
/// the identical background-indexer spawn. This is the single session-registry
/// writer for file-backed sessions — MCP adds a caller, not a divergent path.
///
/// Shape differs from a `#[tauri::command]` only in that `path` arrives as `&str`
/// and `app` as `&AppHandle`; behaviour is otherwise byte-for-byte the same.
///
/// Sync (not `async`): the original branch had no `.await`. Both callers
/// (`load_log_file` and the MCP bridge's `h_open_file`) now invoke this fn
/// inside `tokio::task::spawn_blocking` — see the callers for the starvation
/// rationale — so the background indexer's spawn uses
/// `tauri::async_runtime::spawn` rather than bare `tokio::spawn`:
/// `spawn_blocking` closures run on the blocking thread pool, not as a polled
/// task, and `tauri::async_runtime::spawn` resolves the app's runtime from a
/// process-global handle set at startup instead of relying on ambient
/// thread-local tokio context, so the spawn is reached identically regardless
/// of which kind of thread `open_file_inner` itself is running on.
///
/// `source_type_override`, when present, replaces content detection for the
/// session this opens — including the case where `path` is a zip, since the
/// extracted bugreport becomes that same single session. Detection is a
/// heuristic and now gates which processors run (see
/// `excluded_by_declared_source_types`), so callers that know the file's
/// provenance better than its first bytes do need a way to say so.
pub(crate) fn open_file_inner(
    state: &AppState,
    app: &tauri::AppHandle,
    path: &str,
    source_type_override: Option<crate::core::session::SourceType>,
) -> Result<Vec<LoadResult>, String> {
    let path_obj = Path::new(path);

    // If the file is a .zip, extract the dumpstate/bugreport .txt to a temp file
    // and load that instead. The temp file persists for the session lifetime.
    //
    // This decompression — and the mmap + line-index build later in this
    // function — used to run synchronously on whichever async runtime called
    // us, briefly blocking that worker thread on large zips. Both callers
    // (`load_log_file` and `h_open_file` in `mcp_bridge.rs`) now invoke this
    // whole fn inside `tokio::task::spawn_blocking`, so that is no longer the
    // case: `open_file_inner` stays deliberately `sync` (see the fn doc above)
    // and each caller owns the blocking-thread hop around it.
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
        .map_err(|e| format!("Failed to read metadata for {effective_path}: {e}"))?;

    // Derive stable IDs from the original path (not the temp extraction).
    // Deterministic per (canonical path, length, content prefix, source-type
    // override) so an unchanged file keeps its id across restarts — MCP handles
    // survive, restore diagnostics correlate. See core::session_identity
    // (design §Q5). The override is part of the identity because it selects the
    // parser that builds the line index: same id + different type would mean two
    // incompatible parses sharing every id-keyed structure, including the
    // frontend line cache.
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

    // Rescue the bookmarks/pipeline-meta of any session we are about to
    // replace, BEFORE closing it — `close_session_inner` deletes a session's
    // bookmarks and pipeline meta along with the session itself (analyses are
    // workspace-owned and survive the close; their per-reference session
    // attribution is instead restamped onto `session_id` below).
    //
    // This matters because a source-type override changes the session id, so a
    // reopen is a close of one id and a create of another. Without the rescue the
    // user's bookmarks are silently destroyed by the act of correcting a
    // misdetected file.
    //
    // GUARD: only rescue/restamp from a session whose id we can still reproduce
    // from the file's CURRENT bytes. The id preimage is (path, length, content
    // prefix, override), so reproducing it proves the file has not been replaced
    // since that session was opened — and therefore that its line numbers still
    // mean the same thing. If the file changed on disk, its artifacts refer to
    // content that no longer exists and must be allowed to die with it.
    let rescued = rescue_artifacts_for_replacement(state, path_obj, path, &session_id)?;

    // Close any existing sessions for the same file path (e.g. stale sessions from
    // frontend reloads). Collects ALL matching IDs then closes each one.
    let closed_ids = close_stale_sessions(state, Some(app), path)?;

    // Tell the frontend about sessions that are NOT about to be re-created under
    // the same id. That only happens when the id changed — i.e. a reopen with a
    // different source-type override. Without this the frontend keeps a tab
    // bound to a session the backend has already dropped.
    //
    // Filtering on `id != session_id` is what makes this safe for the ordinary
    // same-id reopen: emitting there would tell the frontend to discard a tab it
    // is about to reuse.
    for stale_id in closed_ids.iter().filter(|id| *id != &session_id) {
        let _ = app.emit("session-closed", serde_json::json!({ "sessionId": stale_id }));
    }

    const INITIAL_BYTES: usize = 1_000_000; // 1 MB initial chunk

    let mut session = AnalysisSession::new(session_id.clone());
    session.file_path = Some(path.to_string());
    // Recorded so workspace save can replay it. Only the explicit override is
    // kept — never the detected type, which would freeze detection for that
    // workspace and stop any later detector fix from reaching it.
    session.source_type_override = override_label;
    // Hold the temp file handle in the session so it persists (deleted on drop).
    session.temp_file = _temp_file;
    // `mmap_weak` is a Weak, not a strong Arc: the session's own FileLogSource
    // (inserted into `sessions` below) is the only strong owner of the mmap.
    // Handing the background indexer a Weak means it can never keep the
    // mapping alive past this session's own drop/removal — see the
    // `temp_file` field doc on AnalysisSession and `add_source_partial_typed`.
    let (mmap_weak, total_bytes, bytes_consumed) =
        session.add_source_partial_typed(
            effective_path_obj,
            source_id.clone(),
            INITIAL_BYTES,
            source_type_override,
        )?;

    let source = session.primary_source().ok_or("No source after partial load")?;
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

    // Capture the session's per-instantiation generation before it is moved into
    // the map. The background indexer re-checks this under the sessions lock so a
    // stale indexer can never mutate a newer same-id session (ids are
    // content-derived, so close+reopen re-derives the same id).
    let session_generation = session.generation();

    {
        let mut sessions = lock_or_err(&state.sessions, "sessions")?;
        sessions.insert(session_id.clone(), session);
    }

    // Re-key the rescued artifacts onto the new session. Done after the insert so
    // they never reference a session id that is not yet in the registry.
    rescued.restore_onto(state, &session_id)?;

    // Spawn background indexing task if there's more to scan.
    if is_indexing {
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        {
            let mut tasks = lock_or_err(&state.indexing_tasks, "indexing_tasks")?;
            tasks.insert(session_id.clone(), cancel_tx);
        }
        let app_clone = app.clone();
        let sid = session_id;
        let initial_line_count = total_lines; // capture before session is moved into map
        // `tauri::async_runtime::spawn`, not bare `tokio::spawn`: both callers of
        // `open_file_inner` now run this whole fn inside
        // `tokio::task::spawn_blocking`, i.e. on a blocking-pool thread rather
        // than as a polled async task, so there is no ambient tokio context to
        // resolve `tokio::spawn`'s target runtime from. `tauri::async_runtime`
        // resolves the app's runtime from a process-global handle set at
        // startup instead, so it works identically from either kind of thread
        // — see the doc comment on `open_file_inner` above.
        tauri::async_runtime::spawn(async move {
            run_background_indexer(
                sid,
                mmap_weak,
                source_type,
                encoding,
                bytes_consumed,
                total_bytes,
                initial_line_count,
                session_generation,
                app_clone,
                cancel_rx,
            )
            .await;
        });
    }

    Ok(vec![result])
}

fn load_lts_file_inner(
    state: &AppState,
    app: &tauri::AppHandle,
    lts_path: &str,
) -> Result<Vec<LoadResult>, String> {
    let path_obj = std::path::Path::new(lts_path);

    // 1. Read the .lts zip (all I/O, no locks)
    let lts = crate::workspace::lts::read_lts(path_obj)?;

    if lts.sessions.is_empty() {
        return Err("No sessions in .lts file".to_string());
    }

    close_stale_sessions(state, Some(app), lts_path)?;

    let file_size = path_obj.metadata().map(|m| m.len()).unwrap_or(0);

    // Destructure to avoid cloning the processor fields.
    let crate::workspace::lts::LtsData { sessions, processor_manifest, processor_yamls, editor_tabs, .. } = lts;

    // 3. Create one AnalysisSession per embedded session.
    let mut results = Vec::with_capacity(sessions.len());

    for (entry_index, session_data) in sessions.into_iter().enumerate() {
        // Deterministic per (canonical .lts path, entry index). All entries share
        // one file_path, so the index disambiguates; it is stable because .lts
        // files are immutable after export. See core::session_identity (design §Q5).
        let session_id =
            crate::core::session_identity::derive_lts_session_id(path_obj, entry_index);

        // Resolve bundled processors under session-scoped IDs so they don't
        // collide with the user's globally installed versions.
        let bare_to_scoped: std::collections::HashMap<String, String> =
            crate::commands::export::resolve_lts_processors_raw(
                state,
                &processor_manifest,
                &processor_yamls,
                &session_id,
            )?
            .into_iter()
            .collect();

        // source_id is derived from the original filename (no extension), following the same
        // convention as regular file loads.
        let source_id = std::path::Path::new(&session_data.source_filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("lts-source")
            .to_string();

        let mut session = crate::core::session::AnalysisSession::new(session_id.clone());
        // All sessions in this .lts file share the same file path.
        session.file_path = Some(lts_path.to_string());

        let source_filename = session_data.source_filename.clone();
        session.add_zip_source(
            session_data.source_bytes,
            source_id.clone(),
            source_filename,
        )?;

        let source = session.primary_source().ok_or("No source after zip load")?;
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
            is_indexing: false, // ZipLogSource is fully indexed on load
            has_crlf,
            encoding,
        };

        // Insert session under a brief lock — release before any subsequent work.
        {
            let mut sessions = lock_or_err(&state.sessions, "sessions")?;
            sessions.insert(session_id.clone(), session);
        }

        // Restore bookmarks and analyses, rewriting the stale session_id from the archive.
        let (bm_count, an_count) =
            restore_artifacts(state, &session_id, session_data.bookmarks, session_data.analyses);

        let mut meta: crate::workspace::SessionMeta = session_data.session_meta.into();
        let remap = |ids: &[String]| -> Vec<String> {
            ids.iter().map(|id| bare_to_scoped.get(id).cloned().unwrap_or_else(|| id.clone())).collect()
        };
        meta.active_processor_ids = remap(&meta.active_processor_ids);
        meta.disabled_processor_ids = remap(&meta.disabled_processor_ids);

        // Store pipeline meta and emit workspace-restored event. `source: "lts"`
        // tells the frontend this session was recreated from the .lts archive, so
        // useWorkspaceRestore (not the .ltw restore core) owns its auto-run.
        emit_workspace_restored(
            state,
            app,
            &session_id,
            bm_count,
            an_count,
            meta,
            "lts",
        );

        results.push(result);
    }

    // Emit editor tabs to the frontend if any were stored in the .lts file.
    if !editor_tabs.is_empty() {
        app.emit("lts-editor-tabs", &editor_tabs)
            .map_err(|e| format!("Failed to emit editor tabs: {e}"))?;
    }

    Ok(results)
}

/// Store pipeline meta in AppState and emit `workspace-restored` event.
/// Used by the `.lts` load path and the `restore_workspace_session` command.
///
/// `source` distinguishes the two emitters so the frontend can decide who owns
/// the auto-run: `"lts"` (this session was recreated mid-`load_log_file` from a
/// `.lts` archive — `useWorkspaceRestore` owns its auto-run) vs `"workspace"`
/// (emitted by `restore_workspace_session` on the `.ltw` path — the restore
/// orchestrator's core owns those). Without the tag the frontend cannot tell a
/// `.lts`-backed session apart from a `.ltw` manifest session and would either
/// double-run it or silently drop its auto-run.
pub(crate) fn emit_workspace_restored(
    state: &AppState,
    app: &tauri::AppHandle,
    session_id: &str,
    bm_count: usize,
    an_count: usize,
    meta: crate::workspace::SessionMeta,
    source: &str,
) {
    let has_chain = !meta.active_processor_ids.is_empty();
    if has_chain {
        // `session_pipeline_meta` is a flat, independently-keyed map (see the
        // poison-recovery split documented at the top of `mcp_bridge.rs`), so a
        // panicking writer cannot leave it torn — recover via `into_inner`
        // rather than silently dropping this update on poison.
        let mut map = state
            .session_pipeline_meta
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        map.insert(session_id.to_string(), meta.clone());
    }

    if bm_count > 0 || an_count > 0 || has_chain {
        let _ = app.emit("workspace-restored", serde_json::json!({
            "sessionId": session_id,
            "bookmarkCount": bm_count,
            "analysisCount": an_count,
            "activeProcessorIds": meta.active_processor_ids,
            "disabledProcessorIds": meta.disabled_processor_ids,
            "source": source,
        }));
    }
}

/// Close **all** sessions whose `file_path` refers to the same on-disk file as
/// `path`. Collects every matching ID under a short-lived lock, then closes each
/// one. Previously used `.find()` which only removed one duplicate per call — the
/// remaining stale sessions caused the MCP agent to target the wrong session ID.
///
/// Comparison is **canonical** (see [`stale_path_matches`]), not raw-string:
/// `derive_file_session_id_from_disk` derives the session id from the
/// canonical-lowercased path, so two spellings of the same file (different casing
/// or a `\\?\` prefix) derive the SAME deterministic id. A raw-string `==` would
/// miss the alias, and the subsequent `sessions.insert(same_id, …)` would silently
/// overwrite the prior session WITHOUT running `close_session_inner`'s cleanup
/// (indexing-task cancel, watch/filter purge). Matching canonically keeps this
/// scan consistent with the id invariant so the cleanup always runs.
/// Bookmarks and pipeline meta lifted off sessions that are about to be
/// replaced by a reopen of the same file, so they can be re-keyed onto the
/// new session id.
///
/// Analyses are NOT carried here — they are workspace-owned and are never
/// removed by `close_session_inner`, so there is nothing to rescue for them.
/// Their per-reference session attribution is instead rewritten in place by
/// [`restamp_analysis_references`], called from
/// [`rescue_artifacts_for_replacement`] before this struct is even built.
#[derive(Default)]
pub(crate) struct RescuedArtifacts {
    bookmarks: Vec<crate::core::bookmark::Bookmark>,
    pipeline_meta: Option<crate::workspace::SessionMeta>,
}

impl RescuedArtifacts {
    fn is_empty(&self) -> bool {
        self.bookmarks.is_empty() && self.pipeline_meta.is_none()
    }

    /// Attach the rescued artifacts to `session_id`.
    ///
    /// Delegates to [`restore_artifacts`], the same helper the `.lts` import
    /// path uses, because each bookmark also carries an embedded `session_id`
    /// that has to be rewritten — storing under the new map key alone leaves the
    /// field pointing at a session that no longer exists, which then travels out
    /// over the MCP bridge and into workspace saves. Verified against the
    /// running app: re-keying without the rewrite reported a bookmark whose
    /// `sessionId` was the closed session's.
    fn restore_onto(self, state: &AppState, session_id: &str) -> Result<(), String> {
        if self.is_empty() {
            return Ok(());
        }
        restore_artifacts(state, session_id, self.bookmarks, vec![]);
        if let Some(meta) = self.pipeline_meta {
            let mut pm = lock_or_err(&state.session_pipeline_meta, "session_pipeline_meta")?;
            pm.insert(session_id.to_string(), meta);
        }
        Ok(())
    }
}

/// Take the bookmarks/pipeline-meta of every session bound to `path` whose id
/// can still be reproduced from the file's current bytes, and restamp
/// workspace analysis references from those old ids onto `new_session_id`.
///
/// Reproducing the id is the safety check: it proves the file has not been
/// replaced since that session was opened, so its bookmarks and analyses still
/// point at the same lines. A source-type change is exactly this case — same
/// bytes, different id, because the override is part of the id preimage. A file
/// whose content changed derives a different id and is skipped, so its stale
/// artifacts are not grafted onto content they never referred to.
///
/// Bookmarks/pipeline-meta are REMOVED here rather than copied:
/// `close_session_inner` would delete them moments later anyway, and taking
/// them keeps a single owner. Analyses are workspace-owned and are never
/// removed by `close_session_inner`, so their references are restamped in
/// place instead of being lifted and re-inserted.
fn rescue_artifacts_for_replacement(
    state: &AppState,
    path_obj: &Path,
    path: &str,
    new_session_id: &str,
) -> Result<RescuedArtifacts, String> {
    // (id, override) for sessions on this path. Lock taken and dropped before any
    // artifact lock, per the AppState ordering rules.
    let candidates: Vec<(String, Option<String>)> = {
        let incoming_canonical =
            crate::commands::bridge_access::canonical_compare_form(path_obj);
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        sessions
            .values()
            .filter(|s| {
                s.file_path
                    .as_deref()
                    .is_some_and(|stored| {
                        stale_path_matches(stored, path, incoming_canonical.as_deref())
                    })
            })
            .map(|s| (s.id.clone(), s.source_type_override.clone()))
            .collect()
    };

    let migratable: Vec<String> = candidates
        .into_iter()
        .filter(|(id, override_label)| {
            crate::core::session_identity::derive_file_session_id_from_disk(
                path_obj,
                override_label.as_deref(),
            ) == *id
        })
        .map(|(id, _)| id)
        .collect();

    // Restamp analysis references onto the new id regardless of whether
    // there is anything to rescue for bookmarks/pipeline meta below — the
    // two are independent concerns now that analyses live in their own
    // workspace store.
    restamp_analysis_references(state, &migratable, new_session_id)?;

    if migratable.is_empty() {
        return Ok(RescuedArtifacts::default());
    }

    let mut out = RescuedArtifacts::default();
    {
        let mut bm = lock_or_err(&state.bookmarks, "bookmarks")?;
        for id in &migratable {
            if let Some(v) = bm.remove(id) {
                out.bookmarks.extend(v);
            }
        }
    }
    {
        let mut pm = lock_or_err(&state.session_pipeline_meta, "session_pipeline_meta")?;
        // Last one wins; in practice there is at most one session per path.
        for id in &migratable {
            if let Some(m) = pm.remove(id) {
                out.pipeline_meta = Some(m);
            }
        }
    }
    Ok(out)
}

/// Returns the ids actually closed, so callers can notify the frontend about
/// sessions that are not being immediately re-created under the same id.
fn close_stale_sessions(state: &AppState, app: Option<&tauri::AppHandle>, path: &str) -> Result<Vec<String>, String> {
    // Canonicalize the incoming path once, outside the sessions lock.
    let incoming_canonical =
        crate::commands::bridge_access::canonical_compare_form(Path::new(path));
    let stale_ids: Vec<String> = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
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
        close_session_inner(state, app, stale_id)?;
    }
    Ok(stale_ids)
}

/// True if a stored session `file_path` refers to the same on-disk file as the
/// `incoming` open path. `incoming_canonical` is [`canonical_compare_form`] of
/// `incoming`, pre-computed once by the caller so it isn't recomputed per session.
///
/// When BOTH the stored path and the incoming path canonicalize, their canonical
/// (resolved, case-folded) forms are compared — this is what makes stale-close
/// consistent with the canonical id derivation. Otherwise (either side can't be
/// canonicalized — e.g. the file was deleted since the session opened) it falls
/// back to raw string equality, so a deleted-then-reopened file still matches its
/// stale entry rather than leaking a duplicate under the same raw path.
fn stale_path_matches(stored: &str, incoming: &str, incoming_canonical: Option<&str>) -> bool {
    match (
        crate::commands::bridge_access::canonical_compare_form(Path::new(stored)),
        incoming_canonical,
    ) {
        (Some(stored_canonical), Some(incoming_canonical)) => stored_canonical == incoming_canonical,
        _ => stored == incoming,
    }
}

pub(crate) fn close_session_inner(state: &AppState, _app: Option<&tauri::AppHandle>, session_id: &str) -> Result<(), String> {
    // 1. Cancel active ADB stream (if any)
    if let Some(cancel_tx) = lock_or_err(&state.stream_tasks, "stream_tasks")?.remove(session_id) {
        let _ = cancel_tx.send(());
    }

    // 2. Cancel active background indexing (if any)
    if let Some(cancel_tx) = lock_or_err(&state.indexing_tasks, "indexing_tasks")?.remove(session_id) {
        let _ = cancel_tx.send(());
    }

    // 3. Remove session (drops mmap / stream data)
    lock_or_err(&state.sessions, "sessions")?.remove(session_id);

    // 5. Remove state tracker results (never written by streaming flush_batch)
    lock_or_err(&state.state_tracker_results, "state_tracker_results")?.remove(session_id);

    // 6. Remove correlator results (never written by streaming flush_batch)
    lock_or_err(&state.correlator_results, "correlator_results")?.remove(session_id);

    // 4, 7-11. Remove everything an in-flight ADB `flush_batch` could re-insert
    //   — the accumulated streaming pipeline results, all three continuous
    //   stream-state maps, the PII mappings, and the stream anonymizer — and DROP
    //   the streaming epoch, all atomically under the epoch lock. This closes
    //   race (c): a batch that extracted state before this close ran now finds a
    //   dropped epoch at re-insert time and discards its state instead of
    //   recreating entries under a dead session id. See `AppState::stream_epochs`.
    state.clear_stream_epoch_with(session_id, || {
        lock_or_err(&state.pipeline_results, "pipeline_results")?.remove(session_id);
        lock_or_err(&state.stream_processor_state, "stream_processor_state")?.remove(session_id);
        lock_or_err(&state.stream_tracker_state, "stream_tracker_state")?.remove(session_id);
        lock_or_err(&state.stream_transformer_state, "stream_transformer_state")?.remove(session_id);
        lock_or_err(&state.pii_mappings, "pii_mappings")?.remove(session_id);
        lock_or_err(&state.stream_anonymizers, "stream_anonymizers")?.remove(session_id);
        Ok(())
    })?;

    // 12. Remove MCP anonymizer + its per-session anonymize flag
    lock_or_err(&state.mcp_anonymizers, "mcp_anonymizers")?.remove(session_id);
    lock_or_err(&state.mcp_anonymize, "mcp_anonymize")?.remove(session_id);

    // 13. Clean up bookmarks and pipeline meta. Analyses are workspace-owned
    //     (see `AppState::analyses`) and are deliberately NOT removed here —
    //     an analysis that references a closed session stays visible
    //     (orphaned-but-visible is the intended behavior) rather than being
    //     destroyed by the act of closing one of the sessions it cites.
    lock_or_err(&state.bookmarks, "bookmarks")?.remove(session_id);
    lock_or_err(&state.session_pipeline_meta, "session_pipeline_meta")?.remove(session_id);

    // 14. Remove session-scoped processors imported from .lts files.
    let lts_suffix = format!("{}{}{}",
        crate::processors::marketplace::NAMESPACE_SEP,
        crate::processors::marketplace::LTS_NS_PREFIX,
        session_id,
    );
    lock_or_err(&state.processors, "processors")?
        .retain(|key, _| !key.ends_with(&lts_suffix));

    // 15. Remove cached .lts processor YAMLs.
    lock_or_err(&state.lts_processor_yamls, "lts_processor_yamls")?
        .retain(|key, _| !key.ends_with(&lts_suffix));

    // 16. Remove watches targeting the closed session.
    lock_or_err(&state.active_watches, "active_watches")?.remove(session_id);

    // 17. Remove filters targeting the closed session. active_filters is keyed
    //     by filter_id, so match on each filter's session_id. Cancel before
    //     dropping so the background scan task stops and the filter's status
    //     reads Cancelled rather than Complete.
    lock_or_err(&state.active_filters, "active_filters")?.retain(|_, filter| {
        if filter.session_id == session_id {
            filter.cancel();
            false
        } else {
            true
        }
    });

    // 18. Remove the per-session pipeline run lock so the registry does not grow
    //     unboundedly (and never accumulates poisoned locks) across the app's
    //     lifetime. Eviction is safe: any pipeline run in flight for this session
    //     holds its OWN clone of the `Arc<Mutex<()>>`, so the Mutex stays alive
    //     by refcount and that run finishes normally — removing the registry's
    //     reference never drops a lock a live run is using. The only consequence
    //     is that if the identical file is reopened (ids are content-derived)
    //     *while* an old run is still executing, the reopened session mints a
    //     fresh lock and the two runs no longer serialize; that requires running
    //     a pipeline across a close+reopen of the same file, and its worst case
    //     is one stale result overwritten by the next clean run — not corruption.
    lock_or_err(&state.pipeline_run_locks, "pipeline_run_locks")?.remove(session_id);

    Ok(())
}

#[tauri::command]
pub async fn close_session(
    state: State<'_, std::sync::Arc<AppState>>,
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    close_session_inner(&state, Some(&app), &session_id)
}

/// Decide whether the background indexer should stop, given the result of a
/// non-blocking `cancel_rx.try_recv()`.
///
/// Both an explicit cancel (`Ok(())`, sent by `close_session_inner`) and a
/// *dropped sender* (`Err(Closed)`) mean stop. The dropped-sender case matters
/// because any path that overwrites this indexer's `indexing_tasks` entry
/// (rather than send-then-remove) drops the `Sender` without signalling — the
/// old asymmetry (vs `run_streaming_task`'s `select!`) that left indexers
/// unstoppable. Only `Err(Empty)` — no signal yet, sender still alive —
/// continues.
fn indexer_cancelled(
    recv: Result<(), tokio::sync::oneshot::error::TryRecvError>,
) -> bool {
    !matches!(recv, Err(tokio::sync::oneshot::error::TryRecvError::Empty))
}

#[allow(clippy::too_many_arguments)]
async fn run_background_indexer(
    session_id: String,
    mmap: Weak<Mmap>,
    source_type: crate::core::session::SourceType,
    encoding: crate::core::log_source::Encoding,
    start_byte: usize,
    total_bytes: usize,
    initial_line_count: usize,
    expected_generation: u64,
    app: AppHandle,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) {
    // ~100k lines at ~80 bytes avg; exact line count varies but
    // build_partial_line_index stops at the next newline past this limit.
    const CHUNK_BYTES: usize = 8_000_000;

    let state = app.state::<std::sync::Arc<AppState>>();
    let parser = parser_for(&source_type);

    // BugreportParser is stateful: it must see the `== dumpstate:` header to
    // set dumpstate_year before it can year-correct logcat timestamps.  The
    // header was in the initial chunk (already indexed), so re-feed that one
    // line to the fresh parser before it processes the remaining chunks.
    //
    // Upgraded under the `sessions` lock, same as every other use of `mmap`
    // below — see the comment on the main loop's upgrade for why that matters.
    if matches!(source_type, crate::core::session::SourceType::Bugreport | crate::core::session::SourceType::Dumpstate) && start_byte > 0 {
        let initial_text = {
            let Ok(sessions) = state.sessions.lock() else {
                return;
            };
            let Some(session) = sessions.get(&session_id) else {
                return;
            };
            if session.generation() != expected_generation {
                return;
            }
            let Some(mmap_strong) = mmap.upgrade() else {
                return;
            };
            let data: &[u8] = mmap_strong.as_ref();
            let end = start_byte.min(data.len());
            if encoding.is_utf16() {
                crate::core::log_source::decode_utf16_bytes(
                    &data[encoding.bom_len()..end],
                    encoding == crate::core::log_source::Encoding::Utf16Be,
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

    // Start from the count already indexed in the initial partial scan, passed directly
    // to avoid a session lock that might fail or see a replaced session.
    let mut cursor = start_byte;
    let mut total_indexed: usize = initial_line_count;

    // `total_bytes` is the mmap's fixed length (captured once at open — a
    // memory map never resizes), so it is used as the loop bound instead of
    // re-reading `data.len()` from a live mapping outside the lock below.
    while cursor < total_bytes {
        // Stop on an explicit cancel (Ok) OR a dropped sender (Err(Closed)) —
        // see `indexer_cancelled`. Only Err(Empty) continues.
        if indexer_cancelled(cancel_rx.try_recv()) {
            return;
        }

        // Call build_partial_line_index under the session lock so the tag interner
        // is available. memchr-based scanning of 8 MB chunks completes in < 1 ms,
        // so lock contention is negligible.
        let (chunk_line_count, bytes_in_chunk) = {
            let Ok(mut sessions) = state.sessions.lock() else {
                return;
            };
            let Some(session) = sessions.get_mut(&session_id) else {
                return;
            };

            // The session id is content-derived and deterministic: a close+reopen
            // of the same file re-derives the SAME id. If this stale indexer
            // blocked on the sessions lock while its session was closed and a new
            // same-id session inserted, `get_mut` now resolves that NEW session.
            // Writing our old-cursor/old-mmap offsets into it would corrupt its
            // line_index (duplicated/gapped) and interleave with the new session's
            // own indexer. The generation is unique per instantiation, so a
            // mismatch means "not our session" — abort silently.
            if session.generation() != expected_generation {
                return;
            }

            // Upgrade the Weak mmap handle INSIDE the same `sessions` mutex
            // that `close_session_inner` locks to remove the session (and,
            // via struct field drop order, delete `temp_file`). That shared
            // lock serializes the two operations: either this indexer wins
            // the lock first, upgrades successfully, and drops its strong
            // `Arc<Mmap>` again before releasing the lock (well before close
            // can run) — or the close wins first, and this indexer observes
            // the session already gone via `get_mut` above and returns
            // without ever upgrading. There is no interleaving in which this
            // task can hold a strong `Arc<Mmap>` at the moment the session's
            // own `Arc` — and therefore `temp_file` — drops.
            let Some(mmap_strong) = mmap.upgrade() else {
                // Session's FileLogSource (and its Arc<Mmap>) is already gone.
                return;
            };
            let data: &[u8] = mmap_strong.as_ref();

            if cursor >= data.len() {
                // Defensive: total_bytes should always equal data.len() for an
                // immutable mapping, but never index out of bounds if not.
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
                    // No progress — break out of the loop.
                    // Return (0, 0) to signal the outer loop to break.
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
            // `mmap_strong` (and `data`, which borrows it) drop here, still
            // inside the `sessions` lock.
        }; // session lock released

        if bytes_in_chunk == 0 {
            break;
        }

        cursor += bytes_in_chunk;
        let done = cursor >= total_bytes;
        total_indexed += chunk_line_count;

        let _ = app.emit(
            "file-index-progress",
            FileIndexProgress {
                session_id: session_id.clone(),
                indexed_lines: total_indexed,
                bytes_scanned: cursor,
                total_bytes,
            },
        );

        if done {
            let _ = app.emit(
                "file-index-complete",
                FileIndexComplete {
                    session_id: session_id.clone(),
                    total_lines: total_indexed,
                },
            );
            if let Ok(mut tasks) = state.indexing_tasks.lock() {
                let tasks: &mut std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>> = &mut tasks;
                tasks.remove(&session_id);
            }
            return;
        }

        // Yield to allow other tokio tasks (e.g. get_lines) to run.
        tokio::task::yield_now().await;
    }
}

// ---------------------------------------------------------------------------
// get_lines
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_lines(
    state: State<'_, std::sync::Arc<AppState>>,
    request: LineRequest,
) -> Result<LineWindow, String> {
    let sessions = lock_or_err(&state.sessions, "sessions")?;

    let session = sessions
        .get(&request.session_id)
        .ok_or_else(|| format!("Session '{}' not found", request.session_id))?;

    let source = session
        .primary_source()
        .ok_or("No sources in session")?;

    let total_lines = source.total_lines();
    let parser = parser_for(source.source_type());

    match request.mode {
        ViewMode::Full => {
            let start = request.offset.min(total_lines);
            let end = (request.offset + request.count).min(total_lines);

            let mut lines = Vec::with_capacity(end - start);

            for i in start..end {
                let raw = source.raw_line(i).as_deref().unwrap_or("").to_string();
                // meta_at() adjusts for stream eviction offset; avoids OOB panic.
                let meta = source.meta_at(i);

                let highlights = request
                    .search
                    .as_ref()
                    .map(|q| compute_search_highlights(&raw, q))
                    .unwrap_or_default();

                let view_line = if let Some(ctx) = parser.parse_line(&raw, source.id(), i) {
                    ViewLine {
                        line_num: i,
                        virtual_index: i,
                        raw: ctx.raw.to_string(),
                        level: ctx.level,
                        tag: ctx.tag.to_string(),
                        message: ctx.message.to_string(),
                        timestamp: ctx.timestamp,
                        pid: ctx.pid,
                        tid: ctx.tid,
                        source_id: ctx.source_id.to_string(),
                        highlights,
                        matched_by: vec![],
                        is_context: false,
                    }
                } else {
                    // Section header or unparseable — fall back to stored meta.
                    // If meta is None (line was evicted from stream buffer), use defaults.
                    ViewLine {
                        line_num: i,
                        virtual_index: i,
                        raw: raw.clone(),
                        level: meta.map_or(LogLevel::Info, |m| m.level),
                        tag: meta.map_or_else(String::new, |m| session.resolve_tag(m.tag_id).to_string()),
                        message: raw,
                        timestamp: meta.map_or(0, |m| m.timestamp),
                        pid: 0,
                        tid: 0,
                        source_id: source.id().to_string(),
                        highlights,
                        matched_by: vec![],
                        is_context: false,
                    }
                };

                lines.push(view_line);
            }

            Ok(LineWindow { total_lines, lines })
        }

        ViewMode::Processor => {
            let proc_id = request.processor_id.as_deref().ok_or("processor_id required for Processor mode")?;

            // Get the matched line numbers from the last pipeline run.
            let matched: Vec<usize> = {
                let pr = lock_or_err(&state.pipeline_results, "pipeline_results")?;
                pr.get(&request.session_id)
                    .and_then(|s| s.get(proc_id))
                    .map(|r| r.matched_line_nums.clone())
                    .unwrap_or_default()
            };

            if matched.is_empty() {
                return Ok(LineWindow { total_lines, lines: vec![] });
            }

            let ctx_lines = request.context;

            // Build the set of lines to include (matches + context).
            // Use a sorted deduplicated list so we emit in order.
            let mut to_show: Vec<usize> = Vec::new();
            for &m in &matched {
                let start = m.saturating_sub(ctx_lines);
                let end = (m + ctx_lines + 1).min(total_lines);
                for ln in start..end {
                    if to_show.last() != Some(&ln) {
                        to_show.push(ln);
                    }
                }
            }
            to_show.sort_unstable();
            to_show.dedup();

            // Apply offset/count pagination over the collapsed view.
            let total_collapsed = to_show.len();
            let page_start = request.offset.min(total_collapsed);
            let page_end = (page_start + request.count).min(total_collapsed);
            let page = &to_show[page_start..page_end];

            let matched_set: std::collections::HashSet<usize> =
                matched.iter().copied().collect();

            let mut lines = Vec::with_capacity(page.len());
            for (pos, &ln) in page.iter().enumerate() {
                let vi = page_start + pos;
                let raw = source.raw_line(ln).as_deref().unwrap_or("").to_string();
                let Some(meta) = source.meta_at(ln) else { continue };
                let highlights = request
                    .search
                    .as_ref()
                    .map(|q| compute_search_highlights(&raw, q))
                    .unwrap_or_default();

                let view_line = if let Some(ctx) = parser.parse_line(&raw, source.id(), ln) {
                    ViewLine {
                        line_num: ln,
                        virtual_index: vi,
                        raw: ctx.raw.to_string(),
                        level: ctx.level,
                        tag: ctx.tag.to_string(),
                        message: ctx.message.to_string(),
                        timestamp: ctx.timestamp,
                        pid: ctx.pid,
                        tid: ctx.tid,
                        source_id: ctx.source_id.to_string(),
                        highlights,
                        matched_by: if matched_set.contains(&ln) {
                            vec![proc_id.to_string()]
                        } else {
                            vec![]
                        },
                        is_context: !matched_set.contains(&ln),
                    }
                } else {
                    ViewLine {
                        line_num: ln,
                        virtual_index: vi,
                        raw: raw.clone(),
                        level: meta.level,
                        tag: session.resolve_tag(meta.tag_id).to_string(),
                        message: raw,
                        timestamp: meta.timestamp,
                        pid: 0,
                        tid: 0,
                        source_id: source.id().to_string(),
                        highlights,
                        matched_by: if matched_set.contains(&ln) {
                            vec![proc_id.to_string()]
                        } else {
                            vec![]
                        },
                        is_context: !matched_set.contains(&ln),
                    }
                };
                lines.push(view_line);
            }

            Ok(LineWindow {
                total_lines: total_collapsed,
                lines,
            })
        }

        ViewMode::Focus(center) => {
            // Return `context` lines before and after center
            let half = request.context.max(25);
            let start = center.saturating_sub(half);
            let end = (center + half + 1).min(total_lines);

            // Build the sub-window inline. This is NOT a recursive call into the
            // `ViewMode::Full` arm above — it can't be, since that arm always
            // reports `is_context: false` while this one marks every line but
            // `center` as context. Re-acquire the session lock after dropping
            // it below (`get_lines` itself is not re-entered).
            drop(sessions); // release lock before re-acquiring below
            let state_ref: &AppState = &state;
            let inner_sessions = lock_or_err(&state_ref.sessions, "sessions")?;
            let inner_session = inner_sessions
                .get(&request.session_id)
                .ok_or("Session not found")?;
            let inner_source = inner_session.primary_source().ok_or("No source")?;

            let mut lines = Vec::new();
            for i in start..end {
                let raw = inner_source.raw_line(i).as_deref().unwrap_or("").to_string();
                let meta = inner_source.meta_at(i);
                let highlights = request
                    .search
                    .as_ref()
                    .map(|q| compute_search_highlights(&raw, q))
                    .unwrap_or_default();
                let ctx = parser.parse_line(&raw, inner_source.id(), i);
                let view_line = match ctx {
                    Some(c) => ViewLine {
                        line_num: i,
                        virtual_index: i,
                        raw: c.raw.to_string(),
                        level: c.level,
                        tag: c.tag.to_string(),
                        message: c.message.to_string(),
                        timestamp: c.timestamp,
                        pid: c.pid,
                        tid: c.tid,
                        source_id: c.source_id.to_string(),
                        highlights,
                        matched_by: vec![],
                        is_context: i != center,
                    },
                    None => {
                        let m = meta.unwrap_or(&crate::core::line::LineMeta {
                            level: LogLevel::Info,
                            tag_id: 0,
                            timestamp: 0,
                            byte_offset: 0,
                            byte_len: 0,
                            is_section_boundary: false,
                        });
                        ViewLine {
                            line_num: i,
                            virtual_index: i,
                            raw: raw.clone(),
                            level: m.level,
                            tag: inner_session.resolve_tag(m.tag_id).to_string(),
                            message: raw,
                            timestamp: m.timestamp,
                            pid: 0,
                            tid: 0,
                            source_id: inner_source.id().to_string(),
                            highlights,
                            matched_by: vec![],
                            is_context: i != center,
                        }
                    },
                };
                lines.push(view_line);
            }

            Ok(LineWindow { total_lines, lines })
        }
    }
}

// ---------------------------------------------------------------------------
// search_logs (streaming chunked results via events)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgress {
    session_id: String,
    matched_so_far: usize,
    lines_scanned: usize,
    total_lines: usize,
    new_matches: Vec<usize>,
    done: bool,
}

/// Parse "HH:MM" or "HH:MM:SS" into nanoseconds within a 24-hour day.
/// Returns None on invalid input.
fn parse_time_to_day_ns(s: &str) -> Option<i64> {
    let mut parts = s.splitn(3, ':');
    let h: i64 = parts.next()?.trim().parse().ok()?;
    let m: i64 = parts.next()?.trim().parse().ok()?;
    let sec: i64 = parts
        .next()
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if !(0..=23).contains(&h) || !(0..=59).contains(&m) || !(0..=59).contains(&sec) {
        return None;
    }
    Some((h * 3600 + m * 60 + sec) * 1_000_000_000)
}

const SEARCH_CHUNK_SIZE: usize = 10_000;

#[tauri::command]
pub async fn search_logs(
    state: State<'_, std::sync::Arc<AppState>>,
    app_handle: AppHandle,
    session_id: String,
    query: SearchQuery,
) -> Result<SearchSummary, String> {
    // Acquire the lock briefly to read total_lines and validate the session exists.
    let total_lines = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{session_id}' not found"))?;
        let source = session.primary_source().ok_or("No sources in session")?;
        source.total_lines()
    };

    let compiled_re = if query.is_regex {
        let pattern = if query.case_sensitive {
            query.text.clone()
        } else {
            format!("(?i){}", query.text)
        };
        Some(Regex::new(&pattern).map_err(|e| format!("Invalid regex: {e}"))?)
    } else {
        None
    };

    let needle_lower = query.text.to_lowercase();

    // Pre-compute time range bounds (nanoseconds within a 24-hour day)
    const DAY_NS: i64 = 86_400_000_000_000; // 24 * 60 * 60 * 1_000_000_000
    let start_ns = query.start_time.as_deref().and_then(parse_time_to_day_ns);
    let end_ns = query.end_time.as_deref().and_then(parse_time_to_day_ns);
    let has_time_filter = start_ns.is_some() || end_ns.is_some();

    let mut match_line_nums: Vec<usize> = Vec::new();
    let mut by_level: HashMap<String, usize> = HashMap::new();
    let mut by_tag: HashMap<String, usize> = HashMap::new();

    // Process in chunks, emitting progress events
    let mut chunk_start = 0;
    while chunk_start < total_lines {
        let chunk_end = (chunk_start + SEARCH_CHUNK_SIZE).min(total_lines);
        let mut chunk_matches: Vec<usize> = Vec::new();

        // Acquire lock briefly to read this chunk of lines
        {
            let sessions = lock_or_err(&state.sessions, "sessions")?;
            let session = sessions
                .get(&session_id)
                .ok_or_else(|| format!("Session '{session_id}' not found"))?;
            let source = session.primary_source().ok_or("No sources in session")?;

            for i in chunk_start..chunk_end {
                let Some(meta) = source.meta_at(i) else {
                    continue;
                };

                // Level filter
                if let Some(min_level) = query.min_level {
                    if meta.level < min_level {
                        continue;
                    }
                }

                // Tag filter
                if let Some(ref tags) = query.tags {
                    let tag_str = session.resolve_tag(meta.tag_id);
                    if !tags.is_empty() && !tags.iter().any(|t| t == tag_str) {
                        continue;
                    }
                }

                // Time range filter
                if has_time_filter {
                    if meta.timestamp == 0 {
                        continue;
                    }
                    let ts_mod = meta.timestamp % DAY_NS;
                    if let Some(s) = start_ns {
                        if ts_mod < s {
                            continue;
                        }
                    }
                    if let Some(e) = end_ns {
                        if ts_mod > e {
                            continue;
                        }
                    }
                }

                // Text match
                let raw_cow = source.raw_line(i);
                let raw = raw_cow.as_deref().unwrap_or("");
                let matched = if let Some(ref re) = compiled_re {
                    re.is_match(raw)
                } else if query.case_sensitive {
                    raw.contains(query.text.as_str())
                } else {
                    raw.to_lowercase().contains(&needle_lower)
                };

                if matched {
                    chunk_matches.push(i);
                    *by_level
                        .entry(format!("{:?}", meta.level))
                        .or_insert(0) += 1;
                    let tag_str = session.resolve_tag(meta.tag_id);
                    if !tag_str.is_empty() {
                        *by_tag.entry(tag_str.to_string()).or_insert(0) += 1;
                    }
                }
            }
        } // lock released

        match_line_nums.extend_from_slice(&chunk_matches);

        // Emit progress event for this chunk
        let _ = app_handle.emit(
            "search-progress",
            SearchProgress {
                session_id: session_id.clone(),
                matched_so_far: match_line_nums.len(),
                lines_scanned: chunk_end,
                total_lines,
                new_matches: chunk_matches,
                done: false,
            },
        );

        chunk_start = chunk_end;

        // Yield to allow other tasks to run between chunks
        tokio::task::yield_now().await;
    }

    // Emit final done event
    let _ = app_handle.emit(
        "search-progress",
        SearchProgress {
            session_id: session_id.clone(),
            matched_so_far: match_line_nums.len(),
            lines_scanned: total_lines,
            total_lines,
            new_matches: vec![],
            done: true,
        },
    );

    Ok(SearchSummary {
        total_matches: match_line_nums.len(),
        match_line_nums,
        by_level,
        by_tag,
    })
}

// ---------------------------------------------------------------------------
// get_dumpstate_metadata
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_dumpstate_metadata(
    state: State<'_, std::sync::Arc<AppState>>,
    session_id: String,
) -> Result<DumpstateMetadata, String> {
    get_dumpstate_metadata_inner(&state, &session_id).await
}

/// Inner implementation taking `&AppState` directly (rather than Tauri's
/// `State<'_, std::sync::Arc<AppState>>` wrapper) so it can be exercised in unit tests
/// without a running Tauri app — mirrors `close_session_inner` /
/// `stop_mcp_bridge_inner` elsewhere in `commands/`.
pub(crate) async fn get_dumpstate_metadata_inner(
    state: &AppState,
    session_id: &str,
) -> Result<DumpstateMetadata, String> {
    let total_lines = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("Session '{session_id}' not found"))?;
        let source = session.primary_source().ok_or("No sources in session")?;
        source.total_lines()
    };

    let mut meta = DumpstateMetadata {
        build_string: None,
        build_fingerprint: None,
        os_version: None,
        build_type: None,
        bootloader: None,
        serial: None,
        uptime: None,
        kernel_version: None,
        sdk_version: None,
        device_model: None,
        manufacturer: None,
    };

    // Track which section we're in based on section header tags.
    let mut in_kernel_section = false;
    let mut kernel_next = false; // next plain content line after KERNEL VERSION header
    let mut in_props_section = false;
    let mut passed_first_section = false;
    let mut done = false;

    // Scanned in chunks, re-acquiring the session lock per chunk and yielding
    // in between — same pattern as `search_logs` above. Reusing
    // `SEARCH_CHUNK_SIZE` as the chunk/yield interval keeps this in step with
    // that established rhythm rather than inventing a second tuning knob.
    let mut chunk_start = 0;
    while chunk_start < total_lines && !done {
        let chunk_end = (chunk_start + SEARCH_CHUNK_SIZE).min(total_lines);

        {
            let sessions = lock_or_err(&state.sessions, "sessions")?;
            let session = sessions
                .get(session_id)
                .ok_or_else(|| format!("Session '{session_id}' not found"))?;
            let source = session.primary_source().ok_or("No sources in session")?;

            for i in chunk_start..chunk_end {
                let Some(line_m) = source.meta_at(i) else {
                    continue;
                };
                let raw_cow = source.raw_line(i);
                let raw = raw_cow.as_deref().unwrap_or("").trim_end_matches(['\r', '\n']);

                // Detect section boundaries from tag field (BugreportParser sets tag on ------ lines).
                if raw.starts_with("------") {
                    if !raw.contains("was the duration of") {
                        // Section start header.
                        passed_first_section = true;
                        let tag = session.resolve_tag(line_m.tag_id);
                        in_kernel_section = tag == "KERNEL VERSION";
                        in_props_section = tag == "SYSTEM PROPERTIES";
                        kernel_next = in_kernel_section;
                    }
                    continue;
                }

                // Skip decorative separators and == dumpstate: lines.
                if raw.starts_with("====") || raw.starts_with("==") {
                    continue;
                }

                if in_kernel_section && kernel_next && !raw.trim().is_empty() {
                    meta.kernel_version = Some(raw.trim().to_string());
                    kernel_next = false;
                    in_kernel_section = false;
                    continue;
                }

                if in_props_section {
                    // Pattern: [ro.build.version.sdk]: [34]
                    if let Some(rest) = raw.strip_prefix("[ro.build.version.sdk]: [") {
                        meta.sdk_version = rest.strip_suffix(']').map(str::trim).map(String::from);
                    } else if let Some(rest) = raw.strip_prefix("[ro.product.model]: [") {
                        meta.device_model = rest.strip_suffix(']').map(str::trim).map(String::from);
                    } else if let Some(rest) = raw.strip_prefix("[ro.product.manufacturer]: [") {
                        meta.manufacturer = rest.strip_suffix(']').map(str::trim).map(String::from);
                    }

                    // Stop scanning once we have all header data, the kernel
                    // version, and every system property we track. This check
                    // MUST live here, before this branch's own `continue` —
                    // every in_props_section iteration previously fell through
                    // to that `continue` before a check placed after the loop
                    // body could ever run, making the old break unreachable
                    // dead code (every call scanned the whole source).
                    if passed_first_section
                        && meta.kernel_version.is_some()
                        && meta.sdk_version.is_some()
                        && meta.device_model.is_some()
                        && meta.manufacturer.is_some()
                    {
                        done = true;
                        break;
                    }

                    continue;
                }

                // Header lines before the first section.
                if !passed_first_section {
                    if raw.starts_with("Build: ") && meta.build_string.is_none() {
                        let value = raw["Build: ".len()..].trim().to_string();
                        // Extract build type from trailing "(user)" / "(userdebug)" / "(eng)".
                        if let (Some(lp), Some(rp)) = (value.rfind('('), value.rfind(')')) {
                            if lp < rp {
                                meta.build_type = Some(value[lp + 1..rp].to_string());
                            }
                        }
                        meta.build_string = Some(value);
                    } else if raw.starts_with("Build fingerprint: '") && meta.build_fingerprint.is_none() {
                        let fp = raw["Build fingerprint: '".len()..]
                            .trim_end_matches('\'')
                            .trim()
                            .to_string();
                        // Extract OS version from fingerprint: brand/product/device:RELEASE/id/...
                        // Third `:` separates device from RELEASE.
                        if let Some(colon_pos) = fp.find(':') {
                            let after = &fp[colon_pos + 1..];
                            if let Some(slash_pos) = after.find('/') {
                                meta.os_version = Some(after[..slash_pos].to_string());
                            }
                        }
                        meta.build_fingerprint = Some(fp);
                    } else if raw.starts_with("Bootloader: ") && meta.bootloader.is_none() {
                        meta.bootloader = Some(raw["Bootloader: ".len()..].trim().to_string());
                    } else if raw.contains("androidboot.serialno") && meta.serial.is_none() {
                        // Handles both:
                        //   androidboot.serialno = "R52X10EJCFA"        (standalone line)
                        //   ...androidboot.serialno=R52X10EJCFA ...     (kernel cmdline)
                        if let Some(sn_pos) = raw.find("androidboot.serialno") {
                            let after = raw[sn_pos + "androidboot.serialno".len()..].trim_start_matches(' ');
                            if let Some(rest) = after.strip_prefix('=') {
                                let rest = rest.trim_start_matches([' ', '"']);
                                let val: String = rest.chars().take_while(|&c| c != ' ' && c != '"').collect();
                                if !val.is_empty() {
                                    meta.serial = Some(val);
                                }
                            }
                        }
                    } else if raw.starts_with("Uptime: ") && meta.uptime.is_none() {
                        meta.uptime = Some(raw["Uptime: ".len()..].trim().to_string());
                    }
                }
            }
        } // lock released

        chunk_start = chunk_end;

        if !done {
            tokio::task::yield_now().await;
        }
    }

    Ok(meta)
}

// ---------------------------------------------------------------------------
// read_text_file / write_text_file
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("Failed to write file: {e}"))
}

// ---------------------------------------------------------------------------
// get_startup_file
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_startup_file(state: State<'_, std::sync::Arc<AppState>>) -> Result<Option<String>, String> {
    let mut sp = lock_or_err(&state.startup_file_path, "startup_file_path")?;
    Ok(sp.take())
}

// ---------------------------------------------------------------------------
// get_sections
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_sections(
    state: State<'_, std::sync::Arc<AppState>>,
    session_id: String,
) -> Result<Vec<SectionInfo>, String> {
    let sessions = lock_or_err(&state.sessions, "sessions")?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{session_id}' not found"))?;
    let src = session.primary_source().ok_or("No sources in session")?;
    Ok(src.sections().to_vec())
}

// ---------------------------------------------------------------------------
// Highlight computation
// ---------------------------------------------------------------------------

pub fn compute_search_highlights(raw: &str, query: &SearchQuery) -> Vec<HighlightSpan> {
    if query.text.is_empty() {
        return vec![];
    }

    let mut spans = Vec::new();

    if query.is_regex {
        let pattern = if query.case_sensitive {
            query.text.clone()
        } else {
            format!("(?i){}", query.text)
        };
        if let Ok(re) = Regex::new(&pattern) {
            for m in re.find_iter(raw) {
                spans.push(HighlightSpan {
                    start: m.start(),
                    end: m.end(),
                    kind: HighlightKind::Search,
                });
            }
        }
    } else if query.case_sensitive {
        let mut offset = 0;
        while let Some(pos) = raw[offset..].find(query.text.as_str()) {
            let abs = offset + pos;
            spans.push(HighlightSpan {
                start: abs,
                end: abs + query.text.len(),
                kind: HighlightKind::Search,
            });
            offset = abs + query.text.len().max(1);
            if offset >= raw.len() {
                break;
            }
        }
    } else {
        let lower_raw = raw.to_lowercase();
        let lower_needle = query.text.to_lowercase();
        let mut offset = 0;
        while let Some(pos) = lower_raw[offset..].find(&lower_needle) {
            let abs = offset + pos;
            spans.push(HighlightSpan {
                start: abs,
                end: abs + lower_needle.len(),
                kind: HighlightKind::Search,
            });
            offset = abs + lower_needle.len().max(1);
            if offset >= lower_raw.len() {
                break;
            }
        }
    }

    spans
}

// ---------------------------------------------------------------------------
// restore_artifacts — shared helper
// ---------------------------------------------------------------------------

/// Restore bookmarks and analyses into AppState.
///
/// Bookmarks are session-keyed as before: stored under `session_id`'s map
/// entry with their own `session_id` field rewritten to match.
///
/// Analyses are workspace-owned (not keyed by session): each restored
/// artifact is stamped via [`crate::core::analysis::migrate_artifact`] with
/// `session_id` as the fallback (so any reference that arrived with no
/// attribution of its own resolves to this session; references that already
/// carry their own `session_id` — a multi-session artifact restored from an
/// archive that also touched another still-open session — are left alone),
/// then UPSERTED into the workspace store by artifact id: an artifact whose
/// id already exists in the store is replaced in place, otherwise it is
/// appended. This makes restoring the same `.lts`/`.ltw` twice (or restoring
/// several sessions that both reference the same multi-session artifact)
/// idempotent rather than producing duplicate entries.
pub(crate) fn restore_artifacts(
    state: &AppState,
    session_id: &str,
    bookmarks: Vec<crate::core::bookmark::Bookmark>,
    analyses: Vec<crate::core::analysis::AnalysisArtifact>,
) -> (usize, usize) {
    let bm_count = bookmarks.len();
    let an_count = analyses.len();
    if !bookmarks.is_empty() {
        let mut bm = bookmarks;
        for b in &mut bm {
            b.session_id = session_id.to_string();
        }
        if let Ok(mut map) = state.bookmarks.lock() {
            map.insert(session_id.to_string(), bm);
        }
    }
    if !analyses.is_empty() {
        if let Ok(mut store) = state.analyses.lock() {
            for mut artifact in analyses {
                crate::core::analysis::migrate_artifact(&mut artifact, Some(session_id));
                if let Some(existing) = store.iter_mut().find(|a| a.id == artifact.id) {
                    *existing = artifact;
                } else {
                    store.push(artifact);
                }
            }
        }
    }
    (bm_count, an_count)
}

/// Rewrite every workspace analysis reference whose `session_id` matches one
/// of `old_ids` to point at `new_id` instead.
///
/// Analyses are workspace-owned and are never removed by
/// [`close_session_inner`] — so when a session's id changes across a
/// close+reopen of the same underlying file (e.g. correcting a source-type
/// override, which is part of the id preimage), per-reference attribution
/// pointing at the old id would otherwise silently go stale, pointing at a
/// session that no longer exists. A no-op when `old_ids` is empty.
pub(crate) fn restamp_analysis_references(
    state: &AppState,
    old_ids: &[String],
    new_id: &str,
) -> Result<(), String> {
    if old_ids.is_empty() {
        return Ok(());
    }
    let mut analyses = lock_or_err(&state.analyses, "analyses")?;
    for artifact in analyses.iter_mut() {
        for section in &mut artifact.sections {
            for reference in &mut section.references {
                if reference
                    .session_id
                    .as_deref()
                    .is_some_and(|sid| old_ids.iter().any(|old| old == sid))
                {
                    reference.session_id = Some(new_id.to_string());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::AppState;
    use crate::core::session::AnalysisSession;
    use std::collections::HashMap;

    fn make_state() -> AppState {
        AppState::new()
    }

    fn sample_bookmark(
        id: &str,
        session_id: &str,
        line: u32,
    ) -> crate::core::bookmark::Bookmark {
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

    fn insert_session(state: &AppState, id: &str, file_path: Option<&str>) {
        let mut session = AnalysisSession::new(id.to_string());
        session.file_path = file_path.map(str::to_string);
        state.sessions.lock().unwrap().insert(id.to_string(), session);
    }

    // -------------------------------------------------------------------------
    // indexer_cancelled — cancellation polling semantics
    // -------------------------------------------------------------------------

    #[test]
    fn indexer_cancelled_treats_ok_and_closed_as_cancel() {
        use tokio::sync::oneshot::error::TryRecvError;
        // Explicit cancel signal → stop.
        assert!(indexer_cancelled(Ok(())));
        // Sender dropped without sending (overwritten indexing_tasks entry) →
        // stop. This is the "unstoppable indexer on sender drop" bug.
        assert!(indexer_cancelled(Err(TryRecvError::Closed)));
        // No signal yet, sender still alive → keep indexing.
        assert!(!indexer_cancelled(Err(TryRecvError::Empty)));
    }

    #[test]
    fn indexer_cancelled_on_dropped_sender_via_channel() {
        // A real channel: dropping the sender makes try_recv return Closed, which
        // indexer_cancelled must treat as "stop".
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        drop(tx);
        assert!(indexer_cancelled(rx.try_recv()), "dropped sender must cancel");

        // Sender alive, nothing sent → Empty → keep going.
        let (_tx, mut rx2) = tokio::sync::oneshot::channel::<()>();
        assert!(!indexer_cancelled(rx2.try_recv()), "live+empty must not cancel");

        // Explicit send → Ok → cancel.
        let (tx3, mut rx3) = tokio::sync::oneshot::channel::<()>();
        tx3.send(()).unwrap();
        assert!(indexer_cancelled(rx3.try_recv()), "signalled must cancel");
    }

    // -------------------------------------------------------------------------
    // close_session_inner
    // -------------------------------------------------------------------------

    #[test]
    fn close_session_inner_removes_session_from_map() {
        let state = make_state();
        insert_session(&state, "sess-1", None);
        assert!(state.sessions.lock().unwrap().contains_key("sess-1"));

        close_session_inner(&state, None, "sess-1").unwrap();

        assert!(!state.sessions.lock().unwrap().contains_key("sess-1"),
            "session must be removed after close");
    }

    #[test]
    fn close_session_inner_sends_indexing_cancellation() {
        let state = make_state();
        insert_session(&state, "sess-2", None);
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
        state.indexing_tasks.lock().unwrap().insert("sess-2".to_string(), cancel_tx);

        close_session_inner(&state, None, "sess-2").unwrap();

        // The sender was consumed and the cancellation signal delivered
        assert!(cancel_rx.try_recv().is_ok(),
            "indexing task must receive cancellation on close");
    }

    #[test]
    fn close_session_inner_removes_pipeline_results() {
        let state = make_state();
        insert_session(&state, "sess-3", None);
        state.pipeline_results.lock().unwrap()
            .insert("sess-3".to_string(), HashMap::new());

        close_session_inner(&state, None, "sess-3").unwrap();

        assert!(!state.pipeline_results.lock().unwrap().contains_key("sess-3"),
            "pipeline results must be cleared on close");
    }

    #[test]
    fn close_session_inner_removes_pipeline_run_lock() {
        let state = make_state();
        insert_session(&state, "sess-runlock", None);
        // Materialize the per-session run lock (as execute_pipeline would).
        let _ = state.pipeline_run_lock("sess-runlock").unwrap();
        assert!(
            state.pipeline_run_locks.lock().unwrap().contains_key("sess-runlock"),
            "precondition: run lock entry exists before close"
        );

        close_session_inner(&state, None, "sess-runlock").unwrap();

        assert!(
            !state.pipeline_run_locks.lock().unwrap().contains_key("sess-runlock"),
            "close_session_inner must evict the session's pipeline run lock so the \
             registry does not grow (or retain poisoned locks) for the app's lifetime"
        );
    }

    #[test]
    fn close_session_inner_is_noop_on_unknown_id() {
        let state = make_state();
        // Must not panic or error when the session doesn't exist
        assert!(close_session_inner(&state, None, "nonexistent").is_ok());
    }

    /// Acceptance test for the MCP close endpoint: closing a session must actually
    /// DROP the file's memory map, not merely unregister the session. On Windows a
    /// mapped file stays locked until every mapping view is dropped, so a successful
    /// rename after close is proof the mmap was released. This is the whole point of
    /// wiring the bridge close through `close_session_inner` (which removes the
    /// session, dropping its `FileLogSource` and the `Arc<Mmap>` inside it).
    #[test]
    fn close_session_inner_drops_mmap_so_file_can_be_renamed() {
        let state = make_state();
        let id = "mmap-drop-sess";

        // A real on-disk temp file with logcat-shaped content so the parser indexes it.
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut temp_path = std::env::temp_dir();
        temp_path.push(format!("logtapper_close_mmap_{unique}.log"));
        std::fs::write(
            &temp_path,
            "01-01 00:00:00.000  1000  1000 I TestTag: first line\n\
             01-01 00:00:00.001  1000  1000 I TestTag: second line\n",
        )
        .expect("write temp log file");

        // Build a session over the file — this opens the memory map — and register it.
        // `add_source_partial` returns a Weak<Mmap> (the handle handed to the
        // background indexer in production) rather than a strong Arc clone —
        // keep it here and assert it can no longer upgrade after close, below.
        // Holding a Weak must NOT keep the mapping alive, unlike the old Arc
        // clone this test used to discard to avoid masking a leak.
        let weak_mmap = {
            let mut session = AnalysisSession::new(id.to_string());
            session.file_path = Some(temp_path.to_string_lossy().to_string());
            let (weak_mmap, _, _) = session
                .add_source_partial(&temp_path, "src-0".to_string(), 1_000_000)
                .expect("add_source_partial should open + index the file");
            state.sessions.lock().unwrap().insert(id.to_string(), session);
            weak_mmap
        };
        assert!(state.sessions.lock().unwrap().contains_key(id));
        assert!(
            weak_mmap.upgrade().is_some(),
            "precondition: the mmap must still be live before close"
        );

        // Close: removes the session, dropping the FileLogSource and its mmap.
        close_session_inner(&state, None, id).unwrap();

        // (a) The id is gone from the sessions map.
        assert!(
            !state.sessions.lock().unwrap().contains_key(id),
            "session id must be gone from the sessions map after close"
        );

        // (a.5) The Weak handle a background indexer would have held can no
        // longer be upgraded — the session's own Arc<Mmap> was the only
        // strong owner, and it is gone. This is the ownership invariant that
        // lets temp_file's Drop reliably delete a zip-extracted temp file:
        // nothing outside the session can resurrect a strong reference to
        // the mapping once the session itself has been dropped.
        assert!(
            weak_mmap.upgrade().is_none(),
            "a Weak<Mmap> handed to a background indexer must not upgrade after \
             the owning session is closed — otherwise it could keep the mapping \
             alive past temp_file's Drop and orphan the extracted file on Windows"
        );

        // (b) The file can now be renamed. On Windows this FAILS with an access/sharing
        //     violation if the mmap is still held, so success proves the mapping was
        //     actually dropped rather than just unregistered.
        let moved_path = temp_path.with_extension("moved");
        let _ = std::fs::remove_file(&moved_path); // clear any leftover from a prior run
        std::fs::rename(&temp_path, &moved_path).expect(
            "rename must succeed after close — a lingering mmap keeps the file locked on Windows",
        );

        // Cleanup.
        let _ = std::fs::remove_file(&moved_path);
    }

    // -------------------------------------------------------------------------
    // Stale-session dedup (same logic as load_log_file's path-scan block)
    // -------------------------------------------------------------------------

    #[test]
    fn stale_session_with_matching_path_is_found_and_closed() {
        let state = make_state();
        insert_session(&state, "stale-id", Some("/logs/device.log"));
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
        state.indexing_tasks.lock().unwrap()
            .insert("stale-id".to_string(), cancel_tx);

        // Replicate the exact scan + close block from load_log_file
        let path = "/logs/device.log";
        let stale_id = {
            let sessions = state.sessions.lock().unwrap();
            sessions.values()
                .find(|s| s.file_path.as_deref() == Some(path))
                .map(|s| s.id.clone())
        };
        assert_eq!(stale_id.as_deref(), Some("stale-id"),
            "must find the stale session by file path");

        close_session_inner(&state, None, stale_id.unwrap().as_str()).unwrap();

        assert!(!state.sessions.lock().unwrap().contains_key("stale-id"),
            "stale session must be removed");
        assert!(cancel_rx.try_recv().is_ok(),
            "stale session's indexing task must be cancelled");
    }

    #[test]
    fn stale_session_scan_returns_none_for_different_path() {
        let state = make_state();
        insert_session(&state, "sess-a", Some("/logs/other.log"));

        let stale_id = {
            let sessions = state.sessions.lock().unwrap();
            sessions.values()
                .find(|s| s.file_path.as_deref() == Some("/logs/device.log"))
                .map(|s| s.id.clone())
        };

        assert!(stale_id.is_none(),
            "must not find a session when paths don't match");
        // Original session is untouched
        assert!(state.sessions.lock().unwrap().contains_key("sess-a"));
    }

    #[test]
    fn stale_session_scan_ignores_stream_sessions_with_no_path() {
        let state = make_state();
        // A live ADB session has file_path = None — must not match any file path
        insert_session(&state, "adb-session", None);

        let stale_id = {
            let sessions = state.sessions.lock().unwrap();
            sessions.values()
                .find(|s| s.file_path.as_deref() == Some("/logs/device.log"))
                .map(|s| s.id.clone())
        };

        assert!(stale_id.is_none(),
            "stream sessions with no file_path must not be matched");
    }

    // -------------------------------------------------------------------------
    // close_stale_sessions — canonical (case-insensitive) matching
    // -------------------------------------------------------------------------

    /// Two differently-cased spellings of the SAME real file must be recognised
    /// as the same session by `close_stale_sessions`. This is the invariant that
    /// makes reopen idempotent: `derive_file_session_id_from_disk` derives the id
    /// from the canonical-lowercased path, so both spellings derive the same id;
    /// the stale-close must catch the alias so the reopen's `sessions.insert` does
    /// not silently overwrite the prior entry and skip its cleanup. The map must
    /// end with exactly one session (the freshly opened one).
    #[test]
    fn close_stale_sessions_matches_differently_cased_paths_to_same_file() {
        use std::fs;

        let state = make_state();
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("device.log");
        fs::write(&file, "line one\nline two\n").expect("write test file");

        // Existing (stale) session stored under the path's as-created casing.
        let stored_path = file.to_string_lossy().into_owned();
        insert_session(&state, "stale-id", Some(&stored_path));
        assert!(state.sessions.lock().unwrap().contains_key("stale-id"));

        // Reopen the SAME file via an upper-cased spelling. NTFS resolves it to
        // the same file, so canonical comparison must treat the stale session as
        // a match even though the raw strings differ.
        let reopened_path = stored_path.to_uppercase();
        assert_ne!(reopened_path, stored_path, "test needs a case-differing spelling");

        close_stale_sessions(&state, None, &reopened_path).unwrap();
        // Simulate what open_file_inner does next: insert the fresh session.
        insert_session(&state, "fresh-id", Some(&reopened_path));

        let sessions = state.sessions.lock().unwrap();
        assert!(!sessions.contains_key("stale-id"),
            "differently-cased path to the same file must be closed as stale");
        assert_eq!(sessions.len(), 1,
            "map must hold exactly the freshly opened session after the stale one closes");
        assert!(sessions.contains_key("fresh-id"));
    }

    /// Reopening a file with a different source type mints a NEW session id
    /// (the override is part of the id preimage), and closing the old session
    /// deletes its bookmarks. Without a rescue, correcting a misdetected file
    /// silently destroys the user's work.
    #[test]
    fn reopen_with_override_carries_artifacts_to_the_new_session() {
        use std::fs;
        let state = make_state();
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("board.txt");
        fs::write(&file, "[    0.000000] boot
[    1.000000] more
").expect("write");
        let path = file.to_string_lossy().to_string();

        // A session opened with detection (no override), carrying user work.
        let detected_id =
            crate::core::session_identity::derive_file_session_id_from_disk(&file, None);
        insert_session(&state, &detected_id, Some(&path));
        state.bookmarks.lock().unwrap().insert(
            detected_id.clone(),
            vec![sample_bookmark("bm-1", &detected_id, 42)],
        );

        // The id a Kernel-override reopen would produce — known upfront so
        // the rescue can restamp analysis references onto it directly.
        let override_id =
            crate::core::session_identity::derive_file_session_id_from_disk(&file, Some("Kernel"));
        assert_ne!(override_id, detected_id, "the override must change the id");

        let rescued = rescue_artifacts_for_replacement(&state, &file, &path, &override_id)
            .expect("rescue must succeed");

        assert_eq!(rescued.bookmarks.len(), 1, "the bookmark must be rescued");
        assert_eq!(rescued.bookmarks[0].line_number, 42, "line reference is preserved");
        assert!(
            state.bookmarks.lock().unwrap().get(&detected_id).is_none(),
            "rescued artifacts are taken, not copied — the old id must be emptied"
        );

        rescued.restore_onto(&state, &override_id).expect("restore");

        let bm = state.bookmarks.lock().unwrap();
        let carried = bm.get(&override_id).expect("the new session must inherit the bookmark");
        assert_eq!(carried.len(), 1);
        assert_eq!(
            carried[0].session_id, override_id,
            "the embedded session_id must be rewritten too — storing under the new map key \
             alone leaves it pointing at a session that no longer exists, and that value \
             travels out over the MCP bridge and into workspace saves"
        );
    }

    /// The guard that keeps the rescue honest. If the file's bytes changed, the
    /// stale session's id can no longer be reproduced from disk, and its
    /// bookmarks refer to lines that no longer mean the same thing. They must
    /// die with the old session rather than being grafted onto new content.
    #[test]
    fn replaced_file_does_not_inherit_stale_artifacts() {
        use std::fs;
        let state = make_state();
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("device.log");
        fs::write(&file, "original content
").expect("write");
        let path = file.to_string_lossy().to_string();

        let old_id = crate::core::session_identity::derive_file_session_id_from_disk(&file, None);
        insert_session(&state, &old_id, Some(&path));
        state.bookmarks.lock().unwrap().insert(
            old_id.clone(),
            vec![sample_bookmark("bm-stale", &old_id, 3)],
        );

        // The file is replaced underneath the open session.
        fs::write(&file, "completely different content, many more lines
").expect("rewrite");

        let new_id = crate::core::session_identity::derive_file_session_id_from_disk(&file, None);
        let rescued = rescue_artifacts_for_replacement(&state, &file, &path, &new_id)
            .expect("rescue must succeed");

        assert!(
            rescued.bookmarks.is_empty(),
            "artifacts from a session whose file changed must NOT be carried forward"
        );
        assert!(
            state.bookmarks.lock().unwrap().get(&old_id).is_some(),
            "they are left in place for close_session_inner to purge with the session"
        );
    }

    // -------------------------------------------------------------------------
    // restamp_analysis_references
    // -------------------------------------------------------------------------

    /// A source-type-override reopen mints a new session id for the same
    /// underlying file. Analyses are workspace-owned and are never removed
    /// by `close_session_inner`, so a reference pointing at the old id must
    /// be restamped onto the new one — otherwise it silently points at a
    /// session that no longer exists.
    #[test]
    fn restamp_moves_references_from_old_session_id_to_new_on_type_change_reopen() {
        use crate::core::analysis::{AnalysisArtifact, AnalysisSection, HighlightType, SourceReference};

        let state = make_state();
        let artifact = AnalysisArtifact {
            id: "art-1".to_string(),
            title: "Analysis".to_string(),
            created_at: 1,
            sections: vec![AnalysisSection {
                heading: "H".to_string(),
                body: "B".to_string(),
                references: vec![SourceReference {
                    line_number: 1,
                    end_line: None,
                    label: "ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: Some("old-sess".to_string()),
                }],
                severity: None,
            }],
            legacy_session_id: None,
        };
        state.analyses.lock().unwrap().push(artifact);

        restamp_analysis_references(&state, &["old-sess".to_string()], "new-sess")
            .expect("restamp must succeed");

        let analyses = state.analyses.lock().unwrap();
        assert_eq!(
            analyses[0].sections[0].references[0].session_id.as_deref(),
            Some("new-sess"),
            "a reference pointing at an old id must be restamped onto the new id"
        );
    }

    /// A reference attributed to a session that is not in `old_ids` must be
    /// left completely untouched — restamp only rewrites the ids it was
    /// explicitly told about.
    #[test]
    fn restamp_leaves_references_for_unrelated_sessions_alone() {
        use crate::core::analysis::{AnalysisArtifact, AnalysisSection, HighlightType, SourceReference};

        let state = make_state();
        let artifact = AnalysisArtifact {
            id: "art-1".to_string(),
            title: "Analysis".to_string(),
            created_at: 1,
            sections: vec![AnalysisSection {
                heading: "H".to_string(),
                body: "B".to_string(),
                references: vec![SourceReference {
                    line_number: 1,
                    end_line: None,
                    label: "ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: Some("unrelated-sess".to_string()),
                }],
                severity: None,
            }],
            legacy_session_id: None,
        };
        state.analyses.lock().unwrap().push(artifact);

        restamp_analysis_references(&state, &["old-sess".to_string()], "new-sess")
            .expect("restamp must succeed");

        let analyses = state.analyses.lock().unwrap();
        assert_eq!(
            analyses[0].sections[0].references[0].session_id.as_deref(),
            Some("unrelated-sess"),
            "a reference for a session not in old_ids must not be rewritten"
        );
    }

    /// The raw-string fallback: when the incoming path cannot be canonicalized
    /// (e.g. a virtual/nonexistent path), a stale entry with the same raw string
    /// still matches, so it is not leaked.
    #[test]
    fn close_stale_sessions_falls_back_to_raw_equality_for_uncanonicalizable_paths() {
        let state = make_state();
        // A path that does not exist on disk — canonical_compare_form returns None.
        insert_session(&state, "stale-id", Some("/nonexistent/virtual/device.log"));

        close_stale_sessions(&state, None, "/nonexistent/virtual/device.log").unwrap();

        assert!(!state.sessions.lock().unwrap().contains_key("stale-id"),
            "identical raw path must still match when neither side canonicalizes");
    }

    // -------------------------------------------------------------------------
    // restore_artifacts
    // -------------------------------------------------------------------------

    #[test]
    fn restore_artifacts_rewrites_session_id() {
        use crate::core::analysis::AnalysisArtifact;
        use crate::core::bookmark::{Bookmark, CreatedBy};

        let state = make_state();
        let new_session_id = "new-session-xyz";

        // Bookmarks arrive with an old session_id from the .lts file.
        let bm = Bookmark {
            id: "bm-1".to_string(),
            session_id: "old-session-id".to_string(),
            line_number: 7,
            line_number_end: None,
            snippet: None,
            category: None,
            tags: None,
            label: "Test".to_string(),
            note: String::new(),
            created_by: CreatedBy::User,
            created_at: 1000,
        };
        let artifact = AnalysisArtifact {
            id: "art-1".to_string(),
            title: "Analysis".to_string(),
            created_at: 2000,
            sections: vec![],
            legacy_session_id: None,
        };

        let (bm_count, an_count) =
            restore_artifacts(&state, new_session_id, vec![bm], vec![artifact]);

        assert_eq!(bm_count, 1);
        assert_eq!(an_count, 1);

        // Verify session_id was rewritten on stored bookmarks.
        let bookmarks = state.bookmarks.lock().unwrap();
        let stored_bms = bookmarks.get(new_session_id).expect("bookmarks must be stored under new session id");
        assert_eq!(stored_bms[0].session_id, new_session_id, "bookmark session_id must be rewritten");
        assert_eq!(stored_bms[0].line_number, 7);
        drop(bookmarks);

        // Analyses are workspace-owned: verify the artifact landed in the
        // flat store, not re-keyed under a map.
        let analyses = state.analyses.lock().unwrap();
        assert_eq!(analyses.len(), 1);
        assert_eq!(analyses[0].id, "art-1");
    }

    /// An analysis restored with an unattributed reference (a fresh publish,
    /// or an old archive whose reference predates per-reference attribution)
    /// must have that reference stamped with the restore target session.
    #[test]
    fn restore_artifacts_stamps_unattributed_references_with_target_session() {
        use crate::core::analysis::{AnalysisArtifact, AnalysisSection, HighlightType, SourceReference};

        let state = make_state();
        let new_session_id = "new-session-xyz";
        let artifact = AnalysisArtifact {
            id: "art-1".to_string(),
            title: "Analysis".to_string(),
            created_at: 2000,
            sections: vec![AnalysisSection {
                heading: "H".to_string(),
                body: "B".to_string(),
                references: vec![SourceReference {
                    line_number: 5,
                    end_line: None,
                    label: "ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: None,
                }],
                severity: None,
            }],
            legacy_session_id: None,
        };

        restore_artifacts(&state, new_session_id, vec![], vec![artifact]);

        let analyses = state.analyses.lock().unwrap();
        assert_eq!(
            analyses[0].sections[0].references[0].session_id.as_deref(),
            Some(new_session_id),
            "unattributed reference must be stamped with the restore target session"
        );
    }

    #[test]
    fn restore_artifacts_empty_vecs_are_noop() {
        let state = make_state();
        let session_id = "empty-sess";

        // Calling with empty vecs must not insert anything into AppState.
        let (bm_count, an_count) = restore_artifacts(&state, session_id, vec![], vec![]);

        assert_eq!(bm_count, 0);
        assert_eq!(an_count, 0);
        assert!(
            !state.bookmarks.lock().unwrap().contains_key(session_id),
            "no bookmark entry must be created for empty input"
        );
        assert!(
            state.analyses.lock().unwrap().is_empty(),
            "no analysis entry must be created for empty input"
        );
    }

    /// A reference that already carries its own `session_id` (e.g. a
    /// multi-session artifact whose OTHER reference points at a still-open
    /// session) must be left alone by restore — only unattributed references
    /// fall back to the restore target.
    #[test]
    fn restore_artifacts_leaves_already_attributed_references_alone() {
        use crate::core::analysis::{AnalysisArtifact, AnalysisSection, HighlightType, SourceReference};

        let state = make_state();
        let artifact = AnalysisArtifact {
            id: "art-multi".to_string(),
            title: "Multi".to_string(),
            created_at: 1,
            sections: vec![AnalysisSection {
                heading: "H".to_string(),
                body: "B".to_string(),
                references: vec![SourceReference {
                    line_number: 1,
                    end_line: None,
                    label: "already-attributed".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: Some("other-open-session".to_string()),
                }],
                severity: None,
            }],
            legacy_session_id: None,
        };

        restore_artifacts(&state, "restore-target", vec![], vec![artifact]);

        let analyses = state.analyses.lock().unwrap();
        assert_eq!(
            analyses[0].sections[0].references[0].session_id.as_deref(),
            Some("other-open-session"),
            "an already-attributed reference must not be overwritten by the restore target"
        );
    }

    /// Restoring the same artifact id twice (e.g. re-opening the same `.lts`
    /// archive, or two sessions from a multi-session archive that both cite
    /// the same shared artifact) must upsert in place rather than duplicate.
    #[test]
    fn restore_artifacts_upserts_by_artifact_id_on_repeat_restore() {
        use crate::core::analysis::AnalysisArtifact;

        let state = make_state();
        let v1 = AnalysisArtifact {
            id: "art-dup".to_string(),
            title: "Version 1".to_string(),
            created_at: 1,
            sections: vec![],
            legacy_session_id: None,
        };
        let v2 = AnalysisArtifact {
            id: "art-dup".to_string(),
            title: "Version 2".to_string(),
            created_at: 2,
            sections: vec![],
            legacy_session_id: None,
        };

        restore_artifacts(&state, "sess-a", vec![], vec![v1]);
        restore_artifacts(&state, "sess-a", vec![], vec![v2]);

        let analyses = state.analyses.lock().unwrap();
        assert_eq!(analyses.len(), 1, "repeat restore of the same artifact id must not duplicate it");
        assert_eq!(analyses[0].title, "Version 2", "the later restore must win in place");
    }

    #[test]
    fn close_session_inner_no_panic_with_none_app() {
        // Passing None for app must not panic even when there is a file_path set.
        let state = make_state();
        insert_session(&state, "sess-no-app", Some("/logs/file.log"));
        // Must return Ok without panicking.
        assert!(close_session_inner(&state, None, "sess-no-app").is_ok());
        assert!(!state.sessions.lock().unwrap().contains_key("sess-no-app"));
    }

    // -------------------------------------------------------------------------
    // Bookmarks and analyses cleanup
    // -------------------------------------------------------------------------

    #[test]
    fn close_session_inner_removes_bookmarks_but_keeps_analyses() {
        use crate::core::bookmark::{Bookmark, CreatedBy};
        use crate::core::analysis::AnalysisArtifact;

        let state = make_state();
        insert_session(&state, "sess-bm", None);

        // Populate bookmarks for the session.
        let bm = Bookmark {
            id: "bm-1".to_string(),
            session_id: "sess-bm".to_string(),
            line_number: 42,
            line_number_end: None,
            snippet: None,
            category: None,
            tags: None,
            label: "Test".to_string(),
            note: String::new(),
            created_by: CreatedBy::User,
            created_at: 1000,
        };
        state.bookmarks.lock().unwrap().insert("sess-bm".to_string(), vec![bm]);

        // Populate the workspace-owned analyses store — not keyed by session.
        let artifact = AnalysisArtifact {
            id: "art-1".to_string(),
            title: "Test".to_string(),
            created_at: 2000,
            sections: vec![],
            legacy_session_id: None,
        };
        state.analyses.lock().unwrap().push(artifact);

        close_session_inner(&state, None, "sess-bm").unwrap();

        assert!(!state.bookmarks.lock().unwrap().contains_key("sess-bm"),
            "bookmarks must be removed on close");
        assert_eq!(state.analyses.lock().unwrap().len(), 1,
            "analyses are workspace-owned and must survive closing a session that references them \
             — orphaned-but-visible is the intended behavior");
    }

    #[test]
    fn close_session_inner_cleans_up_pipeline_meta() {
        let state = make_state();
        insert_session(&state, "sess-pm", None);

        state.session_pipeline_meta.lock().unwrap().insert(
            "sess-pm".to_string(),
            crate::workspace::SessionMeta {
                active_processor_ids: vec!["proc-a".to_string()],
                disabled_processor_ids: vec![],
            },
        );

        close_session_inner(&state, None, "sess-pm").unwrap();

        assert!(!state.session_pipeline_meta.lock().unwrap().contains_key("sess-pm"),
            "pipeline meta must be removed on close");
    }

    // -------------------------------------------------------------------------
    // Watches and filters cleanup
    // -------------------------------------------------------------------------

    #[test]
    fn close_session_inner_removes_watches() {
        use crate::core::filter::FilterCriteria;
        use crate::core::watch::WatchSession;

        let state = make_state();
        insert_session(&state, "sess-w", None);
        insert_session(&state, "sess-w-other", None);

        {
            let mut watches = state.active_watches.lock().unwrap();
            watches.insert("sess-w".to_string(), vec![Arc::new(WatchSession::new(
                "watch-1".to_string(),
                "sess-w".to_string(),
                FilterCriteria::default(),
            ).unwrap())]);
            watches.insert("sess-w-other".to_string(), vec![Arc::new(WatchSession::new(
                "watch-2".to_string(),
                "sess-w-other".to_string(),
                FilterCriteria::default(),
            ).unwrap())]);
        }

        close_session_inner(&state, None, "sess-w").unwrap();

        let watches = state.active_watches.lock().unwrap();
        assert!(!watches.contains_key("sess-w"),
            "watches must be removed on close");
        assert!(watches.contains_key("sess-w-other"),
            "watches for other sessions must be preserved");
    }

    #[test]
    fn close_session_inner_removes_and_cancels_filters() {
        use crate::core::filter::{FilterCriteria, FilterSession};

        let state = make_state();
        insert_session(&state, "sess-f", None);

        let closed_filter = Arc::new(FilterSession::new(
            "filter-1".to_string(),
            "sess-f".to_string(),
            FilterCriteria::default(),
            100,
        ));
        let other_filter = Arc::new(FilterSession::new(
            "filter-2".to_string(),
            "sess-f-other".to_string(),
            FilterCriteria::default(),
            100,
        ));
        {
            let mut filters = state.active_filters.lock().unwrap();
            filters.insert("filter-1".to_string(), Arc::clone(&closed_filter));
            filters.insert("filter-2".to_string(), Arc::clone(&other_filter));
        }

        close_session_inner(&state, None, "sess-f").unwrap();

        let filters = state.active_filters.lock().unwrap();
        assert!(!filters.contains_key("filter-1"),
            "filters targeting the closed session must be removed");
        assert!(closed_filter.is_cancelled(),
            "removed filter must be cancelled so its background scan stops");
        assert!(filters.contains_key("filter-2"),
            "filters for other sessions must be preserved");
        assert!(!other_filter.is_cancelled(),
            "filters for other sessions must not be cancelled");
    }

    // -------------------------------------------------------------------------
    // Stale session cleanup — close_stale_sessions
    // -------------------------------------------------------------------------

    #[test]
    fn close_stale_sessions_removes_all_duplicates() {
        // Simulate the bug: the same file opened 3 times → 3 sessions with the
        // same file_path but different IDs. close_stale_sessions must remove ALL
        // of them so the MCP agent never sees stale session IDs.
        let state = make_state();
        let path = "/logs/device-dumpstate.log";
        insert_session(&state, "sess-old-1", Some(path));
        insert_session(&state, "sess-old-2", Some(path));
        insert_session(&state, "sess-old-3", Some(path));

        // Also insert an unrelated session that must NOT be touched
        insert_session(&state, "sess-other", Some("/logs/other.log"));

        close_stale_sessions(&state, None, path).unwrap();

        let sessions = state.sessions.lock().unwrap();
        assert!(!sessions.contains_key("sess-old-1"),
            "first duplicate must be removed");
        assert!(!sessions.contains_key("sess-old-2"),
            "second duplicate must be removed");
        assert!(!sessions.contains_key("sess-old-3"),
            "third duplicate must be removed");
        assert!(sessions.contains_key("sess-other"),
            "unrelated session must be preserved");
    }

    #[test]
    fn close_stale_sessions_leaves_workspace_analyses_intact() {
        // The MCP publishes an analysis referencing a stale session. When the
        // file is reloaded, close_stale_sessions removes the stale sessions
        // but the workspace-owned analysis must survive — it is not deleted
        // just because one of the sessions it references closed.
        use crate::core::analysis::AnalysisArtifact;

        let state = make_state();
        let path = "/logs/device-dumpstate.log";
        insert_session(&state, "sess-stale-a", Some(path));
        insert_session(&state, "sess-stale-b", Some(path));

        // Simulate MCP publishing an analysis while sess-stale-a was open.
        let artifact = AnalysisArtifact {
            id: "art-mcp-1".to_string(),
            title: "Memory Overview".to_string(),
            created_at: 1000,
            sections: vec![],
            legacy_session_id: None,
        };
        state.analyses.lock().unwrap().push(artifact);

        close_stale_sessions(&state, None, path).unwrap();

        let sessions = state.sessions.lock().unwrap();
        let analyses = state.analyses.lock().unwrap();

        assert!(!sessions.contains_key("sess-stale-a"),
            "stale session A must be removed");
        assert!(!sessions.contains_key("sess-stale-b"),
            "stale session B must be removed");
        assert_eq!(analyses.len(), 1,
            "workspace-owned analyses must survive closing the stale sessions they reference");
    }

    #[test]
    fn close_stale_sessions_is_noop_when_no_match() {
        let state = make_state();
        insert_session(&state, "sess-keep", Some("/logs/other.log"));

        close_stale_sessions(&state, None, "/logs/no-match.log").unwrap();

        assert!(state.sessions.lock().unwrap().contains_key("sess-keep"),
            "non-matching session must not be removed");
    }

    // -------------------------------------------------------------------------
    // Q5 — deterministic session identity, integration.
    //
    // load_log_file needs an AppHandle (indexing + event emit) so it can't be
    // called in a unit test; this replicates its id-derive + close_stale + insert
    // sequence (files.rs) with a real temp file, mirroring the stale-session
    // tests above, to prove: loading the SAME unchanged file twice yields the
    // SAME session id and leaves exactly ONE live session for that path.
    // -------------------------------------------------------------------------
    #[test]
    fn load_same_file_twice_yields_same_id_and_one_live_session() {
        use std::io::Write;

        let mut tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        writeln!(tmp, "01-01 00:00:01.000  100  101 I Tag: hello").unwrap();
        tmp.flush().unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        let path_obj = tmp.path();

        let state = make_state();

        // First load: derive id, close stale (none yet), register.
        let id1 = crate::core::session_identity::derive_file_session_id_from_disk(path_obj, None);
        close_stale_sessions(&state, None, &path).unwrap();
        insert_session(&state, &id1, Some(&path));

        // Second load of the SAME unchanged file: same deterministic id;
        // close_stale_sessions closes the first before the second registers.
        let id2 = crate::core::session_identity::derive_file_session_id_from_disk(path_obj, None);
        assert_eq!(id1, id2, "same unchanged file must derive the same session id");
        close_stale_sessions(&state, None, &path).unwrap();
        insert_session(&state, &id2, Some(&path));

        let sessions = state.sessions.lock().unwrap();
        let for_path: Vec<_> = sessions
            .values()
            .filter(|s| s.file_path.as_deref() == Some(path.as_str()))
            .collect();
        assert_eq!(for_path.len(), 1, "exactly one live session must remain for the file path");
        assert_eq!(for_path[0].id, id1, "the live session carries the deterministic id");
    }

    // -------------------------------------------------------------------------
    // WI-3 — Multi-session import: format layer round-trip
    //
    // load_lts_file_inner requires an AppHandle (for processor resolution and
    // emitting Tauri events) which cannot be constructed in unit tests. The
    // tests below verify the format layer (write_lts + read_lts) that
    // load_lts_file_inner consumes, and also validate restore_artifacts rewriting
    // for the multi-session case — which IS testable without AppHandle.
    // -------------------------------------------------------------------------

    #[test]
    fn multi_session_lts_roundtrip_two_sessions() {
        use crate::workspace::lts::{write_lts, read_lts, LtsSessionData, LtsSessionMeta};
        use crate::core::bookmark::{Bookmark, CreatedBy};
        use crate::core::analysis::AnalysisArtifact;

        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let source_a = b"01-01 00:00:01.000  100  101 I TagA: hello session A\n".to_vec();
        let source_b = b"01-01 00:00:02.000  200  201 I TagB: hello session B\n".to_vec();

        let bm_a = Bookmark {
            id: "bm-a".to_string(),
            session_id: "old-sess-a".to_string(),
            line_number: 1,
            line_number_end: None,
            snippet: None,
            category: None,
            tags: None,
            label: "Bookmark A".to_string(),
            note: String::new(),
            created_by: CreatedBy::User,
            created_at: 1000,
        };
        let artifact_b = AnalysisArtifact {
            id: "art-b".to_string(),
            title: "Analysis B".to_string(),
            created_at: 2000,
            sections: vec![],
            legacy_session_id: None,
        };

        let sessions = vec![
            LtsSessionData {
                source_bytes: source_a.clone(),
                source_filename: "session_a.log".to_string(),
                bookmarks: vec![bm_a],
                analyses: vec![],
                session_meta: LtsSessionMeta {
                    active_processor_ids: vec!["proc-x".to_string()],
                    disabled_processor_ids: vec![],
                },
            },
            LtsSessionData {
                source_bytes: source_b.clone(),
                source_filename: "session_b.log".to_string(),
                bookmarks: vec![],
                analyses: vec![artifact_b],
                session_meta: LtsSessionMeta::default(),
            },
        ];

        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        assert_eq!(loaded.sessions.len(), 2, "must load 2 sessions");

        let s0 = &loaded.sessions[0];
        assert_eq!(s0.source_filename, "session_a.log");
        assert_eq!(s0.source_bytes, source_a);
        assert_eq!(s0.bookmarks.len(), 1);
        assert_eq!(s0.bookmarks[0].label, "Bookmark A");
        assert!(s0.analyses.is_empty());
        assert_eq!(s0.session_meta.active_processor_ids, vec!["proc-x"]);

        let s1 = &loaded.sessions[1];
        assert_eq!(s1.source_filename, "session_b.log");
        assert_eq!(s1.source_bytes, source_b);
        assert!(s1.bookmarks.is_empty());
        assert_eq!(s1.analyses.len(), 1);
        assert_eq!(s1.analyses[0].title, "Analysis B");
        assert!(s1.session_meta.active_processor_ids.is_empty());
    }

    #[test]
    fn multi_session_lts_restore_artifacts_rewrites_ids_for_each_session() {
        use crate::workspace::lts::{write_lts, read_lts, LtsSessionData, LtsSessionMeta};
        use crate::core::bookmark::{Bookmark, CreatedBy};

        let tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        let zip_path = tmp.path().to_path_buf();
        drop(tmp);

        let sessions = vec![
            LtsSessionData {
                source_bytes: b"data A\n".to_vec(),
                source_filename: "a.log".to_string(),
                bookmarks: vec![Bookmark {
                    id: "bm-1".to_string(),
                    session_id: "stale-sess".to_string(),
                    line_number: 1,
                    line_number_end: None,
                    snippet: None,
                    category: None,
                    tags: None,
                    label: "BM1".to_string(),
                    note: String::new(),
                    created_by: CreatedBy::User,
                    created_at: 100,
                }],
                analyses: vec![],
                session_meta: LtsSessionMeta::default(),
            },
            LtsSessionData {
                source_bytes: b"data B\n".to_vec(),
                source_filename: "b.log".to_string(),
                bookmarks: vec![Bookmark {
                    id: "bm-2".to_string(),
                    session_id: "stale-sess".to_string(),
                    line_number: 2,
                    line_number_end: None,
                    snippet: None,
                    category: None,
                    tags: None,
                    label: "BM2".to_string(),
                    note: String::new(),
                    created_by: CreatedBy::User,
                    created_at: 200,
                }],
                analyses: vec![],
                session_meta: LtsSessionMeta::default(),
            },
        ];

        write_lts(&zip_path, &sessions, &[], &[]).expect("write_lts");

        let loaded = read_lts(&zip_path).expect("read_lts");

        // Simulate what load_lts_file_inner does for each session.
        let state = make_state();
        let new_ids = ["new-sess-alpha", "new-sess-beta"];

        for (session_data, new_id) in loaded.sessions.into_iter().zip(new_ids.iter()) {
            let (bm_count, _) =
                restore_artifacts(&state, new_id, session_data.bookmarks, session_data.analyses);
            assert_eq!(bm_count, 1);
        }

        // Each session's bookmarks must be stored under its own fresh ID.
        let bookmarks = state.bookmarks.lock().unwrap();
        let bms_alpha = bookmarks.get("new-sess-alpha").expect("bookmarks for alpha");
        let bms_beta = bookmarks.get("new-sess-beta").expect("bookmarks for beta");

        assert_eq!(bms_alpha[0].session_id, "new-sess-alpha",
            "bookmark session_id must be rewritten to alpha session");
        assert_eq!(bms_beta[0].session_id, "new-sess-beta",
            "bookmark session_id must be rewritten to beta session");

        // The stale ID must not appear anywhere in the map.
        assert!(!bookmarks.contains_key("stale-sess"),
            "stale session ID must not remain after restore");
    }

    // This test validates that load_lts_file_inner returns one LoadResult per session
    // embedded in the .lts file. It is marked #[ignore] because constructing a Tauri
    // AppHandle for processor resolution and event emission is not possible in unit tests.
    //
    // Manual verification: open a multi-session .lts file in the app and confirm that
    // N tabs are registered (one per session) and each tab shows the correct source.
    #[test]
    #[ignore = "requires Tauri AppHandle — run as integration test with the running app"]
    fn load_lts_file_inner_returns_one_result_per_session() {
        // Intentionally empty — serves as a documentation stub for future integration test.
    }

    // -------------------------------------------------------------------------
    // get_dumpstate_metadata_inner — early-exit reachability (bug 9716f391d)
    // -------------------------------------------------------------------------
    //
    // Before the fix, the "stop scanning once everything is found" check sat
    // AFTER the loop body's per-branch `continue`s, so it was unreachable dead
    // code: every `in_props_section` iteration hit `continue` first, and every
    // call scanned the entire source regardless of how early the needed data
    // appeared. These tests build a source where the header, kernel version,
    // and all three system properties appear within the first dozen lines,
    // followed by tens of thousands of additional lines — including, crucially,
    // a SECOND, differently-valued occurrence of each system property. The
    // props-section fields (`sdk_version` / `device_model` / `manufacturer`)
    // have no `.is_none()` guard, so without early-exit the second occurrence
    // would silently overwrite the first as the scan continued to EOF. The
    // returned metadata therefore only matches the FIRST occurrence if the
    // scan actually stopped once the completion condition was met.

    /// Header + kernel section + the three system properties, each appearing
    /// exactly once. Shared prefix for both fixtures below.
    fn dumpstate_base_prefix() -> String {
        let mut out = String::new();
        out.push_str("========================================================\n");
        out.push_str("== dumpstate: 2024-01-15 10:00:00\n");
        out.push_str("========================================================\n");
        out.push_str("Build: userdebug/product/device:14/UP1A.231005.007/1234567:userdebug/test-keys (userdebug)\n");
        out.push_str("Build fingerprint: 'brand/product/device:14/UP1A.231005.007/1234567:userdebug/test-keys'\n");
        out.push_str("Bootloader: unknown\n");
        out.push_str("androidboot.serialno=ABC123XYZ\n");
        out.push_str("Uptime: up 1 day, 2:03\n");
        out.push_str("------ KERNEL VERSION (uname -a) ------\n");
        out.push_str("Linux localhost 5.15.0-test #1 SMP PREEMPT\n");
        out.push_str("------ 0.001s was the duration of 'KERNEL VERSION' ------\n");
        out.push_str("------ SYSTEM PROPERTIES ------\n");
        out.push_str("[ro.build.version.sdk]: [34]\n");
        out.push_str("[ro.product.model]: [Pixel Test]\n");
        out.push_str("[ro.product.manufacturer]: [Google]\n");
        out
    }

    /// Base prefix followed by `junk_lines` unrelated property lines, then a
    /// SECOND, differently-valued occurrence of every tracked property, then
    /// more junk, then the section footer. The props-section fields
    /// (`sdk_version` / `device_model` / `manufacturer`) have no `.is_none()`
    /// guard, so without early-exit the second occurrence silently overwrites
    /// the first as the scan continues to EOF — this is the fixture that
    /// catches a regression back to the old unreachable-break behavior.
    fn dumpstate_fixture_with_overwrite_trap(junk_lines: usize) -> Vec<u8> {
        let mut out = dumpstate_base_prefix();

        // Spans multiple SEARCH_CHUNK_SIZE-sized chunks, so the test also
        // exercises the chunk/re-lock/yield boundary — not just a
        // single-chunk scan.
        for i in 0..junk_lines {
            out.push_str(&format!("[some.other.prop.{i}]: [junk-{i}]\n"));
        }

        out.push_str("[ro.build.version.sdk]: [999]\n");
        out.push_str("[ro.product.model]: [Should Not Appear]\n");
        out.push_str("[ro.product.manufacturer]: [Should Not Appear]\n");
        for i in 0..2_000 {
            out.push_str(&format!("[trailing.prop.{i}]: [more-junk-{i}]\n"));
        }
        out.push_str("------ 0.001s was the duration of 'SYSTEM PROPERTIES' ------\n");

        out.into_bytes()
    }

    /// Base prefix with each field appearing exactly once — an ordinary,
    /// non-adversarial dumpstate file with no trap and no early-exit pressure.
    fn dumpstate_fixture_minimal() -> Vec<u8> {
        let mut out = dumpstate_base_prefix();
        out.push_str("------ 0.001s was the duration of 'SYSTEM PROPERTIES' ------\n");
        out.into_bytes()
    }

    fn insert_bugreport_session(state: &AppState, session_id: &str, data: Vec<u8>) {
        let mut session = AnalysisSession::new(session_id.to_string());
        session
            .add_zip_source(data, "src1".to_string(), "bugreport.txt".to_string())
            .expect("add_zip_source");
        state.sessions.lock().unwrap().insert(session_id.to_string(), session);
    }

    #[tokio::test]
    async fn get_dumpstate_metadata_stops_early_and_keeps_first_values() {
        let state = make_state();
        // 25,000 junk lines sit AFTER the fields are found. The scan should
        // never reach them (it breaks out of the very first chunk), which is
        // exactly what this test is checking — see the "crosses chunk
        // boundary" test below for the case where completion genuinely spans
        // multiple re-locked chunks.
        let data = dumpstate_fixture_with_overwrite_trap(25_000);
        insert_bugreport_session(&state, "sess-dumpstate", data);

        let meta = get_dumpstate_metadata_inner(&state, "sess-dumpstate")
            .await
            .expect("get_dumpstate_metadata_inner");

        assert_eq!(meta.build_fingerprint.as_deref(), Some("brand/product/device:14/UP1A.231005.007/1234567:userdebug/test-keys"));
        assert_eq!(meta.os_version.as_deref(), Some("14"));
        assert_eq!(meta.build_type.as_deref(), Some("userdebug"));
        assert_eq!(meta.bootloader.as_deref(), Some("unknown"));
        assert_eq!(meta.serial.as_deref(), Some("ABC123XYZ"));
        assert_eq!(meta.uptime.as_deref(), Some("up 1 day, 2:03"));
        assert_eq!(meta.kernel_version.as_deref(), Some("Linux localhost 5.15.0-test #1 SMP PREEMPT"));

        // The load-bearing assertions: these must hold the FIRST occurrence's
        // values, not the second ("999" / "Should Not Appear") that sits tens
        // of thousands of lines later. That is only possible if the scan
        // actually stopped once these were first found.
        assert_eq!(meta.sdk_version.as_deref(), Some("34"),
            "must keep the first sdk_version, proving the scan stopped before the second occurrence");
        assert_eq!(meta.device_model.as_deref(), Some("Pixel Test"),
            "must keep the first device_model, proving the scan stopped before the second occurrence");
        assert_eq!(meta.manufacturer.as_deref(), Some("Google"),
            "must keep the first manufacturer, proving the scan stopped before the second occurrence");
    }

    #[tokio::test]
    async fn get_dumpstate_metadata_matches_full_scan_when_data_is_sparse() {
        // Regression guard for the "preserve the exact metadata result"
        // requirement: an ordinary file with no duplicate/trap data must
        // still parse identically to a full, un-early-exited scan.
        let state = make_state();
        let data = dumpstate_fixture_minimal();
        insert_bugreport_session(&state, "sess-dumpstate-small", data);

        let meta = get_dumpstate_metadata_inner(&state, "sess-dumpstate-small")
            .await
            .expect("get_dumpstate_metadata_inner");

        assert_eq!(meta.sdk_version.as_deref(), Some("34"));
        assert_eq!(meta.device_model.as_deref(), Some("Pixel Test"));
        assert_eq!(meta.manufacturer.as_deref(), Some("Google"));
        assert_eq!(meta.kernel_version.as_deref(), Some("Linux localhost 5.15.0-test #1 SMP PREEMPT"));
    }

    #[tokio::test]
    async fn get_dumpstate_metadata_missing_session_errors() {
        let state = make_state();
        let result = get_dumpstate_metadata_inner(&state, "does-not-exist").await;
        assert!(result.is_err(), "unknown session id must error, not panic");
    }

    #[tokio::test]
    async fn get_dumpstate_metadata_completes_across_chunk_boundary() {
        // Padding sits BETWEEN the kernel section and the system properties
        // section, so the completion point (all four fields found) lands past
        // line 10,000 — SEARCH_CHUNK_SIZE — meaning the outer chunk loop must
        // re-acquire the session lock, yield, and continue with `in_kernel_section`
        // / `kernel_next` / `passed_first_section` / the partially-filled `meta`
        // all correctly carried over from the first chunk before the second
        // chunk can find the remaining fields.
        let mut out = String::new();
        out.push_str("========================================================\n");
        out.push_str("== dumpstate: 2024-01-15 10:00:00\n");
        out.push_str("========================================================\n");
        out.push_str("Build: userdebug/product/device:14/UP1A.231005.007/1234567:userdebug/test-keys (userdebug)\n");
        out.push_str("Build fingerprint: 'brand/product/device:14/UP1A.231005.007/1234567:userdebug/test-keys'\n");
        out.push_str("Bootloader: unknown\n");
        out.push_str("androidboot.serialno=ABC123XYZ\n");
        out.push_str("Uptime: up 1 day, 2:03\n");
        out.push_str("------ KERNEL VERSION (uname -a) ------\n");
        out.push_str("Linux localhost 5.15.0-test #1 SMP PREEMPT\n");
        out.push_str("------ 0.001s was the duration of 'KERNEL VERSION' ------\n");
        // Padding: harmless content lines that fall through every branch as a
        // no-op (passed_first_section is already true, so they don't match
        // the header-field block either). Pushes the props section well past
        // the SEARCH_CHUNK_SIZE (10,000) boundary.
        for i in 0..12_000 {
            out.push_str(&format!("padding line {i}\n"));
        }
        out.push_str("------ SYSTEM PROPERTIES ------\n");
        out.push_str("[ro.build.version.sdk]: [34]\n");
        out.push_str("[ro.product.model]: [Pixel Test]\n");
        out.push_str("[ro.product.manufacturer]: [Google]\n");
        out.push_str("------ 0.001s was the duration of 'SYSTEM PROPERTIES' ------\n");

        let state = make_state();
        insert_bugreport_session(&state, "sess-dumpstate-crossing", out.into_bytes());

        let meta = get_dumpstate_metadata_inner(&state, "sess-dumpstate-crossing")
            .await
            .expect("get_dumpstate_metadata_inner");

        assert_eq!(meta.kernel_version.as_deref(), Some("Linux localhost 5.15.0-test #1 SMP PREEMPT"),
            "kernel_version found in chunk 1 must survive into chunk 2");
        assert_eq!(meta.sdk_version.as_deref(), Some("34"));
        assert_eq!(meta.device_model.as_deref(), Some("Pixel Test"));
        assert_eq!(meta.manufacturer.as_deref(), Some("Google"));
    }
}
