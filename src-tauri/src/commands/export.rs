use tauri::AppHandle;

use crate::commands::AppState;
use crate::commands::adapters::ui_ctx;
use crate::services::analyses::{self, AnalysisMarkdownOptions};
use crate::services::export::{self, ExportAllOptions, ExportAllSessionsInfo};

// ---------------------------------------------------------------------------
// Multi-session export commands — thin adapters over `services::export`
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_export_all_sessions_info(app: AppHandle) -> Result<ExportAllSessionsInfo, String> {
    let ctx = ui_ctx(&app);
    Ok(export::info(&ctx)?)
}

#[tauri::command]
pub async fn export_all_sessions(app: AppHandle, options: ExportAllOptions) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    Ok(export::run(ctx, options).await?)
}

// ---------------------------------------------------------------------------
// Analysis hand-off export — thin adapters over `services::analyses`
// ---------------------------------------------------------------------------

/// The rendered document, for the reader's **Copy**. Ui-only: there is no
/// bridge route that returns the text (see `services::analyses`' "Markdown
/// hand-off export" section).
#[tauri::command]
pub async fn render_analysis_markdown(app: AppHandle, opts: AnalysisMarkdownOptions) -> Result<String, String> {
    let ctx = ui_ctx(&app);
    Ok(analyses::render_markdown(&ctx, opts)?)
}

/// Write the rendered document to `dest_path`, for the reader's **Save as…**.
#[tauri::command]
pub async fn export_analysis_markdown(
    app: AppHandle,
    opts: AnalysisMarkdownOptions,
    dest_path: String,
) -> Result<(), String> {
    let ctx = ui_ctx(&app);
    Ok(analyses::export_markdown(ctx, opts, dest_path).await?)
}

// ---------------------------------------------------------------------------
// T7 — Resolve processors from imported .lts file
// ---------------------------------------------------------------------------
//
// Import-side helpers (not part of the `export` service — these run when a
// `.lts` file is *loaded*, not exported). Used by `commands::files`.

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

        crate::commands::lock_or_err(&state.processors, "processors")?
            .insert(scoped_id.clone(), bundled_proc);

        crate::commands::lock_or_err(&state.lts_processor_yamls, "lts_processor_yamls")?
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
        let mut yamls = std::collections::HashMap::new();
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
}
