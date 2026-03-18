//! Shared filter-rule evaluation used by reporter, transformer, and correlator engines.
//!
//! Each engine previously had its own copy of `rule_matches`, `get_or_compile`,
//! `parse_level`, and `parse_time_hms`. This module centralizes them so new
//! `FilterRule` variants only need to be added in one place.

use regex::Regex;
use std::collections::HashMap;

use crate::core::line::{LineContext, LogLevel, PipelineContext};
use crate::processors::reporter::schema::FilterRule;

/// Result of evaluating a single `FilterRule` against a log line.
///
/// Carries both the match/no-match outcome and any regex capture groups
/// extracted during matching (used by `TagRegex` and `MessageRegex`).
#[derive(Debug, Clone)]
pub struct FilterMatch {
    pub matched: bool,
    /// Captured groups: `(group_index, captured_string)`.
    /// Empty for non-regex rules or when no groups are present.
    pub captures: Vec<(usize, String)>,
}

impl FilterMatch {
    pub fn no_match() -> Self {
        Self { matched: false, captures: vec![] }
    }
    pub fn matched() -> Self {
        Self { matched: true, captures: vec![] }
    }
    pub fn with_captures(caps: Vec<(usize, String)>) -> Self {
        Self { matched: true, captures: caps }
    }
}

/// Evaluate a single `FilterRule` against a log line.
///
/// `pipeline_ctx` is `Some` for reporters (which support `SourceTypeIs` /
/// `SectionIs`), and `None` for transformers and correlators where those
/// variants are rejected at install time and default to passthrough.
pub fn rule_matches(
    regex_cache: &mut HashMap<String, Regex>,
    rule: &FilterRule,
    line: &LineContext,
    pipeline_ctx: Option<&PipelineContext>,
) -> FilterMatch {
    match rule {
        FilterRule::TagMatch { tag_set, tags } => {
            let line_tag: &str = &line.tag;
            let matched = if !tag_set.is_empty() {
                tag_set.iter().any(|t| line_tag.starts_with(t.as_str()))
            } else {
                tags.iter().any(|t| line_tag.starts_with(t.as_str()))
            };
            if matched { FilterMatch::matched() } else { FilterMatch::no_match() }
        }
        FilterRule::TagRegex { pattern } => {
            match get_or_compile(regex_cache, pattern) {
                Some(re) => {
                    match re.captures(&line.tag) {
                        Some(caps) => {
                            let captures: Vec<(usize, String)> = caps.iter()
                                .enumerate()
                                .skip(1)
                                .filter_map(|(i, m)| m.map(|m| (i, m.as_str().to_string())))
                                .collect();
                            FilterMatch::with_captures(captures)
                        }
                        None => FilterMatch::no_match(),
                    }
                }
                None => FilterMatch::no_match(),
            }
        }
        FilterRule::MessageContains { value } => {
            if line.message.contains(value.as_str()) {
                FilterMatch::matched()
            } else {
                FilterMatch::no_match()
            }
        }
        FilterRule::MessageContainsAny { values } => {
            if values.iter().any(|v| line.message.contains(v.as_str())) {
                FilterMatch::matched()
            } else {
                FilterMatch::no_match()
            }
        }
        FilterRule::MessageRegex { pattern } => {
            match get_or_compile(regex_cache, pattern) {
                Some(re) => {
                    match re.captures(&line.message) {
                        Some(caps) => {
                            let captures: Vec<(usize, String)> = caps.iter()
                                .enumerate()
                                .skip(1)
                                .filter_map(|(i, m)| m.map(|m| (i, m.as_str().to_string())))
                                .collect();
                            FilterMatch::with_captures(captures)
                        }
                        None => FilterMatch::no_match(),
                    }
                }
                None => FilterMatch::no_match(),
            }
        }
        FilterRule::LevelMin { level } => {
            let min = parse_level(level).unwrap_or(LogLevel::Verbose);
            if line.level >= min { FilterMatch::matched() } else { FilterMatch::no_match() }
        }
        FilterRule::TimeRange { from, to, from_ns, to_ns } => {
            let nanos_per_day = 86_400_000_000_000i64;
            let time_of_day = line.timestamp.rem_euclid(nanos_per_day);
            let from_val = from_ns.unwrap_or_else(|| parse_time_hms(from));
            let to_val = to_ns.unwrap_or_else(|| parse_time_hms(to));
            if time_of_day >= from_val && time_of_day <= to_val {
                FilterMatch::matched()
            } else {
                FilterMatch::no_match()
            }
        }
        FilterRule::SourceTypeIs { source_type } => {
            match pipeline_ctx {
                Some(ctx) => {
                    if ctx.source_type.matches_str(source_type) {
                        FilterMatch::matched()
                    } else {
                        FilterMatch::no_match()
                    }
                }
                None => FilterMatch::matched(), // passthrough for engines that don't support it
            }
        }
        FilterRule::SectionIs { section } => {
            match pipeline_ctx {
                Some(ctx) => {
                    let line_section = crate::core::line::section_for_line(&ctx.sections, line.source_line_num);
                    if line_section == section {
                        FilterMatch::matched()
                    } else {
                        FilterMatch::no_match()
                    }
                }
                None => FilterMatch::matched(),
            }
        }
    }
}

