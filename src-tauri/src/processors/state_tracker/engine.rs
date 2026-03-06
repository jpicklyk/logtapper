use std::collections::HashMap;
use std::sync::OnceLock;
use regex::Regex;
use serde_json::Value as JsonValue;

use crate::core::line::{LineContext, LogLevel, PipelineContext};
use crate::processors::state_tracker::schema::{StateTrackerDef, TransitionFilter};
use crate::processors::state_tracker::types::{
    ContinuousTrackerState, FieldChange, StateSnapshot, StateTrackerResult, StateTransition,
};

pub struct StateTrackerRun {
    def: StateTrackerDef,
    current_state: HashMap<String, JsonValue>,
    transitions: Vec<StateTransition>,
    tracker_id: String,
}

impl StateTrackerRun {
    pub fn new(tracker_id: &str, def: &StateTrackerDef) -> Self {
        let current_state = build_defaults(def);
        StateTrackerRun {
            def: def.clone(),
            current_state,
            transitions: Vec::new(),
            tracker_id: tracker_id.to_string(),
        }
    }

    pub fn new_seeded(tracker_id: &str, def: &StateTrackerDef, saved: ContinuousTrackerState) -> Self {
        StateTrackerRun {
            def: def.clone(),
            current_state: saved.current_state,
            transitions: saved.transitions,
            tracker_id: tracker_id.to_string(),
        }
    }
    pub fn process_line(&mut self, line: &LineContext, pipeline_ctx: &PipelineContext) {
        for rule in &self.def.transitions {
            let captures = match matches_filter_with_captures(&rule.filter, line, pipeline_ctx) {
                Some(caps) => caps,
                None => continue,
            };

            let mut new_state = self.current_state.clone();

            for (field_name, yaml_value) in &rule.set {
                let expanded = expand_captures(yaml_value, &captures);
                new_state.insert(field_name.clone(), expanded);
            }

            for field_name in &rule.clear {
                if let Some(default_val) = find_default(&self.def, field_name) {
                    new_state.insert(field_name.clone(), default_val);
                }
            }

            let changes = compute_changes(&self.current_state, &new_state);

            if !changes.is_empty() {
                self.transitions.push(StateTransition {
                    line_num: line.source_line_num,
                    timestamp: line.timestamp,
                    transition_name: rule.name.clone(),
                    changes,
                });
                self.current_state = new_state;
            }

            break;
        }
    }
    pub fn get_state_at_line(&self, line_num: usize) -> StateSnapshot {
        let pos = self.transitions.partition_point(|t| t.line_num <= line_num);

        let mut fields = build_defaults(&self.def);
        let mut initialized: std::collections::HashSet<String> = Default::default();

        for t in &self.transitions[..pos] {
            for (field, change) in &t.changes {
                fields.insert(field.clone(), change.to.clone());
                initialized.insert(field.clone());
            }
        }

        let (line, ts) = if pos > 0 {
            let t = &self.transitions[pos - 1];
            (t.line_num, t.timestamp)
        } else {
            (0, 0)
        };

        StateSnapshot {
            line_num: line,
            timestamp: ts,
            fields,
            initialized_fields: initialized.into_iter().collect(),
        }
    }

    pub fn get_all_transitions(&self) -> &[StateTransition] {
        &self.transitions
    }

    pub fn finish(self) -> StateTrackerResult {
        StateTrackerResult {
            tracker_id: self.tracker_id,
            transitions: self.transitions,
            final_state: self.current_state,
        }
    }

    pub fn into_continuous_state(self, last_processed_line: usize) -> ContinuousTrackerState {
        ContinuousTrackerState {
            current_state: self.current_state,
            transitions: self.transitions,
            last_processed_line,
        }
    }
}

// -- Helpers ------------------------------------------------------------------

fn build_defaults(def: &StateTrackerDef) -> HashMap<String, JsonValue> {
    def.state.iter()
        .map(|f| (f.name.clone(), f.default.clone()))
        .collect()
}

fn find_default(def: &StateTrackerDef, name: &str) -> Option<JsonValue> {
    def.state.iter()
        .find(|f| f.name == name)
        .map(|f| f.default.clone())
}
fn level_char(level: &LogLevel) -> &'static str {
    match level {
        LogLevel::Verbose => "V",
        LogLevel::Debug   => "D",
        LogLevel::Info    => "I",
        LogLevel::Warn    => "W",
        LogLevel::Error   => "E",
        LogLevel::Fatal   => "F",
    }
}


