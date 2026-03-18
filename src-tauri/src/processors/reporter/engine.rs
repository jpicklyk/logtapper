use regex::Regex;
use serde_json::Value as JsonValue;
use smallvec::SmallVec;
use std::collections::{HashMap, HashSet, VecDeque};


use crate::core::line::{LineContext, PipelineContext};
use super::schema::{
    AggType, CastType, ExtractField, FilterRule, PipelineStage, ReporterDef,
};
use super::vars::VarStore;
use crate::scripting::engine::ScriptEngine;

/// Inline field storage — most extract stages produce <= 4 fields per line.
type FieldVec = SmallVec<[(String, JsonValue); 4]>;

// ---------------------------------------------------------------------------
// Emission — one row pushed via emit() or the aggregate stage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Emission {
    pub line_num: usize,
    pub fields: Vec<(String, JsonValue)>,
}

impl serde::Serialize for Emission {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("Emission", 2)?;
        s.serialize_field("line_num", &self.line_num)?;
        struct FieldsAsMap<'a>(&'a [(String, JsonValue)]);
        impl serde::Serialize for FieldsAsMap<'_> {
            fn serialize<S2: serde::Serializer>(&self, serializer: S2) -> Result<S2::Ok, S2::Error> {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(self.0.len()))?;
                for (k, v) in self.0 {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
        s.serialize_field("fields", &FieldsAsMap(&self.fields))?;
        s.end()
    }
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
    /// Filter stages with rules pre-sorted by ascending cost (cheapest first).
    sorted_filter_rules: Vec<Vec<FilterRule>>,
}

impl<'a> ProcessorRun<'a> {
    /// Build filter stages with rules pre-sorted by ascending cost (cheapest first).
    fn build_sorted_filter_rules(def: &ReporterDef) -> Vec<Vec<FilterRule>> {
        def.pipeline.iter()
            .filter_map(|stage| match stage {
                PipelineStage::Filter(fs) => {
                    let mut rules = fs.rules.clone();
                    rules.sort_by_key(super::schema::FilterRule::cost_rank);
                    for rule in &mut rules {
                        rule.prepare_tag_set();
                    }
                    Some(rules)
                }
                _ => None,
            })
            .collect()
    }

    pub fn new(def: &'a ReporterDef) -> Self {
        let sorted_filter_rules = Self::build_sorted_filter_rules(def);
        Self {
            vars: VarStore::new(&def.vars),
            def,
            emissions: Vec::with_capacity(64),
            matched_line_nums: Vec::new(),
            regex_cache: HashMap::new(),
            script_engine: None,
            history: VecDeque::new(),
            burst_windows: HashMap::new(),
            burst_active: HashSet::new(),
            sorted_filter_rules,
        }
    }

