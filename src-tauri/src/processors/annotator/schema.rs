use serde::{Deserialize, Serialize};

/// Stub schema -- engine not yet implemented.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotatorDef {
    #[serde(default)]
    pub phases: Vec<serde_yaml::Value>,
}
