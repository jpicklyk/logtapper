//! `export` service — multi-session `.lts` export.
//!
//! Moved from `commands/export.rs`. [`info`] is a pure read (no journaling).
//! [`run`] is the one mutation this package owns: it stops any live ADB
//! streams (emitting `adb-stream-stopped` through [`ServiceCtx::events`]
//! rather than a raw `AppHandle::emit`), snapshots session/bookmark/analysis
//! data one `AppState` lock at a time, and writes a `.lts` zip off the async
//! runtime via `spawn_blocking` — the exact `commands::pipeline::run` pattern
//! ([`ServiceCtx`] is `Clone + Send + 'static`, so it owns its own blocking
//! task instead of the caller cloning a handle).
//!
//! ## Destination policy
//!
//! The export destination is authorized via [`policy::authorize_write_dest`]
//! — the same write-destination gate `workspace::save` and
//! `stream::save_live_capture` use. `Ui` passes straight through (the native
//! save dialog is the consent step); an `Agent`'s destination must be
//! absolute, on a local drive, free of NTFS alternate-data-stream suffixes,
//! and its parent directory must resolve inside the MCP open allowlist (or
//! `allow_all`) — the destination file itself need not exist yet. An agent
//! can therefore only export into a directory it could already read files
//! from — it cannot escape the sandbox merely because export is a write
//! instead of a read.
//!
//! ## Redaction
//!
//! Export is a raw-line pathway — session source text ends up on disk in the
//! `.lts` archive — and the decision to redact it is made once, per caller,
//! by [`should_anonymize_export`]:
//!
//! - **`Agent`**: unaffected by [`ExportAllOptions::anonymize`] — the flag is
//!   silently ignored for an agent caller. Governed exactly as every other
//!   raw-line route: [`policy::should_anonymize`], i.e. redacted by default,
//!   raw only once the user has persisted the `agent_raw_access` opt-out
//!   (`services::settings::set_agent_raw_access`). An agent exporting every
//!   open session is the widest version of the leak that gate exists to
//!   close, so it must not be reachable by an options flag the agent's own
//!   request body controls.
//! - **`Ui`**: honors `options.anonymize` — the explicit "Anonymize PII in
//!   exported log lines" checkbox in the Export dialog. A `Ui` export is the
//!   user writing their own machine's logs to their own disk through a
//!   native save dialog, so it is raw by default (unticked), and redacted
//!   only when the user opts in for that one export.
//!
//! Once redaction applies (for either caller), the mechanism is the same:
//! [`policy::anonymize_session_text`], reusing the session's cached
//! `LogAnonymizer` so token numbering is stable — see [`export_line_text`].

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::Arc;

use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::commands::AppState;
use crate::core::analysis::artifact_references_session;
use crate::core::log_source::{FileLogSource, StreamLogSource, ZipLogSource};
use crate::workspace::lts::{LtsEditorTab, LtsSessionData, LtsSessionMeta};

use super::paths::AppPaths;
use super::policy;
use super::{lock_svc, Caller, ServiceCtx, ServiceError};

// ---------------------------------------------------------------------------
// Per-session helpers
// ---------------------------------------------------------------------------

/// Read a processor's YAML definition from disk under the app data directory.
/// Returns `None` if the file doesn't exist or can't be read.
fn read_processor_yaml(paths: &dyn AppPaths, processor_id: &str) -> Option<String> {
    let data_dir = paths.app_data_dir().ok()?;
    let filename = crate::processors::marketplace::id_to_filename(processor_id);
    let path = data_dir.join("processors").join(format!("{filename}.yaml"));
    std::fs::read_to_string(&path).ok()
}

/// Returns active non-builtin processor IDs for a session.
/// Excludes built-in processors (IDs starting with `__`) and disabled ones.
/// Session-scoped `.lts` processors are stripped to bare IDs so exported
/// `.lts` files remain portable across different sessions.
fn active_custom_processor_ids(state: &AppState, session_id: &str) -> Vec<String> {
    let Ok(meta_guard) = state.session_pipeline_meta.lock() else {
        return vec![];
    };
    let Some(meta) = meta_guard.get(session_id) else {
        return vec![];
    };
    let disabled: HashSet<&str> = meta.disabled_processor_ids.iter().map(String::as_str).collect();
    meta.active_processor_ids
        .iter()
        .filter(|id| !id.starts_with("__") && !disabled.contains(id.as_str()))
        .map(|id| {
            let (bare, _) = crate::processors::marketplace::split_qualified_id(id);
            if crate::processors::marketplace::is_lts_scoped(id) {
                bare.to_string()
            } else {
                id.clone()
            }
        })
        .collect()
}

/// Count deduplicated non-builtin processors in the pipeline across sessions
/// (includes disabled ones — the total pipeline size before filtering).
fn all_pipeline_custom_processor_count(state: &AppState, session_ids: &[String]) -> usize {
    let Ok(meta_guard) = state.session_pipeline_meta.lock() else {
        return 0;
    };
    let mut seen: HashSet<String> = HashSet::new();
    for session_id in session_ids {
        if let Some(meta) = meta_guard.get(session_id) {
            for id in &meta.active_processor_ids {
                if !id.starts_with("__") {
                    seen.insert(id.clone());
                }
            }
        }
    }
    seen.len()
}

