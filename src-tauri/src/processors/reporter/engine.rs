use regex::Regex;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet, VecDeque};

use crate::core::line::LineContext;
use super::schema::{
    AggType, CastType, ExtractField, FilterRule, FilterStage, PipelineStage, ReporterDef,
};
use super::vars::VarStore;
use crate::scripting::engine::ScriptEngine;

// ---------------------------------------------------------------------------
// Emission — one row pushed via emit() or the aggregate stage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct Emission {
    pub line_num: usize,
    pub fields: HashMap<String, JsonValue>,
}

// ---------------------------------------------------------------------------
// ProcessorRun — mutable state for one processor pass over all lines
// ---------------------------------------------------------------------------

pub struct ProcessorRun<'a> {
    def: &'a ReporterDef,
    vars: VarStore,
    emissions: Vec<Emission>,
    matched_line_nums: Vec<usize>,
    /// Compiled filter regexes, keyed by pattern string.
    regex_cache: HashMap<String, Regex>,
    /// Script engine (lazily created when a script stage is encountered).
    script_engine: Option<ScriptEngine>,
    /// Lookback buffer (capped at 1000 lines).
    history: VecDeque<LineContext>,
    /// Per-key sliding windows of timestamps (nanos). Used by BurstDetector.
    burst_windows: HashMap<String, VecDeque<i64>>,
    /// Keys currently in an active burst (suppresses duplicate emissions per burst).
    burst_active: HashSet<String>,
}

impl<'a> ProcessorRun<'a> {
    pub fn new(def: &'a ReporterDef) -> Self {
        Self {
            vars: VarStore::new(&def.vars),
            def,
            emissions: Vec::new(),
            matched_line_nums: Vec::new(),
            regex_cache: HashMap::new(),
            script_engine: None,
            history: VecDeque::new(),
            burst_windows: HashMap::new(),
            burst_active: HashSet::new(),
        }
    }

    /// Create a run seeded with previously saved state for continuous (streaming) processing.
    pub fn new_seeded(def: &'a ReporterDef, state: ContinuousRunState) -> Self {
        Self {
            vars: state.vars,
            def,
            emissions: state.emissions,
            matched_line_nums: state.matched_line_nums,
            regex_cache: HashMap::new(),
            script_engine: None,
            history: state.history,
            burst_windows: state.burst_windows,
            burst_active: state.burst_active,
        }
    }

    /// Process a single line through the entire pipeline.
    pub fn process_line(&mut self, line: &LineContext) {
        // Extracted fields accumulate across stages.
        let mut fields: HashMap<String, JsonValue> = HashMap::new();

        for stage in &self.def.pipeline {
            match stage {
                PipelineStage::Filter(fs) => {
                    if !self.apply_filter(fs, line) {
                        return; // Line rejected — skip remaining stages.
                    }
                }
                PipelineStage::Extract(es) => {
                    self.apply_extract(&es.fields, line, &mut fields);
                }
                PipelineStage::Script(ss) => {
                    use crate::scripting::bridge::BridgeInput;
                    let engine = self.script_engine.get_or_insert_with(ScriptEngine::new);
                    let input = BridgeInput {
                        line,
                        fields: &fields,
                        vars: &self.vars,
                        history: self.history.make_contiguous(),
                    };
                    if let Ok((new_vars, new_emissions)) = engine.run_script(&ss.src, &input) {
                        // Merge var updates
                        self.vars.update_from_rhai(&new_vars);
                        // Collect emissions — auto-inject timestamp so time series charts work
                        for mut e in new_emissions {
                            e.entry("timestamp".to_string())
                                .or_insert_with(|| JsonValue::Number(line.timestamp.into()));
                            self.emissions.push(Emission {
                                line_num: line.source_line_num,
                                fields: e,
                            });
                        }
                    }
                }
                PipelineStage::Aggregate(agg) => {
                    for group in &agg.groups {
                        self.apply_aggregate(
                            &group.agg_type,
                            group.field.as_deref(),
                            &fields,
                            line.timestamp,
                            group.window_ms,
                            group.threshold,
                        );
                    }
                }
                PipelineStage::Correlate(_) | PipelineStage::Output(_) => {
                    // Correlate is handled in Phase 3; Output is consumed at the end.
                }
            }
        }

        // Record this line as matched
        self.matched_line_nums.push(line.source_line_num);

        // Add to lookback buffer (Phase 3 will use this in session.query)
        self.history.push_back(line.clone());
        if self.history.len() > 1000 {
            self.history.pop_front();
        }
    }

