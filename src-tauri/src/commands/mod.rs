use std::collections::HashMap;
use std::sync::Mutex;

use crate::core::session::AnalysisSession;

pub mod charts;
pub mod claude;
pub mod files;
pub mod pipeline;
pub mod processors;
pub mod session;

/// Global application state managed by Tauri.
pub struct AppState {
    pub sessions: Mutex<HashMap<String, AnalysisSession>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}
