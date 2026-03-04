pub mod anonymizer;
pub mod charts;
pub mod claude;
pub mod commands;
pub mod core;
pub mod mcp_bridge;
pub mod processors;
pub mod scripting;

use commands::AppState;
use processors::marketplace::{qualified_id, Source, SourceType};
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
                Ok(mut def) => {
                    // Check for provenance: if `_source` is present, reconstruct
                    // the qualified ID and set the source field.
                    if let Ok(prov) = serde_yaml::from_str::<processors::marketplace::Provenance>(yaml) {
                        if let Some(ref source) = prov.source {
                            def.source = Some(source.clone());
                            let qid = processors::marketplace::qualified_id(&def.meta.id, source);
                            procs.insert(qid, def);
                            continue;
                        }
                    }
                    procs.insert(def.meta.id.clone(), def);
                }
                Err(e) => eprintln!("Skipping {:?}: {e}", path.file_name()),
            }
        }
    }
}

/// Bundled builtin YAML content indexed by path suffix (matches marketplace_snapshot.json `path`).
const BUILTIN_YAMLS: &[(&str, &str)] = &[
    ("builtin/wifi_state.yaml",           include_str!("processors/builtin/wifi_state.yaml")),
    ("builtin/battery_state.yaml",        include_str!("processors/builtin/battery_state.yaml")),
    ("builtin/app_lifecycle.yaml",        include_str!("processors/builtin/app_lifecycle.yaml")),
    ("builtin/network_connectivity.yaml", include_str!("processors/builtin/network_connectivity.yaml")),
    ("builtin/samsung_auto_blocker.yaml", include_str!("processors/builtin/samsung_auto_blocker.yaml")),
];

/// Install the 5 state-tracker processors from the bundled snapshot as marketplace processors
/// under the "official" source. Each gets a qualified ID (`id@official`) and provenance metadata.
fn install_snapshot_processors(state: &AppState, app: &tauri::AppHandle) {
    let snapshot_json = include_str!("processors/builtin/marketplace_snapshot.json");
    let index: processors::marketplace::MarketplaceIndex = match serde_json::from_str(snapshot_json) {
        Ok(idx) => idx,
        Err(e) => {
            eprintln!("Failed to parse builtin marketplace snapshot: {e}");
            return;
        }
    };

    let Ok(data_dir) = app.path().app_data_dir() else { return };
    let proc_dir = data_dir.join("processors");
    let _ = std::fs::create_dir_all(&proc_dir);

    let Ok(mut procs) = state.processors.lock() else { return };

    for entry in &index.processors {
        // Find the bundled YAML for this entry's path
        let yaml_content = BUILTIN_YAMLS.iter().find(|(p, _)| *p == entry.path).map(|(_, c)| *c);
        let Some(raw_yaml) = yaml_content else {
            eprintln!("No bundled YAML for snapshot entry '{}' at path '{}'", entry.id, entry.path);
            continue;
        };

        // Rewrite the `id:` field to the bare marketplace ID (strip __ prefix from builtin ID)
        // and set builtin: false since this is now a marketplace processor.
        let rewritten = rewrite_yaml_for_marketplace(raw_yaml, &entry.id);

        // Attach provenance metadata (use a static placeholder; exact timestamp not critical)
        let now = "2000-01-01T00:00:00Z";
        let provenance_suffix = format!(
            "\n_source: official\n_installed_version: {}\n_installed_at: {}\n_sha256: \"\"\n",
            entry.version, now
        );
        let final_yaml = format!("{}{}", rewritten, provenance_suffix);

        match AnyProcessor::from_yaml(&final_yaml) {
            Ok(mut def) => {
                def.source = Some("official".to_string());
                let qid = qualified_id(&def.meta.id, "official");

                // Persist to disk
                let filename = processors::marketplace::id_to_filename(&qid);
                let dest = proc_dir.join(format!("{filename}.yaml"));
                if let Err(e) = std::fs::write(&dest, &final_yaml) {
                    eprintln!("Failed to persist '{}': {e}", qid);
                }

                procs.insert(qid, def);
            }
            Err(e) => eprintln!("Failed to parse snapshot processor '{}': {e}", entry.id),
        }
    }
}

