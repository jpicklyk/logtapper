//! HTTP bridge for the LogTapper MCP server.
//!
//! A TypeScript MCP server process (stdio transport) talks to Claude Code/Desktop.
//! That process queries THIS local HTTP server on `127.0.0.1:40404` to read live
//! AppState data — sessions, sampled log lines, and state-tracker events.
//!
//! Lock discipline: acquire a Mutex, copy/clone the data needed, drop the lock,
//! THEN build the JSON response. Never hold a lock across an `.await`.
//!
//! The route table itself is split by domain under `routes/` — see
//! [`router`] for the wiring and the append-only contract.

mod middleware;
mod respond;
mod routes;

use std::sync::Arc;

use axum::{
    Router,
    middleware as axum_middleware,
    routing::{delete, get, post},
};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::AppState;
use crate::services::{AppPaths, Caller, EventSink, ServiceCtx, Spawner};

use routes::activity::h_activity;
use routes::artifacts::{
    h_create_bookmark, h_delete_analysis, h_delete_analysis_scoped, h_delete_bookmark,
    h_get_analysis, h_get_analysis_scoped, h_list_all_analyses, h_list_analyses,
    h_list_bookmarks, h_publish_analysis, h_publish_workspace_analysis, h_update_analysis,
    h_update_analysis_scoped, h_update_bookmark,
};
use routes::filters::{h_cancel_filter, h_close_filter, h_create_filter, h_filter_info, h_filter_lines};
use routes::insights::h_insights;
use routes::lines::{h_lines_around, h_query, h_tag_stats};
use routes::pipeline::{h_pipeline, h_processor_detail, h_run_pipeline};
use routes::processors::{h_processor_defs_list, h_processor_defs_single};
use routes::search::{h_search, h_search_with_context};
use routes::sessions::{h_close_session, h_metadata, h_open_file, h_sessions, h_status};
use routes::settings::{h_get_anonymizer_config, h_get_open_allowlist, h_test_anonymizer};
use routes::tracker::{h_correlations, h_events, h_section_at, h_sections, h_state_at_line};
use routes::watches::{h_cancel_watch, h_create_watch, h_list_watches};
use routes::workspace::{
    h_autosave_workspace, h_current_workspace, h_list_workspaces, h_load_workspace,
    h_save_workspace,
};

pub const PORT: u16 = 40404;

/// Router state for every bridge handler.
///
/// Replaces the bare `AppHandle` the router used to carry. Handlers reach
/// state through `ctx.state` and notify the frontend through `ctx.events`
/// instead of resolving them out of a Tauri handle, which is what lets
/// [`router`] be built (and driven with `tower::ServiceExt::oneshot`) without a
/// live webview.
///
/// No longer carries a Tauri handle at all. It originally covered four call
/// sites that took an `AppHandle` directly — `files::open_file_inner`,
/// `files::close_session_inner`, the bookmark/analysis mutation handlers (the
/// former `artifact_mutations::*`), and `pipeline::execute_pipeline` — all of
/// which have since converted to `ServiceCtx` (WP-4, WP-5, WP-6). Nothing may
/// reintroduce it: reach for `state`, `events`, `paths` or `spawner` instead.
#[derive(Clone)]
pub struct BridgeCtx {
    pub state: Arc<AppState>,
    pub events: Arc<dyn EventSink>,
    pub paths: Arc<dyn AppPaths>,
    pub spawner: Arc<dyn Spawner>,
}

impl BridgeCtx {
    /// Assemble a bridge context from a live `AppHandle`. Called once, by
    /// `commands::mcp::start_mcp_bridge`. The handle itself is not retained —
    /// only what the three adapter types built from it here need.
    pub fn new(app: AppHandle<Wry>) -> Self {
        Self {
            state: Arc::clone(&*app.state::<Arc<AppState>>()),
            events: Arc::new(crate::commands::adapters::TauriSink::new(app.clone())),
            paths: Arc::new(crate::commands::adapters::TauriPaths::new(app.clone())),
            spawner: Arc::new(crate::commands::adapters::TauriSpawner),
        }
    }