/// Check all filter conditions and extract capture groups in a single pass.
///
/// Returns `None` if the filter does not match. Returns `Some(captures)` on match,
/// where captures may be `None` (no regex groups) or `Some(vec)` with `$N` pairs.
/// Tag regex captures are numbered first ($1, $2, ...), then message regex captures
/// continue the sequence.
fn matches_filter_with_captures(
    filter: &TransitionFilter,
    line: &LineContext,
    pipeline_ctx: &PipelineContext,
) -> Option<Option<Vec<(usize, String)>>> {
    // Check source_type and section first (cheapest comparisons)
    if let Some(ref st) = filter.source_type {
        if !pipeline_ctx.source_type.matches_str(st) {
            return None;
        }
    }
    if let Some(ref sec) = filter.section {
        let line_section = crate::core::line::section_for_line(&pipeline_ctx.sections, line.source_line_num);
        if line_section != sec {
            return None;
        }
    }

    if let Some(tag) = &filter.tag {
        if &*line.tag != tag.as_str() {
            return None;
        }
    }

    // Tag regex: use captures() instead of is_match() to avoid double execution.
    let tag_caps: Vec<(usize, String)> = if let Some(pattern) = &filter.tag_regex {
        match get_compiled_regex(pattern).and_then(|re| re.captures(&line.tag)) {
            Some(caps) => caps.iter().enumerate().skip(1)
                .filter_map(|(i, m)| m.map(|m| (i, m.as_str().to_string())))
                .collect(),
            None => return None,
        }
    } else {
        Vec::new()
    };

    if let Some(substr) = &filter.message_contains {
        if !line.message.contains(substr.as_str()) {
            return None;
        }
    }

    // Message regex: use captures() and offset group indices by tag capture count.
    let msg_caps: Vec<(usize, String)> = if let Some(pattern) = &filter.message_regex {
        match get_compiled_regex(pattern).and_then(|re| re.captures(&line.message)) {
            Some(caps) => caps.iter().enumerate().skip(1)
                .filter_map(|(i, m)| {
                    m.map(|m| (i + tag_caps.len(), m.as_str().to_string()))
                })
                .collect(),
            None => return None,
        }
    } else {
        Vec::new()
    };

    if let Some(level_str) = &filter.level {
        if level_char(&line.level) != level_str.as_str() {
            return None;
        }
    }

    let captures = if tag_caps.is_empty() && msg_caps.is_empty() {
        None
    } else {
        let mut combined = tag_caps;
        combined.extend(msg_caps);
        Some(combined)
    };
    Some(captures)
}

/// Thread-safe compiled regex cache.
fn get_compiled_regex(pattern: &str) -> Option<&'static Regex> {
    use std::sync::Mutex;

    static CACHE: OnceLock<Mutex<HashMap<String, Option<Regex>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cache.lock().unwrap();

    if let Some(opt) = map.get(pattern) {
        // SAFETY: entries are never removed; Regex lifetime is effectively 'static
        return opt.as_ref().map(|re| unsafe { &*(re as *const Regex) });
    }

    let compiled = Regex::new(pattern).ok();
    map.insert(pattern.to_string(), compiled);
    map.get(pattern).unwrap().as_ref().map(|re| unsafe { &*(re as *const Regex) })
}

/// Expand capture references ($1, $2, ...) in a serde_yaml::Value.
fn expand_captures(value: &serde_yaml::Value, captures: &Option<Vec<(usize, String)>>) -> JsonValue {
    match value {
        serde_yaml::Value::String(s) => {
            let mut result = s.clone();
            if let Some(caps) = captures {
                for (i, cap_str) in caps {
                    result = result.replace(&format!("${i}"), cap_str);
                }
            }
            JsonValue::String(result)
        }
        serde_yaml::Value::Bool(b) => JsonValue::Bool(*b),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                JsonValue::Number(i.into())
            } else if let Some(f) = n.as_f64() {
                JsonValue::Number(serde_json::Number::from_f64(f).unwrap_or(0.into()))
            } else {
                JsonValue::Null
            }
        }
        _ => JsonValue::Null,
    }
}

