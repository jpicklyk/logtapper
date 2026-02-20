use std::collections::HashMap;
use std::sync::Mutex;

use crate::anonymizer::config::AnonymizerConfig;
use crate::anonymizer::LogAnonymizer;
use crate::core::session::AnalysisSession;
use crate::processors::AnyProcessor;
use crate::processors::interpreter::{ContinuousRunState, RunResult};
use crate::processors::state_tracker::types::{StateTrackerResult, ContinuousTrackerState};
use crate::processors::transformer::types::ContinuousTransformerState;

pub mod adb;
pub mod anonymizer;
pub mod charts;
pub mod claude;
pub mod files;
pub mod pipeline;
pub mod processors;
pub mod session;
pub mod state_tracker;

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
    /// StateTracker results: sessionId -> trackerId -> StateTrackerResult.
    #[allow(dead_code)]
    pub state_tracker_results: Mutex<HashMap<String, HashMap<String, StateTrackerResult>>>,
    /// Continuous StateTracker state for live streaming.
    #[allow(dead_code)]
    pub stream_tracker_state: Mutex<HashMap<String, HashMap<String, ContinuousTrackerState>>>,
    /// Continuous Transformer state for live streaming.
    #[allow(dead_code)]
    pub stream_transformer_state: Mutex<HashMap<String, HashMap<String, ContinuousTransformerState>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
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
            stream_processor_state: Mutex::new(HashMap::new()),
            anonymizer_config: Mutex::new(AnonymizerConfig::with_defaults()),
            pii_mappings: Mutex::new(HashMap::new()),
            stream_anonymizers: Mutex::new(HashMap::new()),
            mcp_anonymizers: Mutex::new(HashMap::new()),
            state_tracker_results: Mutex::new(HashMap::new()),
            stream_tracker_state: Mutex::new(HashMap::new()),
            stream_transformer_state: Mutex::new(HashMap::new()),
        }
    }
}
