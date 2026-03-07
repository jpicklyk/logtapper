//! Correlator engine — matches pairs (or groups) of log events across sources
//! within a configurable time/line window and emits a `CorrelationEvent` when
//! all non-trigger sources have at least one match.

use regex::Regex;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, VecDeque};

use crate::core::line::{LineContext, PipelineContext};
// Arc<str> fields deref to &str, so most comparisons work via deref.
use super::schema::{CorrelatorDef, ExtractField, FilterRule, SourceDef};

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

/// A single correlated observation: the trigger event plus the matching context
/// from every other source, all within the configured window.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrelationEvent {
    pub trigger_line_num: usize,
    pub trigger_timestamp: i64,
    pub trigger_source_id: String,
    pub trigger_fields: HashMap<String, JsonValue>,
    /// Raw log line text for the trigger line.
    pub trigger_raw_line: String,
    /// Non-trigger source matches available within the window at trigger time.
    pub matched_sources: HashMap<String, Vec<SourceMatchRecord>>,
    /// Human-readable message formatted from `CorrelateDef::emit` template.
    pub message: String,
}

/// A single match from a non-trigger source stored in the ring buffer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMatchRecord {
    pub line_num: usize,
    pub timestamp: i64,
    pub fields: HashMap<String, JsonValue>,
    /// Raw log line text for this matched source line.
    pub raw_line: String,
}

// ---------------------------------------------------------------------------
// CorrelatorRun — stateful accumulator for one pass
// ---------------------------------------------------------------------------

pub struct CorrelatorRun<'a> {
    def: &'a CorrelatorDef,
    /// Ring buffers of recent matches per non-trigger source ID.
    source_buffers: HashMap<String, VecDeque<SourceMatchRecord>>,
    /// Emitted correlation events.
    events: Vec<CorrelationEvent>,
    /// Compiled regex cache.
    regex_cache: HashMap<String, Regex>,
}

impl<'a> CorrelatorRun<'a> {
    pub fn new(def: &'a CorrelatorDef) -> Self {
        let mut source_buffers = HashMap::new();
        for src in &def.sources {
            if src.id != def.correlate.trigger {
                source_buffers.insert(src.id.clone(), VecDeque::new());
            }
        }
        Self {
            def,
            source_buffers,
            events: Vec::new(),
            regex_cache: HashMap::new(),
        }
    }

    /// Process one log line through all source definitions.
    pub fn process_line(&mut self, line: &LineContext, _pipeline_ctx: &PipelineContext) {
        let trigger_id = self.def.correlate.trigger.clone();

        // Snapshot which source IDs match this line (avoid borrow issues).
        let mut source_matches: Vec<(String, HashMap<String, JsonValue>)> = Vec::new();

        for src in &self.def.sources {
            if let Some(extracted) = self.try_match_source(src, line) {
                source_matches.push((src.id.clone(), extracted));
            }
        }

        // Process matches: non-triggers go into ring buffers; trigger checks correlations.
        for (src_id, fields) in source_matches {
            if src_id != trigger_id {
                let record = SourceMatchRecord {
                    line_num: line.source_line_num,
                    timestamp: line.timestamp,
                    fields: fields.clone(),
                    raw_line: line.raw.to_string(),
                };
                if let Some(buf) = self.source_buffers.get_mut(&src_id) {
                    buf.push_back(record);
                }
            } else {
                // This is a trigger match: evict stale entries from all non-trigger buffers,
                // then check if every non-trigger source has at least one match within window.
                let within_lines = self.def.correlate.within_lines;
                let within_ms = self.def.correlate.within_ms;
                let trigger_line = line.source_line_num;
                let trigger_ts = line.timestamp;

                // Evict entries outside the window from all non-trigger buffers.
                for buf in self.source_buffers.values_mut() {
                    buf.retain(|r| {
                        let line_ok = within_lines.map_or(true, |wl| {
                            trigger_line.saturating_sub(r.line_num) <= wl
                        });
                        let ms_ok = within_ms.map_or(true, |wms| {
                            let window_nanos = wms as i64 * 1_000_000;
                            trigger_ts - r.timestamp <= window_nanos
                        });
                        line_ok && ms_ok
                    });
                }

                // Check if all non-trigger sources have at least one match.
                let all_matched = self.source_buffers.values().all(|buf| !buf.is_empty());

                if all_matched && !self.source_buffers.is_empty() {
                    // Collect the best (most recent) match from each non-trigger source.
                    let mut matched_sources: HashMap<String, Vec<SourceMatchRecord>> =
                        HashMap::new();
                    for (sid, buf) in &self.source_buffers {
                        let records: Vec<SourceMatchRecord> = buf.iter().cloned().collect();
                        matched_sources.insert(sid.clone(), records);
                    }

                    // Format the message template.
                    let message = self.format_message(
                        &self.def.correlate.emit.clone(),
                        &trigger_id,
                        &fields,
                        &matched_sources,
                    );

                    self.events.push(CorrelationEvent {
                        trigger_line_num: trigger_line,
                        trigger_timestamp: trigger_ts,
                        trigger_source_id: trigger_id.clone(),
                        trigger_fields: fields,
                        trigger_raw_line: line.raw.to_string(),
                        matched_sources,
                        message,
                    });
                }
            }
        }
    }

