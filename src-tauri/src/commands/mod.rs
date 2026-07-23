use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use crate::anonymizer::config::AnonymizerConfig;
use crate::anonymizer::LogAnonymizer;
use crate::core::session::AnalysisSession;
use crate::processors::marketplace::Source;
use crate::processors::{AnyProcessor, PackMeta};
use crate::processors::interpreter::{ContinuousRunState, RunResult};
use crate::processors::state_tracker::types::{StateTrackerResult, ContinuousTrackerState};
use crate::processors::transformer::types::ContinuousTransformerState;
use crate::core::analysis::AnalysisArtifact;
use crate::core::bookmark::Bookmark;
use crate::core::filter::FilterSession;
use crate::core::watch::WatchSession;
use crate::processors::correlator::engine::CorrelatorResult;

pub mod adb;
pub mod analysis;
pub mod anonymizer;
pub mod artifact_mutations;
pub mod bookmark;
pub mod bridge_access;
pub mod charts;
pub mod claude;
pub mod correlator;
pub mod export;
pub mod file_associations;
pub mod files;
pub mod filter;
pub mod mcp;
pub mod pipeline;
pub mod pipeline_core;
pub mod processors;
pub mod session;
pub mod sources;
pub mod state_tracker;
pub mod watch;
pub mod workspace_cmd;
pub mod workspace_sync;

