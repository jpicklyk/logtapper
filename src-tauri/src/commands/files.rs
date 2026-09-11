use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::commands::{lock_or_err, AppState};
use crate::core::line::{LineRequest, LineWindow, SearchQuery, SearchSummary};
use crate::core::session::SectionInfo;
use crate::commands::adapters::{TauriProgressSink, ui_ctx};
use crate::services::events::ProgressSink;
use crate::services::lines::{
    self, LineFilters, LineMetadataSource, LineSelection, LinesRequest,
};
use crate::services::search;
// Only the `#[cfg(test)]` module below calls this directly; production code
// reaches it through `services::lines::build_view_line`.
#[cfg(test)]
use crate::services::lines::compute_search_highlights;
use crate::services::{ServiceCtx, ServiceError};
use ts_rs::TS;

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
    pub(crate) session_id: String,
    pub(crate) indexed_lines: usize,
    pub(crate) bytes_scanned: usize,
    pub(crate) total_bytes: usize,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexComplete {
    pub(crate) session_id: String,
    pub(crate) total_lines: usize,
}

/// Thin adapter over [`crate::services::sessions::open`] — see that function
/// for the open/close/index logic this used to contain directly (moved there
/// in WP-6, along with the identical logic the MCP bridge's `h_open_file`
/// used to duplicate by calling `open_file_inner`/`load_lts_file_inner`
/// straight from the bridge).
#[tauri::command]
pub async fn load_log_file(
    app: AppHandle,
    path: String,
    source_type: Option<String>,
) -> Result<Vec<LoadResult>, String> {
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

    let ctx = ui_ctx(&app);
    crate::services::sessions::open(ctx, &path, source_type_override)
        .await
        .map_err(String::from)
}

/// Compatibility shim for `commands::workspace_cmd::restore_workspace_session`
/// (a different work package, not yet converted to `ServiceCtx`), which calls
/// this exact signature with a real `AppHandle`. The logic now lives in
/// [`crate::services::sessions::emit_workspace_restored`] — this just builds a
/// UI context and delegates. `state` is accepted only for call-site
/// compatibility (the rebuilt `ServiceCtx` resolves the same `Arc<AppState>`
/// from `app`, since a Tauri process only ever has one). Delete this shim once
/// `restore_workspace_session` is converted to build a `ServiceCtx` directly.
pub(crate) fn emit_workspace_restored(
    _state: &AppState,
    app: &tauri::AppHandle,
    session_id: &str,
    bm_count: usize,
    an_count: usize,
    meta: crate::workspace::SessionMeta,
    source: &str,
) {
    let ctx = crate::commands::adapters::ui_ctx(app);
    crate::services::sessions::emit_workspace_restored(&ctx, session_id, bm_count, an_count, meta, source);
}

/// Thin adapter over [`crate::services::sessions::close`] — see that function
/// for the state-cleanup logic this used to contain directly.
#[tauri::command]
pub async fn close_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    Ok(crate::services::sessions::close(&ctx, &session_id)?)
}

// ---------------------------------------------------------------------------
// get_lines
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_lines(app: AppHandle, request: LineRequest) -> Result<LineWindow, String> {
    Ok(line_window(&ui_ctx(&app), request)?)
}

/// The viewer's `LineRequest` in the service layer's vocabulary.
///
/// The whole request is one contiguous window (`offset`/`count`) — `Processor`
/// mode paginates the collapsed match list with the same two numbers, and
/// `Focus` overrides the selection entirely with a window around its centre,
/// both inside the service. The viewer sets no filters, no per-line character
/// cap and no anonymization, which is what keeps its bytes unchanged.
fn lines_request(request: LineRequest) -> LinesRequest {
    LinesRequest {
        session_id: request.session_id,
        selection: LineSelection::Range {
            offset: request.offset,
            limit: request.count,
        },
        filters: LineFilters::default(),
        view_mode: request.mode,
        processor_id: request.processor_id,
        context: request.context,
        search: request.search,
        max_line_chars: None,
        with_stats: false,
        skip_unreadable: false,
        metadata: LineMetadataSource::Parsed,
    }
}