    /// Create a run seeded with previously saved state for continuous (streaming) processing.
    pub fn new_seeded(def: &'a ReporterDef, state: ContinuousRunState) -> Self {
        let sorted_filter_rules = Self::build_sorted_filter_rules(def);
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
            sorted_filter_rules,
        }
    }

    /// Process a single line through the entire pipeline.
    pub fn process_line(&mut self, line: &LineContext, pipeline_ctx: &PipelineContext) {
        // Extracted fields accumulate across stages.
        let mut fields: FieldVec = SmallVec::new();
        let mut filter_idx = 0usize;

        for stage in &self.def.pipeline {
            match stage {
                PipelineStage::Filter(_) => {
                    if !self.apply_filter_sorted(filter_idx, line, pipeline_ctx) {
                        return; // Line rejected — skip remaining stages.
                    }
                    filter_idx += 1;
                }
                PipelineStage::Extract(es) => {
                    self.apply_extract(&es.fields, line, &mut fields);
                }
                PipelineStage::Script(ss) => {
                    use crate::scripting::bridge::BridgeInput;
                    let engine = self.script_engine.get_or_insert_with(ScriptEngine::new);
                    let input = BridgeInput {
                        line,
                        fields: fields.as_slice(),
                        vars: &self.vars,
                        history: self.history.make_contiguous(),
                        pipeline_ctx,
                    };
                    if let Ok((new_vars, new_emissions)) = engine.run_script(&ss.src, &input) {
                        // Merge var updates
                        self.vars.update_from_rhai(&new_vars);
                        // Collect emissions — auto-inject timestamp so time series charts work
                        for mut e in new_emissions {
                            if !e.iter().any(|(k, _)| k == "timestamp") {
                                e.push(("timestamp".to_string(), JsonValue::Number(line.timestamp.into())));
                            }
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

    fn apply_filter_sorted(&mut self, filter_idx: usize, line: &LineContext, pipeline_ctx: &PipelineContext) -> bool {
        // Call filter::rule_matches directly (not via self.rule_matches) to avoid
        // borrowing &mut self while also borrowing self.sorted_filter_rules.
        for rule in &self.sorted_filter_rules[filter_idx] {
            if !crate::processors::filter::rule_matches(&mut self.regex_cache, rule, line, Some(pipeline_ctx)) {
                return false;
            }
        }
        true
    }

    // ────────────────────────────────────────────────────────────────────────
    // Extract
    // ────────────────────────────────────────────────────────────────────────

    fn apply_extract(
        &mut self,
        fields: &[ExtractField],
        line: &LineContext,
        out: &mut FieldVec,
    ) {
        for field in fields {
            let Some(re) = crate::processors::filter::get_or_compile(&mut self.regex_cache, &field.pattern) else {
                continue; // Invalid pattern — skip this field.
            };

            if let Some(caps) = re.captures(&line.message) {
                // Capture group 1 if present, else whole match.
                let raw = caps
                    .get(1)
                    .or_else(|| caps.get(0))
                    .map_or("", |m| m.as_str());

                let val = match &field.cast {
                    Some(CastType::Int) => raw
                        .parse::<i64>()
                        .map_or_else(
                            |_| JsonValue::String(raw.to_string()),
                            JsonValue::from,
                        ),
                    Some(CastType::Float) => raw
                        .parse::<f64>()
                        .ok()
                        .and_then(serde_json::Number::from_f64)
                        .map_or_else(
                            || JsonValue::String(raw.to_string()),
                            JsonValue::Number,
                        ),
                    _ => JsonValue::String(raw.to_string()),
                };
                out.push((field.name.clone(), val));
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
        fields: &[(String, JsonValue)],
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
                    if let Some(JsonValue::String(group)) = fields.iter().find(|(k, _)| k == fname).map(|(_, v)| v) {
                        self.emissions.push(Emission {
                            line_num: 0,
                            fields: vec![
                                (fname.to_string(), JsonValue::String(group.clone())),
                                ("_count".to_string(), JsonValue::Number(1.into())),
                            ],
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
                    .and_then(|f| fields.iter().find(|(k, _)| k == f).map(|(_, v)| v))
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
                        fields: vec![
                            ("burst_key".to_string(), JsonValue::String(key)),
                            ("count_in_window".to_string(), JsonValue::Number(count_in_window.into())),
                            ("window_ms".to_string(), JsonValue::Number(window_ms.unwrap_or(2000).into())),
                            ("timestamp".to_string(), JsonValue::Number(timestamp.into())),
                        ],
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

#[derive(Clone)]
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

// parse_level and parse_time_hms moved to crate::processors::filter

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::core::line::{LineContext, LogLevel, PipelineContext};
    use crate::processors::reporter::schema::ReporterDef;

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn make_line(tag: &str, message: &str, level: LogLevel, line_num: usize) -> LineContext {
        LineContext {
            raw: Arc::from(format!("01-01 00:00:00.000  123  456 {:?} {tag}: {message}", level).as_str()),
            timestamp: 1_000_000_000i64 * (line_num as i64 + 1),
            level,
            tag: Arc::from(tag),
            pid: 123,
            tid: 456,
            message: Arc::from(message),
            source_id: Arc::from("test"),
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

    fn get_field<'a>(e: &'a Emission, k: &str) -> Option<&'a JsonValue> {
        e.fields.iter().find(|(key, _)| key == k).map(|(_, v)| v)
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
        run.process_line(&make_line("MyTag", "hello", LogLevel::Info, 10), &PipelineContext::test_default());
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
        run.process_line(&make_line("OtherTag", "hello", LogLevel::Info, 5), &PipelineContext::test_default());
        assert!(run.finish().matched_line_nums.is_empty());
    }

    #[test]
    fn filter_tag_match_prefix_matches_subtag() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: [NetworkMonitor]
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("NetworkMonitor/102", "PROBE_DNS ok", LogLevel::Debug, 1), &PipelineContext::test_default());
        run.process_line(&make_line("NetworkMonitor", "direct match", LogLevel::Debug, 2), &PipelineContext::test_default());
        run.process_line(&make_line("NetworkMonitorExtra", "also matches prefix", LogLevel::Debug, 3), &PipelineContext::test_default());
        run.process_line(&make_line("OtherTag", "no match", LogLevel::Debug, 4), &PipelineContext::test_default());
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![1, 2, 3]);
    }

    #[test]
    fn filter_tag_match_trailing_slash_specificity() {
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: ["NetworkMonitor/"]
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("NetworkMonitor/102", "matches", LogLevel::Debug, 1), &PipelineContext::test_default());
        run.process_line(&make_line("NetworkMonitor", "no slash suffix", LogLevel::Debug, 2), &PipelineContext::test_default());
        run.process_line(&make_line("NetworkMonitorExtra", "no slash", LogLevel::Debug, 3), &PipelineContext::test_default());
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![1]);
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
        run.process_line(&make_line("T", "DISCONNECT reason=3", LogLevel::Info, 1), &PipelineContext::test_default());
        run.process_line(&make_line("T", "CONNECT event", LogLevel::Info, 2), &PipelineContext::test_default());
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
        run.process_line(&make_line("T", "read: EBADF", LogLevel::Error, 1), &PipelineContext::test_default());
        run.process_line(&make_line("T", "Bad file descriptor", LogLevel::Error, 2), &PipelineContext::test_default());
        run.process_line(&make_line("T", "all good", LogLevel::Info, 3), &PipelineContext::test_default());
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
        run.process_line(&make_line("T", "v", LogLevel::Verbose, 1), &PipelineContext::test_default());
        run.process_line(&make_line("T", "d", LogLevel::Debug,   2), &PipelineContext::test_default());
        run.process_line(&make_line("T", "i", LogLevel::Info,    3), &PipelineContext::test_default());
        run.process_line(&make_line("T", "w", LogLevel::Warn,    4), &PipelineContext::test_default());
        run.process_line(&make_line("T", "e", LogLevel::Error,   5), &PipelineContext::test_default());
        run.process_line(&make_line("T", "f", LogLevel::Fatal,   6), &PipelineContext::test_default());
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
        run.process_line(&make_line("T", "Watchdog FD: 950 heap: 512", LogLevel::Info, 7), &PipelineContext::test_default());
        run.process_line(&make_line("T", "No match here", LogLevel::Info, 8), &PipelineContext::test_default());
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
        run.process_line(&make_line("T", "anything", LogLevel::Info, 1), &PipelineContext::test_default());
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
        run.process_line(&inside, &PipelineContext::test_default());
        run.process_line(&outside, &PipelineContext::test_default());
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
        run.process_line(&make_line("ActivityManager", "Killing PID 1234", LogLevel::Info, 1), &PipelineContext::test_default());
        // Wrong tag → rejected
        run.process_line(&make_line("System", "Killing PID 5678", LogLevel::Info, 2), &PipelineContext::test_default());
        // Right tag, wrong message → rejected
        run.process_line(&make_line("ActivityManager", "Starting PID 9999", LogLevel::Info, 3), &PipelineContext::test_default());
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
        run.process_line(&make_line("T", "FD: 950 heap: 512", LogLevel::Info, 1), &PipelineContext::test_default());
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1);
        assert_eq!(get_field(&result.emissions[0], "fd"), Some(&JsonValue::Number(950.into())));
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
        run.process_line(&make_line("T", "no fd here", LogLevel::Info, 1), &PipelineContext::test_default());
        let result = run.finish();
        assert_eq!(get_field(&result.emissions[0], "has_fd"), Some(&JsonValue::Bool(false)));
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
            run.process_line(&make_line("T", "msg", LogLevel::Info, i), &PipelineContext::test_default());
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
        run.process_line(&line, &PipelineContext::test_default());
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1);
        assert_eq!(
            get_field(&result.emissions[0], "timestamp"),
            Some(&JsonValue::Number(123_456_789_000i64.into())),
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
        run.process_line(&line, &PipelineContext::test_default());
        let result = run.finish();
        assert_eq!(
            get_field(&result.emissions[0], "timestamp"),
            Some(&JsonValue::Number(999i64.into())),
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
        run.process_line(&make_line("T", "msg", LogLevel::Info, 42), &PipelineContext::test_default());
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
            run.process_line(&make_line("T", "msg", LogLevel::Info, i), &PipelineContext::test_default());
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
                base + (i as i64) * 10_000_000), &PipelineContext::test_default());
        }
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1, "exactly one burst emission on rising edge");
        assert_eq!(get_field(&result.emissions[0], "burst_key"),
                   Some(&JsonValue::String("mykey".to_string())));
        assert_eq!(get_field(&result.emissions[0], "count_in_window"),
                   Some(&JsonValue::Number(5.into())));
    }

    #[test]
    fn burst_does_not_fire_below_threshold() {
        let d = def(&burst_def_yaml(2000, 10));
        let mut run = ProcessorRun::new(&d);
        let base = 1_000_000_000_000i64;
        for i in 0..5usize {
            run.process_line(&make_line_ts("T", "key=k event", LogLevel::Error, i + 1,
                base + (i as i64) * 10_000_000), &PipelineContext::test_default());
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
                base + (i as i64) * 10_000_000), &PipelineContext::test_default());
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
                base + (i as i64) * 10 * ms), &PipelineContext::test_default());
        }
        // Second burst: 3 events starting 1s later (> 500ms gap clears the window)
        for i in 0..3usize {
            run.process_line(&make_line_ts("T", "key=k event", LogLevel::Error, i + 10,
                base + 1000 * ms + (i as i64) * 10 * ms), &PipelineContext::test_default());
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
                base + (i as i64) * 10_000_000), &PipelineContext::test_default());
        }
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1);
        assert!(
            result.emissions[0].fields.iter().any(|(k, _)| k == "timestamp"),
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
                base + (i as i64) * 10_000_000), &PipelineContext::test_default());
        }
        let result = run.finish();
        assert_eq!(result.emissions.len(), 1);
        assert_eq!(get_field(&result.emissions[0], "burst_key"),
                   Some(&JsonValue::String("_default".to_string())));
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
            run.process_line(&make_line("T", "msg", LogLevel::Info, i), &PipelineContext::test_default());
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
            run.process_line(&make_line("T", "msg", LogLevel::Info, i), &PipelineContext::test_default());
        }

        let state = run.into_continuous_state(5, false);
        // Everything should be preserved with drain=false
        assert_eq!(state.emissions.len(), 5, "drain=false must preserve emissions");
        assert_eq!(state.matched_line_nums.len(), 5, "drain=false must preserve matched_line_nums");
        assert!(!state.history.is_empty(), "drain=false must preserve history");
        assert_eq!(state.last_processed_line, 5);
    }

    // ── Filter cost sorting ─────────────────────────────────────────────────

    #[test]
    fn filter_rules_sorted_cheapest_first() {
        // Define a processor with expensive rules listed first in YAML order:
        // message_regex (cost 5) then level_min (cost 0).
        // After cost-sorting, LevelMin should come first in sorted_filter_rules.
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: message_regex
        pattern: 'FD:\s+\d+'
      - type: level_min
        level: W
"#);
        let run = ProcessorRun::new(&d);
        assert_eq!(run.sorted_filter_rules.len(), 1, "one filter stage");
        // First rule should be LevelMin (cheapest, cost 0)
        assert!(
            matches!(run.sorted_filter_rules[0][0], FilterRule::LevelMin { .. }),
            "LevelMin should be sorted first, got: {:?}", run.sorted_filter_rules[0][0]
        );
        // Second rule should be MessageRegex (most expensive, cost 5)
        assert!(
            matches!(run.sorted_filter_rules[0][1], FilterRule::MessageRegex { .. }),
            "MessageRegex should be sorted last, got: {:?}", run.sorted_filter_rules[0][1]
        );
    }

    #[test]
    fn filter_cost_sorting_preserves_and_semantics() {
        // Verify that sorting doesn't break AND semantics: a line must pass ALL rules.
        // YAML order: [message_regex, level_min, tag_match] — gets sorted to
        // [level_min, tag_match, message_regex].
        let d = def(r#"
meta:
  id: t
  name: T
pipeline:
  - stage: filter
    rules:
      - type: message_regex
        pattern: 'Killing'
      - type: level_min
        level: W
      - type: tag_match
        tags: [ActivityManager]
"#);
        let mut run = ProcessorRun::new(&d);
        // Passes all three rules
        run.process_line(&make_line("ActivityManager", "Killing PID 1234", LogLevel::Warn, 1), &PipelineContext::test_default());
        // Fails level_min (Info < Warn)
        run.process_line(&make_line("ActivityManager", "Killing PID 5678", LogLevel::Info, 2), &PipelineContext::test_default());
        // Fails tag_match
        run.process_line(&make_line("System", "Killing PID 9999", LogLevel::Warn, 3), &PipelineContext::test_default());
        // Fails message_regex
        run.process_line(&make_line("ActivityManager", "Starting PID 0000", LogLevel::Error, 4), &PipelineContext::test_default());
        let result = run.finish();
        assert_eq!(result.matched_line_nums, vec![1], "only line 1 should pass all three rules");
    }

    // ── Emission serialization ─────────────────────────────────────────────

    #[test]
    fn emission_serializes_fields_as_json_object() {
        let emission = Emission {
            line_num: 42,
            fields: vec![("key".to_string(), JsonValue::String("val".to_string()))],
        };
        let json = serde_json::to_value(&emission).unwrap();
        assert!(json["fields"].is_object(), "fields must serialize as JSON object, not array");
        assert_eq!(json["fields"]["key"], "val");
        assert_eq!(json["line_num"], 42);
    }

    // ── Lazy history access (history_get / history_len) ───────────────────

    #[test]
    fn script_history_len_returns_correct_count() {
        // Process N lines, then check history_len() returns N (up to cap of 1000).
        let d = def(r#"
meta:
  id: t
  name: T
vars:
  - name: hist_len
    type: int
    default: 0
pipeline:
  - stage: script
    runtime: rhai
    src: |
      vars.hist_len = history_len();
"#);
        let mut run = ProcessorRun::new(&d);
        for i in 0..5usize {
            run.process_line(&make_line("T", "msg", LogLevel::Info, i), &PipelineContext::test_default());
        }
        let result = run.finish();
        // After processing 5 lines, history_len() on the last call should be 4
        // (the current line is added AFTER process_line completes the pipeline).
        assert_eq!(result.vars["hist_len"], JsonValue::Number(4.into()));
    }

    #[test]
    fn script_history_get_returns_correct_entry() {
        // Process 3 lines, then verify history_get(0) returns the first (oldest) entry.
        let d = def(r#"
meta:
  id: t
  name: T
vars:
  - name: first_tag
    type: string
    default: ""
  - name: last_msg
    type: string
    default: ""
pipeline:
  - stage: script
    runtime: rhai
    src: |
      if history_len() > 0 {
        let first = history_get(0);
        vars.first_tag = first.tag;
        let last = history_get(history_len() - 1);
        vars.last_msg = last.message;
      }
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("TagA", "alpha", LogLevel::Info, 0), &PipelineContext::test_default());
        run.process_line(&make_line("TagB", "beta", LogLevel::Info, 1), &PipelineContext::test_default());
        run.process_line(&make_line("TagC", "gamma", LogLevel::Info, 2), &PipelineContext::test_default());
        let result = run.finish();
        // On the third line's script execution, history = [TagA, TagB]
        assert_eq!(result.vars["first_tag"], JsonValue::String("TagA".to_string()));
        assert_eq!(result.vars["last_msg"], JsonValue::String("beta".to_string()));
    }

    #[test]
    fn script_history_get_out_of_bounds_returns_unit() {
        // history_get(9999) on an empty/small history should return () (unit), not panic.
        let d = def(r#"
meta:
  id: t
  name: T
vars:
  - name: is_unit
    type: bool
    default: false
pipeline:
  - stage: script
    runtime: rhai
    src: |
      let val = history_get(9999);
      vars.is_unit = val == ();
"#);
        let mut run = ProcessorRun::new(&d);
        run.process_line(&make_line("T", "msg", LogLevel::Info, 0), &PipelineContext::test_default());
        let result = run.finish();
        assert_eq!(result.vars["is_unit"], JsonValue::Bool(true));
    }

    #[test]
    fn exception_stack_tracker_fatal_and_nonfatal() {
        let script = r#"
      if "fatal_thread_name" in fields {
        if vars.in_fatal_trace && vars.current_fatal_app != "" {
          let detail = vars.current_fatal_exception;
          if vars.current_fatal_root_cause != "" && vars.current_fatal_root_cause != vars.current_fatal_exception {
            detail = detail + " (root: " + vars.current_fatal_root_cause + ")";
          }
          detail = detail + " on " + vars.current_fatal_thread;
          let crashes = vars.fatal_crashes;
          crashes[vars.current_fatal_app] = detail;
          vars.fatal_crashes = crashes;
          _emits.push(#{
            source: vars.current_fatal_app,
            exception: vars.current_fatal_exception,
            root_cause: if vars.current_fatal_root_cause != "" { vars.current_fatal_root_cause } else { vars.current_fatal_exception },
            crash_thread: vars.current_fatal_thread,
            start_line: vars.fatal_trace_start,
            fatal: true,
          });
        }
        vars.current_fatal_thread = fields.fatal_thread_name;
        vars.current_fatal_app = "";
        vars.current_fatal_exception = "";
        vars.current_fatal_root_cause = "";
        vars.fatal_trace_start = line.line_number;
        vars.in_fatal_trace = true;
        vars.fatal_count += 1;
        return;
      }

      if vars.in_fatal_trace && "process_name" in fields {
        vars.current_fatal_app = fields.process_name;
        return;
      }

      if vars.in_fatal_trace && line.tag == "AndroidRuntime" {
        if "caused_by_class" in fields {
          vars.current_fatal_root_cause = fields.caused_by_class;
        }
        if "exception_class" in fields && vars.current_fatal_exception == "" {
          vars.current_fatal_exception = fields.exception_class;
        }
        if vars.current_fatal_app != "" && vars.current_fatal_exception != "" {
          let detail = vars.current_fatal_exception;
          if vars.current_fatal_root_cause != "" && vars.current_fatal_root_cause != vars.current_fatal_exception {
            detail = detail + " (root: " + vars.current_fatal_root_cause + ")";
          }
          detail = detail + " on " + vars.current_fatal_thread;
          let crashes = vars.fatal_crashes;
          crashes[vars.current_fatal_app] = detail;
          vars.fatal_crashes = crashes;
        }
        return;
      }

      if vars.in_fatal_trace {
        if vars.current_fatal_app != "" {
          let detail = vars.current_fatal_exception;
          if vars.current_fatal_root_cause != "" && vars.current_fatal_root_cause != vars.current_fatal_exception {
            detail = detail + " (root: " + vars.current_fatal_root_cause + ")";
          }
          detail = detail + " on " + vars.current_fatal_thread;
          let crashes = vars.fatal_crashes;
          crashes[vars.current_fatal_app] = detail;
          vars.fatal_crashes = crashes;
          _emits.push(#{
            source: vars.current_fatal_app,
            exception: vars.current_fatal_exception,
            root_cause: if vars.current_fatal_root_cause != "" { vars.current_fatal_root_cause } else { vars.current_fatal_exception },
            crash_thread: vars.current_fatal_thread,
            start_line: vars.fatal_trace_start,
            fatal: true,
          });
        }
        vars.in_fatal_trace = false;
      }

      if vars.in_stderr_trace && line.tag != "System.err" {
        let src = if vars.stderr_source != "" { vars.stderr_source } else { "System.err" };
        let exc = vars.stderr_exception;
        let key = src + ": " + exc;
        let summary = vars.nonfatal_summary;
        if key in summary { summary[key] = summary[key] + 1; } else { summary[key] = 1; }
        vars.nonfatal_summary = summary;
        _emits.push(#{
          source: src,
          exception: exc,
          root_cause: vars.stderr_root_cause,
          crash_thread: "",
          start_line: vars.stderr_start_line,
          fatal: false,
        });
        vars.in_stderr_trace = false;
        vars.stderr_source = "";
        vars.stderr_exception = "";
        vars.stderr_root_cause = "";
      }

      if line.tag == "System.err" {
        if "exception_class" in fields && !("caused_by_class" in fields) {
          if vars.in_stderr_trace {
            let src = if vars.stderr_source != "" { vars.stderr_source } else { "System.err" };
            let exc = vars.stderr_exception;
            let key = src + ": " + exc;
            let summary = vars.nonfatal_summary;
            if key in summary { summary[key] = summary[key] + 1; } else { summary[key] = 1; }
            vars.nonfatal_summary = summary;
            _emits.push(#{
              source: src,
              exception: exc,
              root_cause: vars.stderr_root_cause,
              crash_thread: "",
              start_line: vars.stderr_start_line,
              fatal: false,
            });
          }
          vars.in_stderr_trace = true;
          vars.stderr_exception = fields.exception_class;
          vars.stderr_root_cause = fields.exception_class;
          vars.stderr_start_line = line.line_number;
          vars.stderr_source = "";
          vars.nonfatal_count += 1;
          return;
        }
        if vars.in_stderr_trace && "caused_by_class" in fields {
          vars.stderr_root_cause = fields.caused_by_class;
          return;
        }
        if vars.in_stderr_trace && "at_class" in fields && vars.stderr_source == "" {
          let pkg = fields.at_class;
          if !pkg.starts_with("java.") && !pkg.starts_with("javax.") &&
             !pkg.starts_with("android.") && !pkg.starts_with("com.android.") &&
             !pkg.starts_with("libcore.") && !pkg.starts_with("sun.") &&
             !pkg.starts_with("dalvik.") && !pkg.starts_with("kotlin.") &&
             !pkg.starts_with("androidx.") {
            vars.stderr_source = pkg;
          }
          return;
        }
        return;
      }

      if "exception_class" in fields && !("caused_by_class" in fields) && !("at_class" in fields) {
        let tag = line.tag;
        let exc = fields.exception_class;
        vars.nonfatal_count += 1;
        let key = tag + ": " + exc;
        let summary = vars.nonfatal_summary;
        if key in summary {
          summary[key] = summary[key] + 1;
        } else {
          summary[key] = 1;
        }
        vars.nonfatal_summary = summary;
        let root = if "caused_by_class" in fields { fields.caused_by_class } else { exc };
        _emits.push(#{
          source: tag,
          exception: exc,
          root_cause: root,
          crash_thread: "",
          start_line: line.line_number,
          fatal: false,
        });
      }
