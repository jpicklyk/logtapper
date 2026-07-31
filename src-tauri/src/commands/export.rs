use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{lock_or_err, AppState};
use crate::core::log_source::{FileLogSource, ZipLogSource, StreamLogSource};
use crate::mcp_bridge::{anonymize_for_session, resolve_should_anonymize};
use crate::workspace::lts::{LtsEditorTab, LtsSessionData, LtsSessionMeta};

// ---------------------------------------------------------------------------
// T4 — Processor YAML reader helper
// ---------------------------------------------------------------------------

/// Read a processor's YAML definition from disk.
/// Returns None if the file doesn't exist or can't be read.
pub fn read_processor_yaml(app: &AppHandle, processor_id: &str) -> Option<String> {
    let data_dir = app.path().app_data_dir().ok()?;
    let filename = crate::processors::marketplace::id_to_filename(processor_id);
    let path = data_dir.join("processors").join(format!("{filename}.yaml"));
    std::fs::read_to_string(&path).ok()
}

// ---------------------------------------------------------------------------
// Per-session helpers
// ---------------------------------------------------------------------------

/// Returns active non-builtin processor IDs for a session.
/// Excludes built-in processors (IDs starting with `__`) and disabled ones.
/// Session-scoped `.lts` processors are stripped to bare IDs so exported
/// `.lts` files remain portable across different sessions.
pub(crate) fn active_custom_processor_ids(state: &AppState, session_id: &str) -> Vec<String> {
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
pub(crate) fn all_active_custom_processor_ids(
    state: &AppState,
    session_ids: &[String],
) -> Vec<String> {
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

// ---------------------------------------------------------------------------
// Stream byte extraction helper
// ---------------------------------------------------------------------------

/// Snapshot all bytes from a streaming log source without stopping the stream.
/// Iterates spill file lines first (oldest) then in-memory retained lines (newest),
/// joining with newlines. Returns the complete log content as UTF-8 bytes.
pub(crate) fn snapshot_stream_bytes(source: &StreamLogSource) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    let _ = source.write_stream_lines(&mut buf);
    buf
}

/// Anonymize each line in `lines` for `session_id` (honoring that session's
/// `mcp_anonymize` flag via [`anonymize_for_session`]) and reassemble into
/// the exact byte layout `write_lts` expects for a session's `source_bytes`:
/// one record per line, `\n`-terminated, in original order. Used for the
/// `SourceRef::RawLines` path in `export_all_sessions` (called only after
/// the `sessions` lock has been dropped — see that function's step 1b/2).
///
/// Pulled out as a standalone helper (taking `&AppState` rather than the
/// Tauri `State<'_, AppState>` extractor, and no `AppHandle`) so it is
/// directly unit-testable without spinning up a Tauri app — mirroring how
/// `mcp_bridge::resolve_should_anonymize` is tested as a pure function.
fn anonymize_lines_to_bytes(state: &AppState, session_id: &str, lines: &[String]) -> Vec<u8> {
    let mut buf = Vec::new();
    for line in lines {
        let anonymized = anonymize_for_session(state, session_id, line);
        buf.extend_from_slice(anonymized.as_bytes());
        buf.push(b'\n');
    }
    buf
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAllSessionsInfo {
    pub sessions: Vec<ExportSessionEntry>,
    pub total_processor_count: usize,
    pub total_pipeline_processor_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionEntry {
    pub session_id: String,
    pub source_filename: String,
    pub bookmark_count: usize,
    pub analysis_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAllOptions {
    pub dest_path: String,
    pub include_bookmarks: bool,
    pub include_analyses: bool,
    pub include_processors: bool,
    pub editor_tabs: Vec<LtsEditorTab>,
}

// ---------------------------------------------------------------------------
// Multi-session export commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_export_all_sessions_info(
    state: State<'_, AppState>,
) -> Result<ExportAllSessionsInfo, String> {
    // Collect session IDs and source filenames under brief lock.
    let session_entries: Vec<(String, String)> = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        sessions
            .iter()
            .map(|(id, session)| {
                let name = session_display_name(session);
                (id.clone(), name)
            })
            .collect()
    };
    // sessions lock dropped

    let session_ids: Vec<String> = session_entries.iter().map(|(id, _)| id.clone()).collect();

    // Build per-session entries with bookmark/analysis counts (one lock each, not per-session).
    let sessions: Vec<ExportSessionEntry> = {
        let bookmarks = lock_or_err(&state.bookmarks, "bookmarks")?;
        let analyses = lock_or_err(&state.analyses, "analyses")?;
        session_entries
            .into_iter()
            .map(|(session_id, source_filename)| {
                let bookmark_count = bookmarks.get(&session_id).map_or(0, Vec::len);
                let analysis_count = analyses.get(&session_id).map_or(0, Vec::len);
                ExportSessionEntry { session_id, source_filename, bookmark_count, analysis_count }
            })
            .collect()
    };

    let total_processor_count = all_active_custom_processor_ids(&state, &session_ids).len();
    let total_pipeline_processor_count = all_pipeline_custom_processor_count(&state, &session_ids);

    Ok(ExportAllSessionsInfo {
        sessions,
        total_processor_count,
        total_pipeline_processor_count,
    })
}

#[tauri::command]
pub async fn export_all_sessions(
    state: State<'_, AppState>,
    app: AppHandle,
    options: ExportAllOptions,
) -> Result<(), String> {
    // Source snapshot helper (outside lock scope).
    enum SourceRef {
        Mmap(Arc<Mmap>),
        Zip(Arc<Vec<u8>>),
        Stream(Vec<u8>),
        /// Owned, per-line raw text captured for a session whose
        /// `mcp_anonymize` flag is set. Anonymized line-by-line (via
        /// `anonymize_for_session`) once the `sessions` lock has been
        /// dropped — see step 2 below — instead of being written raw.
        RawLines(Vec<String>),
    }

    // 0. Stop any active ADB streams so no new lines arrive mid-export.
    let stopped_sessions: Vec<String> = {
        let mut tasks = lock_or_err(&state.stream_tasks, "stream_tasks")?;
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
            let _ = app.emit(
                "adb-stream-stopped",
                super::adb::AdbStreamStopped {
                    session_id: sid.clone(),
                    reason: "export".to_string(),
                },
            );
        }
    }

    // 1a. Snapshot the per-session MCP-anonymize flags *before* taking the
    // `sessions` lock. `anonymize_for_session` / `resolve_should_anonymize`
    // (from `mcp_bridge`) must never be called while `sessions` is held —
    // see their doc comments — so the anonymize decision has to be made
    // from data captured outside that lock.
    let anonymize_flags: HashMap<String, bool> = {
        let flags = lock_or_err(&state.mcp_anonymize, "mcp_anonymize")?;
        flags.clone()
    };

    // 1b. Collect all session IDs and snapshot source references under brief lock.
    //
    // Sessions with anonymization enabled (same per-session flag the MCP
    // bridge honors, via `resolve_should_anonymize`) get their raw text
    // captured line-by-line here as owned `String`s (`SourceRef::RawLines`)
    // instead of the raw byte snapshot, so no unanonymized Tier-1 text is
    // ever copied toward the archive. `raw_line`/`total_lines` are on the
    // `LogSource` trait and work uniformly across `FileLogSource`,
    // `ZipLogSource`, and `StreamLogSource` (the latter transparently
    // covering evicted/spilled lines), so this path needs no per-type
    // downcasting. Non-anonymized sessions keep the original fast
    // Arc-clone / byte-snapshot path unchanged.
    let session_snapshots: Vec<(String, String, SourceRef)> = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        let mut result = Vec::with_capacity(sessions.len());
        for (session_id, session) in sessions.iter() {
            let should_anonymize = resolve_should_anonymize(&anonymize_flags, session_id);
            let (name, sref) = match session.primary_source() {
                Some(src) => {
                    let name = src.name().to_string();
                    let sref = if should_anonymize {
                        let lines: Vec<String> = (0..src.total_lines())
                            .filter_map(|i| src.raw_line(i).map(|c| c.into_owned()))
                            .collect();
                        SourceRef::RawLines(lines)
                    } else if let Some(file_src) = src.as_any().downcast_ref::<FileLogSource>() {
                        SourceRef::Mmap(Arc::clone(file_src.mmap()))
                    } else if let Some(zip_src) = src.as_any().downcast_ref::<ZipLogSource>() {
                        SourceRef::Zip(Arc::clone(zip_src.data()))
                    } else if let Some(stream_src) = src.as_any().downcast_ref::<StreamLogSource>() {
                        SourceRef::Stream(snapshot_stream_bytes(stream_src))
                    } else {
                        return Err(format!("Unsupported source type in session: {session_id}"));
                    };
                    (name, sref)
                }
                None => {
                    (session_display_name(session), SourceRef::Stream(vec![]))
                }
            };
            result.push((session_id.clone(), name, sref));
        }
        result
    };
    // sessions lock dropped — data copies (and anonymization, for
    // RawLines sessions) happen outside the lock

    // 2. Build per-session data, copying source bytes outside the lock.
    let session_ids: Vec<String> = session_snapshots.iter().map(|(id, _, _)| id.clone()).collect();
    let mut lts_sessions: Vec<LtsSessionData> = Vec::with_capacity(session_snapshots.len());

    // Snapshot bookmarks and analyses under one lock each (not per-session).
    let all_bookmarks = if options.include_bookmarks {
        let guard = lock_or_err(&state.bookmarks, "bookmarks")?;
        session_snapshots.iter().map(|(id, _, _)| guard.get(id).cloned().unwrap_or_default()).collect::<Vec<_>>()
    } else {
        vec![vec![]; session_snapshots.len()]
    };
    let all_analyses = if options.include_analyses {
        let guard = lock_or_err(&state.analyses, "analyses")?;
        session_snapshots.iter().map(|(id, _, _)| guard.get(id).cloned().unwrap_or_default()).collect::<Vec<_>>()
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
            // Anonymize outside the `sessions` lock (dropped above), one
            // line at a time, then reassemble — preserving line order and
            // count exactly.
            SourceRef::RawLines(lines) => anonymize_lines_to_bytes(&state, &session_id, &lines),
        };

        let session_meta: LtsSessionMeta =
            crate::commands::workspace_sync::snapshot_pipeline_meta(&state, &session_id).into();

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
        let proc_ids = all_active_custom_processor_ids(&state, &session_ids);
        proc_ids
            .into_iter()
            .filter_map(|id| {
                // Disk-installed processors are found directly; .lts-imported processors
                // exist only in memory, so fall back to the in-memory YAML cache.
                let yaml = read_processor_yaml(&app, &id).or_else(|| {
                    let lts_yamls = state.lts_processor_yamls.lock().ok()?;
                    lts_yamls
                        .iter()
                        .find(|(k, _)| {
                            let (bare, _) = crate::processors::marketplace::split_qualified_id(k);
                            bare == id && crate::processors::marketplace::is_lts_scoped(k)
                        })
                        .map(|(_, v)| v.clone())
                })?;
                let filename = crate::processors::marketplace::id_to_filename(&id);
                Some((id, format!("{filename}.yaml"), yaml))
            })
            .collect()
    } else {
        vec![]
    };

    // 4. Write multi-session .lts file (no locks held). Offloaded to the
    // blocking pool: `write_lts` performs synchronous, CPU-bound zip
    // compression over the (potentially large) owned buffers assembled
    // above, and running it directly on this async command would hold a
    // tokio worker thread for the duration of the write — stalling ADB
    // streaming and any other pending command for the whole export.
    // Everything moved into the closure below is already owned data (no
    // `&AppState` or lock guard crosses this boundary), matching the
    // pattern used by `workspace::autosave`'s flush (~line 360) and
    // `commands::pipeline::run_pipeline` (~line 235).
    let dest = std::path::PathBuf::from(&options.dest_path);
    let editor_tabs = options.editor_tabs;
    tokio::task::spawn_blocking(move || {
        crate::workspace::lts::write_lts(&dest, &lts_sessions, &processor_yamls, &editor_tabs)
    })
    .await
    .map_err(|e| format!("Export task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// T7 — Resolve processors from imported .lts file
// ---------------------------------------------------------------------------

/// Resolve processors from an imported .lts file under session-scoped IDs.
///
/// Registers each bundled processor in `AppState` under a scoped ID
/// `{proc-id}@lts-{session_id}`. These are ephemeral — removed when the
/// session closes and never written to disk.
///
/// Returns `(bare_id, scoped_id)` pairs for remapping active_processor_ids.
pub fn resolve_lts_processors(
    state: &AppState,
    lts: &crate::workspace::lts::LtsData,
    session_id: &str,
) -> Result<Vec<(String, String)>, String> {
    resolve_lts_processors_raw(state, &lts.processor_manifest, &lts.processor_yamls, session_id)
}

/// Low-level variant that accepts the processor manifest and YAML map directly.
/// Used by `load_lts_file_inner` where `LtsData` has been partially consumed.
pub fn resolve_lts_processors_raw(
    state: &AppState,
    processor_manifest: &crate::workspace::lts::LtsProcessorManifest,
    processor_yamls: &std::collections::HashMap<String, String>,
    session_id: &str,
) -> Result<Vec<(String, String)>, String> {
    use crate::processors::marketplace::{LTS_NS_PREFIX, qualified_id};

    let mut result = Vec::new();

    for entry in &processor_manifest.processors {
        let Some(bundled_yaml) = processor_yamls.get(&entry.id) else {
            continue;
        };

        let mut bundled_proc = match crate::processors::AnyProcessor::from_yaml(bundled_yaml) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("Failed to parse processor {} from .lts: {e}", entry.id);
                continue;
            }
        };

        let scoped_id = qualified_id(&entry.id, &format!("{LTS_NS_PREFIX}{session_id}"));
        bundled_proc.meta.id = scoped_id.clone();

        lock_or_err(&state.processors, "processors")?
            .insert(scoped_id.clone(), bundled_proc);

        lock_or_err(&state.lts_processor_yamls, "lts_processor_yamls")?
            .insert(scoped_id.clone(), bundled_yaml.clone());

        log::info!("Scoped processor '{}' as '{}'", entry.id, scoped_id);
        result.push((entry.id.clone(), scoped_id));
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use crate::commands::AppState;
    use crate::core::log_source::StreamLogSource;
    use crate::workspace::SessionMeta;

    fn make_state_with_sessions(
        session_metas: Vec<(String, SessionMeta)>,
    ) -> AppState {
        let state = AppState::new();
        let mut meta_map = state.session_pipeline_meta.lock().unwrap();
        for (id, meta) in session_metas {
            meta_map.insert(id, meta);
        }
        drop(meta_map);
        state
    }

    /// `read_processor_yaml` with a nonexistent processor ID must return None without panicking.
    #[test]
    fn read_processor_yaml_nonexistent_returns_none() {
        let nonexistent = std::path::Path::new("/tmp/nonexistent-logtapper-test-xyz/processors/bogus-id.yaml");
        let result = std::fs::read_to_string(nonexistent).ok();
        assert!(result.is_none(), "reading a nonexistent path must return None");
    }

    /// Two sessions with overlapping custom processors → deduplicated union preserving first-seen order.
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

        let ids = all_active_custom_processor_ids(
            &state,
            &["sess-1".to_string(), "sess-2".to_string()],
        );

        // proc-b should appear only once; order: proc-a, proc-b (from sess-1), then proc-c (new from sess-2)
        assert_eq!(ids, vec!["proc-a", "proc-b", "proc-c"]);
    }

    /// Built-in processors (__ prefix) and disabled processors are excluded across all sessions.
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

        let ids = all_active_custom_processor_ids(
            &state,
            &["sess-1".to_string(), "sess-2".to_string()],
        );

        assert_eq!(ids, vec!["custom-a", "custom-c"]);
    }

    /// No pipeline meta for any session → returns empty vec.
    #[test]
    fn all_sessions_processor_ids_empty_state() {
        let state = make_state_with_sessions(vec![]);

        let ids = all_active_custom_processor_ids(
            &state,
            &["sess-missing".to_string()],
        );

        assert!(ids.is_empty(), "expected empty vec for sessions with no pipeline meta");
    }

    /// `resolve_lts_processors_raw` creates scoped keys and does NOT install under bare ID.
    #[test]
    fn resolve_lts_processors_raw_creates_scoped_keys() {
        use crate::workspace::lts::{LtsProcessorManifest, LtsProcessorEntry};

        let state = AppState::new();
        let manifest = LtsProcessorManifest {
            processors: vec![LtsProcessorEntry {
                id: "test-proc".to_string(),
                filename: "test-proc.yaml".to_string(),
                sha256: "abc123".to_string(),
            }],
        };

        // Minimal valid reporter YAML (meta layout).
        let yaml = "meta:\n  id: test-proc\n  name: Test Proc\n  version: \"1.0.0\"\n";
        let mut yamls = HashMap::new();
        yamls.insert("test-proc".to_string(), yaml.to_string());

        let result = resolve_lts_processors_raw(&state, &manifest, &yamls, "sess-123").unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, "test-proc");
        assert_eq!(result[0].1, "test-proc@lts-sess-123");

        // Verify it's in state.processors under the scoped key only.
        let procs = state.processors.lock().unwrap();
        assert!(procs.contains_key("test-proc@lts-sess-123"), "scoped key must exist");
        assert!(!procs.contains_key("test-proc"), "bare key must NOT exist");

        // Verify it's in lts_processor_yamls.
        drop(procs);
        let lts_yamls = state.lts_processor_yamls.lock().unwrap();
        assert!(lts_yamls.contains_key("test-proc@lts-sess-123"), "YAML cache must contain scoped key");
    }

    /// `active_custom_processor_ids` strips @lts-* namespace for export.
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

        // lts-scoped ID must be returned as its bare form; regular ID unchanged.
        assert!(ids.contains(&"wifi-state".to_string()), "lts ID should be stripped to bare");
        assert!(ids.contains(&"regular-proc".to_string()), "regular ID should be unchanged");
        assert!(!ids.iter().any(|id| id.contains("@lts-")), "no lts namespace in output");
    }

    // ---------------------------------------------------------------------------
    // snapshot_stream_bytes tests
    // ---------------------------------------------------------------------------

    /// Helper: construct a StreamLogSource with the given retained lines and no spill.
    /// `tag` is appended to the session ID to ensure spill-file isolation between tests.
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

    /// Empty stream (no lines) → empty byte vec.
    #[test]
    fn snapshot_stream_bytes_empty() {
        let src = make_stream_source("empty", &[]);
        let bytes = snapshot_stream_bytes(&src);
        assert!(bytes.is_empty(), "snapshot of empty stream must be empty");
    }

    /// Only retained in-memory lines (no spill) → correct content with newlines.
    #[test]
    fn snapshot_stream_bytes_retained_only() {
        let src = make_stream_source("retained", &["line-a", "line-b", "line-c"]);
        let bytes = snapshot_stream_bytes(&src);
        let text = std::str::from_utf8(&bytes).expect("bytes must be valid UTF-8");
        assert_eq!(text, "line-a\nline-b\nline-c\n");
    }

    /// Spill + retained: spill lines appear before retained lines.
    #[test]
    fn snapshot_stream_bytes_spill_then_retained() {
        let mut src = make_stream_source("spill-mix", &["evict-0", "evict-1", "retain-0", "retain-1"]);
        // Evict the first 2 lines — they go to the spill file.
        src.evict(2);
        let bytes = snapshot_stream_bytes(&src);
        let text = std::str::from_utf8(&bytes).expect("bytes must be valid UTF-8");
        assert_eq!(text, "evict-0\nevict-1\nretain-0\nretain-1\n");
    }

    /// All lines evicted (only spill, no retained) → spill content returned.
    #[test]
    fn snapshot_stream_bytes_all_spilled() {
        let mut src = make_stream_source("all-spilled", &["spill-a", "spill-b"]);
        src.evict(2);
        let bytes = snapshot_stream_bytes(&src);
        let text = std::str::from_utf8(&bytes).expect("bytes must be valid UTF-8");
        assert_eq!(text, "spill-a\nspill-b\n");
    }

    // ---------------------------------------------------------------------------
    // anonymize_lines_to_bytes tests — item 44906851
    //
    // export_all_sessions used to snapshot raw session bytes (mmap.to_vec() /
    // zip buffer clone / reconstructed stream text) and write them byte-for-byte
    // via workspace::lts::write_lts, with no anonymizer call anywhere in this
    // file. A session with PII anonymization enabled (the same per-session
    // `mcp_anonymize` flag the MCP bridge honors) would still export raw,
    // unredacted PII into the .lts archive. `anonymize_lines_to_bytes` is the
    // fix: it is what `SourceRef::RawLines` sessions are now routed through
    // (see `export_all_sessions`, step 1b/2) before their bytes ever reach
    // `write_lts`.
    //
    // A full round-trip test of `export_all_sessions` itself is impractical
    // here: the command takes `AppHandle` (used for `app.emit` and
    // `read_processor_yaml`'s `app_data_dir()`), and there is no precedent
    // elsewhere in this crate for constructing a `AppHandle`/`State` pair in a
    // unit test (see `commands/files.rs` around its multi-session test comment).
    // So — per the fallback this task explicitly allows — these tests exercise
    // `anonymize_lines_to_bytes` directly, which is the exact same function
    // (and the exact same `AppState::mcp_anonymize` / `anonymizer_config` /
    // `mcp_anonymizers` state) the export path calls. The gap left uncovered
    // is purely the surrounding glue in `export_all_sessions` (SourceRef
    // selection while holding `sessions`, and the write_lts call) — not the
    // anonymization decision or the redaction itself.
    // ---------------------------------------------------------------------------

    /// Session with anonymization enabled (`mcp_anonymize` flag = true, the
    /// same flag the MCP bridge reads): exported line text must have PII
    /// replaced by tokens, and the raw PII values must be absent. Line count
    /// (and therefore line ordering) must be preserved exactly.
    #[test]
    fn anonymize_lines_to_bytes_redacts_pii_when_flag_enabled() {
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap()
            .insert("sess-anon".to_string(), true);

        let lines = vec![
            "connecting to 192.168.1.100 now".to_string(),
            "user email is user@example.com, please contact".to_string(),
            "no pii on this line at all".to_string(),
        ];

        let bytes = anonymize_lines_to_bytes(&state, "sess-anon", &lines);
        let text = String::from_utf8(bytes).expect("output must be valid UTF-8");

        assert!(
            !text.contains("192.168.1.100"),
            "raw IP must not appear in an anonymized export: {text}"
        );
        assert!(
            !text.contains("user@example.com"),
            "raw email must not appear in an anonymized export: {text}"
        );
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

    /// Session without anonymization enabled (`mcp_anonymize` flag = false,
    /// explicitly disabled — e.g. `__pii_anonymizer` removed from the chain):
    /// exported line text must be byte-for-byte identical to the raw input,
    /// preserving the pre-fix behavior for sessions that never asked to be
    /// anonymized.
    #[test]
    fn anonymize_lines_to_bytes_passes_through_raw_when_flag_disabled() {
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap()
            .insert("sess-raw".to_string(), false);

        let lines = vec![
            "connecting to 192.168.1.100 now".to_string(),
            "user email is user@example.com, please contact".to_string(),
        ];

        let bytes = anonymize_lines_to_bytes(&state, "sess-raw", &lines);
        let text = String::from_utf8(bytes).expect("output must be valid UTF-8");

        assert_eq!(
            text,
            "connecting to 192.168.1.100 now\nuser email is user@example.com, please contact\n",
            "raw (non-anonymized) session must export byte-for-byte unchanged"
        );
    }

    /// A session with no explicit `mcp_anonymize` entry at all (never
    /// signalled by the frontend, e.g. a session that was never focused)
    /// must still be anonymized — `resolve_should_anonymize` fails closed to
    /// `true` for an unknown session, and export must honor that same
    /// fail-closed default rather than assuming raw export is safe.
    #[test]
    fn anonymize_lines_to_bytes_fails_closed_for_unsignalled_session() {
        let state = AppState::new(); // no mcp_anonymize entry for "sess-unknown"

        let lines = vec!["contact user@example.com for access".to_string()];

        let bytes = anonymize_lines_to_bytes(&state, "sess-unknown", &lines);
        let text = String::from_utf8(bytes).expect("output must be valid UTF-8");

        assert!(
            !text.contains("user@example.com"),
            "an unsignalled session must fail closed to anonymized, not raw: {text}"
        );
    }
}