/// Rewrite the `id:` and `builtin:` fields in a YAML string for marketplace use.
fn rewrite_yaml_for_marketplace(yaml: &str, new_id: &str) -> String {
    let mut lines: Vec<String> = yaml.lines().map(|l| l.to_string()).collect();
    let mut found_id = false;
    let mut found_builtin = false;

    for line in &mut lines {
        if !found_id && line.trim_start().starts_with("id:") {
            *line = format!("id: {}", new_id);
            found_id = true;
        } else if !found_builtin && line.trim_start().starts_with("builtin:") {
            *line = "builtin: false".to_string();
            found_builtin = true;
        }
    }

    if !found_builtin {
        lines.push("builtin: false".to_string());
    }

    lines.join("\n")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let data_dir = app.path().app_data_dir()?;
            let proc_dir = data_dir.join("processors");
            let sources_path = data_dir.join("sources.json");
            let state = app.state::<AppState>();

            // Load anonymizer config from disk
            let config_path = data_dir.join("anonymizer_config.json");
            if let Ok(json) = std::fs::read_to_string(&config_path) {
                if let Ok(cfg) = serde_json::from_str::<crate::anonymizer::config::AnonymizerConfig>(&json) {
                    if let Ok(mut stored) = state.anonymizer_config.lock() {
                        *stored = cfg;
                    }
                }
            }

            // Load or initialize sources
            let first_run = !sources_path.exists();
            if first_run {
                // Create the official source on first run
                let official = Source {
                    name: "official".to_string(),
                    source_type: SourceType::Local {
                        path: "__bundled__".to_string(),
                    },
                    enabled: true,
                    auto_update: false,
                    last_checked: None,
                };
                if let Ok(mut sources) = state.sources.lock() {
                    sources.push(official);
                }
                // Persist sources.json
                if let Ok(sources) = state.sources.lock() {
                    if let Ok(json) = serde_json::to_string_pretty(&*sources) {
                        let _ = std::fs::write(&sources_path, json);
                    }
                }
            } else {
                let loaded = commands::sources::load_sources(app.handle());
                if let Ok(mut sources) = state.sources.lock() {
                    *sources = loaded;
                }
            }

            // Load persisted user processors from app data directory.
            if proc_dir.exists() {
                load_persisted_processors(&state, &proc_dir);
            }

            // On first run, install the snapshot processors (that aren't already on disk).
            if first_run {
                install_snapshot_processors(&state, app.handle());
            }

            // Load the true built-in: pii_anonymizer (always present, id starts with __).
            {
                let pii_yaml = include_str!("processors/builtin/pii_anonymizer.yaml");
                if let Ok(mut procs) = state.processors.lock() {
                    match AnyProcessor::from_yaml(pii_yaml) {
                        Ok(def) => { procs.insert(def.meta.id.clone(), def); }
                        Err(e) => eprintln!("Failed to load built-in '__pii_anonymizer': {e}"),
                    }
                }
            }

            // Spawn the MCP HTTP bridge on Tauri's async runtime.
            let bridge_handle = app.handle().clone();
            tauri::async_runtime::spawn(crate::mcp_bridge::start(bridge_handle));

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
            commands::adb::save_live_capture,
            commands::files::load_log_file,
            commands::files::get_lines,
            commands::files::search_logs,
            commands::files::get_dumpstate_metadata,
            commands::files::get_sections,
            commands::files::close_session,
            commands::pipeline::run_pipeline,
            commands::pipeline::stop_pipeline,
            commands::processors::list_processors,
            commands::processors::load_processor_yaml,
            commands::processors::load_processor_from_file,
            commands::processors::get_processor_vars,
            commands::processors::get_matched_lines,
            commands::processors::uninstall_processor,
            commands::charts::get_chart_data,
            commands::charts::get_timeline_data,
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
            // Correlator query command
            commands::correlator::get_correlator_events,
            commands::session::get_mcp_status,
            commands::session::set_mcp_anonymize,
            commands::session::get_session_metadata,
            // Phase 1 — Filter commands
            commands::filter::create_filter,
            commands::filter::get_filtered_lines,
            commands::filter::cancel_filter,
            commands::filter::get_filter_info,
            commands::filter::close_filter,
            // Phase 2 — Bookmark commands
            commands::bookmark::create_bookmark,
            commands::bookmark::list_bookmarks,
            commands::bookmark::update_bookmark,
            commands::bookmark::delete_bookmark,
            // Phase 2 — Analysis commands
            commands::analysis::publish_analysis,
            commands::analysis::update_analysis,
            commands::analysis::list_analyses,
            commands::analysis::get_analysis,
            commands::analysis::delete_analysis,
            // Phase 4 — Watch commands
            commands::watch::create_watch,
            commands::watch::cancel_watch,
            commands::watch::list_watches,
            // Phase 2 Marketplace — Source management commands
            commands::sources::list_sources,
            commands::sources::add_source,
            commands::sources::remove_source,
            commands::sources::fetch_marketplace_for_source,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
