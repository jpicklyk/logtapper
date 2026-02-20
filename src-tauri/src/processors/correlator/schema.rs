use serde::{Deserialize, Serialize};

/// Stub schema -- engine not yet implemented.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelatorDef {
    // Placeholder fields -- will be expanded in future workstreams
    #[serde(default)]
    pub trigger: Option<serde_yaml::Value>,
    #[serde(default)]
    pub window: Option<serde_yaml::Value>,
    #[serde(default)]
    pub collect: Vec<serde_yaml::Value>,
    #[serde(default)]
    pub output: Option<serde_yaml::Value>,
}