/// Global application state managed by Tauri.
pub struct AppState {
    /// Port the MCP HTTP bridge is listening on, or None if it failed to bind.
    pub mcp_bridge_port: Mutex<Option<u16>>,
    /// Timestamp of the most recent request received by the MCP HTTP bridge.
    /// None = bridge never received a request (Claude Code hasn't connected yet).
    pub mcp_last_activity: Mutex<Option<std::time::Instant>>,
    /// Active analysis sessions (sessionId -> session).
    pub sessions: Mutex<HashMap<String, AnalysisSession>>,
    /// Installed processors (processorId -> definition).
    pub processors: Mutex<HashMap<String, AnyProcessor>>,
    /// Pipeline results: sessionId -> processorId -> RunResult.
    pub pipeline_results: Mutex<HashMap<String, HashMap<String, RunResult>>>,
    /// Claude API key (set by the user at runtime).
    pub api_key: Mutex<Option<String>>,
    /// Shared HTTP client for registry and Claude API calls.
    pub http_client: reqwest::Client,
    /// Cancellation senders for active ADB streaming tasks.
    pub stream_tasks: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    /// Cancellation senders for active background file-indexing tasks.
    pub indexing_tasks: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    /// Continuous processor state for live streaming.
    pub stream_processor_state: Mutex<HashMap<String, HashMap<String, ContinuousRunState>>>,
    /// Global anonymizer configuration (persisted to disk).
    pub anonymizer_config: Mutex<AnonymizerConfig>,
    /// Directories an MCP client may open files from via the
    /// `logtapper_open_file` endpoint (raw strings, as persisted in
    /// `mcp_open_allowlist.json`). Default-deny unless `allowAll` is set, in
    /// which case any path that passes path-hygiene is permitted regardless
    /// of `allowed_dirs`. See `commands/bridge_access.rs`.
    pub mcp_open_allowlist: Mutex<bridge_access::McpOpenAllowlist>,
    /// PII token->original mappings from the last pipeline run per session.
    pub pii_mappings: Mutex<HashMap<String, HashMap<String, String>>>,
    /// Persistent anonymizers for live ADB stream sessions.
    pub stream_anonymizers: Mutex<HashMap<String, LogAnonymizer>>,
    /// Persistent anonymizers for MCP query results (one per session for stable token numbering).
    pub mcp_anonymizers: Mutex<HashMap<String, LogAnonymizer>>,
    /// Whether to apply PII anonymization to MCP query results.
    /// Set to true by the frontend when __pii_anonymizer is in the pipeline chain.
    pub mcp_anonymize: Mutex<bool>,
    /// StateTracker results: sessionId -> trackerId -> StateTrackerResult.
    #[allow(dead_code)]
    pub state_tracker_results: Mutex<HashMap<String, HashMap<String, StateTrackerResult>>>,
    /// Correlator results: sessionId -> correlatorId -> CorrelatorResult.
    pub correlator_results: Mutex<HashMap<String, HashMap<String, CorrelatorResult>>>,
    /// Continuous StateTracker state for live streaming.
    #[allow(dead_code)]
    pub stream_tracker_state: Mutex<HashMap<String, HashMap<String, ContinuousTrackerState>>>,
    /// Continuous Transformer state for live streaming.
    #[allow(dead_code)]
    pub stream_transformer_state: Mutex<HashMap<String, HashMap<String, ContinuousTransformerState>>>,
    /// Per-session generation stamp guarding the ADB streaming
    /// extract-process-reinsert pattern (see `commands::adb::flush_batch`).
    ///
    /// Every writer that clears or replaces a session's continuous stream state
    /// (`stop_adb_stream`, `set_stream_anonymize`, `update_stream_processors`,
    /// `update_stream_trackers`, `update_stream_transformers`,
    /// `close_session_inner`) bumps or drops this stamp *while holding this lock*.
    /// `flush_batch` records the stamp when a batch begins and, at re-insert
    /// time, re-reads it under this lock and drops the batch's state when the
    /// stamp changed (or the entry is gone). This ensures a concurrent writer's
    /// clear/update is never resurrected or clobbered by an in-flight batch,
    /// without holding any lock across batch processing. Lock order is always
    /// `stream_epochs` (outer) → the specific stream-state map (inner).
    pub stream_epochs: Mutex<HashMap<String, u64>>,
    /// Cancellation flag for the active pipeline run.
    pub pipeline_cancel: Arc<AtomicBool>,
    /// Active filter sessions: filterId -> FilterSession.
    pub active_filters: Mutex<HashMap<String, Arc<FilterSession>>>,
    /// Bookmarks: sessionId -> Vec<Bookmark>.
    pub bookmarks: Mutex<HashMap<String, Vec<Bookmark>>>,
    /// Analysis artifacts: sessionId -> Vec<AnalysisArtifact>.
    pub analyses: Mutex<HashMap<String, Vec<AnalysisArtifact>>>,
    /// Active watches: sessionId -> Vec<Arc<WatchSession>>.
    pub active_watches: Mutex<HashMap<String, Vec<Arc<WatchSession>>>>,
    /// Configured marketplace sources.
    pub sources: Mutex<Vec<Source>>,
    /// Pending processor updates found by the startup check (for UI badges).
    pub pending_updates: Mutex<Vec<crate::commands::sources::UpdateAvailable>>,
    /// Pending pack updates found by the startup check (for UI badges).
    pub pending_pack_updates: Mutex<Vec<crate::commands::sources::PackUpdateAvailable>>,
    /// Pipeline chain per session, pushed by the frontend via set_session_pipeline_meta.
    /// Used by workspace save sites to persist SessionMeta with the actual chain state.
    pub session_pipeline_meta: Mutex<HashMap<String, crate::workspace::SessionMeta>>,
    /// Installed processor packs (packId -> PackMeta).
    pub packs: Mutex<Vec<PackMeta>>,
    /// Path passed via CLI args at launch (double-click file association).
    pub startup_file_path: Mutex<Option<String>>,
    /// Shutdown sender for the MCP HTTP bridge. Send `()` to stop the server.
    pub mcp_bridge_shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// YAML content for session-scoped processors imported from .lts files.
    /// Keyed by scoped ID like `wifi-state@lts-{session-uuid}`.
    /// Ephemeral — removed when the session closes.
    pub lts_processor_yamls: Mutex<HashMap<String, String>>,
    /// Q4 — last frontend-supplied workspace envelope (name / editor tabs /
    /// layout / chain). The background flusher merges it with a fresh session
    /// snapshot; `None` until the first frontend push (flush then log-and-skips).
    pub workspace_envelope: Mutex<Option<crate::workspace::autosave::WorkspaceEnvelope>>,
    /// Q4 — sender to the background auto-save scheduler. Set during `lib.rs`
    /// setup once the `AppHandle` exists; `schedule_autosave` sends on it.
    pub autosave_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>,
    /// Q4 — serialises `.ltw` file writes between the command-path save handlers
    /// and the background flush so they never interleave on the same file.
    pub ltw_write_lock: Arc<Mutex<()>>,
    /// Q4 — serialises `app-state.json` writes between `save_app_state_cmd` and
    /// the background flush's read-modify-write (a torn file parses as empty,
    /// silently dropping the workspace list).
    pub app_state_write_lock: Arc<Mutex<()>>,
    /// Q5 — incremented by every `schedule_autosave` call; a cheap, lock-free
    /// "dirty" signal. Compared against `autosave_flushed_generation` so the
    /// `RunEvent::Exit` handler can tell, synchronously, whether any mutation
    /// is still unflushed and worth a blocking exit-time flush.
    pub autosave_generation: AtomicU64,
    /// Q5 — the `autosave_generation` value as of the last successful flush
    /// (periodic or exit-time). `autosave_generation != autosave_flushed_generation`
    /// means a mutation happened since the last durable write.
    pub autosave_flushed_generation: AtomicU64,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// Acquire a Mutex lock, mapping poison errors to a consistent `String` error.
pub fn lock_or_err<'a, T>(
    mutex: &'a std::sync::Mutex<T>,
    name: &str,
) -> Result<std::sync::MutexGuard<'a, T>, String> {
    mutex.lock().map_err(|_| format!("{name} lock poisoned"))
}