    /// Assemble a bridge context from already-built parts, with no Tauri
    /// handle. Used by in-process router tests (`tests/bridge_http.rs`).
    pub fn from_parts(
        state: Arc<AppState>,
        events: Arc<dyn EventSink>,
        paths: Arc<dyn AppPaths>,
        spawner: Arc<dyn Spawner>,
    ) -> Self {
        Self { state, events, paths, spawner }
    }

    /// A [`ServiceCtx`] for an agent caller.
    ///
    /// This is one of exactly two places a [`Caller`] is constructed (the other
    /// is `commands::adapters::ui_ctx`). `client` is the self-reported
    /// `X-LogTapper-Client` header value, defaulting to `"mcp"` — it labels the
    /// activity feed and is never trusted for authorization.
    pub fn svc(&self, client: &str) -> ServiceCtx {
        ServiceCtx::new(
            Arc::clone(&self.state),
            Arc::clone(&self.events),
            Arc::clone(&self.paths),
            Arc::clone(&self.spawner),
            Caller::agent(client),
        )
    }
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------
//
// Single source of truth for the *expected* route list (method + path), in
// the SAME order `router()` registers them. `router()` cannot be built
// generically from this list — axum's `.route(path, get(handler))` needs each
// handler's concrete (distinct) type at the call site — so the two are kept
// in sync by hand; the `route_table_matches_expected` test below (the only
// consumer, hence `#[cfg(test)]`) guards against a silent drift by pinning
// the rendered list against router()'s actual `.route(...)` calls. A later
// package can additionally assert this against a live `router(ctx)` via
// `tower::ServiceExt::oneshot` once `BridgeCtx::app` is retired (see the WP-0
// handoff notes).
//
// APPEND-ONLY from Wave 1 on: adding a route is fine, changing or removing one
// breaks a shipped MCP client. Add one line per (method, path) pair here AND
// the matching `.route(...)` call in `router()` below.
//
// `pub` (not `#[cfg(test)]`): WP-T2's `tests/bridge_http.rs` drives the live
// `router(ctx)` in-process with `tower::ServiceExt::oneshot` against every
// entry here (substituting placeholder path params) and asserts none comes
// back as axum's routing 404/405 — the real regression guard the
// `route_table_matches_expected` test below cannot provide alone (it only
// compares this list against a second hardcoded literal, never against
// `router()`'s actual `.route(...)` registrations).
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/mcp/status"),
    ("POST", "/mcp/open_file"),
    ("GET", "/mcp/sessions"),
    ("POST", "/mcp/sessions/{session_id}/close"),
    ("GET", "/mcp/sessions/{session_id}/query"),
    ("GET", "/mcp/sessions/{session_id}/pipeline"),
    ("GET", "/mcp/sessions/{session_id}/events"),
    ("GET", "/mcp/sessions/{session_id}/correlations"),
    ("GET", "/mcp/sessions/{session_id}/processor/{processor_id}"),
    ("GET", "/mcp/sessions/{session_id}/tracker/{tracker_id}/state_at"),
    ("GET", "/mcp/sessions/{session_id}/search"),
    ("GET", "/mcp/sessions/{session_id}/metadata"),
    ("GET", "/mcp/sessions/{session_id}/sections"),
    ("GET", "/mcp/sessions/{session_id}/section_at"),
    ("GET", "/mcp/sessions/{session_id}/tag-stats"),
    ("GET", "/mcp/sessions/{session_id}/lines_around"),
    ("GET", "/mcp/sessions/{session_id}/search_with_context"),
    ("GET", "/mcp/processors"),
    ("GET", "/mcp/processors/{processor_id}"),
    // Phase 2 — Bookmarks
    ("GET", "/mcp/sessions/{session_id}/bookmarks"),
    ("POST", "/mcp/sessions/{session_id}/bookmarks"),
    ("DELETE", "/mcp/sessions/{session_id}/bookmarks/{bookmark_id}"),
    ("PUT", "/mcp/sessions/{session_id}/bookmarks/{bookmark_id}"),
    // Phase 2 — Analysis artifacts (workspace-owned; see routes/artifacts.rs)
    ("GET", "/mcp/analyses"),
    ("POST", "/mcp/analyses"),
    ("GET", "/mcp/analyses/{artifact_id}"),
    ("PUT", "/mcp/analyses/{artifact_id}"),
    ("DELETE", "/mcp/analyses/{artifact_id}"),
    ("GET", "/mcp/sessions/{session_id}/analyses"),
    ("POST", "/mcp/sessions/{session_id}/analyses"),
    ("GET", "/mcp/sessions/{session_id}/analyses/{artifact_id}"),
    ("PUT", "/mcp/sessions/{session_id}/analyses/{artifact_id}"),
    ("DELETE", "/mcp/sessions/{session_id}/analyses/{artifact_id}"),
    // Phase 3 — Insights
    ("GET", "/mcp/sessions/{session_id}/insights"),
    // Pipeline run trigger (MCP)
    ("POST", "/mcp/sessions/{session_id}/run_pipeline"),
    // Phase 4 — Watches
    ("GET", "/mcp/sessions/{session_id}/watches"),
    ("POST", "/mcp/sessions/{session_id}/watches"),
    ("DELETE", "/mcp/sessions/{session_id}/watches/{watch_id}"),
    // Activity feed (both callers' actions; see `services::activity`).
    ("GET", "/mcp/activity"),
    // WP-12 settings — read + preview only, deliberately no write routes
    // (see `routes/settings.rs`'s doc comment for why).
    ("GET", "/mcp/settings/anonymizer"),
    ("GET", "/mcp/settings/open_allowlist"),
    ("POST", "/mcp/settings/anonymizer/test"),
    // WP-7 filters
    ("POST", "/mcp/sessions/{session_id}/filters"),
    ("GET", "/mcp/filters/{filter_id}"),
    ("GET", "/mcp/filters/{filter_id}/lines"),
    ("POST", "/mcp/filters/{filter_id}/cancel"),
    ("DELETE", "/mcp/filters/{filter_id}"),
    // WP-8 workspace — no `save_app_state` route by design (see
    // `routes/workspace.rs`); `GET /mcp/workspaces` is the read-only twin.
    ("GET", "/mcp/workspaces"),
    ("GET", "/mcp/workspace"),
    ("POST", "/mcp/workspace/load"),
    ("POST", "/mcp/workspace/save"),
    ("POST", "/mcp/workspace/autosave"),
];

