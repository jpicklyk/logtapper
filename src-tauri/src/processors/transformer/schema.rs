use serde::{Deserialize, Serialize};
use crate::processors::reporter::schema::FilterStage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformerDef {
    #[serde(default)]
    pub filter: Option<FilterStage>,
    #[serde(default)]
    pub transforms: Vec<TransformOp>,
    /// Selects a built-in transformer implementation (e.g. pii_anonymizer).
    /// Uses key builtin_kind to avoid collision with the top-level
    /// builtin: bool field in ProcessorMeta.
    #[serde(default, rename = "builtin_kind")]
    pub builtin: Option<BuiltinTransformer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltinTransformer {
    PiiAnonymizer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TransformOp {
    ReplaceField {
        field: String,
        regex: String,
        replacement: String,
    },
    AddField {
        name: String,
        script: String,
    },
    SetField {
        name: String,
        value: serde_yaml::Value,
    },
    DropField {
        name: String,
    },
}