    /// Consume the run and return results.
    pub fn finish(self) -> RunResult {
        RunResult {
            emissions: self.emissions,
            vars: self.vars.to_json(),
            matched_line_nums: self.matched_line_nums,
        }
    }

    /// Non-consuming snapshot of current results (used after each streaming batch).
    pub fn current_result(&self) -> RunResult {
        RunResult {
            emissions: self.emissions.clone(),
            vars: self.vars.to_json(),
            matched_line_nums: self.matched_line_nums.clone(),
        }
    }

    /// Consume the run into a `ContinuousRunState` for storage between batches.
    ///
    /// When `drain` is true (streaming mode), emissions and matched_line_nums
    /// are cleared rather than carried forward -- they have already been
    /// snapshot via `current_result()` and stored in `pipeline_results`.
    pub fn into_continuous_state(self, last_processed_line: usize, drain: bool) -> ContinuousRunState {
        ContinuousRunState {
            vars: self.vars,
            emissions: if drain { Vec::new() } else { self.emissions },
            matched_line_nums: if drain { Vec::new() } else { self.matched_line_nums },
            history: self.history,
            last_processed_line,
            burst_windows: self.burst_windows,
            burst_active: self.burst_active,
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Filter
    // ────────────────────────────────────────────────────────────────────────

    fn apply_filter(&mut self, stage: &FilterStage, line: &LineContext) -> bool {
        for rule in &stage.rules {
            if !self.rule_matches(rule, line) {
                return false;
            }
        }
        true
    }

    fn rule_matches(&mut self, rule: &FilterRule, line: &LineContext) -> bool {
        use crate::core::line::LogLevel;
        match rule {
            FilterRule::TagMatch { tags } => tags.iter().any(|t| t == &line.tag),
            FilterRule::MessageContains { value } => line.message.contains(value.as_str()),
            FilterRule::MessageContainsAny { values } => {
                values.iter().any(|v| line.message.contains(v.as_str()))
            }
            FilterRule::MessageRegex { pattern } => {
                match self.get_or_compile(pattern) {
                    Some(re) => re.is_match(&line.message),
                    None => false, // Invalid pattern — treat as no-match.
                }
            }
            FilterRule::LevelMin { level } => {
                let min = parse_level(level).unwrap_or(LogLevel::Verbose);
                line.level >= min
            }
            FilterRule::TimeRange { from, to } => {
                // Parse as HH:MM:SS and compare against timestamp nanos.
                let ts_nanos = line.timestamp;
                let from_ns = parse_time_hms(from);
                let to_ns = parse_time_hms(to);
                // Timestamps are nanos since 2000-01-01; extract time-of-day nanos.
                let nanos_per_day = 86_400_000_000_000i64;
                let time_of_day = ts_nanos.rem_euclid(nanos_per_day);
                time_of_day >= from_ns && time_of_day <= to_ns
            }
        }
    }

    /// Returns `None` if the pattern fails to compile (invalid regex).
    fn get_or_compile(&mut self, pattern: &str) -> Option<&Regex> {
        // We store only successfully compiled regexes; absent key means invalid.
        if !self.regex_cache.contains_key(pattern) {
            if let Ok(re) = Regex::new(pattern) {
                self.regex_cache.insert(pattern.to_string(), re);
            } else {
                // Invalid pattern — return None to skip this rule.
                return None;
            }
        }
        self.regex_cache.get(pattern)
    }

    // ────────────────────────────────────────────────────────────────────────
    // Extract
    // ────────────────────────────────────────────────────────────────────────

    fn apply_extract(
        &mut self,
        fields: &[ExtractField],
        line: &LineContext,
        out: &mut HashMap<String, JsonValue>,
    ) {
        for field in fields {
            let re = match self.get_or_compile(&field.pattern.clone()) {
                Some(r) => r,
                None => continue, // Invalid pattern — skip this field.
            };

            if let Some(caps) = re.captures(&line.message) {
                // Capture group 1 if present, else whole match.
                let raw = caps
                    .get(1)
                    .or_else(|| caps.get(0))
                    .map(|m| m.as_str())
                    .unwrap_or("");

                let val = match &field.cast {
                    Some(CastType::Int) => raw
                        .parse::<i64>()
                        .map(JsonValue::from)
                        .unwrap_or(JsonValue::String(raw.to_string())),
                    Some(CastType::Float) => raw
                        .parse::<f64>()
                        .ok()
                        .and_then(serde_json::Number::from_f64)
                        .map(JsonValue::Number)
                        .unwrap_or(JsonValue::String(raw.to_string())),
                    _ => JsonValue::String(raw.to_string()),
                };
                out.insert(field.name.clone(), val);
            }
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Aggregate (simple declarative pass)
    // ────────────────────────────────────────────────────────────────────────

    fn apply_aggregate(
        &mut self,
        agg_type: &AggType,
        field: Option<&str>,
        fields: &HashMap<String, JsonValue>,
        timestamp: i64,
        window_ms: Option<u64>,
        threshold: Option<usize>,
    ) {
        match agg_type {
            AggType::Count => {
                // Increment a `_count` var if it exists.
                if let Some(v) = self.vars.get("_count").cloned() {
                    if let Ok(n) = v.as_int() {
                        self.vars.set("_count", rhai::Dynamic::from(n + 1));
                    }
                }
            }
            AggType::CountBy => {
                if let Some(fname) = field {
                    if let Some(JsonValue::String(group)) = fields.get(fname) {
                        self.emissions.push(Emission {
                            line_num: 0,
                            fields: HashMap::from([
                                (fname.to_string(), JsonValue::String(group.clone())),
                                ("_count".to_string(), JsonValue::Number(1.into())),
                            ]),
                        });
                    }
                }
            }
            AggType::BurstDetector => {
                // Sliding-window burst detector.
                // Emits one Emission per rising edge (when count crosses threshold).
                // Clears active flag on falling edge so next burst re-triggers.
                let window_nanos = window_ms.unwrap_or(2000) as i64 * 1_000_000;
                let burst_threshold = threshold.unwrap_or(20);

                let key = field
                    .and_then(|f| fields.get(f))
                    .and_then(|v| v.as_str())
                    .unwrap_or("_default")
                    .to_string();

                let window = self.burst_windows.entry(key.clone()).or_default();
                // Evict entries outside the sliding window.
                while window.front().is_some_and(|&ts| timestamp - ts > window_nanos) {
                    window.pop_front();
                }
                window.push_back(timestamp);

                let in_burst = window.len() >= burst_threshold;
                let was_active = self.burst_active.contains(&key);

                if in_burst && !was_active {
                    // Rising edge: emit burst event.
                    self.burst_active.insert(key.clone());
                    let count_in_window = window.len();
                    let line_num = self.matched_line_nums.last().copied().unwrap_or(0);
                    self.emissions.push(Emission {
                        line_num,
                        fields: HashMap::from([
                            ("burst_key".to_string(), JsonValue::String(key)),
                            ("count_in_window".to_string(), JsonValue::Number(count_in_window.into())),
                            ("window_ms".to_string(), JsonValue::Number(window_ms.unwrap_or(2000).into())),
                            ("timestamp".to_string(), JsonValue::Number(timestamp.into())),
                        ]),
                    });
                } else if !in_burst && was_active {
                    // Falling edge: clear so the next burst can re-trigger.
                    self.burst_active.remove(&key);
                }
            }
            // Min/Max/Avg/Percentile/TimeBucket are deferred to Phase 3 chart aggregation.
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// RunResult
// ---------------------------------------------------------------------------

pub struct RunResult {
    /// All emitted rows from emit() calls during the run.
    pub emissions: Vec<Emission>,
    /// Final state of all declared variables.
    pub vars: HashMap<String, JsonValue>,
    /// Line numbers of lines that matched (had at least one emission or passed filter).
    pub matched_line_nums: Vec<usize>,
}

// ---------------------------------------------------------------------------
// ContinuousRunState — persistent processor state between streaming batches
// ---------------------------------------------------------------------------

/// Saved state for a processor running continuously on a live ADB stream.
/// Between batches the `ProcessorRun` is consumed; state is stored here and
/// restored via `ProcessorRun::new_seeded()` for each new batch.
pub struct ContinuousRunState {
    pub vars: VarStore,
    pub emissions: Vec<Emission>,
    pub matched_line_nums: Vec<usize>,
    /// Lookback history (last ≤1000 lines). Persisted across batches.
    pub history: VecDeque<LineContext>,
    /// Absolute session line index of the next line to process.
    pub last_processed_line: usize,
    /// BurstDetector sliding windows (persisted so bursts span batch boundaries).
    pub burst_windows: HashMap<String, VecDeque<i64>>,
    /// BurstDetector active-burst keys (persisted to prevent double-firing).
    pub burst_active: HashSet<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_level(s: &str) -> Option<crate::core::line::LogLevel> {
    use crate::core::line::LogLevel;
    match s.to_uppercase().as_str() {
        "V" | "VERBOSE" => Some(LogLevel::Verbose),
        "D" | "DEBUG" => Some(LogLevel::Debug),
        "I" | "INFO" => Some(LogLevel::Info),
        "W" | "WARN" | "WARNING" => Some(LogLevel::Warn),
        "E" | "ERROR" => Some(LogLevel::Error),
        "F" | "FATAL" => Some(LogLevel::Fatal),
        _ => None,
    }
}

fn parse_time_hms(s: &str) -> i64 {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::line::{LineContext, LogLevel};
    use crate::processors::reporter::schema::ReporterDef;

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn make_line(tag: &str, message: &str, level: LogLevel, line_num: usize) -> LineContext {
        LineContext {
            raw: format!("01-01 00:00:00.000  123  456 {:?} {tag}: {message}", level),
            timestamp: 1_000_000_000i64 * (line_num as i64 + 1),
            level,
            tag: tag.to_string(),
            pid: 123,
            tid: 456,
            message: message.to_string(),
            source_id: "test".to_string(),
            source_line_num: line_num,
            fields: HashMap::new(),
            annotations: vec![],
        }
    }

    fn make_line_ts(tag: &str, message: &str, level: LogLevel, line_num: usize, ts: i64) -> LineContext {
        let mut l = make_line(tag, message, level, line_num);
        l.timestamp = ts;
        l
    }

    fn def(yaml: &str) -> ReporterDef {
        ReporterDef::from_yaml(yaml).expect("YAML parse failed")
    }

    // ── Filter: TagMatch ─────────────────────────────────────────────────────

    #[test]
    fn filter_tag_match_accepts_matching_tag() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: [MyTag]
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("MyTag", "hello", LogLevel::Info, 10));
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![10]);
    }

    #[test]
    fn filter_tag_match_rejects_wrong_tag() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: [MyTag]
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("OtherTag", "hello", LogLevel::Info, 5));
        assert!(run.finish().matched_line_nums.is_empty());
    }

    // ── Filter: MessageContains ──────────────────────────────────────────────

    #[test]
    fn filter_message_contains_accepts_and_rejects() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: message_contains
        value: "DISCONNECT"
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("T", "DISCONNECT reason=3", LogLevel::Info, 1));
        run.process_line(&make_line("T", "CONNECT event", LogLevel::Info, 2));
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![1]);
    }

