use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContinuousTransformerState {
    pub last_processed_line: usize,
    pub pii_mappings: Option<HashMap<String, String>>,
}
