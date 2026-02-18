pub mod commands;
pub mod core;
pub mod anonymizer;
pub mod processors;
pub mod scripting;
pub mod claude;
pub mod charts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            // Phase 1 — File / Session
            commands::files::load_log_file,
            commands::files::get_lines,
            commands::files::search_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
