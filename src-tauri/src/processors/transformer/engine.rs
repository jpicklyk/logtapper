use std::collections::HashMap;
use regex::Regex;
use crate::core::line::{LineContext, LogLevel};
use crate::processors::reporter::schema::{FilterRule, FilterStage};
use crate::processors::transformer::schema::{TransformerDef, TransformOp, BuiltinTransformer};
use crate::processors::transformer::types::ContinuousTransformerState;
use crate::processors::transformer::builtin::PiiTransformer;

pub struct TransformerRun {
    def: TransformerDef,
    pii_transformer: Option<PiiTransformer>,
    regex_cache: HashMap<String, Regex>,
}

impl TransformerRun {
    pub fn new(def: &TransformerDef) -> Self {
        let pii_transformer = if def
            .builtin
            .as_ref()
            .is_some_and(|b| matches!(b, BuiltinTransformer::PiiAnonymizer))
        {
            Some(PiiTransformer::new())
        } else {
            None
        };
        TransformerRun {
            def: def.clone(),
            pii_transformer,
            regex_cache: HashMap::new(),
        }
    }

    pub fn new_seeded(def: &TransformerDef, _saved: ContinuousTransformerState) -> Self {
        Self::new(def)
    }

    pub fn process_line(&mut self, line: &mut LineContext) -> bool {
        if let Some(filter) = &self.def.filter.clone() {
            if !self.apply_filter(filter, line) {
                return false;
            }
        }
        if let Some(pii) = &mut self.pii_transformer {
            pii.apply(line);
        }
        for op in self.def.transforms.clone() {
            self.apply_transform_op(&op, line);
        }
        true
    }

    pub fn get_pii_mappings(&self) -> HashMap<String, String> {
        self.pii_transformer
            .as_ref()
            .map(|p| p.current_mappings())
            .unwrap_or_default()
    }

    pub fn into_continuous_state(self, last_processed_line: usize) -> ContinuousTransformerState {
        let pii_mappings = self
            .pii_transformer
            .as_ref()
            .map(|p| p.current_mappings())
            .filter(|m| !m.is_empty());
        ContinuousTransformerState {
            last_processed_line,
            pii_mappings,
        }
    }

    fn apply_filter(&mut self, stage: &FilterStage, line: &LineContext) -> bool {
        for rule in &stage.rules {
            if !self.rule_matches(rule, line) {
                return false;
            }
        }
        true
    }

    fn rule_matches(&mut self, rule: &FilterRule, line: &LineContext) -> bool {
        match rule {
            FilterRule::TagMatch { tags } => tags.iter().any(|t| t == &line.tag),
            FilterRule::MessageContains { value } => line.message.contains(value.as_str()),
            FilterRule::MessageContainsAny { values } => {
                values.iter().any(|v| line.message.contains(v.as_str()))
            }
            FilterRule::MessageRegex { pattern } => {
                let pattern = pattern.clone();
                match self.get_or_compile(&pattern) {
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
        }
    }

    fn get_or_compile(&mut self, pattern: &str) -> Option<&Regex> {
        if !self.regex_cache.contains_key(pattern) {
            if let Ok(re) = Regex::new(pattern) {
                self.regex_cache.insert(pattern.to_string(), re);
            } else {
                return None;
            }
        }
        self.regex_cache.get(pattern)
    }

    fn apply_transform_op(&mut self, op: &TransformOp, line: &mut LineContext) {
        match op {
            TransformOp::ReplaceField { field, regex, replacement } => {
                let regex = regex.clone();
                if let Some(re) = self.get_or_compile(&regex) {
                    if field == "message" {
                        line.message = re.replace_all(&line.message, replacement.as_str()).to_string();
                    } else if field == "tag" {
                        line.tag = re.replace_all(&line.tag, replacement.as_str()).to_string();
                    } else if let Some(serde_json::Value::String(val)) = line.fields.get(field) {
                        let new_val = re.replace_all(val, replacement.as_str()).to_string();
                        line.fields.insert(field.clone(), serde_json::Value::String(new_val));
                    }
                }
            }
            TransformOp::SetField { name, value } => {
                let json_val = yaml_to_json(value);
                line.fields.insert(name.clone(), json_val);
            }
            TransformOp::DropField { name } => {
                line.fields.remove(name);
            }
            TransformOp::AddField { name, script: _script } => {
                line.fields.entry(name.clone()).or_insert(serde_json::Value::String(String::new()));
            }
        }
    }
}

fn yaml_to_json(value: &serde_yaml::Value) -> serde_json::Value {
    match value {
        serde_yaml::Value::String(s) => serde_json::Value::String(s.clone()),
        serde_yaml::Value::Bool(b) => serde_json::Value::Bool(*b),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_json::Value::Number(i.into())
            } else if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(f)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            } else {
                serde_json::Value::Null
            }
        }
        serde_yaml::Value::Null => serde_json::Value::Null,
        serde_yaml::Value::Sequence(seq) => {
            serde_json::Value::Array(seq.iter().map(yaml_to_json).collect())
        }
        _ => serde_json::Value::Null,
    }
}


