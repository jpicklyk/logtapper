use std::collections::HashMap;
use std::sync::Mutex;

use crate::core::session::AnalysisSession;
use crate::processors::interpreter::RunResult;
use crate::processors::schema::ProcessorDef;

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
        }
    }
}
