use std::collections::HashSet;
use std::sync::Arc;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::{lock_or_err, AppState};
use crate::core::log_source::{FileLogSource, ZipLogSource, StreamLogSource};
use crate::workspace::lts::{LtsSessionData, LtsSessionMeta, write_lts_multi};

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

/// Returns the count of active non-builtin processors for a session.
/// A processor is active if it is in session_pipeline_meta.active_processor_ids
/// and NOT in session_pipeline_meta.disabled_processor_ids.
/// Built-in processors (IDs starting with `__`) are always excluded.
#[allow(dead_code)]
pub(crate) fn active_custom_processor_count(state: &AppState, session_id: &str) -> usize {
    active_custom_processor_ids(state, session_id).len()
}

/// Returns active non-builtin processor IDs for a session.
/// Excludes built-in processors (IDs starting with `__`) and disabled ones.
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
        .cloned()
        .collect()
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

    // Spill lines first (oldest evicted lines)
    if let Some(ref spill) = source.spill {
        for i in 0..spill.total_spilled() {
            if let Some(line) = spill.read_line(i) {
                buf.extend_from_slice(line.as_bytes());
                buf.push(b'\n');
            }
        }
    }

    // Then retained in-memory lines
    for raw in &source.raw_lines {
        buf.extend_from_slice(raw.as_bytes());
        buf.push(b'\n');
    }

    buf
}

// ---------------------------------------------------------------------------
// Multi-session export types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAllSessionsInfo {
    pub sessions: Vec<ExportSessionEntry>,
    pub total_processor_count: usize,
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
                let name = session
                    .primary_source()
                    .map(|src| src.name().to_string())
                    .unwrap_or_default();
                (id.clone(), name)
            })
            .collect()
    };
    // sessions lock dropped

    let session_ids: Vec<String> = session_entries.iter().map(|(id, _)| id.clone()).collect();

    // Build per-session entries with bookmark/analysis counts.
    let mut sessions: Vec<ExportSessionEntry> = Vec::with_capacity(session_entries.len());
    for (session_id, source_filename) in session_entries {
        let bookmark_count = {
            let bookmarks = lock_or_err(&state.bookmarks, "bookmarks")?;
            bookmarks.get(&session_id).map_or(0, Vec::len)
        };
        let analysis_count = {
            let analyses = lock_or_err(&state.analyses, "analyses")?;
            analyses.get(&session_id).map_or(0, Vec::len)
        };
        sessions.push(ExportSessionEntry {
            session_id,
            source_filename,
            bookmark_count,
            analysis_count,
        });
    }

    // Deduplicated processor count across all sessions.
    let total_processor_count = all_active_custom_processor_ids(&state, &session_ids).len();

    Ok(ExportAllSessionsInfo {
        sessions,
        total_processor_count,
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

    // 1. Collect all session IDs and snapshot source references under brief lock.
    let session_snapshots: Vec<(String, String, SourceRef)> = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        let mut result = Vec::with_capacity(sessions.len());
        for (session_id, session) in sessions.iter() {
            let src = session
                .primary_source()
                .ok_or_else(|| format!("No source in session: {session_id}"))?;
            let name = src.name().to_string();
            let sref = if let Some(file_src) = src.as_any().downcast_ref::<FileLogSource>() {
                SourceRef::Mmap(Arc::clone(file_src.mmap()))
            } else if let Some(zip_src) = src.as_any().downcast_ref::<ZipLogSource>() {
                SourceRef::Zip(Arc::clone(zip_src.data()))
            } else if let Some(stream_src) = src.as_any().downcast_ref::<StreamLogSource>() {
                // Point-in-time snapshot of stream bytes without stopping the stream.
                SourceRef::Stream(snapshot_stream_bytes(stream_src))
            } else {
                return Err(format!("Unsupported source type in session: {session_id}"));
            };
            result.push((session_id.clone(), name, sref));
        }
        result
    };
    // sessions lock dropped — data copies happen outside the lock

    // 2. Build per-session data, copying source bytes outside the lock.
    let session_ids: Vec<String> = session_snapshots.iter().map(|(id, _, _)| id.clone()).collect();
    let mut lts_sessions: Vec<LtsSessionData> = Vec::with_capacity(session_snapshots.len());

    for (session_id, source_filename, sref) in session_snapshots {
        let source_bytes = match sref {
            SourceRef::Mmap(mmap) => mmap.to_vec(),
            SourceRef::Zip(data) => data.as_ref().clone(),
            SourceRef::Stream(bytes) => bytes,
        };

        let bookmarks = if options.include_bookmarks {
            lock_or_err(&state.bookmarks, "bookmarks")?
                .get(&session_id)
                .cloned()
                .unwrap_or_default()
        } else {
            vec![]
        };

        let analyses = if options.include_analyses {
            lock_or_err(&state.analyses, "analyses")?
                .get(&session_id)
                .cloned()
                .unwrap_or_default()
        } else {
            vec![]
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
                let yaml = read_processor_yaml(&app, &id)?;
                let filename = crate::processors::marketplace::id_to_filename(&id);
                Some((id, format!("{filename}.yaml"), yaml))
            })
            .collect()
    } else {
        vec![]
    };

    // 4. Write multi-session .lts file (no locks held).
    let dest = std::path::Path::new(&options.dest_path);
    write_lts_multi(dest, &lts_sessions, &processor_yamls)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// T7 — Resolve processors from imported .lts file
