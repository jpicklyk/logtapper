use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTrackerDef {
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub state: Vec<StateFieldDecl>,
    #[serde(default)]
    pub transitions: Vec<TransitionRule>,
    #[serde(default)]
    pub output: StateTrackerOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateFieldDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: StateFieldType,
    /// If omitted from YAML, defaults to `null` — meaning "unknown until first observed".
    #[serde(default)]
    pub default: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateFieldType {
    Bool,
    Int,
    Float,
    String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionRule {
    pub name: String,
    pub filter: TransitionFilter,
    #[serde(default)]
    pub set: HashMap<String, serde_yaml::Value>,
    #[serde(default)]
    pub clear: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TransitionFilter {
    pub tag: Option<String>,
    pub tag_regex: Option<String>,
    pub message_regex: Option<String>,
    pub message_contains: Option<String>,
    pub level: Option<String>,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub section: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StateTrackerOutput {
    #[serde(default)]
    pub timeline: bool,
    #[serde(default)]
    pub annotate: bool,
}
