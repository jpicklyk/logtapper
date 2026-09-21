pub mod anonymizer;
pub mod charts;
pub mod claude;
pub mod commands;
pub mod core;
pub mod mcp_bridge;
pub mod processors;
pub mod scripting;
pub mod services;
pub mod webview_guard;
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
pub(crate) fn simplified_path(p: &std::path::Path) -> std::path::PathBuf {
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
                        def.installed_by = prov.installed_by.clone();
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

    let state = handle.state::<std::sync::Arc<AppState>>();

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
    let installed_packs: std::collections::HashMap<String, (String, Vec<String>)> = {
        let Ok(packs) = state.packs.lock() else { return };
        packs
            .iter()
            .map(|p| (p.id.clone(), (p.version.clone(), p.processors.clone())))
            .collect()
    };

    let mut pending = Vec::new();
    let mut pending_packs = Vec::new();
    let mut auto_applied: Vec<String> = Vec::new();

    for source in &sources {
        let Ok(index) = registry::fetch_marketplace(&state.http_client, source).await else {
            continue;
        };

        for entry in &index.processors {
            let qid = marketplace::qualified_id(&entry.id, &source.name);
            let Some(inst_ver) = installed.get(&qid) else { continue };

            if !commands::sources::is_newer(inst_ver, &entry.version) { continue; }

            if source.auto_update {
                // Auto-apply silently. This is a version bump, not a fresh
                // install initiated by anyone — carry forward whatever
                // `installed_by` the processor already had (`None` if it
                // predates that field) rather than attributing it to a caller.
                let existing_installed_by = state.processors.lock().ok()
                    .and_then(|procs| procs.get(&qid).and_then(|p| p.installed_by.clone()));
                if let Ok(yaml) = registry::download_processor_from_source(
                    &state.http_client, source, entry
                ).await {
                    let final_yaml = format!("{}{}", yaml, commands::sources::build_provenance_yaml(&source.name, &entry.version, &entry.sha256, existing_installed_by.as_deref()));
                    if let Ok(mut def) = AnyProcessor::from_yaml(&final_yaml) {
                        def.source = Some(source.name.clone());
                        def.installed_by = existing_installed_by.clone();
                        // Persist to disk. `qid` is a qualified `id@source` string
                        // assembled from the marketplace index, not validated by
                        // validate_processor_id() directly — persist_processor()
                        // re-checks the resulting filename before writing.
                        if let Err(e) = commands::processors::persist_processor(&handle, &qid, &final_yaml) {
                            eprintln!("Skipping auto-update for {qid}: {e}");
                            continue;
                        }
                        if let Ok(mut procs) = state.processors.lock() {
                            procs.insert(qid.clone(), def);
                        }
                        eprintln!("Auto-updated {} from {} to {}", qid, inst_ver, entry.version);
                        auto_applied.push(qid.clone());
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

        pending_packs.extend(commands::sources::detect_pack_updates(
            &installed_packs,
            &index.packs,
            &source.name,
        ));

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
            *pu = pending.clone();
        }
    }

    // Store pending pack updates.
    if !pending_packs.is_empty() {
        if let Ok(mut ppu) = state.pending_pack_updates.lock() {
            *ppu = pending_packs.clone();
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

    // Tell the UI what happened — after every lock above has dropped. The
    // pending half drives the startup "Update all" prompt; the auto-applied
    // half changed the installed catalog without any caller, so it also
    // rides the same `catalog-update` every other install/update emits (the
    // frontend seeds pending lists at construction too, in case this task
    // finishes before the window has subscribed).
    if !auto_applied.is_empty() {
        services::processors::emit_catalog_update(
            &commands::adapters::ui_ctx(&handle),
            "update",
            auto_applied.clone(),
        );
    }
    if !pending.is_empty() || !pending_packs.is_empty() || !auto_applied.is_empty() {
        let _ = handle.emit(
            services::marketplace::UPDATES_AVAILABLE_EVENT,
            services::marketplace::UpdatesAvailableEvent { updates: pending, pack_updates: pending_packs, auto_applied },
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(std::sync::Arc::new(AppState::new()))
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
        // Opening http/https/mailto links from markdown prose in the OS default
        // handler. Scoped to `opener:allow-open-url` in capabilities/default.json.
        .plugin(tauri_plugin_opener::init())
        // …and the other half of that: the webview itself may never follow such
        // a link. See webview_guard.rs for why a chrome-less window makes this
        // unrecoverable rather than merely surprising.
        .plugin(webview_guard::plugin())
        // In-app updates (Settings > General). The frontend drives check/install
        // through the plugin's own JS API under `updater:default`; nothing here
        // touches raw log text or any agent gate.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            let state = app.state::<std::sync::Arc<AppState>>();

            // Sweep orphaned ADB-stream spill files left by a previous run.
            // Stream sessions are in-memory only and never persisted to `.ltw`
            // (collect_session_data skips sessions without a file_path), so any
            // `logtapper-spill-*.tmp` present at startup is an orphan from a
            // crash / force-kill whose `SpillFile::drop` never ran. Nothing holds
            // these files at startup, so they can be safely deleted.
            let swept = crate::core::log_source::sweep_orphaned_spill_files(&data_dir);
            if swept > 0 {
                log::info!("[startup] removed {swept} orphaned spill file(s)");
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

            // Load the MCP open-file allowlist from disk (default-deny: stays
            // empty on a missing or corrupt file). Gates the
            // `logtapper_open_file` MCP bridge endpoint — see
            // commands/bridge_access.rs.
            let mcp_allowlist_path = data_dir.join("mcp_open_allowlist.json");
            if let Ok(json) = std::fs::read_to_string(&mcp_allowlist_path) {
                match serde_json::from_str::<commands::bridge_access::McpOpenAllowlist>(&json) {
                    Ok(cfg) => {
                        if let Ok(mut stored) = state.mcp_open_allowlist.lock() {
                            *stored = cfg;
                        }
                    }
                    Err(e) => eprintln!("Failed to parse mcp_open_allowlist.json: {e}"),
                }
            }

            // Load the persisted agent raw-access opt-out (fails closed: a
            // missing or corrupt file leaves agents anonymized). The ONLY
            // writer is `set_agent_raw_access`, a Ui-only Tauri command —
            // nothing an agent or a pipeline chain does can flip it.
            let agent_access_path = data_dir.join(crate::services::settings::AGENT_ACCESS_FILE);
            if let Ok(json) = std::fs::read_to_string(&agent_access_path) {
                match serde_json::from_str::<crate::services::settings::AgentAccessFile>(&json) {
                    Ok(cfg) => {
                        if let Ok(mut stored) = state.agent_raw_access.lock() {
                            *stored = cfg.agent_raw_access;
                        }
                    }
                    Err(e) => eprintln!("Failed to parse mcp_agent_access.json: {e}"),
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
                let json_to_write = if let Ok(mut sources) = state.sources.lock() {
                    sources.push(official);
                    serde_json::to_string_pretty(&*sources).ok()
                } else {
                    None
                };
                if let Some(json) = json_to_write {
                    if let Err(e) = std::fs::write(&sources_path, json) {
                        eprintln!("Failed to write sources.json: {e}");
                    }
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

            // Q4 — spawn the background auto-save scheduler and store its sender
            // so any handler (Tauri command or MCP bridge) can schedule a durable
            // flush after mutating AppState.
            let autosave_tx = workspace::autosave::spawn_scheduler(app.handle().clone());
            if let Ok(mut tx) = state.autosave_tx.lock() {
                *tx = Some(autosave_tx);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::adb::list_adb_devices,
            commands::adb::start_adb_stream,
            commands::adb::stop_adb_stream,
            commands::adb::update_stream_processors,
            commands::adb::update_stream_trackers,
            commands::adb::update_stream_transformers,
            commands::adb::get_package_pids,
            commands::adb::save_live_capture,
            commands::adb::get_stream_status,
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
            commands::anonymizer::anonymize_text,
            commands::anonymizer::get_pii_mappings,
            commands::anonymizer::get_agent_raw_access,
            commands::anonymizer::set_agent_raw_access,
            // MCP bridge open-file allowlist (gates the logtapper_open_file endpoint)
            commands::bridge_access::get_mcp_open_allowlist,
            commands::bridge_access::set_mcp_open_allowlist,
            // W1C -- StateTracker query commands
            commands::state_tracker::get_state_at_line,
            commands::state_tracker::get_state_transitions,
            commands::state_tracker::get_all_transition_lines,
            // Correlator query command
            commands::correlator::get_correlator_events,
            commands::session::get_mcp_status,
            commands::session::get_session_metadata,
            commands::session::set_focused_session,
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
            commands::analysis::set_workspace_analyses,
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
            commands::sources::get_pending_pack_updates,
            commands::sources::install_from_marketplace,
            commands::sources::install_pack_from_marketplace,
            commands::sources::uninstall_pack_from_marketplace,
            // Pipeline meta (workspace persistence)
            commands::pipeline::set_session_pipeline_meta,
            commands::pipeline::get_session_chain,
            // Export commands
            commands::export::get_export_all_sessions_info,
            commands::export::export_all_sessions,
            commands::export::render_analysis_markdown,
            commands::export::export_analysis_markdown,
            // Workspace v4 commands
            commands::workspace_cmd::save_workspace_v4,
            commands::workspace_cmd::auto_save_workspace,
            commands::workspace_cmd::sync_workspace_envelope,
            commands::workspace_cmd::begin_workspace_switch,
            commands::workspace_cmd::load_workspace_v4,
            commands::workspace_cmd::restore_workspace_session,
            commands::workspace_cmd::get_app_state,
            commands::workspace_cmd::save_app_state_cmd,
            // MCP bridge control
            // Shared activity feed (UI + agent actions)
            commands::activity::get_activity,
            commands::mcp::get_mcp_sidecar_path,
            commands::mcp::get_mcp_bundle_path,
            commands::mcp::open_mcp_bundle,
            commands::mcp::save_mcp_bundle,
            commands::mcp::start_mcp_bridge,
            commands::mcp::stop_mcp_bridge,
            commands::mcp::get_mcp_http_info,
            commands::mcp::set_mcp_http_port,
            // Shared focus context + agent navigation requests (B1)
            commands::focus::set_focus,
            commands::focus::get_focus,
            commands::navigation::request_navigation,
            // User theme storage (B2)
            commands::themes::list_themes,
            commands::themes::read_theme,
            commands::themes::write_theme,
            commands::themes::delete_theme,
            // Workspace rename/delete (B3)
            commands::workspace_cmd::rename_workspace,
            commands::workspace_cmd::delete_workspace,
        ])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|#[allow(unused_variables)] app_handle, event| {
            match event {
                tauri::RunEvent::Exit => {
                    // Q5 — the async auto-save scheduler's debounce window (up
                    // to DEBOUNCE_MS) dies with the tokio runtime on exit, so
                    // any mutation scheduled in that window and not yet
                    // flushed would otherwise be lost. `RunEvent::Exit` (not
                    // `ExitRequested`, which can be vetoed) is the final exit
                    // path, so this fires exactly once for a real quit.
                    let state = app_handle.state::<std::sync::Arc<AppState>>();
                    if workspace::autosave::has_pending_flush(&state) {
                        log::info!("[autosave] pending mutation(s) on exit; flushing synchronously");
                        workspace::autosave::flush_now_blocking(app_handle);
                    }
                    // The HTTP MCP sidecar has its own parent-pid watchdog, but
                    // a clean quit should not leave it to notice on its own.
                    commands::mcp::stop_mcp_http_server(&state);
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

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // B2: startup provenance recovery (`load_persisted_processors`)
    // -----------------------------------------------------------------------

    #[test]
    fn load_persisted_processors_with_no_installed_by_loads_as_none() {
        // A processor YAML persisted before `_installed_by` existed must
        // still load — with `installed_by: None`, not an error.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("legacy.yaml"),
            "meta:\n  id: legacy\n  name: Legacy\n  version: 1.0.0\n",
        )
        .unwrap();
        let state = AppState::new();
        load_persisted_processors(&state, dir.path());
        let procs = state.processors.lock().unwrap();
        assert_eq!(procs.get("legacy").unwrap().installed_by, None);
    }

    #[test]
    fn load_persisted_processors_recovers_installed_by_from_provenance() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("wifi.yaml"),
            "meta:\n  id: wifi-state\n  name: WiFi\n  version: 1.0.0\n_source: official\n_installed_by: agent:claude\n",
        )
        .unwrap();
        let state = AppState::new();
        load_persisted_processors(&state, dir.path());
        let procs = state.processors.lock().unwrap();
        let p = procs.get("wifi-state@official").expect("qualified by _source");
        assert_eq!(p.installed_by.as_deref(), Some("agent:claude"));
    }
}
