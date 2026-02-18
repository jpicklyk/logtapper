use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use super::detectors::PiiCategory;

// ---------------------------------------------------------------------------
// Session-scoped mappings — never persisted
// ---------------------------------------------------------------------------

/// Holds all live PII → token mappings for a single analysis session.
/// Thread-safe via an internal `Mutex` so it can be shared across pipeline
/// threads without wrapping in an outer `Arc<Mutex<...>>`.
pub struct PiiMappings {
    /// raw_value → replacement token  (e.g. "user@foo.com" → "<EMAIL-3>")
    forward: Mutex<HashMap<String, String>>,
    /// replacement token → raw_value  (used for reversible mode)
    reverse: Mutex<HashMap<String, String>>,
    /// Per-category counters so we get stable sequential numbering.
    counters: Mutex<HashMap<PiiCategory, usize>>,
}

impl PiiMappings {
    pub fn new() -> Self {
        Self {
            forward: Mutex::new(HashMap::new()),
            reverse: Mutex::new(HashMap::new()),
            counters: Mutex::new(HashMap::new()),
        }
    }

    /// Return (or create) the token for `raw`, deterministically.
    pub fn token_for(&self, raw: &str, category: PiiCategory) -> String {
        let mut fwd: MutexGuard<HashMap<String, String>> = self.forward.lock().unwrap();
        if let Some(token) = fwd.get(raw) {
            return token.clone();
        }

        // New value — assign next counter for this category.
        let mut counters = self.counters.lock().unwrap();
        let n = counters.entry(category).or_insert(0);
        *n += 1;
        let token = format!("<{}-{}>", category.prefix(), n);

        fwd.insert(raw.to_string(), token.clone());
        drop(fwd); // release before acquiring reverse
        self.reverse
            .lock()
            .unwrap()
            .insert(token.clone(), raw.to_string());

        token
    }

    /// Look up the original value for a token (reversible mode only).
    pub fn reveal(&self, token: &str) -> Option<String> {
        self.reverse.lock().unwrap().get(token).cloned()
    }

    /// Snapshot of all forward mappings for display/export.
    pub fn all_mappings(&self) -> HashMap<String, String> {
        self.forward.lock().unwrap().clone()
    }
}

impl Default for PiiMappings {
    fn default() -> Self {
        Self::new()
    }
}
