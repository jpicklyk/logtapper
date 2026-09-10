use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use crate::processors::state_tracker::schema::TrackerMode;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StateTransition {
    pub line_num: usize,
    #[ts(type = "number")]
    pub timestamp: i64,
    pub transition_name: String,
    // `#[ts(type)]` clears ts-rs's dependency tracking, so the named value type
    // must be pulled in with an inline import — every generated file is a sibling.
    #[ts(type = "Record<string, import('./FieldChange').FieldChange>")]
    pub changes: HashMap<String, FieldChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct FieldChange {
    #[ts(type = "unknown")]
    pub from: serde_json::Value,
    #[ts(type = "unknown")]
    pub to: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub line_num: usize,
    #[ts(type = "number")]
    pub timestamp: i64,
    #[ts(type = "Record<string, unknown>")]
    pub fields: HashMap<String, serde_json::Value>,
    /// Field names that have been explicitly set by at least one transition before
    /// this snapshot's line. Fields absent from this set are still at their
    /// declared default and have never been touched — i.e. their value is unknown.
    pub initialized_fields: Vec<String>,
    /// Section names this tracker's data was sourced from (bugreport/dumpstate only).
    #[serde(default)]
    pub source_sections: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTrackerResult {
    pub tracker_id: String,
    pub transitions: Vec<StateTransition>,
    pub final_state: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub source_sections: Vec<String>,
    #[serde(default)]
    pub mode: TrackerMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContinuousTrackerState {
    pub current_state: HashMap<String, serde_json::Value>,
    pub transitions: Vec<StateTransition>,
    pub last_processed_line: usize,
}
