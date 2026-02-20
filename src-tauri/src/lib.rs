pub mod anonymizer;
pub mod charts;
pub mod claude;
pub mod commands;
pub mod core;
pub mod mcp_bridge;
pub mod processors;
pub mod scripting;

use commands::AppState;
use processors::AnyProcessor;
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
            match AnyProcessor::from_yaml(yaml) {
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

            // Load persisted user processors from app data directory.
            let data_dir = app.path().app_data_dir()?;
            let proc_dir = data_dir.join("processors");
            let state = app.state::<AppState>();
            if proc_dir.exists() {
                load_persisted_processors(&state, &proc_dir);
            }

            // Load anonymizer config from disk
            let config_path = data_dir.join("anonymizer_config.json");
            if let Ok(json) = std::fs::read_to_string(&config_path) {
                if let Ok(cfg) = serde_json::from_str::<crate::anonymizer::config::AnonymizerConfig>(&json) {
                    if let Ok(mut stored) = state.anonymizer_config.lock() {
                        *stored = cfg;
                    }
                }
            }

            // Spawn the MCP HTTP bridge on Tauri's async runtime.
            // Must use tauri::async_runtime::spawn — tokio::spawn panics here
            // because the setup callback runs before the raw tokio reactor is
            // exposed to callers directly.
            let bridge_handle = app.handle().clone();
            tauri::async_runtime::spawn(crate::mcp_bridge::start(bridge_handle));

            // Load built-in processors compiled into the binary.
            let builtins: &[(&str, &str)] = &[
                ("pii_anonymizer",       include_str!("processors/builtin/pii_anonymizer.yaml")),
                ("wifi_state",           include_str!("processors/builtin/wifi_state.yaml")),
                ("battery_state",        include_str!("processors/builtin/battery_state.yaml")),
                ("app_lifecycle",        include_str!("processors/builtin/app_lifecycle.yaml")),
                ("network_connectivity", include_str!("processors/builtin/network_connectivity.yaml")),
            ];
            if let Ok(mut procs) = state.processors.lock() {
                for (name, yaml) in builtins {
                    match AnyProcessor::from_yaml(yaml) {
                        Ok(def) => { procs.insert(def.meta.id.clone(), def); }
                        Err(e) => eprintln!("Failed to load built-in '{}': {e}", name),
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::adb::list_adb_devices,
            commands::adb::start_adb_stream,
            commands::adb::stop_adb_stream,
            commands::adb::set_stream_anonymize,
            commands::adb::update_stream_processors,
            commands::adb::update_stream_trackers,
            commands::adb::update_stream_transformers,
            commands::adb::get_package_pids,
            commands::files::load_log_file,
            commands::files::get_lines,
            commands::files::search_logs,
            commands::files::get_dumpstate_metadata,
            commands::files::get_sections,
            commands::pipeline::run_pipeline,
            commands::pipeline::stop_pipeline,
            commands::processors::list_processors,
            commands::processors::load_processor_yaml,
            commands::processors::load_processor_from_file,
            commands::processors::get_processor_vars,
            commands::processors::get_matched_lines,
            commands::processors::uninstall_processor,
            commands::charts::get_chart_data,
            commands::claude::set_claude_api_key,
            commands::claude::claude_analyze,
            commands::claude::claude_generate_processor,
            commands::processors::fetch_registry,
            commands::processors::install_from_registry,
            commands::anonymizer::get_anonymizer_config,
            commands::anonymizer::set_anonymizer_config,
            commands::anonymizer::test_anonymizer,
            commands::anonymizer::get_pii_mappings,
            // W1C -- StateTracker query commands
            commands::state_tracker::get_state_at_line,
            commands::state_tracker::get_state_transitions,
            commands::state_tracker::get_all_transition_lines,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