fn compute_changes(
    old: &HashMap<String, JsonValue>,
    new: &HashMap<String, JsonValue>,
) -> HashMap<String, FieldChange> {
    let mut changes = HashMap::new();
    for (key, new_val) in new {
        let old_val = old.get(key).cloned().unwrap_or(JsonValue::Null);
        if &old_val != new_val {
            changes.insert(key.clone(), FieldChange { from: old_val, to: new_val.clone() });
        }
    }
    changes
}

// -- Tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::processors::state_tracker::schema::{
        StateFieldDecl, StateFieldType, StateTrackerOutput, TransitionRule,
    };
    use serde_json::json;

    fn load_battery_def() -> StateTrackerDef {
        let yaml = include_str!("../../../../marketplace/processors/battery_state.yaml");
        let proc: crate::processors::AnyProcessor =
            crate::processors::AnyProcessor::from_yaml(yaml).expect("battery_state.yaml parses");
        match proc.kind {
            crate::processors::ProcessorKind::StateTracker(def) => def,
            _ => panic!("expected StateTracker kind"),
        }
    }

    #[test]
    fn battery_discharging_sets_all_fields() {
        let def = load_battery_def();
        let mut run = StateTrackerRun::new("__battery_state", &def);
        // Samsung ACTION_BATTERY_CHANGED — status:3 (discharging), all plug booleans false
        let msg = "Sending ACTION_BATTERY_CHANGED: level:99, status:3, health:2, remain:0, ac:false, usb:false, wireless:false, pogo:false, misc:0x10000";
        run.process_line(&make_line(1, "BatteryService", msg), &PipelineContext::test_default());
        assert_eq!(run.transitions.len(), 1);
        assert_eq!(run.transitions[0].transition_name, "Discharging");
        assert_eq!(run.current_state["level"], json!("99"));
        assert_eq!(run.current_state["charging"], json!(false));
        assert_eq!(run.current_state["status"], json!("discharging"));
        assert_eq!(run.current_state["plugged"], json!("none"));
        // plugged must appear in changes (null→"none") so it becomes initialized in the UI
        assert!(run.transitions[0].changes.contains_key("plugged"));
    }

    #[test]
    fn battery_charging_usb_sets_all_fields() {
        let def = load_battery_def();
        let mut run = StateTrackerRun::new("__battery_state", &def);
        // Samsung — status:2 (charging), usb:true
        let msg = "Sending ACTION_BATTERY_CHANGED: level:85, status:2, health:2, remain:0, ac:false, usb:true, wireless:false, pogo:false";
        run.process_line(&make_line(1, "BatteryService", msg), &PipelineContext::test_default());
        assert_eq!(run.transitions.len(), 1);
        assert_eq!(run.transitions[0].transition_name, "Charging via USB");
        assert_eq!(run.current_state["level"], json!("85"));
        assert_eq!(run.current_state["charging"], json!(true));
        assert_eq!(run.current_state["status"], json!("charging"));
        assert_eq!(run.current_state["plugged"], json!("usb"));
    }

    #[test]
    fn battery_aosp_ac_sets_all_fields() {
        let def = load_battery_def();
        let mut run = StateTrackerRun::new("__battery_state", &def);
        // AOSP — level=90, status=2, plugged=1 (AC)
        let msg = "level=90, status=2, health=2, present=true, voltage=4200, plugged=1, technology=Li-ion";
        run.process_line(&make_line(1, "BatteryService", msg), &PipelineContext::test_default());
        assert_eq!(run.transitions.len(), 1);
        assert_eq!(run.transitions[0].transition_name, "AC Plugged (AOSP)");
        assert_eq!(run.current_state["level"], json!("90"));
        assert_eq!(run.current_state["charging"], json!(true));
        assert_eq!(run.current_state["plugged"], json!("ac"));
    }

    fn make_line(source_line_num: usize, tag: &str, message: &str) -> LineContext {
        LineContext {
            source_line_num,
            tag: Arc::from(tag),
            message: Arc::from(message),
            raw: Arc::from(format!("{} {}", tag, message).as_str()),
            pid: 0,
            tid: 0,
            timestamp: source_line_num as i64 * 1000,
            level: LogLevel::Info,
            source_id: Arc::from(""),
            fields: Default::default(),
            annotations: vec![],
        }
    }

    fn make_def() -> StateTrackerDef {
        StateTrackerDef {
            group: "Network".to_string(),
            state: vec![
                StateFieldDecl {
                    name: "enabled".to_string(),
                    field_type: StateFieldType::Bool,
                    default: json!(false),
                },
                StateFieldDecl {
                    name: "ssid".to_string(),
                    field_type: StateFieldType::String,
                    default: json!(""),
                },
            ],
            transitions: vec![
                TransitionRule {
                    name: "WiFi Enabled".to_string(),
                    filter: TransitionFilter {
                        tag: Some("WifiStateMachine".to_string()),
                        message_contains: Some("ENABLED".to_string()),
                        ..Default::default()
                    },
                    set: {
                        let mut m = std::collections::HashMap::new();
                        m.insert("enabled".to_string(), serde_yaml::Value::Bool(true));
                        m
                    },
                    clear: vec![],
                },
                TransitionRule {
                    name: "Connected".to_string(),
                    filter: TransitionFilter {
                        tag: Some("WifiInfo".to_string()),
                        message_regex: Some(r#"SSID: "([^"]+)""#.to_string()),
                        ..Default::default()
                    },
                    set: {
                        let mut m = std::collections::HashMap::new();
                        m.insert("ssid".to_string(), serde_yaml::Value::String("$1".to_string()));
                        m
                    },
                    clear: vec![],
                },
                TransitionRule {
                    name: "WiFi Disabled".to_string(),
                    filter: TransitionFilter {
                        tag: Some("WifiStateMachine".to_string()),
                        message_contains: Some("DISABLED".to_string()),
                        ..Default::default()
                    },
                    set: {
                        let mut m = std::collections::HashMap::new();
                        m.insert("enabled".to_string(), serde_yaml::Value::Bool(false));
                        m
                    },
                    clear: vec!["ssid".to_string()],
                },
            ],
            output: StateTrackerOutput { timeline: true, annotate: true },
        }
    }

    #[test]
    fn test_transition_matching_tag_and_contains() {
        let def = make_def();
        let mut run = StateTrackerRun::new("wifi", &def);

        run.process_line(&make_line(1, "WifiStateMachine", "WiFi ENABLED"), &PipelineContext::test_default());
        assert_eq!(run.transitions.len(), 1);
        assert_eq!(run.transitions[0].transition_name, "WiFi Enabled");
        assert_eq!(run.current_state["enabled"], json!(true));
    }

    #[test]
    fn test_no_match_wrong_tag() {
        let def = make_def();
        let mut run = StateTrackerRun::new("wifi", &def);

        run.process_line(&make_line(1, "SomeOtherTag", "WiFi ENABLED"), &PipelineContext::test_default());
        assert_eq!(run.transitions.len(), 0);
    }

    #[test]
    fn test_capture_substitution() {
        let def = make_def();
        let mut run = StateTrackerRun::new("wifi", &def);

        run.process_line(&make_line(1, "WifiInfo", r#"SSID: "HomeNetwork" signal: -60"#), &PipelineContext::test_default());
        assert_eq!(run.transitions.len(), 1);
        assert_eq!(run.current_state["ssid"], json!("HomeNetwork"));
    }

    #[test]
    fn test_clear_resets_to_defaults() {
        let def = make_def();
        let mut run = StateTrackerRun::new("wifi", &def);

        run.process_line(&make_line(1, "WifiStateMachine", "WiFi ENABLED"), &PipelineContext::test_default());
        run.process_line(&make_line(2, "WifiInfo", r#"SSID: "HomeNetwork""#), &PipelineContext::test_default());
        assert_eq!(run.current_state["ssid"], json!("HomeNetwork"));

        run.process_line(&make_line(3, "WifiStateMachine", "WiFi DISABLED"), &PipelineContext::test_default());
        assert_eq!(run.current_state["ssid"], json!(""));
        assert_eq!(run.current_state["enabled"], json!(false));
    }

    #[test]
    fn test_get_state_at_line_before_any_transition() {
        let def = make_def();
        let mut run = StateTrackerRun::new("wifi", &def);
        run.process_line(&make_line(10, "WifiStateMachine", "WiFi ENABLED"), &PipelineContext::test_default());

        let snap = run.get_state_at_line(5);
        assert_eq!(snap.fields["enabled"], json!(false));
    }

    #[test]
    fn test_get_state_at_line_at_transition() {
        let def = make_def();
        let mut run = StateTrackerRun::new("wifi", &def);
        run.process_line(&make_line(10, "WifiStateMachine", "WiFi ENABLED"), &PipelineContext::test_default());
        run.process_line(&make_line(20, "WifiStateMachine", "WiFi DISABLED"), &PipelineContext::test_default());

        let snap = run.get_state_at_line(10);
        assert_eq!(snap.fields["enabled"], json!(true));

        let snap = run.get_state_at_line(25);
        assert_eq!(snap.fields["enabled"], json!(false));
    }

    #[test]
    fn test_get_state_at_line_past_end() {
        let def = make_def();
        let mut run = StateTrackerRun::new("wifi", &def);
        run.process_line(&make_line(10, "WifiStateMachine", "WiFi ENABLED"), &PipelineContext::test_default());

        let snap = run.get_state_at_line(99999);
        assert_eq!(snap.fields["enabled"], json!(true));
    }

    #[test]
    fn test_new_seeded_continuity() {
        let def = make_def();
        let mut run1 = StateTrackerRun::new("wifi", &def);
        run1.process_line(&make_line(1, "WifiStateMachine", "WiFi ENABLED"), &PipelineContext::test_default());

        let saved = run1.into_continuous_state(1);
        assert_eq!(saved.current_state["enabled"], json!(true));
        assert_eq!(saved.transitions.len(), 1);

        let mut run2 = StateTrackerRun::new_seeded("wifi", &def, saved);
        run2.process_line(&make_line(5, "WifiStateMachine", "WiFi DISABLED"), &PipelineContext::test_default());

        let result = run2.finish();
        assert_eq!(result.transitions.len(), 2);
        assert_eq!(result.final_state["enabled"], json!(false));
    }

    // ── tag_regex capture groups ─────────────────────────────────────────────

    fn make_tag_capture_def() -> StateTrackerDef {
        StateTrackerDef {
            group: String::new(),
            state: vec![
                StateFieldDecl { name: "network_id".into(), field_type: StateFieldType::String, default: serde_json::Value::Null },
                StateFieldDecl { name: "time_ms".into(), field_type: StateFieldType::String, default: serde_json::Value::Null },
            ],
            transitions: vec![
                TransitionRule {
                    name: "Validation Failed".into(),
                    filter: TransitionFilter {
                        tag_regex: Some(r"NetworkMonitor/(\d+)".into()),
                        message_regex: Some(r"Time=(\d+)ms".into()),
                        ..Default::default()
                    },
                    set: {
                        let mut m = std::collections::HashMap::new();
                        m.insert("network_id".into(), serde_yaml::Value::String("$1".into()));
                        m.insert("time_ms".into(), serde_yaml::Value::String("$2".into()));
                        m
                    },
                    clear: vec![],
                },
            ],
            output: StateTrackerOutput { timeline: true, annotate: true },
        }
    }

    #[test]
    fn tag_regex_captures_are_dollar_1() {
        let def = make_tag_capture_def();
        let mut run = StateTrackerRun::new("test", &def);
        run.process_line(&make_line(1, "NetworkMonitor/102", "Validation Time=57086ms"), &PipelineContext::test_default());
        assert_eq!(run.transitions.len(), 1);
        assert_eq!(run.current_state["network_id"], json!("102"));
        assert_eq!(run.current_state["time_ms"], json!("57086"));
    }

    #[test]
    fn tag_regex_no_groups_preserves_message_numbering() {
        // tag_regex with no capture groups — $1 should still be message capture
        let def = StateTrackerDef {
            group: String::new(),
            state: vec![
                StateFieldDecl { name: "time_ms".into(), field_type: StateFieldType::String, default: serde_json::Value::Null },
            ],
            transitions: vec![
                TransitionRule {
                    name: "Timed".into(),
                    filter: TransitionFilter {
                        tag_regex: Some(r"NetworkMonitor/\d+".into()),
                        message_regex: Some(r"Time=(\d+)ms".into()),
                        ..Default::default()
                    },
                    set: {
                        let mut m = std::collections::HashMap::new();
                        m.insert("time_ms".into(), serde_yaml::Value::String("$1".into()));
                        m
                    },
                    clear: vec![],
                },
            ],
            output: StateTrackerOutput { timeline: true, annotate: true },
        };
        let mut run = StateTrackerRun::new("test", &def);
        run.process_line(&make_line(1, "NetworkMonitor/102", "Validation Time=500ms"), &PipelineContext::test_default());
        assert_eq!(run.transitions.len(), 1);
        assert_eq!(run.current_state["time_ms"], json!("500"));
    }
}