"#;
        let d = def(&format!(r#"
meta:
  id: t
  name: T
vars:
  - name: fatal_count
    type: int
    default: 0
  - name: nonfatal_count
    type: int
    default: 0
  - name: fatal_crashes
    type: map
    default: {{}}
  - name: nonfatal_summary
    type: map
    default: {{}}
  - name: current_fatal_thread
    type: string
    default: ""
  - name: current_fatal_app
    type: string
    default: ""
  - name: current_fatal_exception
    type: string
    default: ""
  - name: current_fatal_root_cause
    type: string
    default: ""
  - name: fatal_trace_start
    type: int
    default: 0
  - name: in_fatal_trace
    type: bool
    default: false
  - name: in_stderr_trace
    type: bool
    default: false
  - name: stderr_exception
    type: string
    default: ""
  - name: stderr_root_cause
    type: string
    default: ""
  - name: stderr_start_line
    type: int
    default: 0
  - name: stderr_source
    type: string
    default: ""
pipeline:
  - stage: filter
    rules:
      - type: message_contains_any
        values: ["FATAL EXCEPTION", "Exception", "Error", "Process:", "at com."]
  - stage: extract
    fields:
      - name: fatal_thread_name
        pattern: 'FATAL EXCEPTION:\s+(.+)'
      - name: process_name
        pattern: 'Process:\s+([^\s,]+)'
      - name: exception_class
        pattern: '([a-z][\w.]*\.(?:\w+(?:Exception|Error|Throwable)))'
      - name: caused_by_class
        pattern: 'Caused by:\s+([a-z][\w.]*\.(?:\w+(?:Exception|Error|Throwable)))'
      - name: at_class
        pattern: '^\s*at\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_$]*){{2,}})\.[A-Z]'
  - stage: script
    runtime: rhai
    src: |
{script}
  - stage: output
    views:
      - type: table
        source: emissions
        columns: ["fatal", "source", "exception", "root_cause", "start_line"]
        sort: "source"
"#));
        let mut run = ProcessorRun::new(&d);

        // Fatal trace: AndroidRuntime
        run.process_line(&make_line("AndroidRuntime", "FATAL EXCEPTION: main", LogLevel::Error, 100), &PipelineContext::test_default());
        run.process_line(&make_line("AndroidRuntime", "Process: com.samsung.knox.kpu, PID: 1234", LogLevel::Error, 101), &PipelineContext::test_default());
        run.process_line(&make_line("AndroidRuntime", "java.lang.RuntimeException: Unable to start", LogLevel::Error, 102), &PipelineContext::test_default());
        run.process_line(&make_line("AndroidRuntime", "Caused by: java.lang.SecurityException: permission denied", LogLevel::Error, 103), &PipelineContext::test_default());

        // Non-fatal: Binder exception (ends the fatal trace and emits it)
        run.process_line(&make_line("Binder", "Caught a RuntimeException from the binder stub implementation.", LogLevel::Warn, 200), &PipelineContext::test_default());
        run.process_line(&make_line("Binder", "java.lang.SecurityException: Permission Denial: broadcast from android", LogLevel::Warn, 201), &PipelineContext::test_default());

        // System.err printStackTrace — should be attributed to the owning app via at-frames
        // top-level exception starts the deferred trace
        run.process_line(&make_line("System.err", "java.io.FileNotFoundException: /some/path: open failed: ENOENT", LogLevel::Warn, 300), &PipelineContext::test_default());
        // framework at-frames are skipped for attribution
        run.process_line(&make_line("System.err", "\tat libcore.io.IoBridge.open(IoBridge.java:496)", LogLevel::Warn, 301), &PipelineContext::test_default());
        run.process_line(&make_line("System.err", "\tat java.io.FileInputStream.<init>(FileInputStream.java:76)", LogLevel::Warn, 302), &PipelineContext::test_default());
        // first non-framework app frame — sets attribution source
        // No leading \t — the logcat parser strips it via :\s* in the threadtime regex
        run.process_line(&make_line("System.err", "at com.sec.android.app.servicemode.SystemDump$1.run(SystemDump.java:2327)", LogLevel::Warn, 303), &PipelineContext::test_default());
        // Caused by: counts as root cause, not a new exception
        run.process_line(&make_line("System.err", "Caused by: android.system.ErrnoException: open failed: ENOENT", LogLevel::Warn, 310), &PipelineContext::test_default());
        // Non-System.err line flushes the pending stderr trace with attributed source
        run.process_line(&make_line("ActivityManager", "Process died due to Error", LogLevel::Warn, 400), &PipelineContext::test_default());

        let result = run.finish();
        // 1 fatal + 2 non-fatal (Binder + attributed System.err FileNotFoundException)
        assert_eq!(result.vars["fatal_count"], JsonValue::Number(1.into()));
        assert_eq!(result.vars["nonfatal_count"], JsonValue::Number(2.into()));
        assert_eq!(result.vars["in_fatal_trace"], JsonValue::Bool(false));
        assert_eq!(result.vars["in_stderr_trace"], JsonValue::Bool(false));
        let fatal_crashes = result.vars["fatal_crashes"].as_object().unwrap();
        assert!(fatal_crashes.contains_key("com.samsung.knox.kpu"));
        let detail = fatal_crashes["com.samsung.knox.kpu"].as_str().unwrap();
        assert!(detail.contains("java.lang.RuntimeException"), "detail: {detail}");
        assert!(detail.contains("java.lang.SecurityException"), "detail: {detail}");
        assert!(detail.contains("on main"), "detail: {detail}");
        let nonfatal = result.vars["nonfatal_summary"].as_object().unwrap();
        assert!(nonfatal.contains_key("Binder: java.lang.SecurityException"), "nonfatal: {nonfatal:?}");
        // System.err attributed to app package, not "System.err"
        assert!(nonfatal.contains_key("com.sec.android.app.servicemode: java.io.FileNotFoundException"), "nonfatal: {nonfatal:?}");
        assert!(!nonfatal.contains_key("System.err: java.io.FileNotFoundException"), "should be attributed, not System.err: {nonfatal:?}");
        assert!(!nonfatal.contains_key("System.err: android.system.ErrnoException"), "Caused by must not be counted: {nonfatal:?}");
        // 1 fatal emission + 2 non-fatal emissions
        assert_eq!(result.emissions.len(), 3);
        // Attributed emission has the correct source and root_cause from Caused by:
        let get_field = |e: &Emission, key: &str| -> Option<String> {
            e.fields.iter().find(|(k, _)| k == key).and_then(|(_, v)| v.as_str()).map(|s| s.to_string())
        };
        let stderr_emit = result.emissions.iter().find(|e| {
            get_field(e, "fatal").as_deref() == Some("false") ||
            e.fields.iter().any(|(k, v)| k == "fatal" && v == &JsonValue::Bool(false))
        }).and_then(|_| result.emissions.iter().find(|e| {
            e.fields.iter().any(|(k, v)| k == "source" && v.as_str().map(|s| s.contains("servicemode")).unwrap_or(false))
        }));
        assert!(stderr_emit.is_some(), "attributed emission not found in {:?}", result.emissions);
        let root_cause = get_field(stderr_emit.unwrap(), "root_cause").unwrap_or_default();
        assert!(root_cause.contains("ErrnoException"), "root_cause should be from Caused by: {root_cause}");
    }

    #[test]
    fn exception_stack_tracker_fatal_at_end_of_log() {
        // Fatal crash is the last thing in the log — no subsequent line triggers a flush.
        // fatal_crashes must still be populated via the eager write path.
        let script = r#"
      if "fatal_thread_name" in fields {
        if vars.in_fatal_trace && vars.current_fatal_app != "" {
          let detail = vars.current_fatal_exception;
          if vars.current_fatal_root_cause != "" && vars.current_fatal_root_cause != vars.current_fatal_exception {
            detail = detail + " (root: " + vars.current_fatal_root_cause + ")";
          }
          detail = detail + " on " + vars.current_fatal_thread;
          let crashes = vars.fatal_crashes;
          crashes[vars.current_fatal_app] = detail;
          vars.fatal_crashes = crashes;
          _emits.push(#{
            source: vars.current_fatal_app,
            exception: vars.current_fatal_exception,
            root_cause: if vars.current_fatal_root_cause != "" { vars.current_fatal_root_cause } else { vars.current_fatal_exception },
            crash_thread: vars.current_fatal_thread,
            start_line: vars.fatal_trace_start,
            fatal: true,
          });
        }
        vars.current_fatal_thread = fields.fatal_thread_name;
        vars.current_fatal_app = "";
        vars.current_fatal_exception = "";
        vars.current_fatal_root_cause = "";
        vars.fatal_trace_start = line.line_number;
        vars.in_fatal_trace = true;
        vars.fatal_count += 1;
        return;
      }

      if vars.in_fatal_trace && "process_name" in fields {
        vars.current_fatal_app = fields.process_name;
        return;
      }

      if vars.in_fatal_trace && line.tag == "AndroidRuntime" {
        if "caused_by_class" in fields {
          vars.current_fatal_root_cause = fields.caused_by_class;
        }
        if "exception_class" in fields && vars.current_fatal_exception == "" {
          vars.current_fatal_exception = fields.exception_class;
        }
        if vars.current_fatal_app != "" && vars.current_fatal_exception != "" {
          let detail = vars.current_fatal_exception;
          if vars.current_fatal_root_cause != "" && vars.current_fatal_root_cause != vars.current_fatal_exception {
            detail = detail + " (root: " + vars.current_fatal_root_cause + ")";
          }
          detail = detail + " on " + vars.current_fatal_thread;
          let crashes = vars.fatal_crashes;
          crashes[vars.current_fatal_app] = detail;
          vars.fatal_crashes = crashes;
        }
        return;
      }

      if vars.in_fatal_trace {
        if vars.current_fatal_app != "" {
          let detail = vars.current_fatal_exception;
          if vars.current_fatal_root_cause != "" && vars.current_fatal_root_cause != vars.current_fatal_exception {
            detail = detail + " (root: " + vars.current_fatal_root_cause + ")";
          }
          detail = detail + " on " + vars.current_fatal_thread;
          let crashes = vars.fatal_crashes;
          crashes[vars.current_fatal_app] = detail;
          vars.fatal_crashes = crashes;
          _emits.push(#{
            source: vars.current_fatal_app,
            exception: vars.current_fatal_exception,
            root_cause: if vars.current_fatal_root_cause != "" { vars.current_fatal_root_cause } else { vars.current_fatal_exception },
            crash_thread: vars.current_fatal_thread,
            start_line: vars.fatal_trace_start,
            fatal: true,
          });
        }
        vars.in_fatal_trace = false;
      }

      if vars.in_stderr_trace && line.tag != "System.err" {
        let src = if vars.stderr_source != "" { vars.stderr_source } else { "System.err" };
        let exc = vars.stderr_exception;
        let key = src + ": " + exc;
        let summary = vars.nonfatal_summary;
        if key in summary { summary[key] = summary[key] + 1; } else { summary[key] = 1; }
        vars.nonfatal_summary = summary;
        _emits.push(#{
          source: src,
          exception: exc,
          root_cause: vars.stderr_root_cause,
          crash_thread: "",
          start_line: vars.stderr_start_line,
          fatal: false,
        });
        vars.in_stderr_trace = false;
        vars.stderr_source = "";
        vars.stderr_exception = "";
        vars.stderr_root_cause = "";
      }

      if line.tag == "System.err" {
        if "exception_class" in fields && !("caused_by_class" in fields) {
          if vars.in_stderr_trace {
            let src = if vars.stderr_source != "" { vars.stderr_source } else { "System.err" };
            let exc = vars.stderr_exception;
            let key = src + ": " + exc;
            let summary = vars.nonfatal_summary;
            if key in summary { summary[key] = summary[key] + 1; } else { summary[key] = 1; }
            vars.nonfatal_summary = summary;
            _emits.push(#{
              source: src,
              exception: exc,
              root_cause: vars.stderr_root_cause,
              crash_thread: "",
              start_line: vars.stderr_start_line,
              fatal: false,
            });
          }
          vars.in_stderr_trace = true;
          vars.stderr_exception = fields.exception_class;
          vars.stderr_root_cause = fields.exception_class;
          vars.stderr_start_line = line.line_number;
          vars.stderr_source = "";
          vars.nonfatal_count += 1;
          return;
        }
        if vars.in_stderr_trace && "caused_by_class" in fields {
          vars.stderr_root_cause = fields.caused_by_class;
          return;
        }
        if vars.in_stderr_trace && "at_class" in fields && vars.stderr_source == "" {
          let pkg = fields.at_class;
          if !pkg.starts_with("java.") && !pkg.starts_with("javax.") &&
             !pkg.starts_with("android.") && !pkg.starts_with("com.android.") &&
             !pkg.starts_with("libcore.") && !pkg.starts_with("sun.") &&
             !pkg.starts_with("dalvik.") && !pkg.starts_with("kotlin.") &&
             !pkg.starts_with("androidx.") {
            vars.stderr_source = pkg;
          }
          return;
        }
        return;
      }

      if "exception_class" in fields && !("caused_by_class" in fields) && !("at_class" in fields) {
        let tag = line.tag;
        let exc = fields.exception_class;
        vars.nonfatal_count += 1;
        let key = tag + ": " + exc;
        let summary = vars.nonfatal_summary;
        if key in summary {
          summary[key] = summary[key] + 1;
        } else {
          summary[key] = 1;
        }
        vars.nonfatal_summary = summary;
        let root = if "caused_by_class" in fields { fields.caused_by_class } else { exc };
        _emits.push(#{
          source: tag,
          exception: exc,
          root_cause: root,
          crash_thread: "",
          start_line: line.line_number,
          fatal: false,
        });
      }
