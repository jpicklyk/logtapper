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
            // Phase 2 — processor pipeline
            commands::pipeline::run_pipeline,
            commands::pipeline::stop_pipeline,
            // Phase 2 — processor management
            commands::processors::list_processors,
            commands::processors::load_processor_yaml,
            commands::processors::get_processor_vars,
            commands::processors::uninstall_processor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
