use memmap2::Mmap;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tempfile::NamedTempFile;

use crate::commands::{lock_or_err, AppState};
use crate::core::line::{
    HighlightKind, HighlightSpan, LineRequest, LineWindow, LogLevel, SearchQuery,
    SearchSummary, ViewLine, ViewMode,
};
use crate::core::session::{AnalysisSession, SectionInfo, parser_for};

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

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub session_id: String,
    pub source_id: String,
    pub source_name: String,
    /// Full filesystem path for file-backed sessions; None for ADB streams.
    pub file_path: Option<String>,
    pub total_lines: usize,
    pub file_size: u64,
    pub first_timestamp: Option<i64>,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileIndexProgress {
    session_id: String,
    indexed_lines: usize,
    bytes_scanned: usize,
    total_bytes: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileIndexComplete {
    session_id: String,
    total_lines: usize,
}

#[tauri::command]
pub async fn load_log_file(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
) -> Result<Vec<LoadResult>, String> {
    let path_obj = Path::new(&path);

    // If the file is a .lts session export, use the dedicated multi-session import path.
    if path_obj.extension().and_then(|e| e.to_str()) == Some("lts") {
        return load_lts_file_inner(&state, &app, &path);
    }

    // If the file is a .zip, extract the dumpstate/bugreport .txt to a temp file
    // and load that instead. The temp file persists for the session lifetime.
    let (effective_path, _temp_file) = if path_obj.extension().and_then(|e| e.to_str()) == Some("zip") {
        let extracted = extract_bugreport_from_zip(path_obj)?;
        let p = extracted.path().to_string_lossy().to_string();
        (p, Some(extracted))
    } else {
        (path.clone(), None)
    };
    let effective_path_obj = Path::new(&effective_path);

    let file_size = std::fs::metadata(effective_path_obj)
        .map(|m| m.len())
        .unwrap_or(0);

    // Derive stable IDs from the original path (not the temp extraction)
    let session_id = uuid::Uuid::new_v4().to_string();
    let source_id = path_obj
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("source")
        .to_string();

    // Close any existing sessions for the same file path (e.g. stale sessions from
    // frontend reloads). Collects ALL matching IDs then closes each one.
    close_stale_sessions(&state, Some(&app), &path)?;

    const INITIAL_BYTES: usize = 1_000_000; // 1 MB initial chunk

    let mut session = AnalysisSession::new(session_id.clone());
    session.file_path = Some(path.clone());
    // Hold the temp file handle in the session so it persists (deleted on drop).
    session.temp_file = _temp_file;
    let (mmap_arc, total_bytes, bytes_consumed) =
        session.add_source_partial(effective_path_obj, source_id.clone(), INITIAL_BYTES)?;

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
        file_path: Some(path.clone()),
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

    {
        let mut sessions = lock_or_err(&state.sessions, "sessions")?;
        sessions.insert(session_id.clone(), session);
    }

    // ── Workspace restore ────────────────────────────────────────────
    // Check for a matching .ltw file and restore bookmarks/analyses.
    let (_restored_bm, _restored_an) = try_restore_workspace(&state, &app, &session_id, &path);

    // Spawn background indexing task if there's more to scan.
    if is_indexing {
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        {
            let mut tasks = lock_or_err(&state.indexing_tasks, "indexing_tasks")?;
            tasks.insert(session_id.clone(), cancel_tx);
        }
        let app_clone = app;
        let sid = session_id;
        let initial_line_count = total_lines; // capture before session is moved into map
        tokio::spawn(async move {
            run_background_indexer(
                sid,
                mmap_arc,
                source_type,
                encoding,
                bytes_consumed,
                total_bytes,
                initial_line_count,
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

    let file_size = path_obj.metadata().map(|m| m.len()).unwrap_or(0);

    // Destructure to avoid cloning the processor fields.
    let crate::workspace::lts::LtsData { sessions, processor_manifest, processor_yamls, .. } = lts;

    // 2. Resolve bundled processors ONCE for all sessions (install missing / hash-mismatched).
    let _resolved = crate::commands::export::resolve_lts_processors_raw(
        state,
        app,
        &processor_manifest,
        &processor_yamls,
    );

    // 3. Create one AnalysisSession per embedded session.
    let mut results = Vec::with_capacity(sessions.len());

    for session_data in sessions {
        let session_id = uuid::Uuid::new_v4().to_string();

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

        // Store pipeline meta and emit workspace-restored event.
        emit_workspace_restored(
            state,
            app,
            &session_id,
            bm_count,
            an_count,
            session_data.session_meta.into(),
        );

        results.push(result);
    }

    Ok(results)
}

/// Store pipeline meta in AppState and emit `workspace-restored` event.
/// Shared by both `.ltw` (`try_restore_workspace`) and `.lts` (`load_lts_file_inner`) paths.
fn emit_workspace_restored(
    state: &AppState,
    app: &tauri::AppHandle,
    session_id: &str,
    bm_count: usize,
    an_count: usize,
    meta: crate::workspace::SessionMeta,
) {
    let has_chain = !meta.active_processor_ids.is_empty();
    if has_chain {
        if let Ok(mut map) = state.session_pipeline_meta.lock() {
            map.insert(session_id.to_string(), meta.clone());
        }
    }

    if bm_count > 0 || an_count > 0 || has_chain {
        let _ = app.emit("workspace-restored", serde_json::json!({
            "sessionId": session_id,
            "bookmarkCount": bm_count,
            "analysisCount": an_count,
            "activeProcessorIds": meta.active_processor_ids,
            "disabledProcessorIds": meta.disabled_processor_ids,
        }));
    }
}

/// Close **all** sessions whose `file_path` matches the given path.
/// Collects every matching ID under a short-lived lock, then closes each one.
/// Previously used `.find()` which only removed one duplicate per call — the
/// remaining stale sessions caused the MCP agent to target the wrong session ID.
fn close_stale_sessions(state: &AppState, app: Option<&tauri::AppHandle>, path: &str) -> Result<(), String> {
    let stale_ids: Vec<String> = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        sessions
            .values()
            .filter(|s| s.file_path.as_deref() == Some(path))
            .map(|s| s.id.clone())
            .collect()
    };
    for stale_id in stale_ids {
        close_session_inner(state, app, &stale_id)?;
    }
    Ok(())
}

fn close_session_inner(state: &AppState, app: Option<&tauri::AppHandle>, session_id: &str) -> Result<(), String> {
    // 1. Cancel active ADB stream (if any)
    if let Some(cancel_tx) = lock_or_err(&state.stream_tasks, "stream_tasks")?.remove(session_id) {
        let _ = cancel_tx.send(());
    }

    // 2. Cancel active background indexing (if any)
    if let Some(cancel_tx) = lock_or_err(&state.indexing_tasks, "indexing_tasks")?.remove(session_id) {
        let _ = cancel_tx.send(());
    }

    // ── Workspace save (before session removal) ──────────────────────────────
    // Cancel any pending debounced save for this session.
    if let Ok(mut tasks) = state.workspace_save_tasks.lock() {
        tasks.remove(session_id); // dropping the sender cancels the pending task
    }

    // Snapshot file_path under sessions lock, then drop it before acquiring
    // bookmarks/analyses locks. Never hold sessions + bookmarks simultaneously
    // (undefined lock ordering — see CLAUDE.md).
    let file_path: Option<String> = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        sessions.get(session_id).and_then(|s| s.file_path.clone())
    };
    let save_data = file_path.map(|fp| {
        let bm = crate::commands::workspace_sync::snapshot_bookmarks(state, session_id);
        let an = crate::commands::workspace_sync::snapshot_analyses(state, session_id);
        let meta = crate::commands::workspace_sync::snapshot_pipeline_meta(state, session_id);
        (fp, bm, an, meta)
    });

    if let (Some(app), Some((file_path, bookmarks, analyses, meta))) = (app, save_data) {
        // Skip workspace save for .lts sessions — they're self-contained
        if !file_path.ends_with(".lts") {
            if let Ok(ws_path) = crate::workspace::workspace_path_for(app, &file_path) {
                if let Err(e) = crate::workspace::save_workspace(&ws_path, &file_path, &bookmarks, &analyses, &meta) {
                    log::warn!("Workspace save failed for session {session_id}: {e}");
                } else if let Ok(dir) = crate::workspace::workspace_dir(app) {
                    crate::workspace::evict_old_workspaces(&dir, 20);
                }
            }
        }
    }

    // 3. Remove session (drops mmap / stream data)
    lock_or_err(&state.sessions, "sessions")?.remove(session_id);

    // 4. Remove pipeline results
    lock_or_err(&state.pipeline_results, "pipeline_results")?.remove(session_id);

    // 5. Remove state tracker results
    lock_or_err(&state.state_tracker_results, "state_tracker_results")?.remove(session_id);

    // 6. Remove correlator results
    lock_or_err(&state.correlator_results, "correlator_results")?.remove(session_id);

    // 7. Remove streaming processor state
    lock_or_err(&state.stream_processor_state, "stream_processor_state")?.remove(session_id);

    // 8. Remove streaming tracker state
    lock_or_err(&state.stream_tracker_state, "stream_tracker_state")?.remove(session_id);

    // 9. Remove streaming transformer state
    lock_or_err(&state.stream_transformer_state, "stream_transformer_state")?.remove(session_id);

    // 10. Remove PII mappings
    lock_or_err(&state.pii_mappings, "pii_mappings")?.remove(session_id);

    // 11. Remove stream anonymizer
    lock_or_err(&state.stream_anonymizers, "stream_anonymizers")?.remove(session_id);

    // 12. Remove MCP anonymizer
    lock_or_err(&state.mcp_anonymizers, "mcp_anonymizers")?.remove(session_id);

    // 13. Clean up bookmarks, analyses, and pipeline meta.
    if let Ok(mut bookmarks) = state.bookmarks.lock() {
        bookmarks.remove(session_id);
    }
    if let Ok(mut analyses) = state.analyses.lock() {
        analyses.remove(session_id);
    }
    if let Ok(mut meta) = state.session_pipeline_meta.lock() {
        meta.remove(session_id);
    }

    Ok(())
}

#[tauri::command]
pub async fn close_session(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    close_session_inner(&state, Some(&app), &session_id)
}

#[allow(clippy::too_many_arguments)]
async fn run_background_indexer(
    session_id: String,
    mmap: Arc<Mmap>,
    source_type: crate::core::session::SourceType,
    encoding: crate::core::log_source::Encoding,
    start_byte: usize,
    total_bytes: usize,
    initial_line_count: usize,
    app: AppHandle,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) {
    // ~100k lines at ~80 bytes avg; exact line count varies but
    // build_partial_line_index stops at the next newline past this limit.
    const CHUNK_BYTES: usize = 8_000_000;

    let state = app.state::<AppState>();
    let parser = parser_for(&source_type);
    let data: &[u8] = mmap.as_ref();

    // BugreportParser is stateful: it must see the `== dumpstate:` header to
    // set dumpstate_year before it can year-correct logcat timestamps.  The
    // header was in the initial chunk (already indexed), so re-feed that one
    // line to the fresh parser before it processes the remaining chunks.
    if matches!(source_type, crate::core::session::SourceType::Bugreport | crate::core::session::SourceType::Dumpstate) && start_byte > 0 {
        let initial_text: String = if encoding.is_utf16() {
            crate::core::log_source::decode_utf16_bytes(
                &data[encoding.bom_len()..start_byte.min(data.len())],
                encoding == crate::core::log_source::Encoding::Utf16Be,
            ).unwrap_or_default()
        } else {
            std::str::from_utf8(&data[..start_byte.min(data.len())]).unwrap_or("").to_string()
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

    while cursor < data.len() {
        // Check for cancellation
        if cancel_rx.try_recv().is_ok() {
            return;
        }

        let remaining = &data[cursor..];

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
                let done = new_cursor >= data.len();
                let chunk_line_count = chunk_meta.len();

                session.extend_source_index(chunk_index, chunk_meta, sentinel, done);
                (chunk_line_count, bytes_in_chunk)
            }
        }; // session lock released

        if bytes_in_chunk == 0 {
            break;
        }

        cursor += bytes_in_chunk;
        let done = cursor >= data.len();
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
    state: State<'_, AppState>,
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

            let sub_req = LineRequest {
                session_id: request.session_id.clone(),
                mode: ViewMode::Full,
                offset: start,
                count: end - start,
                context: 0,
                processor_id: None,
                search: request.search.clone(),
            };

            // Recurse with Full mode for the sub-window
            drop(sessions); // release lock before recursive call
            let state_ref: &AppState = &state;
            let inner_sessions = lock_or_err(&state_ref.sessions, "sessions")?;
            let inner_session = inner_sessions
                .get(&sub_req.session_id)
                .ok_or("Session not found")?;
            let inner_source = inner_session.primary_source().ok_or("No source")?;

            let mut lines = Vec::new();
            for i in start..end {
                let raw = inner_source.raw_line(i).as_deref().unwrap_or("").to_string();
                let meta = inner_source.meta_at(i);
                let highlights = sub_req
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchProgress {
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
    state: State<'_, AppState>,
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
    state: State<'_, AppState>,
    session_id: String,
) -> Result<DumpstateMetadata, String> {
    let sessions = lock_or_err(&state.sessions, "sessions")?;

    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{session_id}' not found"))?;

    let source = session.primary_source().ok_or("No sources in session")?;

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

    for (i, line_m) in source.line_meta_slice().iter().enumerate() {
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

        // Stop scanning once we have all header data and have seen system properties.
        if passed_first_section
            && in_props_section
            && meta.sdk_version.is_some()
            && meta.device_model.is_some()
            && meta.manufacturer.is_some()
        {
            break;
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
pub fn get_startup_file(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let mut sp = lock_or_err(&state.startup_file_path, "startup_file_path")?;
    Ok(sp.take())
}

// ---------------------------------------------------------------------------
// get_sections
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_sections(
    state: State<'_, AppState>,
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

/// Restore bookmarks and analyses into AppState with session ID rewritten.
fn restore_artifacts(
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
        let mut an = analyses;
        for a in &mut an {
            a.session_id = session_id.to_string();
        }
        if let Ok(mut map) = state.analyses.lock() {
            map.insert(session_id.to_string(), an);
        }
    }
    (bm_count, an_count)
}

// ---------------------------------------------------------------------------
// try_restore_workspace
// ---------------------------------------------------------------------------

/// Attempt to restore bookmarks and analyses from a matching `.ltw` workspace.
/// Returns (bookmark_count, analysis_count) on success, (0, 0) on failure or no workspace.
fn try_restore_workspace(
    state: &crate::commands::AppState,
    app: &tauri::AppHandle,
    session_id: &str,
    file_path: &str,
) -> (usize, usize) {
    // 1. Compute workspace path
    let Ok(ws_path) = crate::workspace::workspace_path_for(app, file_path) else {
        return (0, 0);
    };

    // 2. Check if workspace file exists
    if !ws_path.exists() {
        return (0, 0);
    }

    // 3. Load workspace
    let data = match crate::workspace::load_workspace(&ws_path) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("Failed to load workspace for '{file_path}': {e}");
            return (0, 0);
        }
    };

    // 4-6. Rewrite session IDs and insert into AppState
    let (bm_count, an_count) = restore_artifacts(state, session_id, data.bookmarks, data.analyses);

    // 7-8. Store pipeline meta + emit workspace-restored event
    emit_workspace_restored(state, app, session_id, bm_count, an_count, data.session_meta);

    (bm_count, an_count)
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

    fn insert_session(state: &AppState, id: &str, file_path: Option<&str>) {
        let mut session = AnalysisSession::new(id.to_string());
        session.file_path = file_path.map(str::to_string);
        state.sessions.lock().unwrap().insert(id.to_string(), session);
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
    fn close_session_inner_is_noop_on_unknown_id() {
        let state = make_state();
        // Must not panic or error when the session doesn't exist
        assert!(close_session_inner(&state, None, "nonexistent").is_ok());
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
    // restore_artifacts
    // -------------------------------------------------------------------------

    #[test]
    fn restore_artifacts_rewrites_session_id() {
        use crate::core::bookmark::{Bookmark, CreatedBy};
        use crate::core::analysis::AnalysisArtifact;

        let state = make_state();
        let new_session_id = "new-session-xyz";

        // Bookmarks and analyses arrive with an old session_id from the .lts file.
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
            session_id: "old-session-id".to_string(),
            title: "Analysis".to_string(),
            created_at: 2000,
            sections: vec![],
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

        // Verify session_id was rewritten on stored analyses.
        let analyses = state.analyses.lock().unwrap();
        let stored_ans = analyses.get(new_session_id).expect("analyses must be stored under new session id");
        assert_eq!(stored_ans[0].session_id, new_session_id, "analysis session_id must be rewritten");
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
            !state.analyses.lock().unwrap().contains_key(session_id),
            "no analysis entry must be created for empty input"
        );
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
    fn close_session_inner_removes_bookmarks_and_analyses() {
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

        // Populate analyses for the session.
        let artifact = AnalysisArtifact {
            id: "art-1".to_string(),
            session_id: "sess-bm".to_string(),
            title: "Test".to_string(),
            created_at: 2000,
            sections: vec![],
        };
        state.analyses.lock().unwrap().insert("sess-bm".to_string(), vec![artifact]);

        close_session_inner(&state, None, "sess-bm").unwrap();

        assert!(!state.bookmarks.lock().unwrap().contains_key("sess-bm"),
            "bookmarks must be removed on close");
        assert!(!state.analyses.lock().unwrap().contains_key("sess-bm"),
            "analyses must be removed on close");
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
    fn close_stale_sessions_cleans_up_analyses_for_all_duplicates() {
        // The MCP publishes an analysis to a stale session. When the file is
        // reloaded, close_stale_sessions must remove that analysis data too.
        use crate::core::analysis::AnalysisArtifact;

        let state = make_state();
        let path = "/logs/device-dumpstate.log";
        insert_session(&state, "sess-stale-a", Some(path));
        insert_session(&state, "sess-stale-b", Some(path));

        // Simulate MCP publishing an analysis to the first stale session
        let artifact = AnalysisArtifact {
            id: "art-mcp-1".to_string(),
            session_id: "sess-stale-a".to_string(),
            title: "Memory Overview".to_string(),
            created_at: 1000,
            sections: vec![],
        };
        state.analyses.lock().unwrap()
            .insert("sess-stale-a".to_string(), vec![artifact]);

        close_stale_sessions(&state, None, path).unwrap();

        let sessions = state.sessions.lock().unwrap();
        let analyses = state.analyses.lock().unwrap();

        assert!(!sessions.contains_key("sess-stale-a"),
            "stale session A must be removed");
        assert!(!sessions.contains_key("sess-stale-b"),
            "stale session B must be removed");
        assert!(!analyses.contains_key("sess-stale-a"),
            "analyses for stale session must be cleaned up");
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
            session_id: "old-sess-b".to_string(),
            title: "Analysis B".to_string(),
            created_at: 2000,
            sections: vec![],
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
}
