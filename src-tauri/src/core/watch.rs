use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use serde::Serialize;

use crate::core::filter::FilterCriteria;

/// A live watch that evaluates new lines against filter criteria.
/// Reuses the Phase 1 FilterCriteria and line_matches_criteria evaluation.
pub struct WatchSession {
    pub watch_id: String,
    pub session_id: String,
    pub criteria: FilterCriteria,
    /// Compiled regex from criteria.regex (compiled once on creation).
    pub compiled_regex: Option<regex::Regex>,
    /// Running total of matches across all batches.
    total_matches: AtomicU32,
    /// Whether this watch is still active (can be cancelled).
    active: AtomicBool,
}

impl WatchSession {
    pub fn new(watch_id: String, session_id: String, criteria: FilterCriteria) -> Self {
        let compiled_regex = criteria
            .regex
            .as_ref()
            .and_then(|pat| regex::Regex::new(pat).ok());

        Self {
            watch_id,
            session_id,
            criteria,
            compiled_regex,
            total_matches: AtomicU32::new(0),
            active: AtomicBool::new(true),
        }
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    pub fn cancel(&self) {
        self.active.store(false, Ordering::Relaxed);
    }

    pub fn total_matches(&self) -> u32 {
        self.total_matches.load(Ordering::Relaxed)
    }

    /// Add to the match counter. Returns the new total.
    pub fn add_matches(&self, count: u32) -> u32 {
        self.total_matches.fetch_add(count, Ordering::Relaxed) + count
    }
}

/// Payload emitted as `watch-match` Tauri event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchMatchEvent {
    pub watch_id: String,
    pub session_id: String,
    pub new_matches: u32,
    pub total_matches: u32,
}

/// Info about a watch, returned by list_watches.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchInfo {
    pub watch_id: String,
    pub session_id: String,
    pub total_matches: u32,
    pub active: bool,
    pub criteria: FilterCriteria,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::filter::FilterCriteria;
    use crate::core::line::LogLevel;

    fn make_criteria(text: &str) -> FilterCriteria {
        FilterCriteria {
            text_search: Some(text.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn watch_starts_active_with_zero_matches() {
        let w = WatchSession::new("w1".into(), "s1".into(), make_criteria("error"));
        assert!(w.is_active());
        assert_eq!(w.total_matches(), 0);
    }

    #[test]
    fn add_matches_increments() {
        let w = WatchSession::new("w1".into(), "s1".into(), make_criteria("error"));
        let total = w.add_matches(5);
        assert_eq!(total, 5);
        let total = w.add_matches(3);
        assert_eq!(total, 8);
        assert_eq!(w.total_matches(), 8);
    }

    #[test]
    fn cancel_deactivates() {
        let w = WatchSession::new("w1".into(), "s1".into(), make_criteria("error"));
        assert!(w.is_active());
        w.cancel();
        assert!(!w.is_active());
    }

    #[test]
    fn regex_compiled_on_creation() {
        let criteria = FilterCriteria {
            regex: Some(r"\d+".to_string()),
            ..Default::default()
        };
        let w = WatchSession::new("w1".into(), "s1".into(), criteria);
        assert!(w.compiled_regex.is_some());
    }

    #[test]
    fn invalid_regex_compiles_to_none() {
        let criteria = FilterCriteria {
            regex: Some(r"[invalid".to_string()),
            ..Default::default()
        };
        let w = WatchSession::new("w1".into(), "s1".into(), criteria);
        assert!(w.compiled_regex.is_none());
    }

    #[test]
    fn watch_evaluates_with_line_matches_criteria() {
        use crate::core::filter::line_matches_criteria;

        let criteria = FilterCriteria {
            text_search: Some("ERROR".to_string()),
            log_levels: Some(vec![LogLevel::Error]),
            ..Default::default()
        };
        let w = WatchSession::new("w1".into(), "s1".into(), criteria);

        // Should match: text contains ERROR AND level is Error
        assert!(line_matches_criteria(
            &w.criteria,
            "01-01 12:00:00.000 E/Test: ERROR occurred",
            LogLevel::Error,
            "Test",
            1000,
            100,
            w.compiled_regex.as_ref(),
        ));

        // Should not match: text has ERROR but level is Info
        assert!(!line_matches_criteria(
            &w.criteria,
            "01-01 12:00:00.000 I/Test: ERROR in log",
            LogLevel::Info,
            "Test",
            1000,
            100,
            w.compiled_regex.as_ref(),
        ));
    }

    #[test]
    fn watch_match_event_serde() {
        let event = WatchMatchEvent {
            watch_id: "w1".to_string(),
            session_id: "s1".to_string(),
            new_matches: 3,
            total_matches: 10,
        };
        let val: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(val["watchId"], "w1");
        assert_eq!(val["newMatches"], 3);
        assert_eq!(val["totalMatches"], 10);
    }

    #[test]
    fn watch_info_serde() {
        let info = WatchInfo {
            watch_id: "w1".to_string(),
            session_id: "s1".to_string(),
            total_matches: 5,
            active: true,
            criteria: make_criteria("test"),
        };
        let val: serde_json::Value = serde_json::to_value(&info).unwrap();
        assert_eq!(val["watchId"], "w1");
        assert!(val["active"].as_bool().unwrap());
        assert!(val.get("criteria").is_some());
    }
}
