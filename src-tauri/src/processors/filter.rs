//! Shared filter-rule evaluation used by reporter, transformer, and correlator engines.
//!
//! Each engine previously had its own copy of `rule_matches`, `get_or_compile`,
//! `parse_level`, and `parse_time_hms`. This module centralizes them so new
//! `FilterRule` variants only need to be added in one place.

use regex::Regex;
use std::collections::HashMap;

use crate::core::line::{LineContext, LogLevel, PipelineContext};
use crate::processors::reporter::schema::FilterRule;

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
) -> bool {
    match rule {
        FilterRule::TagMatch { tag_set, tags } => {
            let line_tag: &str = &line.tag;
            if !tag_set.is_empty() {
                tag_set.iter().any(|t| line_tag.starts_with(t.as_str()))
            } else {
                tags.iter().any(|t| line_tag.starts_with(t.as_str()))
            }
        }
        FilterRule::MessageContains { value } => line.message.contains(value.as_str()),
        FilterRule::MessageContainsAny { values } => {
            values.iter().any(|v| line.message.contains(v.as_str()))
        }
        FilterRule::MessageRegex { pattern } => {
            match get_or_compile(regex_cache, pattern) {
                Some(re) => re.is_match(&line.message),
                None => false,
            }
        }
        FilterRule::LevelMin { level } => {
            let min = parse_level(level).unwrap_or(LogLevel::Verbose);
            line.level >= min
        }
        FilterRule::TimeRange { from, to } => {
            let nanos_per_day = 86_400_000_000_000i64;
            let time_of_day = line.timestamp.rem_euclid(nanos_per_day);
            let from_ns = parse_time_hms(from);
            let to_ns = parse_time_hms(to);
            time_of_day >= from_ns && time_of_day <= to_ns
        }
        FilterRule::SourceTypeIs { source_type } => {
            match pipeline_ctx {
                Some(ctx) => ctx.source_type.matches_str(source_type),
                None => true, // passthrough for engines that don't support it
            }
        }
        FilterRule::SectionIs { section } => {
            match pipeline_ctx {
                Some(ctx) => {
                    let line_section = crate::core::line::section_for_line(&ctx.sections, line.source_line_num);
                    line_section == section
                }
                None => true,
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
        assert!(rule_matches(&mut cache, &rule, &line, None));
    }

    #[test]
    fn tag_match_exact_no_prefix() {
        let mut cache = HashMap::new();
        let rule = FilterRule::TagMatch {
            tag_set: Default::default(),
            tags: vec!["WifiService".to_string()],
        };
        let line = make_line("Wifi", "connected", LogLevel::Info);
        assert!(!rule_matches(&mut cache, &rule, &line, None));
    }

    #[test]
    fn message_contains() {
        let mut cache = HashMap::new();
        let rule = FilterRule::MessageContains { value: "error".to_string() };
        let line = make_line("Tag", "an error occurred", LogLevel::Error);
        assert!(rule_matches(&mut cache, &rule, &line, None));
    }

    #[test]
    fn level_min_filters_below() {
        let mut cache = HashMap::new();
        let rule = FilterRule::LevelMin { level: "W".to_string() };
        let line = make_line("Tag", "debug msg", LogLevel::Debug);
        assert!(!rule_matches(&mut cache, &rule, &line, None));
    }

    #[test]
    fn level_min_passes_at_or_above() {
        let mut cache = HashMap::new();
        let rule = FilterRule::LevelMin { level: "W".to_string() };
        let line = make_line("Tag", "warning msg", LogLevel::Warn);
        assert!(rule_matches(&mut cache, &rule, &line, None));
    }

    #[test]
    fn source_type_passthrough_without_ctx() {
        let mut cache = HashMap::new();
        let rule = FilterRule::SourceTypeIs { source_type: "logcat".to_string() };
        let line = make_line("Tag", "msg", LogLevel::Info);
        assert!(rule_matches(&mut cache, &rule, &line, None));
    }

    #[test]
    fn section_is_passthrough_without_ctx() {
        let mut cache = HashMap::new();
        let rule = FilterRule::SectionIs { section: "SYSTEM LOG".to_string() };
        let line = make_line("Tag", "msg", LogLevel::Info);
        assert!(rule_matches(&mut cache, &rule, &line, None));
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
}
