use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::core::line::LogLevel;

// ---------------------------------------------------------------------------
// Filter criteria — what lines to match
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CombineMode {
    #[default]
    And,
    Or,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterCriteria {
    /// Substring search (case-insensitive).
    #[serde(default)]
    pub text_search: Option<String>,
    /// Regex pattern for message content.
    #[serde(default)]
    pub regex: Option<String>,
    /// Include only lines at these log levels.
    #[serde(default)]
    pub log_levels: Option<Vec<LogLevel>>,
    /// Include only lines whose tag contains any of these substrings (case-insensitive).
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// Minimum timestamp (ns since 2000-01-01 UTC, inclusive).
    #[serde(default)]
    pub time_start: Option<i64>,
    /// Maximum timestamp (ns since 2000-01-01 UTC, inclusive).
    #[serde(default)]
    pub time_end: Option<i64>,
    /// PID filter.
    #[serde(default)]
    pub pids: Option<Vec<i32>>,
    /// How to combine criteria (default: AND).
    #[serde(default)]
    pub combine: CombineMode,
}

impl FilterCriteria {
    /// Compile `regex` if one is set, rejecting an invalid pattern instead of
    /// degrading to "matches nothing".
    ///
    /// Every path that creates a filter or a watch must call this before it
    /// starts scanning. `line_matches_criteria` treats an uncompiled regex as a
    /// non-match, so an unvalidated bad pattern yields a filter that scans the
    /// whole source and reports zero matches with no error — indistinguishable
    /// from a valid filter that genuinely found nothing.
    pub fn compile_regex(&self) -> Result<Option<regex::Regex>, String> {
        let Some(pattern) = self.regex.as_deref() else {
            return Ok(None);
        };
        regex::Regex::new(pattern)
            .map(Some)
            .map_err(|e| format!("Invalid regex '{pattern}': {e}"))
    }

    /// Precompute the lowercased `text_search` and `tags` needles used by
    /// [`line_matches_criteria_with_needles`].
    ///
    /// Call this once per scan — exactly like [`compile_regex`] — and pass
    /// the result to every `line_matches_criteria_with_needles` call instead
    /// of letting the needles be re-lowercased on every line. The criteria
    /// are immutable for the whole scan, so re-lowercasing `text_search`/
    /// `tags` per line (as the plain [`line_matches_criteria`] does, for
    /// backward-compat single-call use) is wasted allocation repeated once
    /// per scanned line.
    pub fn precompute_needles(&self) -> PrecomputedNeedles {
        PrecomputedNeedles {
            text_search_lower: self.text_search.as_ref().map(|t| t.to_lowercase()),
            tags_lower: self
                .tags
                .as_ref()
                .map(|tags| tags.iter().map(|t| t.to_lowercase()).collect()),
        }
    }
}

/// Lowercased needles precomputed once per scan by
/// [`FilterCriteria::precompute_needles`]. See that method's doc for why this
/// exists — mirrors how a regex is compiled once via `compile_regex()`
/// rather than per line.
#[derive(Debug, Clone, Default)]
pub struct PrecomputedNeedles {
    text_search_lower: Option<String>,
    tags_lower: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// FilteredLineSet — the result of a filter scan
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct FilteredLineSet {
    /// Sorted list of matching absolute line numbers.
    pub matched_lines: Vec<usize>,
}

// ---------------------------------------------------------------------------
// FilterStatus — lifecycle of a filter session
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FilterStatus {
    Scanning = 0,
    Complete = 1,
    Cancelled = 2,
}

impl FilterStatus {
    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => FilterStatus::Scanning,
            2 => FilterStatus::Cancelled,
            _ => FilterStatus::Complete,
        }
    }
}

// ---------------------------------------------------------------------------
// FilterSession — a persistent filter handle
// ---------------------------------------------------------------------------

pub struct FilterSession {
    pub filter_id: String,
    pub session_id: String,
    pub criteria: FilterCriteria,
    /// Current matched results (grows as scanning progresses).
    pub results: Mutex<FilteredLineSet>,
    /// Number of lines scanned so far.
    pub lines_scanned: std::sync::atomic::AtomicUsize,
    /// Total lines in the source at creation time.
    pub total_lines: std::sync::atomic::AtomicUsize,
    /// Current status.
    pub status: AtomicU8,
    /// Cancellation flag — set to true to stop scanning.
    pub cancelled: AtomicBool,
}