"#;
        let d = def(&format!(r#"
meta:
  id: t
  name: T
vars:
  - name: fatal_count
    type: int
    default: 0
  - name: nonfatal_count
    type: int
    default: 0
  - name: fatal_crashes
    type: map
    default: {{}}
  - name: nonfatal_summary
    type: map
    default: {{}}
  - name: current_fatal_thread
    type: string
    default: ""
  - name: current_fatal_app
    type: string
    default: ""
  - name: current_fatal_exception
    type: string
    default: ""
  - name: current_fatal_root_cause
    type: string
    default: ""
  - name: fatal_trace_start
    type: int
    default: 0
  - name: in_fatal_trace
    type: bool
    default: false
  - name: in_stderr_trace
    type: bool
    default: false
  - name: stderr_exception
    type: string
    default: ""
  - name: stderr_root_cause
    type: string
    default: ""
  - name: stderr_start_line
    type: int
    default: 0
  - name: stderr_source
    type: string
    default: ""
pipeline:
  - stage: filter
    rules:
      - type: message_contains_any
        values: ["FATAL EXCEPTION", "Exception", "Error", "Process:", "at com."]
  - stage: extract
    fields:
      - name: fatal_thread_name
        pattern: 'FATAL EXCEPTION:\s+(.+)'
      - name: process_name
        pattern: 'Process:\s+([^\s,]+)'
      - name: exception_class
        pattern: '([a-z][\w.]*\.(?:\w+(?:Exception|Error|Throwable)))'
      - name: caused_by_class
        pattern: 'Caused by:\s+([a-z][\w.]*\.(?:\w+(?:Exception|Error|Throwable)))'
      - name: at_class
        pattern: '^\s*at\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_$]*){{2,}})\.[A-Z]'
  - stage: script
    runtime: rhai
    src: |
{script}
  - stage: output
    views:
      - type: table
        source: emissions
        columns: ["fatal", "source", "exception", "root_cause", "start_line"]
        sort: "source"
"#));
        let mut run = ProcessorRun::new(&d);

        // Fatal trace at end of log — no subsequent line to flush it
        run.process_line(&make_line("AndroidRuntime", "FATAL EXCEPTION: main", LogLevel::Error, 100), &PipelineContext::test_default());
        run.process_line(&make_line("AndroidRuntime", "Process: com.example.app, PID: 9999", LogLevel::Error, 101), &PipelineContext::test_default());
        run.process_line(&make_line("AndroidRuntime", "java.lang.NullPointerException: attempt to dereference null", LogLevel::Error, 102), &PipelineContext::test_default());
        run.process_line(&make_line("AndroidRuntime", "Caused by: java.lang.IllegalStateException: bad state", LogLevel::Error, 103), &PipelineContext::test_default());
        // Log ends here — no flush trigger

        let result = run.finish();
        assert_eq!(result.vars["fatal_count"], JsonValue::Number(1.into()));
        assert_eq!(result.vars["nonfatal_count"], JsonValue::Number(0.into()));
        // fatal_crashes must be populated via eager write even without a flush
        let fatal_crashes = result.vars["fatal_crashes"].as_object().unwrap();
        assert!(fatal_crashes.contains_key("com.example.app"), "fatal_crashes should have app entry");
        let detail = fatal_crashes["com.example.app"].as_str().unwrap();
        assert!(detail.contains("java.lang.NullPointerException"), "detail: {detail}");
        assert!(detail.contains("java.lang.IllegalStateException"), "detail: {detail}");
        assert!(detail.contains("on main"), "detail: {detail}");
        // No emission yet (trace not flushed) — but display map has the data
        assert_eq!(result.emissions.len(), 0);
    }

    #[test]
    fn exception_stack_tracker_stderr_attribution_two_consecutive_traces() {
        // Replicates the real-log scenario: two back-to-back System.err FileNotFoundException
        // traces from com.sec.android.app.servicemodeapp, with app at-frames that should
        // be attributed. The second trace starts before the first has a non-System.err flush.
        // Inline the same script used by the other exception_stack_tracker tests.
        // Copy from exception_stack_tracker_fatal_at_end_of_log above (same script var).
        let script = r#"
      if "fatal_thread_name" in fields {
        if vars.in_fatal_trace && vars.current_fatal_app != "" {
          let detail = vars.current_fatal_exception;
          if vars.current_fatal_root_cause != "" && vars.current_fatal_root_cause != vars.current_fatal_exception {
            detail = detail + " (root: " + vars.current_fatal_root_cause + ")";
          }
          detail = detail + " on " + vars.current_fatal_thread;
          let crashes = vars.fatal_crashes;
          crashes[vars.current_fatal_app] = detail;
          vars.fatal_crashes = crashes;
          _emits.push(#{
            source: vars.current_fatal_app,
            exception: vars.current_fatal_exception,
            root_cause: if vars.current_fatal_root_cause != "" { vars.current_fatal_root_cause } else { vars.current_fatal_exception },
            crash_thread: vars.current_fatal_thread,
            start_line: vars.fatal_trace_start,
            fatal: true,
          });
        }
        vars.current_fatal_thread = fields.fatal_thread_name;
        vars.current_fatal_app = "";
        vars.current_fatal_exception = "";
        vars.current_fatal_root_cause = "";
        vars.fatal_trace_start = line.line_number;
        vars.in_fatal_trace = true;
        vars.fatal_count += 1;
        return;
      }
      if vars.in_fatal_trace && "process_name" in fields {
        vars.current_fatal_app = fields.process_name;
        return;
      }
      if vars.in_fatal_trace && line.tag == "AndroidRuntime" {
        if "caused_by_class" in fields { vars.current_fatal_root_cause = fields.caused_by_class; }
        if "exception_class" in fields && vars.current_fatal_exception == "" { vars.current_fatal_exception = fields.exception_class; }
        if vars.current_fatal_app != "" && vars.current_fatal_exception != "" {
          let detail = vars.current_fatal_exception;
          if vars.current_fatal_root_cause != "" && vars.current_fatal_root_cause != vars.current_fatal_exception {
            detail = detail + " (root: " + vars.current_fatal_root_cause + ")";
          }
          detail = detail + " on " + vars.current_fatal_thread;
          let crashes = vars.fatal_crashes;
          crashes[vars.current_fatal_app] = detail;
          vars.fatal_crashes = crashes;
        }
        return;
      }
      if vars.in_fatal_trace {
        if vars.current_fatal_app != "" {
          let detail = vars.current_fatal_exception;
          if vars.current_fatal_root_cause != "" && vars.current_fatal_root_cause != vars.current_fatal_exception {
            detail = detail + " (root: " + vars.current_fatal_root_cause + ")";
          }
          detail = detail + " on " + vars.current_fatal_thread;
          let crashes = vars.fatal_crashes;
          crashes[vars.current_fatal_app] = detail;
          vars.fatal_crashes = crashes;
          _emits.push(#{
            source: vars.current_fatal_app,
            exception: vars.current_fatal_exception,
            root_cause: if vars.current_fatal_root_cause != "" { vars.current_fatal_root_cause } else { vars.current_fatal_exception },
            crash_thread: vars.current_fatal_thread,
            start_line: vars.fatal_trace_start,
            fatal: true,
          });
        }
        vars.in_fatal_trace = false;
      }
      if vars.in_stderr_trace && line.tag != "System.err" {
        let src = if vars.stderr_source != "" { vars.stderr_source } else { "System.err" };
        let exc = vars.stderr_exception;
        let key = src + ": " + exc;
        let summary = vars.nonfatal_summary;
        if key in summary { summary[key] = summary[key] + 1; } else { summary[key] = 1; }
        vars.nonfatal_summary = summary;
        _emits.push(#{
          source: src, exception: exc, root_cause: vars.stderr_root_cause,
          crash_thread: "", start_line: vars.stderr_start_line, fatal: false,
        });
        vars.in_stderr_trace = false;
        vars.stderr_source = "";
        vars.stderr_exception = "";
        vars.stderr_root_cause = "";
      }
      if line.tag == "System.err" {
        if "exception_class" in fields && !("caused_by_class" in fields) {
          if vars.in_stderr_trace {
            let src = if vars.stderr_source != "" { vars.stderr_source } else { "System.err" };
            let exc = vars.stderr_exception;
            let key = src + ": " + exc;
            let summary = vars.nonfatal_summary;
            if key in summary { summary[key] = summary[key] + 1; } else { summary[key] = 1; }
            vars.nonfatal_summary = summary;
            _emits.push(#{
              source: src, exception: exc, root_cause: vars.stderr_root_cause,
              crash_thread: "", start_line: vars.stderr_start_line, fatal: false,
            });
          }
          vars.in_stderr_trace = true;
          vars.stderr_exception = fields.exception_class;
          vars.stderr_root_cause = fields.exception_class;
          vars.stderr_start_line = line.line_number;
          vars.stderr_source = "";
          vars.nonfatal_count += 1;
          return;
        }
        if vars.in_stderr_trace && "caused_by_class" in fields {
          vars.stderr_root_cause = fields.caused_by_class;
          return;
        }
        if vars.in_stderr_trace && "at_class" in fields && vars.stderr_source == "" {
          let pkg = fields.at_class;
          if !pkg.starts_with("java.") && !pkg.starts_with("javax.") &&
             !pkg.starts_with("android.") && !pkg.starts_with("com.android.") &&
             !pkg.starts_with("libcore.") && !pkg.starts_with("sun.") &&
             !pkg.starts_with("dalvik.") && !pkg.starts_with("kotlin.") &&
             !pkg.starts_with("androidx.") {
            vars.stderr_source = pkg;
          }
          return;
        }
        return;
      }
      if "exception_class" in fields && !("caused_by_class" in fields) && !("at_class" in fields) {
        let tag = line.tag;
        let exc = fields.exception_class;
        vars.nonfatal_count += 1;
        let key = tag + ": " + exc;
        let summary = vars.nonfatal_summary;
        if key in summary { summary[key] = summary[key] + 1; } else { summary[key] = 1; }
        vars.nonfatal_summary = summary;
        let root = if "caused_by_class" in fields { fields.caused_by_class } else { exc };
        _emits.push(#{
          source: tag, exception: exc, root_cause: root,
          crash_thread: "", start_line: line.line_number, fatal: false,
        });
      }
