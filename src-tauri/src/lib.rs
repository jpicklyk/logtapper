pub mod anonymizer;
pub mod charts;
pub mod claude;
pub mod commands;
pub mod core;
pub mod processors;
pub mod scripting;

use commands::AppState;
use tauri::Manager;

fn load_persisted_processors(state: &AppState, proc_dir: &std::path::Path) {
    let mut yamls: Vec<(std::path::PathBuf, String)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(proc_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "yaml") {
                if let Ok(yaml) = std::fs::read_to_string(&path) {
                    yamls.push((path, yaml));
                }
            }
        }
    }
    if let Ok(mut procs) = state.processors.lock() {
        for (path, yaml) in &yamls {
            match crate::processors::schema::ProcessorDef::from_yaml(yaml) {
                Ok(def) => { procs.insert(def.meta.id.clone(), def); }
                Err(e) => eprintln!("Skipping {:?}: {e}", path.file_name()),
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Load persisted processors from app data directory.
            let data_dir = app.path().app_data_dir()?;
            let proc_dir = data_dir.join("processors");
            if proc_dir.exists() {
                let state = app.state::<AppState>();
                load_persisted_processors(&state, &proc_dir);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ADB streaming
            commands::adb::list_adb_devices,
            commands::adb::start_adb_stream,
            commands::adb::stop_adb_stream,
            commands::adb::get_package_pids,
            // Phase 1 — file loading, viewer, search
            commands::files::load_log_file,
            commands::files::get_lines,
            commands::files::search_logs,
            commands::files::get_dumpstate_metadata,
            commands::files::get_sections,
            // Phase 2 — processor pipeline
            commands::pipeline::run_pipeline,
            commands::pipeline::stop_pipeline,
            // Phase 2 — processor management
            commands::processors::list_processors,
            commands::processors::load_processor_yaml,
            commands::processors::load_processor_from_file,
            commands::processors::get_processor_vars,
            commands::processors::get_matched_lines,
            commands::processors::uninstall_processor,
            // Phase 3 — charts
            commands::charts::get_chart_data,
            // Phase 4 — Claude AI
            commands::claude::set_claude_api_key,
            commands::claude::claude_analyze,
            commands::claude::claude_generate_processor,
            // Phase 4 — GitHub registry
            commands::processors::fetch_registry,
            commands::processors::install_from_registry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
