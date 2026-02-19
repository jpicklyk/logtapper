use regex::Regex;
use serde_json::Value as JsonValue;
use std::collections::HashMap;

use crate::core::line::LineContext;
use super::schema::{
    AggType, CastType, ExtractField, FilterRule, FilterStage, PipelineStage, ProcessorDef,
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
    def: &'a ProcessorDef,
    vars: VarStore,
    emissions: Vec<Emission>,
    matched_line_nums: Vec<usize>,
    /// Compiled filter regexes, keyed by pattern string.
    regex_cache: HashMap<String, Regex>,
    /// Script engine (lazily created when a script stage is encountered).
    script_engine: Option<ScriptEngine>,
    /// Lookback buffer (capped at 1000 lines).
    history: Vec<LineContext>,
}

impl<'a> ProcessorRun<'a> {
    pub fn new(def: &'a ProcessorDef) -> Self {
        Self {
            vars: VarStore::new(&def.vars),
            def,
            emissions: Vec::new(),
            matched_line_nums: Vec::new(),
            regex_cache: HashMap::new(),
            script_engine: None,
            history: Vec::new(),
        }
    }

    /// Create a run seeded with previously saved state for continuous (streaming) processing.
    pub fn new_seeded(
        def: &'a ProcessorDef,
        vars: VarStore,
        emissions: Vec<Emission>,
        matched_line_nums: Vec<usize>,
        history: Vec<LineContext>,
    ) -> Self {
        Self {
            vars,
            def,
            emissions,
            matched_line_nums,
            regex_cache: HashMap::new(),
            script_engine: None,
            history,
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
                        history: &self.history,
                    };
                    if let Ok((new_vars, new_emissions)) = engine.run_script(&ss.src, &input) {
                        // Merge var updates
                        self.vars.update_from_rhai(&new_vars);
                        // Collect emissions
                        for e in new_emissions {
                            self.emissions.push(Emission {
                                line_num: line.source_line_num,
                                fields: e,
                            });
                        }
                    }
                }
                PipelineStage::Aggregate(agg) => {
                    for group in &agg.groups {
                        self.apply_aggregate(&group.agg_type, group.field.as_deref(), &fields);
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
        self.history.push(line.clone());
        if self.history.len() > 1000 {
            self.history.remove(0);
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
    pub fn into_continuous_state(self, last_processed_line: usize) -> ContinuousRunState {
        ContinuousRunState {
            vars: self.vars,
            emissions: self.emissions,
            matched_line_nums: self.matched_line_nums,
            history: self.history,
            last_processed_line,
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
    pub history: Vec<LineContext>,
    /// Absolute session line index of the next line to process.
    pub last_processed_line: usize,
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