impl AppState {
    pub fn new() -> Self {
        Self {
            mcp_bridge_port: Mutex::new(None),
            mcp_last_activity: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            processors: Mutex::new(HashMap::new()),
            pipeline_results: Mutex::new(HashMap::new()),
            api_key: Mutex::new(None),
            http_client: reqwest::Client::builder()
                .user_agent("LogTapper/1.0")
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("Failed to create HTTP client"),
            stream_tasks: Mutex::new(HashMap::new()),
            indexing_tasks: Mutex::new(HashMap::new()),
            stream_processor_state: Mutex::new(HashMap::new()),
            anonymizer_config: Mutex::new(AnonymizerConfig::with_defaults()),
            mcp_open_allowlist: Mutex::new(bridge_access::McpOpenAllowlist::default()),
            pii_mappings: Mutex::new(HashMap::new()),
            stream_anonymizers: Mutex::new(HashMap::new()),
            mcp_anonymizers: Mutex::new(HashMap::new()),
            mcp_anonymize: Mutex::new(false),
            state_tracker_results: Mutex::new(HashMap::new()),
            stream_tracker_state: Mutex::new(HashMap::new()),
            stream_transformer_state: Mutex::new(HashMap::new()),
            stream_epochs: Mutex::new(HashMap::new()),
            correlator_results: Mutex::new(HashMap::new()),
            pipeline_cancel: Arc::new(AtomicBool::new(false)),
            active_filters: Mutex::new(HashMap::new()),
            bookmarks: Mutex::new(HashMap::new()),
            analyses: Mutex::new(HashMap::new()),
            active_watches: Mutex::new(HashMap::new()),
            sources: Mutex::new(Vec::new()),
            pending_updates: Mutex::new(Vec::new()),
            pending_pack_updates: Mutex::new(Vec::new()),
            session_pipeline_meta: Mutex::new(HashMap::new()),
            packs: Mutex::new(Vec::new()),
            startup_file_path: Mutex::new(None),
            mcp_bridge_shutdown: Mutex::new(None),
            lts_processor_yamls: Mutex::new(HashMap::new()),
            workspace_envelope: Mutex::new(None),
            autosave_tx: Mutex::new(None),
            ltw_write_lock: Arc::new(Mutex::new(())),
            app_state_write_lock: Arc::new(Mutex::new(())),
            autosave_generation: AtomicU64::new(0),
            autosave_flushed_generation: AtomicU64::new(0),
        }
    }