/// Collect deduplicated active custom processor IDs across multiple sessions.
/// Preserves first-seen order (first session wins for ordering purposes).
fn all_active_custom_processor_ids(state: &AppState, session_ids: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut result: Vec<String> = Vec::new();
    for session_id in session_ids {
        for id in active_custom_processor_ids(state, session_id) {
            if seen.insert(id.clone()) {
                result.push(id);
            }
        }
    }
    result
}

/// Snapshot all bytes from a streaming log source without stopping the stream.
/// Iterates spill file lines first (oldest) then in-memory retained lines (newest),
/// joining with newlines. Returns the complete log content as UTF-8 bytes.
fn snapshot_stream_bytes(source: &StreamLogSource) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    let _ = source.write_stream_lines(&mut buf);
    buf
}

/// Decide whether `session_id`'s export must be redacted, given this caller
/// and the export options' `anonymize` flag. See the module doc comment's
/// "Redaction" section.
///
/// - `Ui`: honors `ui_anonymize` (`options.anonymize` from the Export
///   dialog's checkbox) directly — raw by default, redacted only when the
///   user opted in for this export.
/// - `Agent`: unaffected by `ui_anonymize`, which is silently ignored.
///   Governed by [`policy::should_anonymize`] like every other raw-line
///   route — redacted unless the user persisted the `agent_raw_access`
///   opt-out.
fn should_anonymize_export(ctx: &ServiceCtx, ui_anonymize: bool) -> bool {
    match ctx.caller() {
        Caller::Ui => ui_anonymize,
        Caller::Agent { .. } => policy::should_anonymize(ctx, ""),
    }
}

/// Redact one line of raw session text for export via the anonymizer
/// mechanism ([`policy::anonymize_session_text`]), reusing `session_id`'s
/// cached `LogAnonymizer` so token numbering is stable.
///
/// Unconditional — only ever called once [`should_anonymize_export`] has
/// already decided redaction applies, for either caller. It does not
/// truncate: export is never subject to the bridge's 500-char response cap.
fn export_line_text(ctx: &ServiceCtx, session_id: &str, raw: &str) -> String {
    policy::anonymize_session_text(ctx.state(), session_id, raw)
}

/// Redact each line in `lines` for `session_id` (caller-aware — see
/// [`export_line_text`]) and
/// reassemble into the exact byte layout `write_lts` expects for a session's
/// `source_bytes`: one record per line, `\n`-terminated, in original order.
fn anonymize_lines_to_bytes(ctx: &ServiceCtx, session_id: &str, lines: &[String]) -> Vec<u8> {
    let mut buf = Vec::new();
    for line in lines {
        let text = export_line_text(ctx, session_id, line);
        buf.extend_from_slice(text.as_bytes());
        buf.push(b'\n');
    }
    buf
}

/// Filter the workspace-owned analyses store down to the artifacts that
/// reference `session_id` (via [`artifact_references_session`]), cloned for
/// embedding in that session's exported `.lts` entry.
///
/// A multi-session artifact (one whose references span more than one open
/// session) is intentionally embedded in EACH session's exported entry it
/// references — this is what makes a later re-import of any one of those
/// `.lts` files still carry the full artifact rather than a partial view.
fn analyses_referencing_session(
    analyses: &[crate::core::analysis::AnalysisArtifact],
    session_id: &str,
) -> Vec<crate::core::analysis::AnalysisArtifact> {
    analyses
        .iter()
        .filter(|a| artifact_references_session(a, session_id))
        .cloned()
        .collect()
}

/// Derive a display name for a session: source name > file_path basename > session ID.
fn session_display_name(session: &crate::core::session::AnalysisSession) -> String {
    if let Some(src) = session.primary_source() {
        return src.name().to_string();
    }
    if let Some(ref path) = session.file_path {
        if let Some(name) = std::path::Path::new(path).file_name().and_then(|n| n.to_str()) {
            return name.to_string();
        }
    }
    session.id.clone()
}