fn parse_level(s: &str) -> Option<LogLevel> {
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
    if parts.len() < 3 { return 0; }
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
    use crate::processors::transformer::schema::TransformOp;

    fn make_line(message: &str) -> LineContext {
        LineContext {
            raw: message.to_string(),
            timestamp: 0,
            level: LogLevel::Info,
            tag: "TestTag".to_string(),
            pid: 0,
            tid: 0,
            message: message.to_string(),
            source_id: String::new(),
            source_line_num: 1,
            fields: HashMap::new(),
            annotations: vec![],
        }
    }

    fn make_def_with_ops(ops: Vec<TransformOp>) -> TransformerDef {
        TransformerDef {
            filter: None,
            transforms: ops,
            builtin: None,
        }
    }

    #[test]
    fn test_replace_field_message() {
        let def = make_def_with_ops(vec![TransformOp::ReplaceField {
            field: "message".to_string(),
            regex: r"\d{4}-\d{2}-\d{2}".to_string(),
            replacement: "DATE".to_string(),
        }]);
        let mut run = TransformerRun::new(&def);
        let mut line = make_line("Error on 2024-01-15: something failed");
        let keep = run.process_line(&mut line);
        assert!(keep);
        assert_eq!(line.message, "Error on DATE: something failed");
    }

    #[test]
    fn test_set_field() {
        let def = make_def_with_ops(vec![TransformOp::SetField {
            name: "severity".to_string(),
            value: serde_yaml::Value::String("high".to_string()),
        }]);
        let mut run = TransformerRun::new(&def);
        let mut line = make_line("some error");
        run.process_line(&mut line);
        assert_eq!(
            line.fields.get("severity"),
            Some(&serde_json::Value::String("high".to_string()))
        );
    }

    #[test]
    fn test_drop_field() {
        let def = make_def_with_ops(vec![TransformOp::DropField {
            name: "secret".to_string(),
        }]);
        let mut run = TransformerRun::new(&def);
        let mut line = make_line("some message");
        line.fields.insert(
            "secret".to_string(),
            serde_json::Value::String("sensitive_data".to_string()),
        );
        run.process_line(&mut line);
        assert!(!line.fields.contains_key("secret"));
    }

    #[test]
    fn test_continuous_state_round_trip() {
        let def = TransformerDef { filter: None, transforms: vec![], builtin: None };
        let run = TransformerRun::new(&def);
        let state = run.into_continuous_state(42);
        assert_eq!(state.last_processed_line, 42);
        assert!(state.pii_mappings.is_none());
    }

    #[test]
    fn test_filter_drops_non_matching_line() {
        use crate::processors::reporter::schema::{FilterRule, FilterStage};
        let def = TransformerDef {
            filter: Some(FilterStage {
                source: None,
                rules: vec![FilterRule::MessageContains { value: "ERROR".to_string() }],
            }),
            transforms: vec![],
            builtin: None,
        };
        let mut run = TransformerRun::new(&def);
        let mut line = make_line("normal debug line");
        let keep = run.process_line(&mut line);
        assert!(!keep, "Line without ERROR should be dropped by filter");
    }

    #[test]
    fn test_filter_passes_matching_line() {
        use crate::processors::reporter::schema::{FilterRule, FilterStage};
        let def = TransformerDef {
            filter: Some(FilterStage {
                source: None,
                rules: vec![FilterRule::MessageContains { value: "ERROR".to_string() }],
            }),
            transforms: vec![],
            builtin: None,
        };
        let mut run = TransformerRun::new(&def);
        let mut line = make_line("ERROR: something went wrong");
        let keep = run.process_line(&mut line);
        assert!(keep, "Line with ERROR should pass filter");
    }

    #[test]
    fn test_new_seeded_produces_valid_run() {
        let def = TransformerDef { filter: None, transforms: vec![], builtin: None };
        let saved = ContinuousTransformerState { last_processed_line: 100, pii_mappings: None };
        let mut run = TransformerRun::new_seeded(&def, saved);
        let mut line = make_line("hello");
        let keep = run.process_line(&mut line);
        assert!(keep);
    }
}