    /// Consume the run and return results.
    pub fn finish(self) -> CorrelatorResult {
        CorrelatorResult {
            guidance: self.def.correlate.guidance.clone(),
            events: self.events,
        }
    }

    /// Non-consuming snapshot for streaming use.
    pub fn current_result(&self) -> CorrelatorResult {
        CorrelatorResult {
            guidance: self.def.correlate.guidance.clone(),
            events: self.events.clone(),
        }
    }

    /// Consume into persistent state for streaming batches.
    pub fn into_continuous_state(self) -> ContinuousCorrelatorState {
        ContinuousCorrelatorState {
            source_buffers: self.source_buffers,
            events: self.events,
        }
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /// Returns `Some(fields)` if the line passes the source's filter and condition.
    fn try_match_source(
        &mut self,
        src: &SourceDef,
        line: &LineContext,
    ) -> Option<HashMap<String, JsonValue>> {
        // AND-ed filter rules.
        for rule in &src.filter {
            if !self.rule_matches(rule, line) {
                return None;
            }
        }

        // Extract fields.
        let mut fields = HashMap::new();
        self.apply_extract(&src.extract, line, &mut fields);

        // Optional Rhai condition.
        if let Some(condition) = &src.condition {
            if !self.eval_condition(condition, &fields) {
                return None;
            }
        }

        Some(fields)
    }

    fn rule_matches(&mut self, rule: &FilterRule, line: &LineContext) -> bool {
        crate::processors::filter::rule_matches(&mut self.regex_cache, rule, line, None)
    }

    fn apply_extract(
        &mut self,
        fields: &[ExtractField],
        line: &LineContext,
        out: &mut HashMap<String, JsonValue>,
    ) {
        use crate::processors::reporter::schema::CastType;
        for field in fields {
            let pat = field.pattern.clone();
            let re = match self.get_or_compile(&pat) {
                Some(r) => r,
                None => continue,
            };
            if let Some(caps) = re.captures(&line.message) {
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

    /// Evaluate a simple Rhai condition expression against extracted fields.
    /// Returns `true` if the expression evaluates to a truthy value, or if
    /// evaluation fails (fail-open so the source still matches).
    fn eval_condition(&self, condition: &str, fields: &HashMap<String, JsonValue>) -> bool {
        // Build a minimal Rhai scope with only the extracted fields.
        let mut engine = rhai::Engine::new();
        engine.set_max_operations(10_000);
        let mut scope = rhai::Scope::new();

        // Push each field into scope.
        for (k, v) in fields {
            match v {
                JsonValue::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        scope.push(k.clone(), i);
                    } else if let Some(f) = n.as_f64() {
                        scope.push(k.clone(), f);
                    }
                }
                JsonValue::Bool(b) => { scope.push(k.clone(), *b); }
                JsonValue::String(s) => { scope.push(k.clone(), s.clone()); }
                _ => {}
            }
        }

        engine.eval_expression_with_scope::<bool>(&mut scope, condition).unwrap_or(true)
    }

    /// Format the emit template by substituting `{{source_id.field_name}}` placeholders.
    fn format_message(
        &self,
        template: &str,
        trigger_id: &str,
        trigger_fields: &HashMap<String, JsonValue>,
        matched_sources: &HashMap<String, Vec<SourceMatchRecord>>,
    ) -> String {
        let mut result = template.to_string();

        // Substitute trigger fields: {{trigger_id.field}}
        for (k, v) in trigger_fields {
            let placeholder = format!("{{{{{}.{}}}}}", trigger_id, k);
            let replacement = json_val_to_str(v);
            result = result.replace(&placeholder, &replacement);
        }

        // Substitute non-trigger source fields using the most recent match.
        for (sid, records) in matched_sources {
            if let Some(rec) = records.last() {
                for (k, v) in &rec.fields {
                    let placeholder = format!("{{{{{}.{}}}}}", sid, k);
                    let replacement = json_val_to_str(v);
                    result = result.replace(&placeholder, &replacement);
                }
            }
        }

        result
    }

    fn get_or_compile(&mut self, pattern: &str) -> Option<&Regex> {
        crate::processors::filter::get_or_compile(&mut self.regex_cache, pattern)
    }
}

// ---------------------------------------------------------------------------
// CorrelatorResult
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrelatorResult {
    /// Optional plain-English guidance from the YAML author, rendered in the panel header.
    pub guidance: Option<String>,
    pub events: Vec<CorrelationEvent>,
}

// ---------------------------------------------------------------------------
// ContinuousCorrelatorState — persisted between ADB streaming batches
// ---------------------------------------------------------------------------

pub struct ContinuousCorrelatorState {
    pub source_buffers: HashMap<String, VecDeque<SourceMatchRecord>>,
    pub events: Vec<CorrelationEvent>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn json_val_to_str(v: &JsonValue) -> String {
    match v {
        JsonValue::String(s) => s.clone(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::Bool(b) => b.to_string(),
        _ => v.to_string(),
    }
}