/// Call the lines service and narrow its [`LinePage`](crate::services::wire::LinePage)
/// to the shape the viewer reads today.
///
/// **Transitional.** `LinePage` is a strict superset of `LineWindow` —
/// `total_lines` and `lines` carry across unchanged and the sampling metadata
/// (`strategy`, `strategyNote`, `scannedLines`, `stats`, plus `offset`/`count`)
/// is dropped on the floor because the viewer has never seen those fields.
/// WP-16 ships `LinePage` straight through and deletes this function.
pub(crate) fn line_window(
    ctx: &ServiceCtx,
    request: LineRequest,
) -> Result<LineWindow, ServiceError> {
    let page = lines::get_lines(ctx, lines_request(request))?;
    Ok(LineWindow {
        total_lines: page.total_lines,
        lines: page.lines,
    })
}

// ---------------------------------------------------------------------------
// search_logs (streaming chunked results via events)
// ---------------------------------------------------------------------------

/// Payload of the `search-progress` event.
///
/// No longer constructed here: `search_logs` emits through
/// [`ProgressEvent::Search`](crate::services::events::ProgressEvent::Search),
/// whose `SearchProgressEvent` is field-for-field identical and serializes to
/// the same bytes. Kept as an exported root type so the generated TypeScript
/// binding the frontend listener imports does not move in this package —
/// **WP-15/WP-16 should repoint that listener at `SearchProgressEvent` and
/// delete this struct** (and its line in `tests/export_bindings.rs`).
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

const SEARCH_CHUNK_SIZE: usize = 10_000;