    // ── Filter: MessageContainsAny ───────────────────────────────────────────

    #[test]
    fn filter_message_contains_any_accepts_either_value() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: message_contains_any
        values: [EBADF, "Bad file descriptor"]
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("T", "read: EBADF", LogLevel::Error, 1));
        run.process_line(&make_line("T", "Bad file descriptor", LogLevel::Error, 2));
        run.process_line(&make_line("T", "all good", LogLevel::Info, 3));
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![1, 2]);
    }

    // ── Filter: LevelMin ────────────────────────────────────────────────────

    #[test]
    fn filter_level_min_accepts_warn_and_above() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: level_min
        level: W
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("T", "v", LogLevel::Verbose, 1));
        run.process_line(&make_line("T", "d", LogLevel::Debug,   2));
        run.process_line(&make_line("T", "i", LogLevel::Info,    3));
        run.process_line(&make_line("T", "w", LogLevel::Warn,    4));
        run.process_line(&make_line("T", "e", LogLevel::Error,   5));
        run.process_line(&make_line("T", "f", LogLevel::Fatal,   6));
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![4, 5, 6]);
    }

    // ── Filter: MessageRegex ─────────────────────────────────────────────────

    #[test]
    fn filter_message_regex_matches_pattern() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: message_regex
        pattern: 'FD:\s+\d+'
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("T", "Watchdog FD: 950 heap: 512", LogLevel::Info, 7));
        run.process_line(&make_line("T", "No match here", LogLevel::Info, 8));
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![7]);
    }

    #[test]
    fn filter_invalid_regex_produces_no_matches() {
        // An invalid regex should not panic — it silently rejects all lines.
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: message_regex
        pattern: '(?!invalid_lookahead)'
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("T", "anything", LogLevel::Info, 1));
        assert!(run.finish().matched_line_nums.is_empty());
    }

    // ── Filter: TimeRange ────────────────────────────────────────────────────

    #[test]
    fn filter_time_range_accepts_within_window() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: time_range
        from: "00:30:00"
        to: "02:00:00"
