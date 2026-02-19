use std::collections::HashMap;
use std::sync::Mutex;

use crate::anonymizer::config::AnonymizerConfig;
use crate::anonymizer::LogAnonymizer;
use crate::core::session::AnalysisSession;
use crate::processors::interpreter::{ContinuousRunState, RunResult};
use crate::processors::schema::ProcessorDef;

pub mod adb;
pub mod anonymizer;
pub mod charts;
pub mod claude;
pub mod files;
pub mod pipeline;
pub mod processors;
pub mod session;

/// Global application state managed by Tauri.
pub struct AppState {
    /// Active analysis sessions (sessionId → session).
    pub sessions: Mutex<HashMap<String, AnalysisSession>>,
    /// Installed processors (processorId → definition).
    pub processors: Mutex<HashMap<String, ProcessorDef>>,
    /// Pipeline results: sessionId → processorId → RunResult.
    pub pipeline_results: Mutex<HashMap<String, HashMap<String, RunResult>>>,
    /// Claude API key (set by the user at runtime).
    pub api_key: Mutex<Option<String>>,
    /// Shared HTTP client for registry and Claude API calls.
    pub http_client: reqwest::Client,
    /// Cancellation senders for active ADB streaming tasks (sessionId → sender).
    pub stream_tasks: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    /// Continuous processor state for live streaming (sessionId → processorId → state).
    pub stream_processor_state: Mutex<HashMap<String, HashMap<String, ContinuousRunState>>>,
    /// Global anonymizer configuration (persisted to disk).
    pub anonymizer_config: Mutex<AnonymizerConfig>,
    /// PII token→original mappings from the last pipeline run per session.
    pub pii_mappings: Mutex<HashMap<String, HashMap<String, String>>>,
    /// Persistent anonymizers for live ADB stream sessions (sessionId → anonymizer).
    /// Created by `set_stream_anonymize(enabled=true)`; dropped on stream stop.
    pub stream_anonymizers: Mutex<HashMap<String, LogAnonymizer>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
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
        }
    }
}