// ---------------------------------------------------------------------------

/// Resolve processors from an imported .lts file.
///
/// For each processor in the .lts manifest:
/// - If already installed locally with matching content hash → skip
/// - If missing or hash mismatch → install from the bundled YAML (global install for v1)
///
/// Returns the list of processor IDs that were installed or already present.
///
/// TODO: Future versions should use session-namespaced IDs to avoid overwriting
/// the user's globally installed processor with the session's version.
pub fn resolve_lts_processors(
    state: &AppState,
    app: &tauri::AppHandle,
    lts: &crate::workspace::lts::LtsData,
) -> Vec<String> {
    resolve_lts_processors_raw(state, app, &lts.processor_manifest, &lts.processor_yamls)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use crate::commands::AppState;
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
}

/// Low-level variant that accepts the processor manifest and YAML map directly.
/// Used by `load_lts_file_inner` where `LtsData` has been partially consumed.
pub fn resolve_lts_processors_raw(
    state: &AppState,
    app: &tauri::AppHandle,
    processor_manifest: &crate::workspace::lts::LtsProcessorManifest,
    processor_yamls: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    let mut resolved_ids = Vec::new();

    for entry in &processor_manifest.processors {
        let Some(bundled_yaml) = processor_yamls.get(&entry.id) else {
            continue; // YAML not actually bundled — skip
        };

        // Check if processor exists locally and compute its content hash.
        let local_yaml = read_processor_yaml(app, &entry.id);
        let needs_install = match &local_yaml {
            Some(local) => {
                let local_hash = crate::workspace::sha256_hex(local);
                let mismatch = local_hash != entry.sha256;
                if mismatch {
                    log::warn!(
                        "Overwriting locally installed processor '{}' with version from .lts session",
                        entry.id
                    );
                }
                mismatch
            }
            None => true, // Not installed locally
        };

        if needs_install {
            // Install the bundled processor globally (v1 — no session namespacing).
            match crate::processors::AnyProcessor::from_yaml(bundled_yaml) {
                Ok(proc) => {
                    let id = proc.meta.id.clone();
                    if let Ok(mut procs) = state.processors.lock() {
                        procs.insert(id.clone(), proc);
                    }
                    // Persist to disk.
                    if let Err(e) = crate::commands::processors::persist_processor(app, &id, bundled_yaml) {
                        log::warn!("Failed to persist processor {id} from .lts: {e}");
                    }
                    resolved_ids.push(id);
                }
                Err(e) => {
                    log::warn!("Failed to parse processor {} from .lts: {e}", entry.id);
                }
            }
        } else {
            resolved_ids.push(entry.id.clone());
        }
    }

    resolved_ids
}