/// Build the bridge's `Router` without binding a socket.
///
/// Split out of [`start`] so the whole route table — middleware included — can
/// be driven in-process by a test with `tower::ServiceExt::oneshot`, instead of
/// only over a real TCP listener. The route list is the transport contract with
/// the MCP server and is **append-only**: adding a route is fine, changing or
/// removing one breaks a shipped client. See [`ROUTES`] above — keep both in sync.
pub fn router(ctx: BridgeCtx) -> Router {
    Router::new()
        .route("/mcp/status", get(h_status))
        .route("/mcp/open_file", post(h_open_file))
        .route("/mcp/sessions", get(h_sessions))
        .route("/mcp/sessions/{session_id}/close", post(h_close_session))
        .route("/mcp/sessions/{session_id}/query", get(h_query))
        .route("/mcp/sessions/{session_id}/pipeline", get(h_pipeline))
        .route("/mcp/sessions/{session_id}/events", get(h_events))
        .route("/mcp/sessions/{session_id}/correlations", get(h_correlations))
        .route("/mcp/sessions/{session_id}/processor/{processor_id}", get(h_processor_detail))
        .route("/mcp/sessions/{session_id}/tracker/{tracker_id}/state_at", get(h_state_at_line))
        .route("/mcp/sessions/{session_id}/search", get(h_search))
        .route("/mcp/sessions/{session_id}/metadata", get(h_metadata))
        .route("/mcp/sessions/{session_id}/sections", get(h_sections))
        .route("/mcp/sessions/{session_id}/section_at", get(h_section_at))
        .route("/mcp/sessions/{session_id}/tag-stats", get(h_tag_stats))
        .route("/mcp/sessions/{session_id}/lines_around", get(h_lines_around))
        .route("/mcp/sessions/{session_id}/search_with_context", get(h_search_with_context))
        .route("/mcp/processors", get(h_processor_defs_list))
        .route("/mcp/processors/{processor_id}", get(h_processor_defs_single))
        // Phase 2 — Bookmarks
        .route("/mcp/sessions/{session_id}/bookmarks", get(h_list_bookmarks).post(h_create_bookmark))
        .route("/mcp/sessions/{session_id}/bookmarks/{bookmark_id}", delete(h_delete_bookmark).put(h_update_bookmark))
        // Phase 2 — Analysis artifacts (workspace-owned; see "Analysis endpoints" below)
        .route("/mcp/analyses", get(h_list_all_analyses).post(h_publish_workspace_analysis))
        .route("/mcp/analyses/{artifact_id}", get(h_get_analysis).put(h_update_analysis).delete(h_delete_analysis))
        .route("/mcp/sessions/{session_id}/analyses", get(h_list_analyses).post(h_publish_analysis))
        .route("/mcp/sessions/{session_id}/analyses/{artifact_id}", get(h_get_analysis_scoped).put(h_update_analysis_scoped).delete(h_delete_analysis_scoped))
        // Phase 3 — Insights
        .route("/mcp/sessions/{session_id}/insights", get(h_insights))
        // Pipeline run trigger (MCP)
        .route("/mcp/sessions/{session_id}/run_pipeline", post(h_run_pipeline))
        // Phase 4 — Watches
        .route("/mcp/sessions/{session_id}/watches", get(h_list_watches).post(h_create_watch))
        .route("/mcp/sessions/{session_id}/watches/{watch_id}", delete(h_cancel_watch))
        // Activity feed (both callers' actions; see `services::activity`).
        .route("/mcp/activity", get(h_activity))
        // WP-12 settings — read + preview only, deliberately no write routes.
        .route("/mcp/settings/anonymizer", get(h_get_anonymizer_config))
        .route("/mcp/settings/open_allowlist", get(h_get_open_allowlist))
        .route("/mcp/settings/anonymizer/test", post(h_test_anonymizer))
        // WP-7 filters
        .route("/mcp/sessions/{session_id}/filters", post(h_create_filter))
        .route("/mcp/filters/{filter_id}", get(h_filter_info).delete(h_close_filter))
        .route("/mcp/filters/{filter_id}/lines", get(h_filter_lines))
        .route("/mcp/filters/{filter_id}/cancel", post(h_cancel_filter))
        // WP-8 workspace
        .route("/mcp/workspaces", get(h_list_workspaces))
        .route("/mcp/workspace", get(h_current_workspace))
        .route("/mcp/workspace/load", post(h_load_workspace))
        .route("/mcp/workspace/save", post(h_save_workspace))
        .route("/mcp/workspace/autosave", post(h_autosave_workspace))
        .layer(axum_middleware::from_fn_with_state(ctx.clone(), middleware::record_activity))
        // `require_local` is added AFTER `record_activity`, which in axum/tower
        // layering means it becomes the OUTERMOST layer and therefore runs
        // FIRST on every inbound request (layers wrap inside-out in the order
        // they're added; the last `.layer()` call is the outermost wrapper).
        // That ordering is required here: a rejected (non-local) request must
        // be turned away by `require_local` before `record_activity` ever
        // sees it, so untrusted traffic cannot stamp `mcp_last_activity`.
        .layer(axum_middleware::from_fn_with_state(ctx.clone(), middleware::require_local))
        .with_state(ctx)
}

