use std::collections::HashMap;
use crate::anonymizer::LogAnonymizer;
use crate::core::line::LineContext;

/// Built-in PII Transformer that wraps LogAnonymizer.
pub struct PiiTransformer {
    pub anonymizer: LogAnonymizer,
}

impl PiiTransformer {
    /// Create a new PiiTransformer with default detector set.
    pub fn new() -> Self {
        PiiTransformer {
            anonymizer: LogAnonymizer::new(),
        }
    }

    /// Apply PII anonymization to a line in place.
    /// Updates line.message. The anonymizer internal PiiMappings tracks
    /// raw_value to token mapping for consistency within a session.
    pub fn apply(&mut self, line: &mut LineContext) {
        let (anonymized, _spans) = self.anonymizer.anonymize(&line.message);
        line.message = anonymized;
    }

    /// Snapshot of accumulated PII mappings (raw value to token).
    pub fn current_mappings(&self) -> HashMap<String, String> {
        self.anonymizer.mappings.all_mappings()
    }
}

impl Default for PiiTransformer {
    fn default() -> Self {
        Self::new()
    }
}
