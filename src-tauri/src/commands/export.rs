use std::sync::Arc;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::{lock_or_err, AppState};
use crate::core::log_source::{FileLogSource, ZipLogSource};
use crate::workspace::lts::{LtsData, LtsProcessorManifest};

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
// Helpers — testable processor selection logic
// ---------------------------------------------------------------------------

/// Count non-builtin processors enabled in the pipeline for a session.
/// Excludes processors present in `disabled_processor_ids`.
pub(crate) fn active_custom_processor_count(state: &AppState, session_id: &str) -> usize {
    let Ok(meta) = state.session_pipeline_meta.lock() else {
        return 0;
    };
    meta.get(session_id)
        .map_or(0, |m| {
            m.active_processor_ids.iter()
                .filter(|id| !id.starts_with("__") && !m.disabled_processor_ids.contains(id))
                .count()
        })
}

/// Collect non-builtin processor IDs enabled in the pipeline for a session.
/// Excludes processors present in `disabled_processor_ids`.
pub(crate) fn active_custom_processor_ids(state: &AppState, session_id: &str) -> Vec<String> {
    let Ok(meta) = state.session_pipeline_meta.lock() else {
        return vec![];
    };
    meta.get(session_id)
        .map(|m| {
            m.active_processor_ids.iter()
                .filter(|id| !id.starts_with("__") && !m.disabled_processor_ids.contains(id))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// T5 — Export session info command
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionInfo {
    pub source_filename: String,
    pub bookmark_count: usize,
    pub analysis_count: usize,
    pub processor_count: usize,
}

#[tauri::command]
pub async fn get_export_session_info(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ExportSessionInfo, String> {
    // Read source filename under brief lock.
    let source_filename = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let src = session
            .primary_source()
            .ok_or("No source in session")?;
        src.name().to_string()
    };
    // sessions lock dropped

    // Bookmark count under brief lock.
    let bookmark_count = {
        let bookmarks = lock_or_err(&state.bookmarks, "bookmarks")?;
        bookmarks.get(&session_id).map_or(0, Vec::len)
    };

    // Analysis count under brief lock.
    let analysis_count = {
        let analyses = lock_or_err(&state.analyses, "analyses")?;
        analyses.get(&session_id).map_or(0, Vec::len)
    };

    let processor_count = active_custom_processor_count(&state, &session_id);

    Ok(ExportSessionInfo {
        source_filename,
        bookmark_count,
        analysis_count,
        processor_count,
    })
}

// ---------------------------------------------------------------------------
// T5 — Export session command
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub dest_path: String,
    pub include_bookmarks: bool,
    pub include_analyses: bool,
    pub include_processors: bool,
}

#[tauri::command]
pub async fn export_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    options: ExportOptions,
) -> Result<(), String> {
    // 1. Snapshot source pointers under brief lock (cheap Arc clones, no data copy).
    enum SourceRef {
        Mmap(Arc<Mmap>),
        Zip(Arc<Vec<u8>>),
    }
    let (source_name, source_ref) = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let src = session
            .primary_source()
            .ok_or("No source in session")?;
        let name = src.name().to_string();
        let sref = if let Some(file_src) = src.as_any().downcast_ref::<FileLogSource>() {
            SourceRef::Mmap(Arc::clone(file_src.mmap()))
        } else if let Some(zip_src) = src.as_any().downcast_ref::<ZipLogSource>() {
            SourceRef::Zip(Arc::clone(zip_src.data()))
        } else {
            return Err("Unsupported source type for export".to_string());
        };
        (name, sref)
    };
    // sessions lock dropped — data copy happens outside the lock.
    let source_bytes = match source_ref {
        SourceRef::Mmap(mmap) => mmap.to_vec(),
        SourceRef::Zip(data) => data.as_ref().clone(),
    };

    // 2. Snapshot bookmarks under brief lock.
    let bookmarks = if options.include_bookmarks {
        lock_or_err(&state.bookmarks, "bookmarks")?
            .get(&session_id)
            .cloned()
            .unwrap_or_default()
    } else {
        vec![]
    };

    // 3. Snapshot analyses under brief lock.
    let analyses = if options.include_analyses {
        lock_or_err(&state.analyses, "analyses")?
            .get(&session_id)
            .cloned()
            .unwrap_or_default()
    } else {
        vec![]
    };

    // 4. Get pipeline-enabled non-builtin processor YAMLs (if requested).
    // Collect active IDs under brief lock, then read YAMLs from disk outside the lock.
    let processor_yamls: Vec<(String, String, String)> = if options.include_processors {
        let proc_ids = active_custom_processor_ids(&state, &session_id);
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

    // 5. Snapshot pipeline meta under brief lock.
    let meta: crate::workspace::lts::LtsSessionMeta =
        crate::commands::workspace_sync::snapshot_pipeline_meta(&state, &session_id).into();

    // 6. Write .lts file (no locks held).
    // TODO(WI-2): Update to v2 multi-session API.
    let dest = std::path::Path::new(&options.dest_path);
    let session_data = crate::workspace::lts::LtsSessionData {
        source_bytes,
        source_filename: source_name,
        bookmarks,
        analyses,
        session_meta: meta,
    };
    crate::workspace::lts::write_lts(dest, &[session_data], &processor_yamls)?;

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
    lts: &LtsData,
) -> Vec<String> {
    resolve_lts_processors_raw(state, app, &lts.processor_manifest, &lts.processor_yamls)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace;

    fn make_state() -> AppState {
        AppState::new()
    }

    fn set_pipeline_meta(state: &AppState, session_id: &str, active: Vec<&str>, disabled: Vec<&str>) {
        state.session_pipeline_meta.lock().unwrap().insert(
            session_id.to_string(),
            workspace::SessionMeta {
                active_processor_ids: active.into_iter().map(String::from).collect(),
                disabled_processor_ids: disabled.into_iter().map(String::from).collect(),
            },
        );
    }

    // -----------------------------------------------------------------------
    // active_custom_processor_count
    // -----------------------------------------------------------------------

    #[test]
    fn count_no_pipeline_meta_returns_zero() {
        let state = make_state();
        assert_eq!(active_custom_processor_count(&state, "sess-1"), 0);
    }

    #[test]
    fn count_empty_active_list_returns_zero() {
        let state = make_state();
        set_pipeline_meta(&state, "sess-1", vec![], vec!["proc-a"]);
        assert_eq!(active_custom_processor_count(&state, "sess-1"), 0);
    }

    #[test]
    fn count_only_builtin_active_returns_zero() {
        let state = make_state();
        set_pipeline_meta(&state, "sess-1", vec!["__pii_anonymizer", "__builtin_other"], vec![]);
        assert_eq!(active_custom_processor_count(&state, "sess-1"), 0);
    }

    #[test]
    fn count_mix_of_builtin_and_custom_active() {
        let state = make_state();
        set_pipeline_meta(
            &state,
            "sess-1",
            vec!["__pii_anonymizer", "crash-reporter", "anr-tracker"],
            vec![],
        );
        assert_eq!(active_custom_processor_count(&state, "sess-1"), 2);
    }

    #[test]
    fn count_all_custom_active() {
        let state = make_state();
        set_pipeline_meta(
            &state,
            "sess-1",
            vec!["proc-a", "proc-b", "proc-c"],
            vec![],
        );
        assert_eq!(active_custom_processor_count(&state, "sess-1"), 3);
    }

    #[test]
    fn count_ignores_other_sessions() {
        let state = make_state();
        set_pipeline_meta(&state, "sess-1", vec!["proc-a", "proc-b"], vec![]);
        set_pipeline_meta(&state, "sess-2", vec!["proc-c"], vec![]);
        assert_eq!(active_custom_processor_count(&state, "sess-1"), 2);
        assert_eq!(active_custom_processor_count(&state, "sess-2"), 1);
        assert_eq!(active_custom_processor_count(&state, "sess-3"), 0);
    }

    #[test]
    fn count_disabled_processors_excluded() {
        let state = make_state();
        // Chain has 3 processors, but 2 are disabled — only 1 should count
        set_pipeline_meta(
            &state,
            "sess-1",
            vec!["proc-a", "proc-b", "proc-c"],
            vec!["proc-b", "proc-c"],
        );
        assert_eq!(active_custom_processor_count(&state, "sess-1"), 1);
    }

    #[test]
    fn count_disabled_builtin_and_custom_mix() {
        // 7 in chain (2 builtin + 5 custom), 3 custom disabled → 2 custom remain
        let state = make_state();
        set_pipeline_meta(
            &state,
            "sess-1",
            vec!["__pii_anonymizer", "__builtin_x", "proc-a", "proc-b", "proc-c", "proc-d", "proc-e"],
            vec!["proc-c", "proc-d", "proc-e"],
        );
        assert_eq!(active_custom_processor_count(&state, "sess-1"), 2);
    }

    #[test]
    fn count_all_custom_disabled() {
        let state = make_state();
        set_pipeline_meta(
            &state,
            "sess-1",
            vec!["proc-a", "proc-b", "proc-c"],
            vec!["proc-a", "proc-b", "proc-c"],
        );
        assert_eq!(active_custom_processor_count(&state, "sess-1"), 0);
    }

    // -----------------------------------------------------------------------
    // active_custom_processor_ids
    // -----------------------------------------------------------------------

    #[test]
    fn ids_no_pipeline_meta_returns_empty() {
        let state = make_state();
        assert!(active_custom_processor_ids(&state, "sess-1").is_empty());
    }

    #[test]
    fn ids_filters_out_builtins() {
        let state = make_state();
        set_pipeline_meta(
            &state,
            "sess-1",
            vec!["__pii_anonymizer", "crash-reporter", "__builtin_x", "anr-tracker"],
            vec![],
        );
        let ids = active_custom_processor_ids(&state, "sess-1");
        assert_eq!(ids, vec!["crash-reporter", "anr-tracker"]);
    }

    #[test]
    fn ids_excludes_disabled() {
        let state = make_state();
        set_pipeline_meta(
            &state,
            "sess-1",
            vec!["proc-a", "proc-b", "proc-c"],
            vec!["proc-b"],
        );
        let ids = active_custom_processor_ids(&state, "sess-1");
        assert_eq!(ids, vec!["proc-a", "proc-c"]);
    }

    #[test]
    fn ids_empty_when_all_disabled() {
        let state = make_state();
        set_pipeline_meta(
            &state,
            "sess-1",
            vec!["proc-a", "proc-b"],
            vec!["proc-a", "proc-b"],
        );
        assert!(active_custom_processor_ids(&state, "sess-1").is_empty());
    }

    #[test]
    fn ids_filters_both_builtin_and_disabled() {
        let state = make_state();
        set_pipeline_meta(
            &state,
            "sess-1",
            vec!["__pii_anonymizer", "proc-a", "proc-b", "proc-c", "__builtin_x"],
            vec!["proc-b"],
        );
        let ids = active_custom_processor_ids(&state, "sess-1");
        assert_eq!(ids, vec!["proc-a", "proc-c"]);
    }

    #[test]
    fn ids_preserves_order() {
        let state = make_state();
        set_pipeline_meta(
            &state,
            "sess-1",
            vec!["zebra-proc", "alpha-proc", "middle-proc"],
            vec![],
        );
        let ids = active_custom_processor_ids(&state, "sess-1");
        assert_eq!(ids, vec!["zebra-proc", "alpha-proc", "middle-proc"]);
    }

    #[test]
    fn ids_scoped_to_session() {
        let state = make_state();
        set_pipeline_meta(&state, "sess-1", vec!["proc-a"], vec![]);
        set_pipeline_meta(&state, "sess-2", vec!["proc-b", "proc-c"], vec![]);

        assert_eq!(active_custom_processor_ids(&state, "sess-1"), vec!["proc-a"]);
        assert_eq!(active_custom_processor_ids(&state, "sess-2"), vec!["proc-b", "proc-c"]);
        assert!(active_custom_processor_ids(&state, "nonexistent").is_empty());
    }

    // -----------------------------------------------------------------------
    // read_processor_yaml (filesystem)
    // -----------------------------------------------------------------------

    #[test]
    fn read_processor_yaml_nonexistent_returns_none() {
        let nonexistent = std::path::Path::new("/tmp/nonexistent-logtapper-test-xyz/processors/bogus-id.yaml");
        let result = std::fs::read_to_string(nonexistent).ok();
        assert!(result.is_none());
    }
}

/// Low-level variant that accepts the processor manifest and YAML map directly.
/// Used by `load_lts_file_inner` where `LtsData` has been partially consumed.
pub fn resolve_lts_processors_raw(
    state: &AppState,
    app: &tauri::AppHandle,
    processor_manifest: &LtsProcessorManifest,
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