"#);
        let mut run = ProcessorRun::new(&d);
        // 1 hour = 3_600_000_000_000 ns; within [30min, 2h] → accepted
        let inside  = make_line_ts("T", "inside",  LogLevel::Info, 1, 3_600_000_000_000);
        // midnight (ts=0) → before 00:30 → rejected
        let outside = make_line_ts("T", "outside", LogLevel::Info, 2, 0);
        run.process_line(&inside);
        run.process_line(&outside);
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![1]);
    }

    // ── Filter: multiple rules AND-ed ────────────────────────────────────────

    #[test]
    fn filter_rules_are_anded_all_must_pass() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: [ActivityManager]
      - type: message_contains
        value: "Killing"
"#);
        let mut run = ProcessorRun::new(&d);
        // Both rules satisfied → accepted
        run.process_line(&make_line("ActivityManager", "Killing PID 1234", LogLevel::Info, 1));
        // Wrong tag → rejected
        run.process_line(&make_line("System", "Killing PID 5678", LogLevel::Info, 2));
        // Right tag, wrong message → rejected
        run.process_line(&make_line("ActivityManager", "Starting PID 9999", LogLevel::Info, 3));
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![1]);
    }

    // ── Extract ──────────────────────────────────────────────────────────────

    #[test]
    fn extract_captures_group_and_casts_to_int() {
        let d = def(r#"
meta:
  id: t
  name: T
vars:
  - name: last_fd
    type: int
    default: 0
pipeline:
  - stage: extract
    fields:
      - name: fd_count
        pattern: 'FD:\s+(\d+)'
        cast: int
  - stage: script
    runtime: rhai
    src: |
      if "fd_count" in fields {
        vars.last_fd = fields.fd_count;
      }
      _emits.push(#{ fd: fields.fd_count });
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("T", "FD: 950 heap: 512", LogLevel::Info, 1));
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1);
        assert_eq!(result.emissions[0].fields["fd"], JsonValue::Number(950.into()));
        assert_eq!(result.vars["last_fd"], JsonValue::Number(950.into()));
    }

    #[test]
    fn extract_non_matching_pattern_omits_field() {
        // When the extract pattern doesn't match, the field is absent from `fields`.
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: extract
    fields:
      - name: fd_count
        pattern: 'FD:\s+(\d+)'
        cast: int
  - stage: script
    runtime: rhai
    src: |
      let has_fd = "fd_count" in fields;
      _emits.push(#{ has_fd: has_fd });
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("T", "no fd here", LogLevel::Info, 1));
        let result = run.finish();
        assert_eq!(result.emissions[0].fields["has_fd"], JsonValue::Bool(false));
    }

    // ── Script / emissions ───────────────────────────────────────────────────

    #[test]
    fn script_var_accumulates_across_lines() {
        let d = def(r#"
meta:
  id: t
  name: T
vars:
  - name: count
    type: int
    default: 0
pipeline:
  - stage: script
    runtime: rhai
    src: |
      vars.count += 1;
"#);
        let mut run = ProcessorRun::new(&d);
        for i in 0..5usize {
            run.process_line(&make_line("T", "msg", LogLevel::Info, i));
        }
        let result = run.finish();
        assert_eq!(result.vars["count"], JsonValue::Number(5.into()));
        assert_eq!(result.matched_line_nums.len(), 5);
    }

    #[test]
    fn script_emission_gets_timestamp_auto_injected() {
        // The engine must inject `line.timestamp` into every emission that
        // doesn't already have a "timestamp" key — required for time series charts.
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: script
    runtime: rhai
    src: |
      _emits.push(#{ value: 42 });
"#);
        let mut run = ProcessorRun::new(&d);
        let line = make_line_ts("T", "msg", LogLevel::Info, 1, 123_456_789_000);
        run.process_line(&line);
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1);
        assert_eq!(
            result.emissions[0].fields["timestamp"],
            JsonValue::Number(123_456_789_000i64.into()),
            "timestamp must be auto-injected from line.timestamp"
        );
    }

    #[test]
    fn script_explicit_timestamp_is_preserved() {
        // If the script already pushed a "timestamp" field, it must not be overwritten.
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: script
    runtime: rhai
    src: |
      _emits.push(#{ value: 1, timestamp: 999 });
"#);
        let mut run = ProcessorRun::new(&d);
        let line = make_line_ts("T", "msg", LogLevel::Info, 1, 111_000);
        run.process_line(&line);
        let result = run.finish();
        assert_eq!(
            result.emissions[0].fields["timestamp"],
            JsonValue::Number(999i64.into()),
            "script-provided timestamp must not be overwritten by auto-inject"
        );
    }

    #[test]
    fn emission_line_num_matches_source_line_num() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: script
    runtime: rhai
    src: |
      _emits.push(#{ x: 1 });
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("T", "msg", LogLevel::Info, 42));
        let result = run.finish();
        assert_eq!(result.emissions[0].line_num, 42);
    }

    // ── No pipeline — pass-through ───────────────────────────────────────────

    #[test]
    fn no_pipeline_all_lines_matched_no_emissions() {
        let d = def(r#"
meta:
  id: t
  name: T
"#);
        let mut run = ProcessorRun::new(&d);
        for i in 1..=3usize {
            run.process_line(&make_line("T", "msg", LogLevel::Info, i));
        }
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![1, 2, 3]);
        assert!(result.emissions.is_empty());
    }

    // ── BurstDetector ────────────────────────────────────────────────────────

    /// Build a minimal YAML with a BurstDetector on the extracted "key" field.
    fn burst_def_yaml(window_ms: u64, threshold: usize) -> String {
        format!(r#"
meta:
  id: burst-test
  name: Burst Test
pipeline:
  - stage: extract
    fields:
      - name: key
        pattern: 'key=(\w+)'
  - stage: aggregate
    groups:
      - type: burst_detector
        field: key
        window_ms: {window_ms}
        threshold: {threshold}
"#)
    }

    #[test]
    fn burst_fires_once_on_rising_edge() {
        let d = def(&burst_def_yaml(2000, 5));
        let mut run = ProcessorRun::new(&d);
        let base = 1_000_000_000_000i64; // arbitrary base timestamp (nanos)
        for i in 0..5usize {
            run.process_line(&make_line_ts("T", "key=mykey event", LogLevel::Error, i + 1,
                base + (i as i64) * 10_000_000)); // 10ms apart → all within 2s window
        }
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1, "exactly one burst emission on rising edge");
        assert_eq!(result.emissions[0].fields["burst_key"],
                   JsonValue::String("mykey".to_string()));
        assert_eq!(result.emissions[0].fields["count_in_window"],
                   JsonValue::Number(5.into()));
    }

    #[test]
    fn burst_does_not_fire_below_threshold() {
        let d = def(&burst_def_yaml(2000, 10));
        let mut run = ProcessorRun::new(&d);
        let base = 1_000_000_000_000i64;
        for i in 0..5usize {
            run.process_line(&make_line_ts("T", "key=k event", LogLevel::Error, i + 1,
                base + (i as i64) * 10_000_000));
        }
        let result = run.finish();
        assert!(result.emissions.is_empty(), "5 events < threshold of 10, no burst");
    }

    #[test]
    fn burst_fires_once_not_on_every_subsequent_line() {
        let d = def(&burst_def_yaml(2000, 3));
        let mut run = ProcessorRun::new(&d);
        let base = 1_000_000_000_000i64;
        // Send 10 rapid events — only the 3rd (rising edge) should emit
        for i in 0..10usize {
            run.process_line(&make_line_ts("T", "key=spam event", LogLevel::Error, i + 1,
                base + (i as i64) * 10_000_000));
        }
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1, "burst emits once on rising edge only");
    }

    #[test]
    fn burst_re_fires_after_window_expires() {
        // After a gap longer than the window, old events expire, active flag clears,
        // and a new burst can trigger again.
        let d = def(&burst_def_yaml(500, 3)); // 500ms window
        let mut run = ProcessorRun::new(&d);
        let base = 1_000_000_000_000i64;
        let ms  = 1_000_000i64; // 1ms in nanos

        // First burst: 3 events within 50ms
        for i in 0..3usize {
            run.process_line(&make_line_ts("T", "key=k event", LogLevel::Error, i + 1,
                base + (i as i64) * 10 * ms));
        }
        // Second burst: 3 events starting 1s later (> 500ms gap clears the window)
        for i in 0..3usize {
            run.process_line(&make_line_ts("T", "key=k event", LogLevel::Error, i + 10,
                base + 1000 * ms + (i as i64) * 10 * ms));
        }
        let result = run.finish();
        assert_eq!(result.emissions.len(), 2, "two separate bursts → two emissions");
    }

    #[test]
    fn burst_emission_contains_timestamp_field() {
        // Burst emissions must have a "timestamp" field so time series charts work.
        let d = def(&burst_def_yaml(2000, 3));
        let mut run = ProcessorRun::new(&d);
        let base = 2_000_000_000_000i64;
        for i in 0..3usize {
            run.process_line(&make_line_ts("T", "key=t event", LogLevel::Error, i + 1,
                base + (i as i64) * 10_000_000));
        }
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1);
        assert!(
            result.emissions[0].fields.contains_key("timestamp"),
            "burst emission must carry a timestamp field for chart rendering"
        );
    }

    #[test]
    fn burst_uses_default_key_when_field_not_extracted() {
        // When the burst field is not present in `fields` (extract didn't match),
        // the key falls back to "_default" and the detector still works.
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: aggregate
    groups:
      - type: burst_detector
        field: nonexistent_field
        window_ms: 2000
        threshold: 3
"#);
        let mut run = ProcessorRun::new(&d);
        let base = 1_000_000_000_000i64;
        for i in 0..3usize {
            run.process_line(&make_line_ts("T", "msg", LogLevel::Info, i + 1,
                base + (i as i64) * 10_000_000));
        }
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1);
        assert_eq!(result.emissions[0].fields["burst_key"],
                   JsonValue::String("_default".to_string()));
    }

    // ── into_continuous_state drain tests ────────────────────────────────

    #[test]
    fn into_continuous_state_drain_clears_emissions_and_matches() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: script
    runtime: rhai
    src: |
      _emits.push(#{ value: 1 });
"#);
        let mut run = ProcessorRun::new(&d);
        for i in 0..5usize {
            run.process_line(&make_line("T", "msg", LogLevel::Info, i));
        }
        // Verify emissions and matches exist before drain
        assert_eq!(run.current_result().emissions.len(), 5);
        assert_eq!(run.current_result().matched_line_nums.len(), 5);

        let state = run.into_continuous_state(5, true);
        // Emissions and matched_line_nums should be empty after drain
        assert!(state.emissions.is_empty(), "drain=true must clear emissions");
        assert!(state.matched_line_nums.is_empty(), "drain=true must clear matched_line_nums");
        // Vars, history, burst state should be preserved
        assert!(!state.history.is_empty(), "drain must preserve history");
        assert_eq!(state.last_processed_line, 5);
    }

    #[test]
    fn into_continuous_state_no_drain_preserves_all() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: script
    runtime: rhai
    src: |
      _emits.push(#{ value: 1 });
"#);
        let mut run = ProcessorRun::new(&d);
        for i in 0..5usize {
            run.process_line(&make_line("T", "msg", LogLevel::Info, i));
        }

        let state = run.into_continuous_state(5, false);
        // Everything should be preserved with drain=false
        assert_eq!(state.emissions.len(), 5, "drain=false must preserve emissions");
        assert_eq!(state.matched_line_nums.len(), 5, "drain=false must preserve matched_line_nums");
        assert!(!state.history.is_empty(), "drain=false must preserve history");
        assert_eq!(state.last_processed_line, 5);
    }
}