// ---------------------------------------------------------------------------
// Multi-session export types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExportAllSessionsInfo {
    pub sessions: Vec<ExportSessionEntry>,
    pub total_processor_count: usize,
    pub total_pipeline_processor_count: usize,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionEntry {
    pub session_id: String,
    pub source_filename: String,
    pub bookmark_count: usize,
    pub analysis_count: usize,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExportAllOptions {
    pub dest_path: String,
    pub include_bookmarks: bool,
    pub include_analyses: bool,
    pub include_processors: bool,
    pub editor_tabs: Vec<LtsEditorTab>,
    /// Explicit "Anonymize PII in exported log lines" opt-in. `Ui`-only — see
    /// the module doc comment's "Redaction" section and
    /// [`should_anonymize_export`]. `#[serde(default)]` so an older client
    /// (or an agent, which never sends this) still deserializes with `false`.
    #[serde(default)]
    pub anonymize: bool,
}

// ---------------------------------------------------------------------------
// info — read-only, not journaled
// ---------------------------------------------------------------------------

/// Summarize every open session for the export dialog / MCP `export/info`
/// route: source filename, bookmark/analysis counts, and processor totals.
pub fn info(ctx: &ServiceCtx) -> Result<ExportAllSessionsInfo, ServiceError> {
    let state = ctx.state();

    // Collect session IDs and source filenames under brief lock.
    let session_entries: Vec<(String, String)> = {
        let sessions = lock_svc(&state.sessions, "sessions")?;
        sessions
            .iter()
            .map(|(id, session)| (id.clone(), session_display_name(session)))
            .collect()
    };
    // sessions lock dropped

    let session_ids: Vec<String> = session_entries.iter().map(|(id, _)| id.clone()).collect();

    // Build per-session entries with bookmark/analysis counts (one lock each, not per-session).
    let sessions: Vec<ExportSessionEntry> = {
        let bookmarks = lock_svc(&state.bookmarks, "bookmarks")?;
        let analyses = lock_svc(&state.analyses, "analyses")?;
        session_entries
            .into_iter()
            .map(|(session_id, source_filename)| {
                let bookmark_count = bookmarks.get(&session_id).map_or(0, Vec::len);
                let analysis_count = analyses
                    .iter()
                    .filter(|a| artifact_references_session(a, &session_id))
                    .count();
                ExportSessionEntry { session_id, source_filename, bookmark_count, analysis_count }
            })
            .collect()
    };

    let total_processor_count = all_active_custom_processor_ids(state, &session_ids).len();
    let total_pipeline_processor_count = all_pipeline_custom_processor_count(state, &session_ids);

    Ok(ExportAllSessionsInfo {
        sessions,
        total_processor_count,
        total_pipeline_processor_count,
    })
}

// ---------------------------------------------------------------------------
// run — the export mutation
// ---------------------------------------------------------------------------

/// Export every open session into a single `.lts` archive at
/// `options.dest_path`. Validated via [`authorize_export_dest`] first, so no
/// session data is ever touched for a destination the caller may not write
/// to. Journals `export.run` with the destination and session count on
/// success.
pub async fn run(ctx: ServiceCtx, options: ExportAllOptions) -> Result<(), ServiceError> {
    let dest = policy::authorize_write_dest(&ctx, &options.dest_path)?;

    // Source snapshot helper (outside lock scope).
    enum SourceRef {
        Mmap(Arc<Mmap>),
        Zip(Arc<Vec<u8>>),
        Stream(Vec<u8>),
        /// Owned, per-line raw text captured when this export must be
        /// redacted. Redacted line-by-line (via [`export_line_text`]) once
        /// the `sessions` lock has been dropped — see step 2 below — instead
        /// of being written raw.
        RawLines(Vec<String>),
    }

    // 0. Stop any active ADB streams so no new lines arrive mid-export.
    let stopped_sessions: Vec<String> = {
        let mut tasks = lock_svc(&ctx.state().stream_tasks, "stream_tasks")?;
        tasks
            .drain()
            .map(|(id, tx)| {
                let _ = tx.send(());
                id
            })
            .collect()
    };
    if !stopped_sessions.is_empty() {
        tokio::task::yield_now().await;
        for sid in &stopped_sessions {
            let payload = crate::commands::adb::AdbStreamStopped {
                session_id: sid.clone(),
                reason: "export".to_string(),
            };
            ctx.events().emit_json(
                "adb-stream-stopped",
                serde_json::to_value(payload).unwrap_or_default(),
            );
        }
    }

    // 1a. Resolve the redaction decision *before* taking the `sessions` lock
    // — `export_line_text`/`policy::anonymize_session_text` acquire
    // `anonymizer_config` / `mcp_anonymizers` themselves, and nesting those
    // under `sessions` would violate the lock-ordering discipline
    // `services/mod.rs` documents. The decision covers every session in this
    // export: caller identity + `agent_raw_access` for an `Agent`, or the
    // `options.anonymize` checkbox for a `Ui` export — see
    // `should_anonymize_export`.
    let anonymizing = should_anonymize_export(&ctx, options.anonymize);

    // 1b. Collect all session IDs and snapshot source references under brief lock.
    let session_snapshots: Vec<(String, String, SourceRef)> = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        let mut result = Vec::with_capacity(sessions.len());
        for (session_id, session) in sessions.iter() {
            let (name, sref) = match session.primary_source() {
                Some(src) => {
                    let name = src.name().to_string();
                    let sref = if anonymizing {
                        let lines: Vec<String> = (0..src.total_lines())
                            .filter_map(|i| src.raw_line(i).map(Cow::into_owned))
                            .collect();
                        SourceRef::RawLines(lines)
                    } else if let Some(file_src) = src.as_any().downcast_ref::<FileLogSource>() {
                        SourceRef::Mmap(Arc::clone(file_src.mmap()))
                    } else if let Some(zip_src) = src.as_any().downcast_ref::<ZipLogSource>() {
                        SourceRef::Zip(Arc::clone(zip_src.data()))
                    } else if let Some(stream_src) = src.as_any().downcast_ref::<StreamLogSource>() {
                        SourceRef::Stream(snapshot_stream_bytes(stream_src))
                    } else {
                        return Err(ServiceError::Internal(format!(
                            "Unsupported source type in session: {session_id}"
                        )));
                    };
                    (name, sref)
                }
                None => (session_display_name(session), SourceRef::Stream(vec![])),
            };
            result.push((session_id.clone(), name, sref));
        }
        result
    };
    // sessions lock dropped — data copies (and redaction, for RawLines
    // sessions) happen outside the lock.

    // 2. Build per-session data, copying source bytes outside the lock.
    let session_ids: Vec<String> = session_snapshots.iter().map(|(id, _, _)| id.clone()).collect();
    let session_count = session_snapshots.len();
    let mut lts_sessions: Vec<LtsSessionData> = Vec::with_capacity(session_snapshots.len());

    // Snapshot bookmarks and analyses under one lock each (not per-session).
    let all_bookmarks = if options.include_bookmarks {
        let guard = lock_svc(&ctx.state().bookmarks, "bookmarks")?;
        session_snapshots
            .iter()
            .map(|(id, _, _)| guard.get(id).cloned().unwrap_or_default())
            .collect::<Vec<_>>()
    } else {
        vec![vec![]; session_snapshots.len()]
    };
    let all_analyses = if options.include_analyses {
        let guard = lock_svc(&ctx.state().analyses, "analyses")?;
        session_snapshots
            .iter()
            .map(|(id, _, _)| analyses_referencing_session(&guard, id))
            .collect::<Vec<_>>()
    } else {
        vec![vec![]; session_snapshots.len()]
    };

    for ((session_id, source_filename, sref), (bookmarks, analyses)) in
        session_snapshots.into_iter().zip(all_bookmarks.into_iter().zip(all_analyses))
    {
        let source_bytes = match sref {
            SourceRef::Mmap(mmap) => mmap.to_vec(),
            SourceRef::Zip(data) => data.as_ref().clone(),
            SourceRef::Stream(bytes) => bytes,
            SourceRef::RawLines(lines) => anonymize_lines_to_bytes(&ctx, &session_id, &lines),
        };

        let session_meta: LtsSessionMeta =
            crate::services::snapshot::snapshot_pipeline_meta(ctx.state(), &session_id).into();

        lts_sessions.push(LtsSessionData {
            source_bytes,
            source_filename,
            bookmarks,
            analyses,
            session_meta,
        });
    }

    // 3. Collect deduplicated processor YAMLs (if requested).
    let processor_yamls: Vec<(String, String, String)> = if options.include_processors {
        let proc_ids = all_active_custom_processor_ids(ctx.state(), &session_ids);
        proc_ids
            .into_iter()
            .filter_map(|id| {
                // Disk-installed processors are found directly; .lts-imported processors
                // exist only in memory, so fall back to the in-memory YAML cache.
                let yaml = read_processor_yaml(ctx.paths(), &id).or_else(|| {
                    let lts_yamls = ctx.state().lts_processor_yamls.lock().ok()?;
                    lts_yamls
                        .iter()
                        .find(|(k, _)| {
                            let (bare, _) = crate::processors::marketplace::split_qualified_id(k);
                            bare == id && crate::processors::marketplace::is_lts_scoped(k)
                        })
                        .map(|(_, v)| v.clone())
                })?;
                let filename = crate::processors::marketplace::id_to_filename(&id);
                // Defense-in-depth (zip-slip): `id` here can originate from an
                // untrusted `.lts` archive re-exported without another trip
                // through `validate_processor_id()`. `id_to_filename()` only
                // escapes `@`, so a crafted id containing `..` or a path
                // separator would otherwise become a traversal entry name in
                // the newly written archive. Refuse to embed it — skip just
                // this processor rather than aborting the whole export.
                if let Err(e) = crate::processors::marketplace::ensure_filename_safe(&filename) {
                    log::warn!(
                        "export::run: skipping processor '{id}' — unsafe archive filename derived from id: {e}"
                    );
                    return None;
                }
                Some((id, format!("{filename}.yaml"), yaml))
            })
            .collect()
    } else {
        vec![]
    };

    // 4. Write the multi-session .lts file (no locks held), off the async
    // runtime — `write_lts` performs synchronous, CPU-bound zip compression
    // over the (potentially large) owned buffers assembled above, and running
    // it directly on this async task would hold a tokio worker thread for the
    // duration of the write. `ServiceCtx` owns nothing that needs to cross
    // this boundary — only owned data moves into the closure, mirroring
    // `services::pipeline::run`'s own `spawn_blocking`.
    let dest_for_write = dest.clone();
    let editor_tabs = options.editor_tabs;
    let write_result = tokio::task::spawn_blocking(move || {
        crate::workspace::lts::write_lts(&dest_for_write, &lts_sessions, &processor_yamls, &editor_tabs)
    })
    .await
    .map_err(|e| ServiceError::Internal(format!("Export task panicked: {e}")))?;
    write_result.map_err(ServiceError::Internal)?;

    ctx.journal(
        "export.run",
        None,
        format!("{session_count} session(s) -> {}", dest.display()),
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;
    use crate::services::Caller;
    use crate::workspace::SessionMeta;

    fn make_state_with_sessions(session_metas: Vec<(String, SessionMeta)>) -> AppState {
        let state = AppState::new();
        let mut meta_map = state.session_pipeline_meta.lock().unwrap();
        for (id, meta) in session_metas {
            meta_map.insert(id, meta);
        }
        drop(meta_map);
        state
    }

    // ── read_processor_yaml ──────────────────────────────────────────────

    #[test]
    fn read_processor_yaml_nonexistent_returns_none() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(read_processor_yaml(ctx.paths(), "bogus-id").is_none());
    }

    #[test]
    fn read_processor_yaml_reads_from_the_app_data_processors_dir() {
        let (ctx, tmp) = test_ctx().build();
        let dir = tmp.path().join("processors");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("my-proc.yaml"), "id: my-proc\nname: X\n").unwrap();
        let yaml = read_processor_yaml(ctx.paths(), "my-proc").expect("file exists");
        assert!(yaml.contains("my-proc"));
    }

    // ── active_custom_processor_ids / all_active_custom_processor_ids ────

    #[test]
    fn all_sessions_processor_ids_deduplicates() {
        let state = make_state_with_sessions(vec![
            (
                "sess-1".to_string(),
                SessionMeta {
                    active_processor_ids: vec!["proc-a".to_string(), "proc-b".to_string()],
                    disabled_processor_ids: vec![],
                },
            ),
            (
                "sess-2".to_string(),
                SessionMeta {
                    active_processor_ids: vec!["proc-b".to_string(), "proc-c".to_string()],
                    disabled_processor_ids: vec![],
                },
            ),
        ]);

        let ids = all_active_custom_processor_ids(&state, &["sess-1".to_string(), "sess-2".to_string()]);

        // proc-b should appear only once; order: proc-a, proc-b (from sess-1), then proc-c (new from sess-2)
        assert_eq!(ids, vec!["proc-a", "proc-b", "proc-c"]);
    }

    #[test]
    fn all_sessions_processor_ids_excludes_builtins_and_disabled() {
        let state = make_state_with_sessions(vec![
            (
                "sess-1".to_string(),
                SessionMeta {
                    active_processor_ids: vec![
                        "__builtin".to_string(),
                        "custom-a".to_string(),
                        "disabled-b".to_string(),
                    ],
                    disabled_processor_ids: vec!["disabled-b".to_string()],
                },
            ),
            (
                "sess-2".to_string(),
                SessionMeta {
                    active_processor_ids: vec!["__another-builtin".to_string(), "custom-c".to_string()],
                    disabled_processor_ids: vec![],
                },
            ),
        ]);

        let ids = all_active_custom_processor_ids(&state, &["sess-1".to_string(), "sess-2".to_string()]);

        assert_eq!(ids, vec!["custom-a", "custom-c"]);
    }

    #[test]
    fn all_sessions_processor_ids_empty_state() {
        let state = make_state_with_sessions(vec![]);
        let ids = all_active_custom_processor_ids(&state, &["sess-missing".to_string()]);
        assert!(ids.is_empty(), "expected empty vec for sessions with no pipeline meta");
    }

    #[test]
    fn active_custom_processor_ids_strips_lts_namespace() {
        let state = make_state_with_sessions(vec![(
            "sess-1".to_string(),
            SessionMeta {
                active_processor_ids: vec![
                    "wifi-state@lts-sess-abc".to_string(),
                    "regular-proc".to_string(),
                ],
                disabled_processor_ids: vec![],
            },
        )]);

        let ids = active_custom_processor_ids(&state, "sess-1");

        assert!(ids.contains(&"wifi-state".to_string()), "lts ID should be stripped to bare");
        assert!(ids.contains(&"regular-proc".to_string()), "regular ID should be unchanged");
        assert!(!ids.iter().any(|id| id.contains("@lts-")), "no lts namespace in output");
    }

    // ── snapshot_stream_bytes ─────────────────────────────────────────────

    fn make_stream_source(tag: &str, lines: &[&str]) -> StreamLogSource {
        let mut src = StreamLogSource::new(
            format!("test-id-{tag}"),
            "test-stream".into(),
            format!("test-session-{tag}"),
            std::env::temp_dir(),
        );
        for line in lines {
            src.push_raw_line((*line).to_string());
        }
        src
    }

    #[test]
    fn snapshot_stream_bytes_empty() {
        let src = make_stream_source("empty", &[]);
        let bytes = snapshot_stream_bytes(&src);
        assert!(bytes.is_empty(), "snapshot of empty stream must be empty");
    }

    #[test]
    fn snapshot_stream_bytes_retained_only() {
        let src = make_stream_source("retained", &["line-a", "line-b", "line-c"]);
        let bytes = snapshot_stream_bytes(&src);
        let text = std::str::from_utf8(&bytes).expect("bytes must be valid UTF-8");
        assert_eq!(text, "line-a\nline-b\nline-c\n");
    }

    #[test]
    fn snapshot_stream_bytes_spill_then_retained() {
        let mut src = make_stream_source("spill-mix", &["evict-0", "evict-1", "retain-0", "retain-1"]);
        src.evict(2);
        let bytes = snapshot_stream_bytes(&src);
        let text = std::str::from_utf8(&bytes).expect("bytes must be valid UTF-8");
        assert_eq!(text, "evict-0\nevict-1\nretain-0\nretain-1\n");
    }

    #[test]
    fn snapshot_stream_bytes_all_spilled() {
        let mut src = make_stream_source("all-spilled", &["spill-a", "spill-b"]);
        src.evict(2);
        let bytes = snapshot_stream_bytes(&src);
        let text = std::str::from_utf8(&bytes).expect("bytes must be valid UTF-8");
        assert_eq!(text, "spill-a\nspill-b\n");
    }

    // ── should_anonymize_export (the decision) ───────────────────────────
    //
    // Ported from item 44906851's regression tests: `export_all_sessions`
    // used to snapshot raw session bytes and write them byte-for-byte, with
    // no anonymizer call anywhere in the file. A session with PII
    // anonymization enabled would still export raw, unredacted PII. These
    // tests now cover the caller split documented in the module doc
    // comment's "Redaction" section — an `Agent` ignores `options.anonymize`
    // entirely and is governed by `agent_raw_access`; a `Ui` export honors
    // `options.anonymize` directly.

    #[test]
    fn should_anonymize_export_ui_follows_the_checkbox() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(!should_anonymize_export(&ctx, false), "unticked: raw by default");
        assert!(should_anonymize_export(&ctx, true), "ticked: the user opted in");
    }

    #[test]
    fn should_anonymize_export_agent_ignores_the_flag_and_is_redacted_by_default() {
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        // Whatever the (agent-supplied) flag says, an agent with no
        // `agent_raw_access` opt-out is always redacted.
        assert!(should_anonymize_export(&ctx, false), "flag=false must not matter for an agent");
        assert!(should_anonymize_export(&ctx, true), "flag=true must not matter for an agent");
    }

    #[test]
    fn should_anonymize_export_agent_ignores_the_flag_even_with_raw_access_on() {
        let (ctx, _tmp) = test_ctx().agent("mcp").agent_raw_access(true).build();
        // The user's own opt-out wins regardless of what the flag says.
        assert!(!should_anonymize_export(&ctx, false), "raw_access=true, flag=false: still raw");
        assert!(!should_anonymize_export(&ctx, true), "raw_access=true, flag=true: still raw — the flag is Ui-only");
    }

    // ── export_line_text / anonymize_lines_to_bytes (the mechanism) ──────
    //
    // Unconditional — only ever invoked once `should_anonymize_export` has
    // already decided redaction applies (see `run`'s `SourceRef::RawLines`
    // branch). No caller dimension here any more.

    #[test]
    fn anonymize_lines_to_bytes_redacts_pii() {
        let (ctx, _tmp) = test_ctx().build();

        let lines = vec![
            "connecting to 192.168.1.100 now".to_string(),
            "user email is user@example.com, please contact".to_string(),
            "no pii on this line at all".to_string(),
        ];

        let bytes = anonymize_lines_to_bytes(&ctx, "sess-anon", &lines);
        let text = String::from_utf8(bytes).expect("output must be valid UTF-8");

        assert!(!text.contains("192.168.1.100"), "raw IP must not appear in an anonymized export: {text}");
        assert!(!text.contains("user@example.com"), "raw email must not appear in an anonymized export: {text}");
        assert!(
            text.contains("<IPv4-") && text.contains("<EMAIL-"),
            "expected PII to be replaced with anonymizer tokens: {text}"
        );

        let out_lines: Vec<&str> = text.lines().collect();
        assert_eq!(out_lines.len(), 3, "line count must be preserved exactly");
        assert_eq!(
            out_lines[2], "no pii on this line at all",
            "line order must be preserved; non-PII line must round-trip unchanged"
        );
    }

    #[test]
    fn anonymize_lines_to_bytes_reuses_one_anonymizer_per_session_so_tokens_are_stable() {
        let (ctx, _tmp) = test_ctx().build();
        let lines = vec![
            "contact user@example.com".to_string(),
            "again: user@example.com".to_string(),
        ];
        let bytes = anonymize_lines_to_bytes(&ctx, "sess-a", &lines);
        let text = String::from_utf8(bytes).unwrap();
        let out_lines: Vec<&str> = text.lines().collect();
        let token = out_lines[0].split_whitespace().last().unwrap();
        assert!(out_lines[1].contains(token), "token numbering drifted: {text}");
    }

    // ── analyses_referencing_session ─────────────────────────────────────

    fn artifact_with_ref(id: &str, session_id: Option<&str>) -> crate::core::analysis::AnalysisArtifact {
        use crate::core::analysis::{AnalysisSection, HighlightType, SourceReference};
        crate::core::analysis::AnalysisArtifact {
            id: id.to_string(),
            title: id.to_string(),
            created_at: 0,
            sections: vec![AnalysisSection {
                heading: "H".to_string(),
                body: "B".to_string(),
                references: vec![SourceReference {
                    line_number: 1,
                    end_line: None,
                    label: "ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: session_id.map(str::to_string),
                }],
                severity: None,
            }],
            legacy_session_id: None,
        }
    }

    fn artifact_with_refs(id: &str, session_ids: &[&str]) -> crate::core::analysis::AnalysisArtifact {
        use crate::core::analysis::{AnalysisSection, HighlightType, SourceReference};
        crate::core::analysis::AnalysisArtifact {
            id: id.to_string(),
            title: id.to_string(),
            created_at: 0,
            sections: vec![AnalysisSection {
                heading: "H".to_string(),
                body: "B".to_string(),
                references: session_ids
                    .iter()
                    .map(|sid| SourceReference {
                        line_number: 1,
                        end_line: None,
                        label: "ref".to_string(),
                        highlight_type: HighlightType::default(),
                        session_id: Some((*sid).to_string()),
                    })
                    .collect(),
                severity: None,
            }],
            legacy_session_id: None,
        }
    }

    #[test]
    fn lts_export_includes_analyses_referencing_the_exported_session_only() {
        let a = artifact_with_ref("art-a", Some("sess-a"));
        let b = artifact_with_ref("art-b", Some("sess-b"));
        let unattributed = artifact_with_ref("art-none", None);
        let all = vec![a, b, unattributed];

        let for_a = analyses_referencing_session(&all, "sess-a");
        assert_eq!(for_a.len(), 1);
        assert_eq!(for_a[0].id, "art-a");

        let for_b = analyses_referencing_session(&all, "sess-b");
        assert_eq!(for_b.len(), 1);
        assert_eq!(for_b[0].id, "art-b");
    }

    #[test]
    fn lts_export_embeds_multi_session_analysis_in_each_referenced_session() {
        let multi = artifact_with_refs("art-multi", &["sess-a", "sess-b"]);
        let all = vec![multi];

        let for_a = analyses_referencing_session(&all, "sess-a");
        let for_b = analyses_referencing_session(&all, "sess-b");

        assert_eq!(for_a.len(), 1, "must be embedded in session A's export");
        assert_eq!(for_a[0].id, "art-multi");
        assert_eq!(for_b.len(), 1, "must ALSO be embedded in session B's export");
        assert_eq!(for_b[0].id, "art-multi");

        let for_c = analyses_referencing_session(&all, "sess-c");
        assert!(for_c.is_empty(), "a session it does not reference must get nothing");
    }

    #[test]
    fn zero_reference_artifact_included_in_lts_export() {
        use crate::core::analysis::{AnalysisArtifact, AnalysisSection};

        let narrative_only = AnalysisArtifact {
            id: "art-narrative".to_string(),
            title: "Summary".to_string(),
            created_at: 0,
            sections: vec![AnalysisSection {
                heading: "Conclusion".to_string(),
                body: "Everything is fine.".to_string(),
                references: vec![],
                severity: None,
            }],
            legacy_session_id: None,
        };
        let anchored = artifact_with_ref("art-anchored", Some("sess-a"));
        let all = vec![narrative_only, anchored];

        let for_a = analyses_referencing_session(&all, "sess-a");
        assert_eq!(for_a.len(), 2, "both the anchored and the narrative-only analysis belong in sess-a's export");
        assert!(for_a.iter().any(|a| a.id == "art-narrative"));

        let for_unrelated = analyses_referencing_session(&all, "sess-unrelated");
        assert_eq!(
            for_unrelated.len(), 1,
            "the narrative-only analysis must also be embedded in a session it never anchored to"
        );
        assert_eq!(for_unrelated[0].id, "art-narrative");
    }

    // ── info ──────────────────────────────────────────────────────────────

    #[test]
    fn info_on_an_empty_workspace_reports_zero_sessions() {
        let (ctx, _tmp) = test_ctx().build();
        let info = info(&ctx).unwrap();
        assert!(info.sessions.is_empty());
        assert_eq!(info.total_processor_count, 0);
        assert_eq!(info.total_pipeline_processor_count, 0);
    }

    #[test]
    fn info_reports_bookmark_and_analysis_counts_per_session() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 3).build();
        ctx.state()
            .bookmarks
            .lock()
            .unwrap()
            .insert("s1".to_string(), vec![crate::core::bookmark::Bookmark {
                id: "b1".to_string(),
                session_id: "s1".to_string(),
                line_number: 1,
                line_number_end: None,
                label: "L".to_string(),
                note: String::new(),
                created_at: 0,
                created_by: crate::core::bookmark::CreatedBy::User,
                snippet: None,
                category: None,
                tags: None,
            }]);
        ctx.state().analyses.lock().unwrap().push(artifact_with_ref("art-a", Some("s1")));

        let info = info(&ctx).unwrap();
        assert_eq!(info.sessions.len(), 1);
        assert_eq!(info.sessions[0].session_id, "s1");
        assert_eq!(info.sessions[0].bookmark_count, 1);
        assert_eq!(info.sessions[0].analysis_count, 1);
    }

    // `authorize_write_dest`'s tests (formerly `authorize_export_dest` here)
    // now live in `services::policy`, next to the consolidated function.

    // ── run (end-to-end) ──────────────────────────────────────────────────

    #[tokio::test]
    async fn run_agent_outside_the_allowlist_is_forbidden_before_touching_any_session() {
        let (ctx, tmp) = test_ctx()
            .caller(Caller::Agent { client: "mcp".into() })
            .with_session("s1", 5)
            .build();
        let dest = tmp.path().join("nope.lts");
        let options = ExportAllOptions {
            dest_path: dest.to_string_lossy().to_string(),
            include_bookmarks: false,
            include_analyses: false,
            include_processors: false,
            editor_tabs: vec![],
            anonymize: false,
        };
        let err = run(ctx, options).await.unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert!(!dest.exists(), "no file must be written on a denied destination");
    }

    #[tokio::test]
    async fn run_ui_writes_an_lts_file_and_journals_with_the_session_count() {
        let (ctx, tmp) = test_ctx().with_session("s1", 5).build();
        let dest = tmp.path().join("out.lts");
        let options = ExportAllOptions {
            dest_path: dest.to_string_lossy().to_string(),
            include_bookmarks: false,
            include_analyses: false,
            include_processors: false,
            editor_tabs: vec![],
            anonymize: false,
        };
        run(ctx.clone(), options).await.expect("export should succeed");
        assert!(dest.exists(), "the .lts file must be written");

        let entries = ctx.state().activity.list(None, None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].action, "export.run");
        assert!(entries[0].summary.contains('1'), "summary should mention the session count: {}", entries[0].summary);
    }

    #[tokio::test]
    async fn run_agent_inside_the_allowlist_writes_redacted_content() {
        let (ctx, tmp) = test_ctx()
            .caller(Caller::Agent { client: "mcp".into() })
            .with_pii_session("s1", 3)
            .build();
        let out_dir = tmp.path().join("allowed-out");
        std::fs::create_dir_all(&out_dir).unwrap();
        ctx.state()
            .mcp_open_allowlist
            .lock()
            .unwrap()
            .allowed_dirs
            .push(out_dir.to_string_lossy().to_string());

        let dest = out_dir.join("agent-out.lts");
        let options = ExportAllOptions {
            dest_path: dest.to_string_lossy().to_string(),
            include_bookmarks: false,
            include_analyses: false,
            include_processors: false,
            editor_tabs: vec![],
            anonymize: false,
        };
        run(ctx, options).await.expect("export inside the allowlist should succeed");
        assert!(dest.exists());

        // Nothing was configured, so an agent export is anonymized: the
        // archive's source bytes must not contain the fixture's raw PII
        // (fixture_session_with_pii embeds `userN@example.com`).
        let bytes = std::fs::read(&dest).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut found_source = false;
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).unwrap();
            if file.name().contains("source/") {
                found_source = true;
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut file, &mut buf).unwrap();
                let text = String::from_utf8_lossy(&buf);
                assert!(!text.contains("@example.com"), "raw PII leaked into an agent's export: {text}");
            }
        }
        assert!(found_source, "the archive must contain a source entry");
    }

    /// Item 0ea8aad3: a `Ui` export honors the explicit `anonymize` checkbox.
    /// Ticked → the written archive's source bytes carry anonymizer tokens,
    /// not the fixture's raw PII.
    #[tokio::test]
    async fn run_ui_with_anonymize_true_redacts_pii_in_the_written_archive() {
        let (ctx, tmp) = test_ctx().with_pii_session("s1", 3).build();
        let dest = tmp.path().join("ui-anon.lts");
        let options = ExportAllOptions {
            dest_path: dest.to_string_lossy().to_string(),
            include_bookmarks: false,
            include_analyses: false,
            include_processors: false,
            editor_tabs: vec![],
            anonymize: true,
        };
        run(ctx, options).await.expect("ui export should succeed");
        assert!(dest.exists());

        let bytes = std::fs::read(&dest).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut found_source = false;
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).unwrap();
            if file.name().contains("source/") {
                found_source = true;
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut file, &mut buf).unwrap();
                let text = String::from_utf8_lossy(&buf);
                assert!(!text.contains("@example.com"), "raw PII leaked into a ticked Ui export: {text}");
                assert!(text.contains("<EMAIL-"), "expected anonymizer tokens in a ticked Ui export: {text}");
            }
        }
        assert!(found_source, "the archive must contain a source entry");
    }

    /// Unticked (the default): a `Ui` export stays raw, exactly as before
    /// this item — regression guard for the existing (never-redacted)
    /// behavior alongside the new opt-in.
    #[tokio::test]
    async fn run_ui_with_anonymize_false_writes_raw_content() {
        let (ctx, tmp) = test_ctx().with_pii_session("s1", 3).build();
        let dest = tmp.path().join("ui-raw.lts");
        let options = ExportAllOptions {
            dest_path: dest.to_string_lossy().to_string(),
            include_bookmarks: false,
            include_analyses: false,
            include_processors: false,
            editor_tabs: vec![],
            anonymize: false,
        };
        run(ctx, options).await.expect("ui export should succeed");
        assert!(dest.exists());

        let bytes = std::fs::read(&dest).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut found_source = false;
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).unwrap();
            if file.name().contains("source/") {
                found_source = true;
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut file, &mut buf).unwrap();
                let text = String::from_utf8_lossy(&buf);
                assert!(text.contains("@example.com"), "an unticked Ui export must stay raw: {text}");
            }
        }
        assert!(found_source, "the archive must contain a source entry");
    }

    /// An agent's request body may set `anonymize: true`, but the flag is
    /// Ui-only and must be silently ignored — an agent with no
    /// `agent_raw_access` opt-out is redacted regardless (already covered by
    /// `run_agent_inside_the_allowlist_writes_redacted_content` for the
    /// `false` case; this pins the `true` case doesn't accidentally do
    /// anything different, e.g. skip redaction because the flag "agreed").
    #[tokio::test]
    async fn run_agent_ignores_a_true_anonymize_flag_and_still_redacts_by_default() {
        let (ctx, tmp) = test_ctx()
            .caller(Caller::Agent { client: "mcp".into() })
            .with_pii_session("s1", 3)
            .build();
        let out_dir = tmp.path().join("allowed-out");
        std::fs::create_dir_all(&out_dir).unwrap();
        ctx.state()
            .mcp_open_allowlist
            .lock()
            .unwrap()
            .allowed_dirs
            .push(out_dir.to_string_lossy().to_string());

        let dest = out_dir.join("agent-flag-ignored.lts");
        let options = ExportAllOptions {
            dest_path: dest.to_string_lossy().to_string(),
            include_bookmarks: false,
            include_analyses: false,
            include_processors: false,
            editor_tabs: vec![],
            anonymize: true,
        };
        run(ctx, options).await.expect("agent export inside the allowlist should succeed");

        let bytes = std::fs::read(&dest).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).unwrap();
            if file.name().contains("source/") {
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut file, &mut buf).unwrap();
                let text = String::from_utf8_lossy(&buf);
                assert!(!text.contains("@example.com"), "raw PII leaked into an agent's export: {text}");
            }
        }
    }
}