"#;
        let d = def(&format!(r#"
meta:
  id: t
  name: T
vars:
  - name: fatal_count
    type: int
    default: 0
  - name: nonfatal_count
    type: int
    default: 0
  - name: fatal_crashes
    type: map
    default: {{}}
  - name: nonfatal_summary
    type: map
    default: {{}}
  - name: current_fatal_thread
    type: string
    default: ""
  - name: current_fatal_app
    type: string
    default: ""
  - name: current_fatal_exception
    type: string
    default: ""
  - name: current_fatal_root_cause
    type: string
    default: ""
  - name: fatal_trace_start
    type: int
    default: 0
  - name: in_fatal_trace
    type: bool
    default: false
  - name: in_stderr_trace
    type: bool
    default: false
  - name: stderr_exception
    type: string
    default: ""
  - name: stderr_root_cause
    type: string
    default: ""
  - name: stderr_start_line
    type: int
    default: 0
  - name: stderr_source
    type: string
    default: ""
pipeline:
  - stage: filter
    rules:
      - type: message_contains_any
        values: ["FATAL EXCEPTION", "Exception", "Error", "Process:", "at com."]
  - stage: extract
    fields:
      - name: fatal_thread_name
        pattern: 'FATAL EXCEPTION:\s+(.+)'
      - name: process_name
        pattern: 'Process:\s+([^\s,]+)'
      - name: exception_class
        pattern: '([a-z][\w.]*\.(?:\w+(?:Exception|Error|Throwable)))'
      - name: caused_by_class
        pattern: 'Caused by:\s+([a-z][\w.]*\.(?:\w+(?:Exception|Error|Throwable)))'
      - name: at_class
        pattern: '^\s*at\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_$]*){{2,}})\.[A-Z]'
  - stage: script
    runtime: rhai
    src: |
{script}
  - stage: output
    views:
      - type: table
        source: emissions
        columns: ["fatal", "source", "exception", "root_cause", "start_line"]
        sort: "source"
"#));
        let mut run = ProcessorRun::new(&d);

        // First trace: FileNotFoundException with app at-frame.
        // NOTE: messages are constructed WITHOUT leading \t — the logcat parser's :\s* strips
        // the tab from "System.err: \tat com.sec..." leaving "at com.sec..." in line.message.
        run.process_line(&make_line("System.err", "java.io.FileNotFoundException: /sys/class/sec/ap_pmic/wake_enabled: open failed: ENOENT (No such file or directory)", LogLevel::Warn, 467406), &PipelineContext::test_default());
        // framework at-frames: NOT in filter (no "at com.") — never reach script
        // app at-frame: contains "at com." → passes filter, at_class extracted
        run.process_line(&make_line("System.err", "at com.sec.android.app.servicemodeapp.SysDump.getSysfsFile(SysDump.java:1093)", LogLevel::Warn, 467410), &PipelineContext::test_default());
        // Second trace arrives without an intervening non-System.err filter line
        run.process_line(&make_line("System.err", "java.io.FileNotFoundException: /sys/module/qpnp_power_on/parameters/wake_enabled: open failed: ENOENT (No such file or directory)", LogLevel::Warn, 467441), &PipelineContext::test_default());
        run.process_line(&make_line("System.err", "at com.sec.android.app.servicemodeapp.SysDump.getSysfsFile(SysDump.java:1093)", LogLevel::Warn, 467445), &PipelineContext::test_default());
        // Non-System.err flush trigger
        run.process_line(&make_line("ServiceModeApp", "some Error in file", LogLevel::Error, 467500), &PipelineContext::test_default());

        let result = run.finish();
        assert_eq!(result.vars["nonfatal_count"], JsonValue::Number(2.into()));
        let nonfatal = result.vars["nonfatal_summary"].as_object().unwrap();
        // Both traces should be attributed to the app package
        assert!(nonfatal.contains_key("com.sec.android.app.servicemodeapp: java.io.FileNotFoundException"),
            "expected attribution, got: {nonfatal:?}");
        assert!(!nonfatal.contains_key("System.err: java.io.FileNotFoundException"),
            "should not fall back to System.err: {nonfatal:?}");
    }
}