/// Compile and cache a regex pattern. Returns `None` for invalid patterns.
pub fn get_or_compile<'a>(
    cache: &'a mut HashMap<String, Regex>,
    pattern: &str,
) -> Option<&'a Regex> {
    if !cache.contains_key(pattern) {
        if let Ok(re) = Regex::new(pattern) {
            cache.insert(pattern.to_string(), re);
        } else {
            return None;
        }
    }
    cache.get(pattern)
}

/// Parse a log-level string (short or long form) into a `LogLevel`.
/// Delegates to [`LogLevel::from_str_loose`].
pub fn parse_level(s: &str) -> Option<LogLevel> {
    LogLevel::from_str_loose(s)
}

/// Parse `HH:MM:SS.mmm` into nanoseconds since midnight.
pub fn parse_time_hms(s: &str) -> i64 {
    let parts: Vec<&str> = s.splitn(3, ':').collect();
    if parts.len() < 3 {
        return 0;
    }
    let h = parts[0].parse::<i64>().unwrap_or(0);
    let m = parts[1].parse::<i64>().unwrap_or(0);
    let sec_ms: Vec<&str> = parts[2].splitn(2, '.').collect();
    let sec = sec_ms[0].parse::<i64>().unwrap_or(0);
    let ms = sec_ms.get(1).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    (h * 3_600 + m * 60 + sec) * 1_000_000_000 + ms * 1_000_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn make_line(tag: &str, message: &str, level: LogLevel) -> LineContext {
        LineContext {
            raw: Arc::from(message),
            timestamp: 0,
            level,
            tag: Arc::from(tag),
            pid: 0,
            tid: 0,
            message: Arc::from(message),
            source_id: Arc::from(""),
            source_line_num: 1,
            fields: HashMap::new(),
            annotations: vec![],
        }
    }

    #[test]
    fn tag_match_uses_prefix() {
        let mut cache = HashMap::new();
        let rule = FilterRule::TagMatch {
            tag_set: Default::default(),
            tags: vec!["Wifi".to_string()],
        };
        let line = make_line("WifiService", "connected", LogLevel::Info);
        assert!(rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn tag_match_exact_no_prefix() {
        let mut cache = HashMap::new();
        let rule = FilterRule::TagMatch {
            tag_set: Default::default(),
            tags: vec!["WifiService".to_string()],
        };
        let line = make_line("Wifi", "connected", LogLevel::Info);
        assert!(!rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn tag_regex_matches_and_captures() {
        let mut cache = HashMap::new();
        let rule = FilterRule::TagRegex { pattern: r"NetworkMonitor/(\d+)".to_string() };
        let line = make_line("NetworkMonitor/102", "validation", LogLevel::Info);
        let result = rule_matches(&mut cache, &rule, &line, None);
        assert!(result.matched);
        assert_eq!(result.captures.len(), 1);
        assert_eq!(result.captures[0], (1, "102".to_string()));
    }

    #[test]
    fn tag_regex_no_match() {
        let mut cache = HashMap::new();
        let rule = FilterRule::TagRegex { pattern: r"NetworkMonitor/(\d+)".to_string() };
        let line = make_line("WifiService", "test", LogLevel::Info);
        assert!(!rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn message_contains() {
        let mut cache = HashMap::new();
        let rule = FilterRule::MessageContains { value: "error".to_string() };
        let line = make_line("Tag", "an error occurred", LogLevel::Error);
        assert!(rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn level_min_filters_below() {
        let mut cache = HashMap::new();
        let rule = FilterRule::LevelMin { level: "W".to_string() };
        let line = make_line("Tag", "debug msg", LogLevel::Debug);
        assert!(!rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn level_min_passes_at_or_above() {
        let mut cache = HashMap::new();
        let rule = FilterRule::LevelMin { level: "W".to_string() };
        let line = make_line("Tag", "warning msg", LogLevel::Warn);
        assert!(rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn source_type_passthrough_without_ctx() {
        let mut cache = HashMap::new();
        let rule = FilterRule::SourceTypeIs { source_type: "logcat".to_string() };
        let line = make_line("Tag", "msg", LogLevel::Info);
        assert!(rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn section_is_passthrough_without_ctx() {
        let mut cache = HashMap::new();
        let rule = FilterRule::SectionIs { section: "SYSTEM LOG".to_string() };
        let line = make_line("Tag", "msg", LogLevel::Info);
        assert!(rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn parse_level_variants() {
        assert_eq!(parse_level("V"), Some(LogLevel::Verbose));
        assert_eq!(parse_level("verbose"), Some(LogLevel::Verbose));
        assert_eq!(parse_level("WARNING"), Some(LogLevel::Warn));
        assert_eq!(parse_level("A"), Some(LogLevel::Fatal));
        assert_eq!(parse_level("ASSERT"), Some(LogLevel::Fatal));
        assert_eq!(parse_level("unknown"), None);
    }

    #[test]
    fn parse_time_hms_basic() {
        let ns = parse_time_hms("01:02:03.456");
        let expected = (1 * 3600 + 2 * 60 + 3) * 1_000_000_000i64 + 456 * 1_000_000;
        assert_eq!(ns, expected);
    }

    #[test]
    fn parse_time_hms_short_input() {
        assert_eq!(parse_time_hms("12:30"), 0);
    }

    // ── Gap 5: TimeRange and context-based rules ─────────────────────────────

    fn make_line_with_ts(tag: &str, message: &str, level: LogLevel, timestamp: i64) -> LineContext {
        LineContext {
            raw: Arc::from(message),
            timestamp,
            level,
            tag: Arc::from(tag),
            pid: 0,
            tid: 0,
            message: Arc::from(message),
            source_id: Arc::from(""),
            source_line_num: 1,
            fields: HashMap::new(),
            annotations: vec![],
        }
    }

    fn make_line_with_line_num(tag: &str, message: &str, level: LogLevel, line_num: usize) -> LineContext {
        LineContext {
            raw: Arc::from(message),
            timestamp: 0,
            level,
            tag: Arc::from(tag),
            pid: 0,
            tid: 0,
            message: Arc::from(message),
            source_id: Arc::from(""),
            source_line_num: line_num,
            fields: HashMap::new(),
            annotations: vec![],
        }
    }

    #[test]
    fn time_range_within_window() {
        let mut cache = HashMap::new();
        let rule = FilterRule::TimeRange {
            from: "10:00:00".into(),
            to: "12:00:00".into(),
            from_ns: None,
            to_ns: None,
        };
        // 11:00:00 in nanos = 11 * 3600 * 1_000_000_000
        let ts = 11i64 * 3600 * 1_000_000_000;
        let line = make_line_with_ts("Tag", "msg", LogLevel::Info, ts);
        assert!(rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn time_range_outside_window() {
        let mut cache = HashMap::new();
        let rule = FilterRule::TimeRange {
            from: "10:00:00".into(),
            to: "12:00:00".into(),
            from_ns: None,
            to_ns: None,
        };
        // 09:00:00 in nanos = 9 * 3600 * 1_000_000_000
        let ts = 9i64 * 3600 * 1_000_000_000;
        let line = make_line_with_ts("Tag", "msg", LogLevel::Info, ts);
        assert!(!rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn time_range_with_precomputed_ns() {
        let mut cache = HashMap::new();
        let from_val = 10i64 * 3600 * 1_000_000_000;
        let to_val = 12i64 * 3600 * 1_000_000_000;
        let rule = FilterRule::TimeRange {
            from: "10:00:00".into(),
            to: "12:00:00".into(),
            from_ns: Some(from_val),
            to_ns: Some(to_val),
        };
        let ts = 11i64 * 3600 * 1_000_000_000;
        let line = make_line_with_ts("Tag", "msg", LogLevel::Info, ts);
        assert!(rule_matches(&mut cache, &rule, &line, None).matched);
    }

    #[test]
    fn source_type_is_matches_with_context() {
        use crate::core::line::PipelineContext;
        use crate::core::session::SourceType;
        let mut cache = HashMap::new();
        let rule = FilterRule::SourceTypeIs { source_type: "Logcat".into() };
        let line = make_line("Tag", "msg", LogLevel::Info);
        let ctx = PipelineContext {
            source_type: SourceType::Logcat,
            source_name: std::sync::Arc::from("test"),
            is_streaming: false,
            sections: std::sync::Arc::from([]),
        };
        assert!(rule_matches(&mut cache, &rule, &line, Some(&ctx)).matched);
    }

    #[test]
    fn source_type_is_rejects_mismatch_with_context() {
        use crate::core::line::PipelineContext;
        use crate::core::session::SourceType;
        let mut cache = HashMap::new();
        let rule = FilterRule::SourceTypeIs { source_type: "Logcat".into() };
        let line = make_line("Tag", "msg", LogLevel::Info);
        let ctx = PipelineContext {
            source_type: SourceType::Bugreport,
            source_name: std::sync::Arc::from("test"),
            is_streaming: false,
            sections: std::sync::Arc::from([]),
        };
        assert!(!rule_matches(&mut cache, &rule, &line, Some(&ctx)).matched);
    }

    #[test]
    fn section_is_matches_with_context() {
        use crate::core::line::PipelineContext;
        use crate::core::session::{SectionInfo, SourceType};
        let mut cache = HashMap::new();
        let rule = FilterRule::SectionIs { section: "SYSTEM LOG".into() };
        let line = make_line_with_line_num("Tag", "msg", LogLevel::Info, 200);
        let sections: std::sync::Arc<[SectionInfo]> = std::sync::Arc::from(vec![
            SectionInfo { name: "SYSTEM LOG".to_string(), start_line: 100, end_line: 500, parent_index: None },
        ].as_slice());
        let ctx = PipelineContext {
            source_type: SourceType::Bugreport,
            source_name: std::sync::Arc::from("test"),
            is_streaming: false,
            sections,
        };
        assert!(rule_matches(&mut cache, &rule, &line, Some(&ctx)).matched);
    }

    #[test]
    fn get_or_compile_invalid_regex_returns_no_match() {
        let mut cache = HashMap::new();
        let rule = FilterRule::MessageRegex { pattern: "[invalid(".into() };
        let line = make_line("Tag", "any message", LogLevel::Info);
        let result = rule_matches(&mut cache, &rule, &line, None);
        assert!(!result.matched);
    }
}
