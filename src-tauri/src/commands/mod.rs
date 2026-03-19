use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::anonymizer::config::AnonymizerConfig;
use crate::anonymizer::LogAnonymizer;
use crate::core::session::AnalysisSession;
use crate::processors::marketplace::Source;
use crate::processors::AnyProcessor;
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
pub mod bookmark;
pub mod charts;
pub mod claude;
pub mod correlator;
pub mod files;
pub mod filter;
pub mod pipeline;
pub mod pipeline_core;
pub mod processors;
pub mod session;
pub mod sources;
pub mod state_tracker;
pub mod watch;
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
    /// Pending workspace auto-save cancellation senders: session_id → cancel sender.
    pub workspace_save_tasks: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
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
            pii_mappings: Mutex::new(HashMap::new()),
            stream_anonymizers: Mutex::new(HashMap::new()),
            mcp_anonymizers: Mutex::new(HashMap::new()),
            mcp_anonymize: Mutex::new(false),
            state_tracker_results: Mutex::new(HashMap::new()),
            stream_tracker_state: Mutex::new(HashMap::new()),
            stream_transformer_state: Mutex::new(HashMap::new()),
            correlator_results: Mutex::new(HashMap::new()),
            pipeline_cancel: Arc::new(AtomicBool::new(false)),
            active_filters: Mutex::new(HashMap::new()),
            bookmarks: Mutex::new(HashMap::new()),
            analyses: Mutex::new(HashMap::new()),
            active_watches: Mutex::new(HashMap::new()),
            sources: Mutex::new(Vec::new()),
            pending_updates: Mutex::new(Vec::new()),
            workspace_save_tasks: Mutex::new(HashMap::new()),
        }
    }
}
