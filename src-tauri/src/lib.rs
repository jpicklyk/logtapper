pub mod anonymizer;
pub mod charts;
pub mod claude;
pub mod commands;
pub mod core;
pub mod mcp_bridge;
pub mod processors;
pub mod scripting;
pub mod workspace;

use commands::AppState;
use processors::marketplace::{Source, SourceType};
use processors::registry;
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


/// Background startup update check.
/// Fetches marketplace indices for enabled sources, compares versions,
/// auto-applies updates for sources with auto_update=true, and stores
/// pending updates for the UI to show badges.
async fn startup_update_check(handle: tauri::AppHandle) {
    use processors::marketplace;

    let state = handle.state::<AppState>();

    // Snapshot sources and installed processors.
    let sources: Vec<Source> = {
        let Ok(s) = state.sources.lock() else { return };
        s.iter().filter(|s| s.enabled).cloned().collect()
    };
    let installed: std::collections::HashMap<String, String> = {
        let Ok(procs) = state.processors.lock() else { return };
        procs.iter()
            .filter_map(|(qid, p)| {
                p.source.as_ref().map(|_| (qid.clone(), p.meta.version.clone()))
            })
            .collect()
    };

    let mut pending = Vec::new();

    for source in &sources {
        let Ok(index) = registry::fetch_marketplace(&state.http_client, source).await else {
            continue;
        };

        for entry in &index.processors {
            let qid = marketplace::qualified_id(&entry.id, &source.name);
            let Some(inst_ver) = installed.get(&qid) else { continue };

            if !commands::sources::is_newer(inst_ver, &entry.version) { continue; }

            if source.auto_update {
                // Auto-apply silently.
                if let Ok(yaml) = registry::download_processor_from_source(
                    &state.http_client, source, entry
                ).await {
                    let final_yaml = format!("{}{}", yaml, commands::sources::build_provenance_yaml(&source.name, &entry.version, &entry.sha256));
                    if let Ok(mut def) = AnyProcessor::from_yaml(&final_yaml) {
                        def.source = Some(source.name.clone());
                        // Persist to disk.
                        if let Ok(data_dir) = handle.path().app_data_dir() {
                            let proc_dir = data_dir.join("processors");
                            let _ = std::fs::create_dir_all(&proc_dir);
                            let filename = marketplace::id_to_filename(&qid);
                            let _ = std::fs::write(proc_dir.join(format!("{filename}.yaml")), &final_yaml);
                        }
                        if let Ok(mut procs) = state.processors.lock() {
                            procs.insert(qid.clone(), def);
                        }
                        eprintln!("Auto-updated {} from {} to {}", qid, inst_ver, entry.version);
                    }
                }
            } else {
                // Store as pending update for UI badge.
                pending.push(commands::sources::UpdateAvailable {
                    processor_id: qid,
                    processor_name: entry.name.clone(),
                    source_name: source.name.clone(),
                    installed_version: inst_ver.clone(),
                    available_version: entry.version.clone(),
                    entry: commands::sources::MarketplaceEntryDto::from(entry.clone()),
                });
            }
        }

        // Update last_checked.
        if let Ok(mut srcs) = state.sources.lock() {
            if let Some(s) = srcs.iter_mut().find(|s| s.name == source.name) {
                s.last_checked = Some(commands::sources::chrono_now_iso());
            }
        }
    }

    // Store pending updates.
    if !pending.is_empty() {
        if let Ok(mut pu) = state.pending_updates.lock() {
            *pu = pending;
        }
    }

    // Persist updated sources (last_checked timestamps).
    if let Ok(sources) = state.sources.lock() {
        if let Ok(json) = serde_json::to_string_pretty(&*sources) {
            if let Ok(data_dir) = handle.path().app_data_dir() {
                let _ = std::fs::write(data_dir.join("sources.json"), json);
            }
        }
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Configure window decorations per platform.
            // Windows/Linux: remove native title bar — the frontend renders custom controls.
            // macOS: overlay traffic lights over our content.
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    use tauri::TitleBarStyle;
                    let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = window.set_decorations(false);
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let data_dir = app.path().app_data_dir()?;
            let proc_dir = data_dir.join("processors");
            let packs_dir = data_dir.join("packs");
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

            // Resolve the marketplace directory path.
            // In dev mode, resource_dir() points to src-tauri/ so ../marketplace
            // Load or initialize sources
            let first_run = !sources_path.exists();
            if first_run {
                // In debug builds, use local marketplace directory for instant iteration.
                // In release builds, use GitHub so users always get the latest.
                let official_source_type = if cfg!(debug_assertions) {
                    // In dev, resolve from the project root's marketplace/ directory.
                    // Cargo sets CARGO_MANIFEST_DIR at compile time to src-tauri/.
                    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap_or(std::path::Path::new("."));
                    let marketplace_dir = project_root.join("marketplace");
                    SourceType::Local {
                        path: marketplace_dir.to_string_lossy().to_string(),
                    }
                } else {
                    SourceType::Github {
                        repo: "jpicklyk/logtapper".to_string(),
                        git_ref: "main".to_string(),
                    }
                };
                let official = Source {
                    name: "official".to_string(),
                    source_type: official_source_type,
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

                // Migrate legacy local official sources to GitHub
                if let Ok(mut sources) = state.sources.lock() {
                    let mut migrated = false;
                    for source in sources.iter_mut() {
                        if source.name == "official" {
                            if let SourceType::Local { .. } = source.source_type {
                                source.source_type = SourceType::Github {
                                    repo: "jpicklyk/logtapper".to_string(),
                                    git_ref: "main".to_string(),
                                };
                                migrated = true;
                            }
                        }
                    }
                    if migrated {
                        if let Ok(json) = serde_json::to_string_pretty(&*sources) {
                            let _ = std::fs::write(&sources_path, json);
                        }
                    }
                }
            }

            // Load persisted user processors from app data directory.
            if proc_dir.exists() {
                load_persisted_processors(&state, &proc_dir);
            }

            // Load persisted packs from app data directory.
            let _ = std::fs::create_dir_all(&packs_dir);
            {
                let loaded_packs = processors::pack::load_packs_from_dir(&packs_dir);
                if let Ok(mut packs) = state.packs.lock() {
                    *packs = loaded_packs;
                }
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

            // Spawn background startup update check (non-blocking).
            // Checks enabled sources for newer processor versions.
            // If auto_update is enabled for a source, applies updates silently.
            // Results are stored in AppState::pending_updates for the UI to query.
            if !first_run {
                let update_handle = app.handle().clone();
                tauri::async_runtime::spawn(startup_update_check(update_handle));
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
            commands::adb::save_live_capture,
            commands::files::load_log_file,
            commands::files::get_lines,
            commands::files::search_logs,
            commands::files::get_dumpstate_metadata,
            commands::files::get_sections,
            commands::files::close_session,
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::pipeline::run_pipeline,
            commands::pipeline::stop_pipeline,
            commands::processors::list_processors,
            commands::processors::load_processor_yaml,
            commands::processors::load_processor_from_file,
            commands::processors::get_processor_vars,
            commands::processors::get_matched_lines,
            commands::processors::uninstall_processor,
            commands::processors::list_packs,
            commands::processors::install_pack_from_yaml,
            commands::processors::uninstall_pack,
            commands::processors::load_pack_from_file,
            commands::charts::get_chart_data,
            commands::charts::get_timeline_data,
            commands::claude::set_claude_api_key,
            commands::claude::claude_analyze,
            commands::claude::claude_generate_processor,
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
            // Phase 4 — Update engine commands
            commands::sources::check_updates,
            commands::sources::update_processor,
            commands::sources::update_all_from_source,
            commands::sources::save_sources_to_disk,
            commands::sources::get_pending_updates,
            commands::sources::install_from_marketplace,
            commands::sources::install_pack_from_marketplace,
            commands::sources::uninstall_pack_from_marketplace,
            // Pipeline meta (workspace persistence)
            commands::pipeline::set_session_pipeline_meta,
            // Export commands (T4 + T5)
            commands::export::get_export_session_info,
            commands::export::export_session,
        ])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                commands::workspace_sync::flush_all_workspaces(app_handle);
            }
        });
}