impl FilterSession {
    pub fn new(
        filter_id: String,
        session_id: String,
        criteria: FilterCriteria,
        total_lines: usize,
    ) -> Self {
        Self {
            filter_id,
            session_id,
            criteria,
            results: Mutex::new(FilteredLineSet::default()),
            lines_scanned: std::sync::atomic::AtomicUsize::new(0),
            total_lines: std::sync::atomic::AtomicUsize::new(total_lines),
            status: AtomicU8::new(FilterStatus::Scanning as u8),
            cancelled: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> FilterStatus {
        FilterStatus::from_u8(self.status.load(Ordering::Relaxed))
    }

    pub fn set_status(&self, s: FilterStatus) {
        self.status.store(s as u8, Ordering::Relaxed);
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        self.set_status(FilterStatus::Cancelled);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Append newly matched line numbers (must be sorted, greater than existing).
    pub fn append_matches(&self, line_nums: &[usize]) {
        if let Ok(mut results) = self.results.lock() {
            results.matched_lines.extend_from_slice(line_nums);
        }
    }

    /// Get a snapshot of the current matched line count.
    pub fn matched_count(&self) -> usize {
        self.results.lock().map(|r| r.matched_lines.len()).unwrap_or(0)
    }

    /// Get paginated results: offset..offset+count from the matched lines.
    pub fn get_page(&self, offset: usize, count: usize) -> Vec<usize> {
        if let Ok(results) = self.results.lock() {
            results.matched_lines.iter()
                .skip(offset)
                .take(count)
                .copied()
                .collect()
        } else {
            vec![]
        }
    }

    /// Update total_lines (for live streams where total grows).
    pub fn set_total_lines(&self, total: usize) {
        self.total_lines.store(total, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Filter evaluation — does a line match the criteria?
// ---------------------------------------------------------------------------

/// Evaluate filter criteria against a single line.
/// `raw` is the raw line text, `level` is the parsed log level,
/// `tag` is the resolved tag string, `timestamp` is ns since 2000-01-01,
/// `pid` is the process ID.
/// `compiled_regex` is a pre-compiled regex (pass None if no regex in criteria).
///
/// This re-lowercases `criteria.text_search`/`criteria.tags` on every call,
/// which is fine for one-off checks (e.g. a single watch evaluation) but
/// wasteful in a full-scan hot loop over many lines with the same immutable
/// criteria. Scan loops should call [`FilterCriteria::precompute_needles`]
/// once and use [`line_matches_criteria_with_needles`] instead.
pub fn line_matches_criteria(
    criteria: &FilterCriteria,
    raw: &str,
    level: LogLevel,
    tag: &str,
    timestamp: i64,
    pid: i32,
    compiled_regex: Option<&regex::Regex>,
) -> bool {
    line_matches_criteria_impl(criteria, None, raw, level, tag, timestamp, pid, compiled_regex)
}

/// Same as [`line_matches_criteria`], but takes needles precomputed once per
/// scan via [`FilterCriteria::precompute_needles`] instead of re-lowercasing
/// `text_search`/`tags` on every call. Use this in scan loops that evaluate
/// the same (immutable-for-the-scan) criteria against many lines.
pub fn line_matches_criteria_with_needles(
    criteria: &FilterCriteria,
    needles: &PrecomputedNeedles,
    raw: &str,
    level: LogLevel,
    tag: &str,
    timestamp: i64,
    pid: i32,
    compiled_regex: Option<&regex::Regex>,
) -> bool {
    line_matches_criteria_impl(criteria, Some(needles), raw, level, tag, timestamp, pid, compiled_regex)
}

#[allow(clippy::too_many_arguments)]
fn line_matches_criteria_impl(
    criteria: &FilterCriteria,
    needles: Option<&PrecomputedNeedles>,
    raw: &str,
    level: LogLevel,
    tag: &str,
    timestamp: i64,
    pid: i32,
    compiled_regex: Option<&regex::Regex>,
) -> bool {
    let combine_and = matches!(criteria.combine, CombineMode::And);

    let mut checks: Vec<bool> = Vec::new();

    // Text search (case-insensitive substring). The needle (criteria.text_search)
    // is immutable for the whole scan, so a caller scanning many lines should
    // supply it precomputed via `needles` rather than have it lowercased here
    // on every call.
    if let Some(ref text) = criteria.text_search {
        match needles.and_then(|n| n.text_search_lower.as_deref()) {
            Some(needle) => checks.push(raw.to_lowercase().contains(needle)),
            None => {
                let needle = text.to_lowercase();
                checks.push(raw.to_lowercase().contains(&needle));
            }
        }
    }

    // Regex match
    if criteria.regex.is_some() {
        if let Some(re) = compiled_regex {
            checks.push(re.is_match(raw));
        } else {
            // Regex was specified but no compiled regex was supplied. Callers
            // validate via FilterCriteria::compile_regex before scanning, so
            // this is a defensive fallback, not a reachable user-facing path.
            checks.push(false);
        }
    }

    // Log level filter
    if let Some(ref levels) = criteria.log_levels {
        if !levels.is_empty() {
            checks.push(levels.contains(&level));
        }
    }

    // Tag filter. `tags_lower` (the configured needle list) is immutable for
    // the whole scan; `tag_lower` (this line's resolved tag) necessarily
    // varies per line and can't be hoisted.
    if let Some(ref tags) = criteria.tags {
        if !tags.is_empty() {
            let tag_lower = tag.to_lowercase();
            match needles.and_then(|n| n.tags_lower.as_deref()) {
                Some(tags_lower) => {
                    checks.push(tags_lower.iter().any(|t| tag_lower.contains(t.as_str())));
                }
                None => {
                    checks.push(tags.iter().any(|t| tag_lower.contains(&t.to_lowercase() as &str)));
                }
            }
        }
    }

    // Time range
    if let Some(start) = criteria.time_start {
        if timestamp > 0 {
            checks.push(timestamp >= start);
        } else {
            checks.push(false); // No timestamp = doesn't match time filter
        }
    }
    if let Some(end) = criteria.time_end {
        if timestamp > 0 {
            checks.push(timestamp <= end);
        } else {
            checks.push(false);
        }
    }

    // PID filter
    if let Some(ref pids) = criteria.pids {
        if !pids.is_empty() {
            checks.push(pids.contains(&pid));
        }
    }

    // If no criteria were specified, match everything
    if checks.is_empty() {
        return true;
    }

    if combine_and {
        checks.iter().all(|&c| c)
    } else {
        checks.iter().any(|&c| c)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_criteria() -> FilterCriteria {
        FilterCriteria {
            text_search: None,
            regex: None,
            log_levels: None,
            tags: None,
            time_start: None,
            time_end: None,
            pids: None,
            combine: CombineMode::And,
        }
    }

    #[test]
    fn empty_criteria_matches_everything() {
        let c = make_criteria();
        assert!(line_matches_criteria(&c, "hello world", LogLevel::Info, "MyTag", 100, 1234, None));
    }

    #[test]
    fn text_search_case_insensitive() {
        let mut c = make_criteria();
        c.text_search = Some("ERROR".to_string());
        assert!(line_matches_criteria(&c, "Something error happened", LogLevel::Error, "", 0, 0, None));
        assert!(!line_matches_criteria(&c, "All is fine", LogLevel::Info, "", 0, 0, None));
    }

    #[test]
    fn compile_regex_none_when_unset() {
        let c = make_criteria();
        assert!(c.compile_regex().unwrap().is_none());
    }

    #[test]
    fn compile_regex_returns_compiled_pattern() {
        let mut c = make_criteria();
        c.regex = Some(r"\d{3}-\d{4}".to_string());
        let re = c.compile_regex().unwrap().expect("valid pattern must compile");
        assert!(re.is_match("Call 555-1234"));
    }

    #[test]
    fn compile_regex_rejects_invalid_pattern() {
        let mut c = make_criteria();
        c.regex = Some(r"[unterminated".to_string());
        let err = c.compile_regex().expect_err("invalid pattern must be an error");
        assert!(err.contains("[unterminated"), "error should quote the pattern: {err}");
    }

    #[test]
    fn compile_regex_rejects_lookahead_unsupported_by_rust_regex() {
        // The regex crate has no look-around. Without create-time validation
        // this compiles to None and the filter silently matches nothing.
        let mut c = make_criteria();
        c.regex = Some(r"foo(?!bar)".to_string());
        assert!(c.compile_regex().is_err());
    }

    #[test]
    fn regex_filter() {
        let mut c = make_criteria();
        c.regex = Some(r"\d{3}-\d{4}".to_string());
        let re = regex::Regex::new(r"\d{3}-\d{4}").unwrap();
        assert!(line_matches_criteria(&c, "Call 555-1234", LogLevel::Info, "", 0, 0, Some(&re)));
        assert!(!line_matches_criteria(&c, "No number here", LogLevel::Info, "", 0, 0, Some(&re)));
    }

    #[test]
    fn log_level_filter() {
        let mut c = make_criteria();
        c.log_levels = Some(vec![LogLevel::Error, LogLevel::Fatal]);
        assert!(line_matches_criteria(&c, "x", LogLevel::Error, "", 0, 0, None));
        assert!(line_matches_criteria(&c, "x", LogLevel::Fatal, "", 0, 0, None));
        assert!(!line_matches_criteria(&c, "x", LogLevel::Info, "", 0, 0, None));
    }

    #[test]
    fn tag_filter() {
        let mut c = make_criteria();
        // Substring match: "Activity" matches "ActivityManager" and "ActivityThread"
        c.tags = Some(vec!["Activity".to_string(), "SystemServer".to_string()]);
        assert!(line_matches_criteria(&c, "x", LogLevel::Info, "ActivityManager", 0, 0, None));
        assert!(line_matches_criteria(&c, "x", LogLevel::Info, "ActivityThread", 0, 0, None));
        assert!(line_matches_criteria(&c, "x", LogLevel::Info, "SystemServer", 0, 0, None));
        assert!(!line_matches_criteria(&c, "x", LogLevel::Info, "Zygote", 0, 0, None));
        // Case-insensitive
        assert!(line_matches_criteria(&c, "x", LogLevel::Info, "activitymanager", 0, 0, None));
    }

    #[test]
    fn time_range_filter() {
        let mut c = make_criteria();
        c.time_start = Some(100);
        c.time_end = Some(200);
        assert!(line_matches_criteria(&c, "x", LogLevel::Info, "", 150, 0, None));
        assert!(!line_matches_criteria(&c, "x", LogLevel::Info, "", 50, 0, None));
        assert!(!line_matches_criteria(&c, "x", LogLevel::Info, "", 250, 0, None));
        // timestamp=0 means no timestamp → doesn't match time filter
        assert!(!line_matches_criteria(&c, "x", LogLevel::Info, "", 0, 0, None));
    }

    #[test]
    fn pid_filter() {
        let mut c = make_criteria();
        c.pids = Some(vec![1000, 2000]);
        assert!(line_matches_criteria(&c, "x", LogLevel::Info, "", 0, 1000, None));
        assert!(!line_matches_criteria(&c, "x", LogLevel::Info, "", 0, 3000, None));
    }

    #[test]
    fn and_combine_requires_all() {
        let mut c = make_criteria();
        c.combine = CombineMode::And;
        c.text_search = Some("error".to_string());
        c.log_levels = Some(vec![LogLevel::Error]);
        // Both match
        assert!(line_matches_criteria(&c, "an error occurred", LogLevel::Error, "", 0, 0, None));
        // Text matches but level doesn't
        assert!(!line_matches_criteria(&c, "an error occurred", LogLevel::Info, "", 0, 0, None));
    }

    #[test]
    fn or_combine_requires_any() {
        let mut c = make_criteria();
        c.combine = CombineMode::Or;
        c.text_search = Some("error".to_string());
        c.log_levels = Some(vec![LogLevel::Fatal]);
        // Text matches, level doesn't → still matches in OR mode
        assert!(line_matches_criteria(&c, "an error occurred", LogLevel::Info, "", 0, 0, None));
        // Neither matches
        assert!(!line_matches_criteria(&c, "all good", LogLevel::Info, "", 0, 0, None));
    }

    #[test]
    fn filter_session_lifecycle() {
        let fs = FilterSession::new("f1".into(), "s1".into(), make_criteria(), 1000);
        assert_eq!(fs.status(), FilterStatus::Scanning);
        assert_eq!(fs.matched_count(), 0);

        fs.append_matches(&[10, 20, 30]);
        assert_eq!(fs.matched_count(), 3);

        fs.append_matches(&[40, 50]);
        assert_eq!(fs.matched_count(), 5);

        let page = fs.get_page(1, 3);
        assert_eq!(page, vec![20, 30, 40]);

        fs.set_status(FilterStatus::Complete);
        assert_eq!(fs.status(), FilterStatus::Complete);
    }

    #[test]
    fn filter_session_cancellation() {
        let fs = FilterSession::new("f1".into(), "s1".into(), make_criteria(), 100);
        assert!(!fs.is_cancelled());
        fs.cancel();
        assert!(fs.is_cancelled());
        assert_eq!(fs.status(), FilterStatus::Cancelled);
    }

    #[test]
    fn get_page_out_of_range() {
        let fs = FilterSession::new("f1".into(), "s1".into(), make_criteria(), 100);
        fs.append_matches(&[10, 20, 30]);
        // Offset beyond matched count returns empty
        let page = fs.get_page(10, 5);
        assert!(page.is_empty());
        // Count exceeding remaining returns what's available
        let page = fs.get_page(2, 100);
        assert_eq!(page, vec![30]);
    }

    #[test]
    fn multiple_criteria_and_mode() {
        let mut c = make_criteria();
        c.combine = CombineMode::And;
        c.text_search = Some("wifi".to_string());
        c.tags = Some(vec!["WifiService".to_string()]);
        c.log_levels = Some(vec![LogLevel::Error, LogLevel::Warn]);
        // All three match
        assert!(line_matches_criteria(&c, "wifi disconnected", LogLevel::Error, "WifiService", 100, 0, None));
        // Tag doesn't match
        assert!(!line_matches_criteria(&c, "wifi disconnected", LogLevel::Error, "Other", 100, 0, None));
        // Text doesn't match
        assert!(!line_matches_criteria(&c, "bluetooth error", LogLevel::Error, "WifiService", 100, 0, None));
    }

    #[test]
    fn regex_without_compiled_returns_false() {
        let mut c = make_criteria();
        c.regex = Some(r"\d+".to_string());
        // Pass None for compiled regex — means compilation failed
        assert!(!line_matches_criteria(&c, "test 123", LogLevel::Info, "", 0, 0, None));
    }

    #[test]
    fn empty_level_and_tag_lists_dont_filter() {
        let mut c = make_criteria();
        c.log_levels = Some(vec![]); // empty list = no level filter applied
        c.tags = Some(vec![]); // empty list = no tag filter applied
        assert!(line_matches_criteria(&c, "anything", LogLevel::Debug, "AnyTag", 0, 0, None));
    }

    #[test]
    fn time_start_only() {
        let mut c = make_criteria();
        c.time_start = Some(500);
        assert!(line_matches_criteria(&c, "x", LogLevel::Info, "", 500, 0, None));
        assert!(line_matches_criteria(&c, "x", LogLevel::Info, "", 999, 0, None));
        assert!(!line_matches_criteria(&c, "x", LogLevel::Info, "", 499, 0, None));
    }

    #[test]
    fn time_end_only() {
        let mut c = make_criteria();
        c.time_end = Some(500);
        assert!(line_matches_criteria(&c, "x", LogLevel::Info, "", 500, 0, None));
        assert!(line_matches_criteria(&c, "x", LogLevel::Info, "", 100, 0, None));
        assert!(!line_matches_criteria(&c, "x", LogLevel::Info, "", 501, 0, None));
    }

    #[test]
    fn set_total_lines_updates() {
        let fs = FilterSession::new("f1".into(), "s1".into(), make_criteria(), 100);
        assert_eq!(fs.total_lines.load(std::sync::atomic::Ordering::Relaxed), 100);
        fs.set_total_lines(200);
        assert_eq!(fs.total_lines.load(std::sync::atomic::Ordering::Relaxed), 200);
    }

    #[test]
    fn filter_status_round_trip() {
        assert_eq!(FilterStatus::from_u8(0), FilterStatus::Scanning);
        assert_eq!(FilterStatus::from_u8(1), FilterStatus::Complete);
        assert_eq!(FilterStatus::from_u8(2), FilterStatus::Cancelled);
        assert_eq!(FilterStatus::from_u8(255), FilterStatus::Complete); // fallback
    }

    #[test]
    fn or_mode_all_fail() {
        let mut c = make_criteria();
        c.combine = CombineMode::Or;
        c.text_search = Some("xyz".to_string());
        c.log_levels = Some(vec![LogLevel::Fatal]);
        c.tags = Some(vec!["NonExistent".to_string()]);
        assert!(!line_matches_criteria(&c, "hello world", LogLevel::Info, "SomeTag", 0, 0, None));
    }

    #[test]
    fn pid_filter_combined_with_text() {
        let mut c = make_criteria();
        c.combine = CombineMode::And;
        c.text_search = Some("crash".to_string());
        c.pids = Some(vec![1234]);
        assert!(line_matches_criteria(&c, "app crash detected", LogLevel::Error, "", 0, 1234, None));
        assert!(!line_matches_criteria(&c, "app crash detected", LogLevel::Error, "", 0, 5678, None));
        assert!(!line_matches_criteria(&c, "app running fine", LogLevel::Error, "", 0, 1234, None));
    }

    // ── PrecomputedNeedles / line_matches_criteria_with_needles ─────────────
    // Needle lowercasing (text_search, tags) is hoisted out of the per-line
    // hot loop into `precompute_needles()`, called once per scan. These
    // tests verify the needle-aware path matches the exact same lines as the
    // original per-call `line_matches_criteria` for text and tag filters,
    // case-insensitively.

    #[test]
    fn precomputed_text_search_matches_same_as_unhoisted() {
        let mut c = make_criteria();
        c.text_search = Some("ERROR".to_string());
        let needles = c.precompute_needles();

        let cases = ["Something error happened", "SOMETHING ERROR HAPPENED", "All is fine", "ErRoR mid-word"];
        for raw in cases {
            let expected = line_matches_criteria(&c, raw, LogLevel::Info, "", 0, 0, None);
            let actual = line_matches_criteria_with_needles(&c, &needles, raw, LogLevel::Info, "", 0, 0, None);
            assert_eq!(actual, expected, "mismatch for raw={raw:?}");
        }
        assert!(line_matches_criteria_with_needles(&c, &needles, "an ERROR occurred", LogLevel::Info, "", 0, 0, None));
        assert!(!line_matches_criteria_with_needles(&c, &needles, "all good", LogLevel::Info, "", 0, 0, None));
    }

    #[test]
    fn precomputed_tag_filter_matches_same_as_unhoisted() {
        let mut c = make_criteria();
        c.tags = Some(vec!["Activity".to_string(), "SystemServer".to_string()]);
        let needles = c.precompute_needles();

        let cases: &[(&str, bool)] = &[
            ("ActivityManager", true),
            ("activitymanager", true),
            ("ACTIVITYTHREAD", true),
            ("SystemServer", true),
            ("Zygote", false),
        ];
        for &(tag, expected) in cases {
            let via_old = line_matches_criteria(&c, "x", LogLevel::Info, tag, 0, 0, None);
            let via_new = line_matches_criteria_with_needles(&c, &needles, "x", LogLevel::Info, tag, 0, 0, None);
            assert_eq!(via_old, expected, "baseline mismatch for tag={tag:?}");
            assert_eq!(via_new, expected, "hoisted-needle mismatch for tag={tag:?}");
        }
    }

    #[test]
    fn precomputed_needles_combine_with_pid_and_regex() {
        let mut c = make_criteria();
        c.combine = CombineMode::And;
        c.text_search = Some("crash".to_string());
        c.tags = Some(vec!["Zygote".to_string()]);
        c.pids = Some(vec![1234]);
        let needles = c.precompute_needles();

        assert!(line_matches_criteria_with_needles(
            &c, &needles, "app CRASH detected", LogLevel::Error, "ZYGOTE", 0, 1234, None
        ));
        assert!(!line_matches_criteria_with_needles(
            &c, &needles, "app CRASH detected", LogLevel::Error, "ZYGOTE", 0, 5678, None
        ));
        assert!(!line_matches_criteria_with_needles(
            &c, &needles, "app running fine", LogLevel::Error, "ZYGOTE", 0, 1234, None
        ));
    }

    #[test]
    fn precompute_needles_is_none_when_criteria_unset() {
        let c = make_criteria();
        let needles = c.precompute_needles();
        // No text_search/tags configured — should behave identically to the
        // no-filter case for both entry points.
        assert!(line_matches_criteria(&c, "anything", LogLevel::Info, "AnyTag", 0, 0, None));
        assert!(line_matches_criteria_with_needles(&c, &needles, "anything", LogLevel::Info, "AnyTag", 0, 0, None));
    }
}
