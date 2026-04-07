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
use tauri::{Emitter, Manager};

/// Returns true if the official source needs correction to point to `correct_path`.
/// In dev builds, the official source must always be `Local` with the right path.
#[cfg(debug_assertions)]
pub(crate) fn needs_source_correction(source_type: &SourceType, correct_path: &str) -> bool {
    match source_type {
        SourceType::Local { ref path } => path != correct_path,
        SourceType::Github { .. } => true,
    }
}

/// Resolve the dev marketplace directory path relative to the running executable.
///
/// Walks up from the executable's directory until it finds a parent containing
/// `marketplace/marketplace.json`. Skips matches inside `target/` (build output
/// copies) to prefer the project root's source-of-truth `marketplace/` directory.
///
/// Uses `simplified_path` to strip the Windows `\\?\` UNC prefix that `canonicalize()`
/// produces, which breaks string comparisons and some file read APIs.
#[cfg(debug_assertions)]
pub(crate) fn resolve_dev_marketplace_path() -> String {
    let exe_path = std::env::current_exe().unwrap_or_default();
    let mut dir = exe_path.parent();
    let mut build_output_fallback: Option<std::path::PathBuf> = None;

    for _ in 0..10 {
        let Some(d) = dir else { break };
        if d.join("marketplace").join("marketplace.json").exists() {
            let is_build_output = d.components().any(|c| c.as_os_str() == "target");
            if !is_build_output {
                return simplified_path(&d.join("marketplace")).to_string_lossy().to_string();
            }
            if build_output_fallback.is_none() {
                build_output_fallback = Some(d.join("marketplace"));
            }
        }
        dir = d.parent();
    }

    if let Some(p) = build_output_fallback {
        return simplified_path(&p).to_string_lossy().to_string();
    }

    let exe_dir = exe_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let fallback = exe_dir.join("..").join("..").join("..").join("marketplace");
    log::warn!("[marketplace] Could not find marketplace/ by walking up from exe");
    fallback.to_string_lossy().to_string()
}

/// Canonicalize a path, stripping the Windows `\\?\` extended-length prefix if present.
/// Falls back to the original path if canonicalization fails.
fn simplified_path(p: &std::path::Path) -> std::path::PathBuf {
    match p.canonicalize() {
        Ok(canonical) => {
            // On Windows, canonicalize() produces \\?\C:\... — strip the prefix
            // so the path works consistently in string comparisons and file reads.
            let s = canonical.to_string_lossy();
            if let Some(stripped) = s.strip_prefix(r"\\?\") {
                std::path::PathBuf::from(stripped)
            } else {
                canonical
            }
        }
        Err(_) => p.to_path_buf(),
    }
}

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
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Focus the existing window.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }

            // Extract file path from args (skip binary name, skip flags).
            if let Some(path) = args.iter().skip(1).find(|a| !a.starts_with('-')) {
                let _ = app.emit("open-file", path.clone());
            }
        }))
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
            // In dev builds, resolve relative to the running executable so the path
            // is machine-independent. The exe lives at src-tauri/target/debug/ so
            // ../../../marketplace reaches the project root's marketplace/ directory.
            // Load or initialize sources
            let first_run = !sources_path.exists();
            if first_run {
                // In debug builds, use local marketplace directory for instant iteration.
                // In release builds, use GitHub so users always get the latest.
                #[cfg(debug_assertions)]
                let official_source_type = {
                    let marketplace_path = resolve_dev_marketplace_path();
                    SourceType::Local {
                        path: marketplace_path,
                    }
                };
                #[cfg(not(debug_assertions))]
                let official_source_type = SourceType::Github {
                    repo: "jpicklyk/logtapper".to_string(),
                    git_ref: "main".to_string(),
                };
                let official = Source {
                    name: "official".to_string(),
                    source_type: official_source_type,
                    enabled: true,
                    auto_update: false,
                    last_checked: None,
                };
                let json_to_write = {
                    let mut sources = state.sources.lock().unwrap();
                    sources.push(official);
                    serde_json::to_string_pretty(&*sources).ok()
                };
                if let Some(json) = json_to_write {
                    let _ = std::fs::write(&sources_path, json);
                }
            } else {
                let loaded = commands::sources::load_sources(app.handle());
                if let Ok(mut sources) = state.sources.lock() {
                    *sources = loaded;
                }

                // Dev: force official source to Local pointing at project root marketplace/.
                // Handles stale paths and Github sources left by release builds.
                #[cfg(debug_assertions)]
                {
                    let correct_path = resolve_dev_marketplace_path();
                    let json_to_write = if let Ok(mut sources) = state.sources.lock() {
                        let mut fixed = false;
                        for source in sources.iter_mut() {
                            if source.name == "official" && needs_source_correction(&source.source_type, &correct_path) {
                                log::info!("[marketplace] Auto-correcting official source to Local: {correct_path}");
                                source.source_type = SourceType::Local { path: correct_path.clone() };
                                fixed = true;
                            }
                        }
                        if fixed { serde_json::to_string_pretty(&*sources).ok() } else { None }
                    } else {
                        None
                    };
                    if let Some(json) = json_to_write {
                        let _ = std::fs::write(&sources_path, json);
                    }
                }

                // Release: migrate legacy local official sources to GitHub.
                #[cfg(not(debug_assertions))]
                {
                    let json_to_write = if let Ok(mut sources) = state.sources.lock() {
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
                        if migrated { serde_json::to_string_pretty(&*sources).ok() } else { None }
                    } else {
                        None
                    };
                    if let Some(json) = json_to_write {
                        let _ = std::fs::write(&sources_path, json);
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

            // Spawn background startup update check (non-blocking).
            // Checks enabled sources for newer processor versions.
            // If auto_update is enabled for a source, applies updates silently.
            // Results are stored in AppState::pending_updates for the UI to query.
            if !first_run {
                let update_handle = app.handle().clone();
                tauri::async_runtime::spawn(startup_update_check(update_handle));
            }

            // Capture file path passed via CLI args (e.g. double-click file association).
            let startup_path: Option<String> = std::env::args()
                .skip(1)
                .find(|a| !a.starts_with('-'));
            if let Some(path) = startup_path {
                if let Ok(mut sp) = state.startup_file_path.lock() {
                    *sp = Some(path);
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
            commands::adb::save_live_capture,
            commands::files::load_log_file,
            commands::files::get_lines,
            commands::files::search_logs,
            commands::files::get_dumpstate_metadata,
            commands::files::get_sections,
            commands::files::close_session,
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::files::get_startup_file,
            // File association management (Windows registry)
            commands::file_associations::get_file_association_status,
            commands::file_associations::set_file_association,
            commands::file_associations::open_default_apps_settings,
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
            // Export commands
            commands::export::get_export_all_sessions_info,
            commands::export::export_all_sessions,
            // Workspace v4 commands
            commands::workspace_cmd::save_workspace_v4,
            commands::workspace_cmd::load_workspace_v4,
            commands::workspace_cmd::get_app_state,
            commands::workspace_cmd::save_app_state_cmd,
            // MCP bridge control
            commands::mcp::start_mcp_bridge,
            commands::mcp::stop_mcp_bridge,
        ])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::Exit => {
                    commands::workspace_sync::flush_all_workspaces(app_handle);
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    // macOS sends file paths as file:// URLs via this event.
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            if let Some(path_str) = path.to_str() {
                                let _ = app_handle.emit("open-file", path_str.to_string());
                            }
                        }
                    }
                }
                _ => {}
            }
        });
}
