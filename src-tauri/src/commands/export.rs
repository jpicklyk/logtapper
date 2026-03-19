use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::{lock_or_err, AppState};
use crate::core::log_source::{FileLogSource, ZipLogSource};

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
// T5 — Export session info command
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProcessorEntry {
    pub id: String,
    pub name: String,
    pub builtin: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionInfo {
    pub source_filename: String,
    pub source_size: u64,
    pub bookmark_count: usize,
    pub analysis_count: usize,
    pub processors: Vec<ExportProcessorEntry>,
}

#[tauri::command]
pub async fn get_export_session_info(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ExportSessionInfo, String> {
    // Read source info under brief lock.
    let (source_filename, source_size) = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let src = session
            .primary_source()
            .ok_or("No source in session")?;
        let name = src.name().to_string();
        // Derive size from line_index sentinel (last entry = total bytes) for file sources,
        // or from data.len() for zip sources.
        let size = if let Some(file_src) = src.as_any().downcast_ref::<FileLogSource>() {
            file_src.line_index().last().copied().unwrap_or(0)
        } else if let Some(zip_src) = src.as_any().downcast_ref::<ZipLogSource>() {
            zip_src.data().len() as u64
        } else {
            0
        };
        (name, size)
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

    // Processor list under brief lock.
    let processors = {
        let procs = lock_or_err(&state.processors, "processors")?;
        procs
            .iter()
            .map(|(id, proc)| ExportProcessorEntry {
                id: id.clone(),
                name: proc.meta.name.clone(),
                builtin: id.starts_with("__"),
            })
            .collect()
    };

    Ok(ExportSessionInfo {
        source_filename,
        source_size,
        bookmark_count,
        analysis_count,
        processors,
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
}

#[tauri::command]
pub async fn export_session(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    options: ExportOptions,
) -> Result<(), String> {
    // 1. Snapshot source data under brief lock.
    let (source_name, source_bytes) = {
        let sessions = lock_or_err(&state.sessions, "sessions")?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let src = session
            .primary_source()
            .ok_or("No source in session")?;
        let name = src.name().to_string();
        let bytes = if let Some(file_src) = src.as_any().downcast_ref::<FileLogSource>() {
            file_src.mmap().to_vec()
        } else if let Some(zip_src) = src.as_any().downcast_ref::<ZipLogSource>() {
            zip_src.data().as_ref().clone()
        } else {
            return Err("Unsupported source type for export".to_string());
        };
        (name, bytes)
    };
    // sessions lock dropped

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

    // 4. Get non-builtin processor YAMLs under brief lock.
    let processor_yamls: Vec<(String, String, String)> = {
        let processors = lock_or_err(&state.processors, "processors")?;
        processors
            .iter()
            .filter(|(id, _)| !id.starts_with("__"))
            .filter_map(|(id, _proc)| {
                let yaml = read_processor_yaml(&app, id)?;
                let filename = crate::processors::marketplace::id_to_filename(id);
                Some((id.clone(), format!("{filename}.yaml"), yaml))
            })
            .collect()
    };
    // processors lock dropped

    // 5. Write .lts file (no locks held).
    let meta = crate::workspace::lts::LtsSessionMeta::default();
    let dest = std::path::Path::new(&options.dest_path);
    crate::workspace::lts::write_lts(
        dest,
        &source_name,
        &source_bytes,
        &bookmarks,
        &analyses,
        &meta,
        &processor_yamls,
    )?;

    Ok(())
}