    // ── ADB streaming epoch guard ────────────────────────────────────────────
    //
    // These helpers implement the per-session generation stamp described on the
    // `stream_epochs` field. They exist so `flush_batch` (which extracts stream
    // state, processes a batch with no locks held, then re-inserts) can never
    // resurrect or clobber state that a concurrent command legitimately cleared,
    // updated, or dropped in between.

    /// Snapshot a session's stream epoch (`None` if never seeded or already
    /// dropped). `flush_batch` calls this once at the start of a batch and passes
    /// the result to every re-insert via [`Self::reinsert_stream_state_if_current`].
    pub fn current_stream_epoch(&self, session_id: &str) -> Option<u64> {
        self.stream_epochs
            .lock()
            .ok()
            .and_then(|e| e.get(session_id).copied())
    }

    /// Seed a session's stream epoch to `0` at stream start, so every later
    /// re-insert compares against a concrete `Some(_)` value (distinguishing a
    /// live session from one that has been closed and had its epoch dropped).
    pub fn seed_stream_epoch(&self, session_id: &str) {
        if let Ok(mut e) = self.stream_epochs.lock() {
            e.entry(session_id.to_string()).or_insert(0);
        }
    }

    /// Run `f` — which clears or replaces one or more of a session's stream-state
    /// maps — and then BUMP the session's epoch, all while holding the
    /// `stream_epochs` lock. Because the mutation and the bump are atomic under
    /// this lock (and [`Self::reinsert_stream_state_if_current`] re-checks the
    /// epoch under the same lock), an in-flight `flush_batch` re-insert gated on
    /// the pre-bump epoch is guaranteed to observe the change and drop its stale
    /// state. Used by the incremental writers (`set_stream_anonymize`,
    /// `update_stream_processors`, `update_stream_trackers`,
    /// `update_stream_transformers`). `f` acquires stream-state map locks (inner)
    /// — never `stream_epochs` again — preserving the `stream_epochs → map` order.
    pub fn bump_stream_epoch_with<F>(&self, session_id: &str, f: F) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut epochs = lock_or_err(&self.stream_epochs, "stream_epochs")?;
        f()?;
        *epochs.entry(session_id.to_string()).or_insert(0) += 1;
        Ok(())
    }

    /// Run `f` — which clears a session's stream-state maps — and then DROP the
    /// session's epoch entry, atomically under the `stream_epochs` lock. An
    /// in-flight re-insert gated on the old epoch then observes `None` and drops
    /// its state. Used by the terminal clearers (`stop_adb_stream`,
    /// `close_session_inner`). `f` acquires stream-state map locks (inner) only.
    pub fn clear_stream_epoch_with<F>(&self, session_id: &str, f: F) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut epochs = lock_or_err(&self.stream_epochs, "stream_epochs")?;
        f()?;
        epochs.remove(session_id);
        Ok(())
    }

    /// Re-insert an in-flight batch's stream state (via `f`) only if the
    /// session's epoch still equals `epoch0` (captured when the batch began).
    /// The `stream_epochs` lock is held across `f` — which performs the actual
    /// map insert — so a concurrent clearer/updater cannot slip between the check
    /// and the insert. When the epoch changed (a writer ran) or the lock is
    /// poisoned, `f` is not run and the stale state is dropped. Lock order:
    /// `stream_epochs` (outer) → target map (inner), matching every writer.
    pub fn reinsert_stream_state_if_current<F: FnOnce()>(
        &self,
        session_id: &str,
        epoch0: Option<u64>,
        f: F,
    ) {
        if let Ok(epochs) = self.stream_epochs.lock() {
            if epochs.get(session_id).copied() == epoch0 {
                f();
            }
        }
        // epoch changed (writer ran) or lock poisoned → drop the stale state.
    }
}