/// Count the lines matching `query`, streaming partial results to the viewer
/// as `search-progress` events while the scan runs.
///
/// A thin adapter over [`services::search::summary`](crate::services::search::summary),
/// which owns the scan, the filters, the histograms and the progress cadence.
/// The service is synchronous by contract — it re-acquires the `sessions` lock
/// once per chunk and must never hold one across an await — so it runs on the
/// blocking pool, which is also what the pre-service body's `yield_now()`
/// between chunks was approximating.
///
/// The signature lost its `State` parameter (the context carries `AppState`
/// now); the invoke payload and the `SearchSummary` return shape are unchanged.
#[tauri::command]
pub async fn search_logs(
    app_handle: AppHandle,
    session_id: String,
    query: SearchQuery,
) -> Result<SearchSummary, String> {
    let ctx = ui_ctx(&app_handle);
    let progress: Arc<dyn ProgressSink> = Arc::new(TauriProgressSink::new(app_handle));
    tokio::task::spawn_blocking(move || search::summary(&ctx, &session_id, &query, progress))
        .await
        .map_err(|e| format!("search task failed: {e}"))?
        .map_err(String::from)
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

/// Thin adapter over `services::sections::list` — see that function for the
/// shared listing logic `mcp_bridge::routes::tracker::h_sections` also uses
/// (paged and name-filtered there; here the UI always wants the full,
/// unfiltered list).
#[tauri::command]
pub async fn get_sections(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<SectionInfo>, String> {
    let ctx = crate::commands::adapters::ui_ctx(&app);
    let page = crate::services::sections::list(&ctx, &session_id, None, 0, usize::MAX)?;
    Ok(page.items)
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

    fn make_state() -> AppState {
        AppState::new()
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

// ---------------------------------------------------------------------------
// get_lines — golden parity with the pre-service handler
// ---------------------------------------------------------------------------

#[cfg(test)]
mod get_lines_golden {
    use super::*;
    // `get_lines` itself no longer parses or builds a `ViewLine` — the frozen
    // reference below does, so these live here rather than at module scope.
    use crate::core::line::{LineMeta, LogLevel, ViewLine, ViewMode};
    use crate::core::session::{AnalysisSession, parser_for};
    use crate::services::testing::{fixture_session_from, test_ctx};
    use serde_json::{Value, json};
    use std::collections::HashMap;

    /// Frozen copy of the pre-service `commands::files::get_lines` body,
    /// taken verbatim from commit 6d1e19b with only the Tauri `State`
    /// extractor replaced by a plain `&AppState`.
    ///
    /// The viewer's wire shape is the one thing this refactor is least allowed
    /// to move, so the parity table below diffs the serialized `LineWindow` —
    /// every field of every line — against this copy rather than spot-checking
    /// a few. If a case fails, the new code is wrong; this copy is never
    /// "fixed".
    fn ref_get_lines(state: &AppState, request: LineRequest) -> Result<LineWindow, String> {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        let session = sessions
            .get(&request.session_id)
            .ok_or_else(|| format!("Session '{}' not found", request.session_id))?;
        let source = session.primary_source().ok_or("No sources in session")?;
        let total_lines = source.total_lines();
        let parser = parser_for(source.source_type());

        match request.mode {
            ViewMode::Full => {
                let start = request.offset.min(total_lines);
                let end = (request.offset + request.count).min(total_lines);
                let mut lines = Vec::with_capacity(end - start);
                for i in start..end {
                    let raw = source.raw_line(i).as_deref().unwrap_or("").to_string();
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
                        ViewLine {
                            line_num: i,
                            virtual_index: i,
                            raw: raw.clone(),
                            level: meta.map_or(LogLevel::Info, |m| m.level),
                            tag: meta
                                .map_or_else(String::new, |m| session.resolve_tag(m.tag_id).to_string()),
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
                let proc_id = request
                    .processor_id
                    .as_deref()
                    .ok_or("processor_id required for Processor mode")?;
                let matched: Vec<usize> = {
                    let pr = lock_or_err(&state.pipeline_results, "pipeline_results")?;
                    pr.get(&request.session_id)
                        .and_then(|s| s.get(proc_id))
                        .map(|r| r.matched_line_nums.clone())
                        .unwrap_or_default()
                };
                if matched.is_empty() {
                    return Ok(LineWindow {
                        total_lines,
                        lines: vec![],
                    });
                }
                let ctx_lines = request.context;
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
                let half = request.context.max(25);
                let start = center.saturating_sub(half);
                let end = (center + half + 1).min(total_lines);
                drop(sessions);
                let inner_sessions = lock_or_err(&state.sessions, "sessions")?;
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
                            let m = meta.unwrap_or(&LineMeta {
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
                        }
                    };
                    lines.push(view_line);
                }
                Ok(LineWindow { total_lines, lines })
            }
        }
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    /// A logcat-shaped log, so the parser path (pid/tid/tag/level/timestamp)
    /// is actually exercised rather than everything falling to the raw
    /// fallback — that fallback is where the two implementations most obviously
    /// agree, so the interesting cases are the ones where the parser fires.
    fn logcat_lines(n: usize) -> Vec<String> {
        (0..n)
            .map(|i| {
                let level = ["V", "D", "I", "W", "E"][i % 5];
                format!(
                    "01-15 10:30:{:02}.{:03}  1234  {} {} Tag{}: message {i}",
                    i % 60,
                    i % 1000,
                    5678 + (i % 3),
                    level,
                    i % 4
                )
            })
            .collect()
    }

    fn fixtures() -> Vec<AnalysisSession> {
        vec![
            fixture_session_from("s1", logcat_lines(200)),
            // A section header (`-----`) makes the parser return None, taking
            // the stored-meta fallback branch — the one place Full and Focus
            // historically disagreed.
            fixture_session_from(
                "mixed",
                vec![
                    "----- BEGIN -----".to_string(),
                    "01-15 10:30:00.000  1  2 I Tag: one".to_string(),
                    "not a log line at all".to_string(),
                    "----- END -----".to_string(),
                ],
            ),
            fixture_session_from("empty", vec![]),
        ]
    }

    fn arena() -> (ServiceCtx, ServiceCtx, Vec<tempfile::TempDir>) {
        let seed = |mut b: crate::services::testing::TestCtxBuilder| {
            for session in fixtures() {
                b = b.with_session_object(session);
            }
            b.build()
        };
        let (a, t1) = seed(test_ctx());
        let (b, t2) = seed(test_ctx());
        for ctx in [&a, &b] {
            let mut per = HashMap::new();
            per.insert(
                "proc@x".to_string(),
                crate::processors::reporter::engine::RunResult {
                    matched_line_nums: vec![3, 4, 10, 50],
                    ..Default::default()
                },
            );
            ctx.state()
                .pipeline_results
                .lock()
                .unwrap()
                .insert("s1".to_string(), per);
        }
        (a, b, vec![t1, t2])
    }

    fn req(session_id: &str, mode: ViewMode, offset: usize, count: usize) -> LineRequest {
        LineRequest {
            session_id: session_id.to_string(),
            mode,
            offset,
            count,
            context: 0,
            processor_id: None,
            search: None,
        }
    }

    fn render(result: Result<LineWindow, String>) -> Value {
        match result {
            Ok(window) => serde_json::to_value(&window).unwrap(),
            Err(e) => json!({ "error": e }),
        }
    }

    #[test]
    fn line_window_matches_the_frozen_handler_in_every_view_mode() {
        let (ref_ctx, new_ctx, _tmp) = arena();

        let search = SearchQuery {
            text: "message".to_string(),
            is_regex: false,
            case_sensitive: true,
            within_processor: None,
            min_level: None,
            tags: None,
            start_time: None,
            end_time: None,
        };

        let cases: Vec<(&str, LineRequest)> = vec![
            ("Full — first window", req("s1", ViewMode::Full, 0, 5)),
            ("Full — mid window", req("s1", ViewMode::Full, 40, 10)),
            (
                "Full — window running past the end",
                req("s1", ViewMode::Full, 195, 20),
            ),
            (
                "Full — offset past the end",
                req("s1", ViewMode::Full, 500, 10),
            ),
            ("Full — zero count", req("s1", ViewMode::Full, 0, 0)),
            (
                "Full — with search highlights",
                LineRequest {
                    search: Some(search.clone()),
                    ..req("s1", ViewMode::Full, 0, 6)
                },
            ),
            (
                "Full — unparseable and section-header lines",
                req("mixed", ViewMode::Full, 0, 4),
            ),
            ("Full — empty session", req("empty", ViewMode::Full, 0, 5)),
            ("Full — unknown session", req("nope", ViewMode::Full, 0, 5)),
            ("Focus — mid log", req("s1", ViewMode::Focus(100), 0, 0)),
            (
                "Focus — line 0 clamps at the start",
                req("s1", ViewMode::Focus(0), 0, 0),
            ),
            (
                "Focus — past EOF",
                req("s1", ViewMode::Focus(500), 0, 0),
            ),
            (
                "Focus — context below the 25-line floor",
                LineRequest {
                    context: 3,
                    ..req("s1", ViewMode::Focus(100), 0, 0)
                },
            ),
            (
                "Focus — context above the floor",
                LineRequest {
                    context: 40,
                    ..req("s1", ViewMode::Focus(100), 0, 0)
                },
            ),
            (
                "Focus — over the fallback branch",
                req("mixed", ViewMode::Focus(0), 0, 0),
            ),
            (
                "Focus — empty session",
                req("empty", ViewMode::Focus(0), 0, 0),
            ),
            (
                "Processor — whole collapsed view",
                LineRequest {
                    context: 1,
                    processor_id: Some("proc@x".to_string()),
                    ..req("s1", ViewMode::Processor, 0, 100)
                },
            ),
            (
                "Processor — no context",
                LineRequest {
                    processor_id: Some("proc@x".to_string()),
                    ..req("s1", ViewMode::Processor, 0, 100)
                },
            ),
            (
                "Processor — paged",
                LineRequest {
                    context: 1,
                    processor_id: Some("proc@x".to_string()),
                    ..req("s1", ViewMode::Processor, 2, 3)
                },
            ),
            (
                "Processor — page past the end",
                LineRequest {
                    context: 1,
                    processor_id: Some("proc@x".to_string()),
                    ..req("s1", ViewMode::Processor, 500, 3)
                },
            ),
            (
                "Processor — processor never ran",
                LineRequest {
                    processor_id: Some("other@x".to_string()),
                    ..req("s1", ViewMode::Processor, 0, 10)
                },
            ),
            (
                "Processor — no processor_id",
                req("s1", ViewMode::Processor, 0, 10),
            ),
            (
                "Processor — with search highlights",
                LineRequest {
                    context: 1,
                    processor_id: Some("proc@x".to_string()),
                    search: Some(search),
                    ..req("s1", ViewMode::Processor, 0, 100)
                },
            ),
        ];

        for (name, request) in cases {
            let expected = render(ref_get_lines(ref_ctx.state(), request.clone()));
            let actual = render(line_window(&new_ctx, request).map_err(|e| e.to_string()));
            assert_eq!(actual, expected, "LineWindow changed for case: {name}");
        }
    }

    #[test]
    fn the_viewer_is_never_redacted_or_truncated() {
        // The one fact the parity table cannot state, because the frozen
        // reference predates redaction existing at all: a `Caller::Ui` request
        // must come back byte-for-byte raw even for a session full of PII.
        let long = format!("head {} tail user@example.com", "x".repeat(2_000));
        let (ctx, _tmp) = test_ctx()
            .with_session_object(fixture_session_from("p1", vec![long.clone()]))
            .build();
        let window = line_window(&ctx, req("p1", ViewMode::Full, 0, 1)).unwrap();
        assert_eq!(window.lines[0].raw, long);
    }
}
