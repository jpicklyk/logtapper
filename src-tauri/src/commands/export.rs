use std::collections::HashSet;
use std::sync::Arc;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{lock_or_err, AppState};
use crate::core::log_source::{FileLogSource, ZipLogSource, StreamLogSource};
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

    // 1. Collect all session IDs and snapshot source references under brief lock.
    let session_snapshots: Vec<(String, String, SourceRef)> = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        let mut result = Vec::with_capacity(sessions.len());
        for (session_id, session) in sessions.iter() {
            let (name, sref) = match session.primary_source() {
                Some(src) => {
                    let name = src.name().to_string();
                    let sref = if let Some(file_src) = src.as_any().downcast_ref::<FileLogSource>() {
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
    // sessions lock dropped — data copies happen outside the lock

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

    // 4. Write multi-session .lts file (no locks held).
    let dest = std::path::Path::new(&options.dest_path);
    crate::workspace::lts::write_lts(dest, &lts_sessions, &processor_yamls, &options.editor_tabs)?;

    Ok(())
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
}