/// Bind `127.0.0.1:PORT` and serve [`router`] until `shutdown_rx` fires.
///
/// Bind + serve + port-flag bookkeeping only — every routing decision lives in
/// [`router`].
pub async fn start(ctx: BridgeCtx, shutdown_rx: tokio::sync::oneshot::Receiver<()>) {
    let state = Arc::clone(&ctx.state);
    let router = router(ctx);

    match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(listener) => {
            // Record that the bridge is running so the frontend can show status.
            if let Ok(mut p) = state.mcp_bridge_port.lock() {
                *p = Some(PORT);
            }
            log::info!("MCP bridge listening on 127.0.0.1:{PORT}");
            let graceful = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                });
            if let Err(e) = graceful.await {
                log::error!("MCP bridge error: {e}");
            }
            // Clear the port flag so the frontend knows the bridge is no longer running.
            if let Ok(mut p) = state.mcp_bridge_port.lock() {
                *p = None;
            }
            // Clear the shutdown sender so start_mcp_bridge can restart cleanly.
            if let Ok(mut s) = state.mcp_bridge_shutdown.lock() {
                s.take();
            }
            log::info!("MCP bridge stopped");
        }
        Err(e) => {
            log::error!(
                "MCP bridge: cannot bind to 127.0.0.1:{PORT} — {e}. \
                 Is another instance running?"
            );
            // Clear the shutdown sender on bind failure too, so the bridge can be restarted.
            if let Ok(mut s) = state.mcp_bridge_shutdown.lock() {
                s.take();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the transport contract in [`ROUTES`] against silent drift: the
    /// rendered "METHOD /path" list must exactly match this pinned snapshot,
    /// in the same order. `router()` is built from the same list by hand (see
    /// the comment on [`ROUTES`]) — changing one without the other is exactly
    /// the mistake this test exists to catch.
    #[test]
    fn route_table_matches_expected() {
        let rendered: Vec<String> = ROUTES.iter().map(|(m, p)| format!("{m} {p}")).collect();

        let expected: Vec<&str> = vec![
            "GET /mcp/status",
            "POST /mcp/open_file",
            "GET /mcp/sessions",
            "POST /mcp/sessions/{session_id}/close",
            "GET /mcp/sessions/{session_id}/query",
            "GET /mcp/sessions/{session_id}/pipeline",
            "GET /mcp/sessions/{session_id}/events",
            "GET /mcp/sessions/{session_id}/correlations",
            "GET /mcp/sessions/{session_id}/processor/{processor_id}",
            "GET /mcp/sessions/{session_id}/tracker/{tracker_id}/state_at",
            "GET /mcp/sessions/{session_id}/search",
            "GET /mcp/sessions/{session_id}/metadata",
            "GET /mcp/sessions/{session_id}/sections",
            "GET /mcp/sessions/{session_id}/section_at",
            "GET /mcp/sessions/{session_id}/tag-stats",
            "GET /mcp/sessions/{session_id}/lines_around",
            "GET /mcp/sessions/{session_id}/search_with_context",
            "GET /mcp/processors",
            "GET /mcp/processors/{processor_id}",
            "GET /mcp/sessions/{session_id}/bookmarks",
            "POST /mcp/sessions/{session_id}/bookmarks",
            "DELETE /mcp/sessions/{session_id}/bookmarks/{bookmark_id}",
            "PUT /mcp/sessions/{session_id}/bookmarks/{bookmark_id}",
            "GET /mcp/analyses",
            "POST /mcp/analyses",
            "GET /mcp/analyses/{artifact_id}",
            "PUT /mcp/analyses/{artifact_id}",
            "DELETE /mcp/analyses/{artifact_id}",
            "GET /mcp/sessions/{session_id}/analyses",
            "POST /mcp/sessions/{session_id}/analyses",
            "GET /mcp/sessions/{session_id}/analyses/{artifact_id}",
            "PUT /mcp/sessions/{session_id}/analyses/{artifact_id}",
            "DELETE /mcp/sessions/{session_id}/analyses/{artifact_id}",
            "GET /mcp/sessions/{session_id}/insights",
            "POST /mcp/sessions/{session_id}/run_pipeline",
            "GET /mcp/sessions/{session_id}/watches",
            "POST /mcp/sessions/{session_id}/watches",
            "DELETE /mcp/sessions/{session_id}/watches/{watch_id}",
            "GET /mcp/activity",
            "GET /mcp/settings/anonymizer",
            "GET /mcp/settings/open_allowlist",
            "POST /mcp/settings/anonymizer/test",
            "POST /mcp/sessions/{session_id}/filters",
            "GET /mcp/filters/{filter_id}",
            "GET /mcp/filters/{filter_id}/lines",
            "POST /mcp/filters/{filter_id}/cancel",
            "DELETE /mcp/filters/{filter_id}",
            "GET /mcp/workspaces",
            "GET /mcp/workspace",
            "POST /mcp/workspace/load",
            "POST /mcp/workspace/save",
            "POST /mcp/workspace/autosave",
        ];

        assert_eq!(rendered, expected, "ROUTES drifted from the pinned route table — update both this test and router() together");
    }
}
