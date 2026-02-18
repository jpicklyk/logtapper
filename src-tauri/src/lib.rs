pub mod anonymizer;
pub mod charts;
pub mod claude;
pub mod commands;
pub mod core;
pub mod processors;
pub mod scripting;

use commands::AppState;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
